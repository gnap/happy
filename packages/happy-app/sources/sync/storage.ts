import { create } from "zustand";
import { useShallow } from 'zustand/react/shallow'
import { Session, Machine, GitStatus } from "./storageTypes";
import { computeBitmap } from "./cacheSegment";
import { createReducer, reducer, ReducerState } from "./reducer/reducer";
import { bump } from './metrics';
import { Message } from "./typesMessage";
import { mergePageIntoWindow } from "./messageIdentity";
import { NormalizedMessage } from "./typesRaw";
import type { DaemonRoute, LanSighting, RelayEndpoint, SessionChannel } from './lan/types';
import type { RelayDirectoryEntry } from './lan/relayDirectory';
import { advanceLanEndpoint, advanceRelayEndpoint, parseLanEndpoints, parseRelayEndpoint } from './lan/relay';
import type { LifecycleEntry } from './lan/client';
import type { DaemonConnectionState } from './lan/daemonConnections';
import { machineBadgeInputs, resolveMachinePresence, type MachineCapability, type MachineLink, type MachinePresence, type MachineReach } from './machinePresence';
import { channelLinks } from './channelLinks';
import { enabledChannels } from '@/utils/enabledChannels';
import { sessionIsRestarting } from '@/utils/sessionRestart';
import { channelDrivers, type ChannelState } from './channels/measure';
import { candidateFailed as candidateFailedAt, candidateKey, candidateSucceeded, rearmAll, type CandidateHealth } from './channels/health';
import type { ChannelDriver, ChannelLinkState, SessionReach } from './channels/types';
import { resolveSessionReach } from './channels/resolve';

export { channelLinks, type ChannelLink } from './channelLinks';
export type { ChannelLinkState } from './channels/types';
import { applySettings, Settings } from "./settings";
import { LocalSettings, applyLocalSettings } from "./localSettings";
import { Purchases, customerInfoToPurchases } from "./purchases";
import { Profile } from "./profile";
import { UserProfile, RelationshipUpdatedEvent } from "./friendTypes";
import { loadSettings, loadLocalSettings, saveLocalSettings, saveSettings, loadPurchases, savePurchases, loadProfile, saveProfile, loadSessionDrafts, saveSessionDrafts, loadSessionPermissionModes, saveSessionPermissionModes, loadSessionModelModes, saveSessionModelModes, loadSessionMaxModes, saveSessionMaxModes, loadSessionProfileIds, saveSessionProfileIds, loadSessionSandboxIsolations, saveSessionSandboxIsolations, loadRelayEndpoints, saveRelayEndpoints } from "./persistence";
import type { PermissionModeKey } from '@/components/PermissionModeSelector';
import type { CustomerInfo } from './revenueCat/types';
import React from "react";
import { sync } from "./sync";
import { getCurrentRealtimeSessionId, getVoiceSession } from '@/realtime/RealtimeSession';
import { isMutableTool } from "@/components/tools/knownTools";
import { projectManager } from "./projectManager";
import { DecryptedArtifact } from "./artifactTypes";
import { FeedItem } from "./feedTypes";

// Debounce timer for realtimeMode changes
let realtimeModeDebounceTimer: ReturnType<typeof setTimeout> | null = null;
const REALTIME_MODE_DEBOUNCE_MS = 150;

/**
 * Centralized session online state resolver
 * Returns either "online" (string) or a timestamp (number) for last seen
 */
function resolveSessionOnlineState(session: { active: boolean; activeAt: number }): "online" | number {
    // Session is online if the active flag is true
    return session.active ? "online" : session.activeAt;
}

function isSandboxEnabled(metadata: Session['metadata'] | null | undefined): boolean {
    const sandbox = metadata?.sandbox;
    return !!sandbox && typeof sandbox === 'object' && (sandbox as { enabled?: unknown }).enabled === true;
}

// Known entitlement IDs
export type KnownEntitlements = 'pro';

export interface OutboxEntry {
    localId: string;
    sessionId: string;
    text: string;
    displayText?: string;
    status: 'sending' | 'acked' | 'delivered' | 'failed';
    failReason?: string;
    createdAt: number;
}

interface SessionMessages {
    messages: Message[];
    /** Highest seq actually loaded into memory; 0 means unknown */
    newestSeq: number;
    /**
     * Bitmap tracking which 100-message segments are fully cached in memory.
     * Bit i is set when [segmentStart(i), segmentEnd(i)] ⊆ [oldestSeq, newestSeq].
     * Recomputed whenever oldestSeq or newestSeq changes.
     */
    cachedBitmap: number;
    messagesMap: Record<string, Message>;
    reducerState: ReducerState;
    isLoaded: boolean;
    /** Lowest seq currently loaded; 0 means unknown / full history loaded */
    oldestSeq: number;
    /** True if there are messages on the server with seq < oldestSeq */
    hasOlderMessages: boolean;
    /** True while an older-messages fetch is in flight */
    isLoadingOlder: boolean;
    /** True while a fetchMessages (incremental/cold-start) call is in flight */
    isFetching: boolean;
}

// Machine type is now imported from storageTypes - represents persisted machine data

// Unified list item type for SessionsList component
export type SessionListViewItem =
    | { type: 'header'; title: string }
    | { type: 'active-sessions'; sessions: Session[] }
    | { type: 'project-group'; displayPath: string; machine: Machine }
    | { type: 'worktree-group'; projectPath: string; homeDir?: string; branch?: string }
    | { type: 'host-group'; projectPath: string; host: string; machineId?: string; onlineCount: number; totalCount: number }
    | {
        type: 'session';
        session: Session;
        variant?: 'default' | 'no-path';
        needsRestart?: boolean;
        /**
         * Whether anything is reaching this session, decided when the list was built.
         *
         * Carried on the item rather than asked again by whoever draws or filters it, because the
         * answer depends on the channels and not on the session alone — and a filter that reads
         * `session.active` instead puts a session the LAN is serving below the "offline" divider.
         */
        online?: boolean;
    };

// Legacy type for backward compatibility - to be removed
export type SessionListItem = string | Session;

/**
 * How long a LAN sighting stays valid after the scan that produced it. Long enough to ride out a
 * missed mDNS announcement (and the gap between periodic scans), short enough that a machine which
 * genuinely left the network stops looking reachable.
 */
export const LAN_SIGHTING_TTL_MS = 90_000;

interface StorageState {
    settings: Settings;
    settingsVersion: number | null;
    localSettings: LocalSettings;
    purchases: Purchases;
    profile: Profile;
    sessions: Record<string, Session>;
    sessionsData: SessionListItem[] | null;  // Legacy - to be removed
    sessionListViewData: SessionListViewItem[] | null;
    sessionMessages: Record<string, SessionMessages>;
    outbox: Record<string, OutboxEntry>;
    sessionGitStatus: Record<string, GitStatus | null>;
    machines: Record<string, Machine>;
    /**
     * Machines the LAN scanner can currently see, keyed by machineId. Purely a local observation —
     * deliberately NOT folded into `machines`, whose `active` flag is the server's answer and gets
     * overwritten wholesale by `fetchMachines`. See `sync/machinePresence.ts`.
     */
    lanSightings: Record<string, LanSighting>;
    /**
     * Public relay routes per machine, learned from `daemonState.p2p` and persisted so they are
     * still known when the server is down at the next cold start.
     */
    relayEndpoints: Record<string, RelayEndpoint>;
    /**
     * Where each machine said it can be reached on the local network, from the metadata it publishes.
     *
     * A second source of LAN addresses beside the mDNS sightings, and not a replacement: discovery
     * needs multicast, which a VLAN or an isolating access point takes away, while this arrives over
     * whatever channel that machine's metadata does. Kept apart from the sightings because a browse
     * owns that set and replaces it — an address a machine published would be swept away by the next
     * scan, and it is exactly the one that survives when scans find nothing.
     */
    lanEndpoints: Record<string, { baseUrls: string[]; at: number }>;
    /**
     * What each address has done lately, keyed by machine + route + address.
     *
     * Deliberately not persisted: it is a record of what *this run* has observed, and a `live`
     * carried over from a previous run is exactly the unevidenced claim this replaced.
     */
    candidateHealth: Record<string, CandidateHealth>;
    /** Something answered at this address, which is the only thing that makes it usable. */
    candidateSucceeded: (machineId: string, route: SessionChannel, baseUrl: string) => void;
    /** Nothing answered at this address. A refusal or a 404 is not this. */
    candidateFailed: (machineId: string, route: SessionChannel, baseUrl: string) => void;
    /** Everything is worth retrying: the device changed network, or came back from suspension. */
    rearmCandidateHealth: () => void;
    applyRelayEndpoint: (machineId: string, endpoint: RelayEndpoint | null) => void;
    /**
     * What the relay says it is holding, keyed by machineId.
     *
     * This is the relay's own directory, not a local observation: the relay knows which daemons
     * dialled in and what sessions each published, and it says so — including pushing an update
     * when one comes or goes. So "the relay can reach this machine" is a fact the App is told,
     * where it used to be a probe the App ran and had to interpret.
     */
    relayDirectory: Record<string, RelayDirectoryEntry>;
    /**
     * Tags the relay is holding that no key on this device matches.
     *
     * Worth keeping apart rather than dropping: a machine that is up and whose tag this App cannot
     * name is a real thing to see — a machine paired on another device, or a key this one has lost.
     */
    relayUnknownTags: string[];
    /** Whether the App's one relay connection is up. */
    relayHubConnected: boolean;
    applyRelayDirectory: (entries: RelayDirectoryEntry[], unknownTags: string[]) => void;
    setRelayHubConnected: (connected: boolean) => void;
    /**
     * Forget what was seen on the network we were on.
     *
     * `applyLanSightings([])` deliberately carries recent sightings over, because mDNS is lossy and
     * one missed scan should not flicker a machine. A network change is the opposite case: what was
     * seen belongs to the old network, and keeping it would have the App reach for an address that
     * the device is no longer on.
     */
    clearLanSightings: () => void;
    /**
     * What each daemon connection is doing, keyed by `machineId:route` — a machine is a daemon with
     * sessions on it, and a route is only how the bytes get there, so this is one entry per daemon
     * per transport rather than one per transport.
     *
     * Each entry says live, opening, retrying after a drop, or idle because nothing wants it. The
     * phase is always present because "nothing is connected" and "nothing is wanted" are different
     * facts and the second is not a fault — showing both as one grey state is what made a channel
     * stuck retrying look like a quiet one.
     */
    daemonSockets: Record<string, DaemonConnectionState>;
    /**
     * A per-session, manually forced channel. Absent means automatic: the server, falling back to
     * the LAN when it cannot answer.
     *
     * This exists so the LAN path can be exercised on demand. Without it the only way to reach
     * that path is to break the server, which makes it untestable in normal use — and an
     * untestable fallback is one nobody finds out is broken until they need it.
     */
    /**
     * What a LAN daemon reported about its sessions, by sessionId.
     *
     * Only useful when the server cannot answer. Note what it cannot do: the LAN summary carries
     * no `metadata` — that is encrypted and only ever travels inside a message payload — so this
     * can confirm which sessions exist and which are alive, but it cannot build a session row.
     */
    daemonSessionList: Record<string, { isAlive: boolean; directory: string; agent: string; via: DaemonRoute; at: number; restartingSince?: number }>;
    /**
     * How far each machine's lifecycle log has been replayed, by machine id.
     *
     * In memory rather than persisted, and that is a decision rather than an omission: replaying
     * from the beginning again is an empty operation, because every entry is idempotent — a create
     * for a session that is already here does nothing, a delete for one that is already gone does
     * nothing. Persisting the cursor would save a few bytes of bandwidth per launch and add a way
     * for the stored position and the stored sessions to disagree.
     */
    lifecycleCursors: Record<string, number>;
    /**
     * Sessions a machine's own log says are gone, by server id or tag, and when it said so.
     *
     * What keeps one from coming back. A delete that a machine announced has not necessarily
     * reached the server yet — that replay is the server channel's own progress — and until it has,
     * every server fetch would offer the session again and the row would reappear under a reader
     * that just watched it go. This is the window, not the record: the durable answer is the server
     * being told, and this only has to outlive the interval between the two.
     */
    lifecycleDeleted: Record<string, number>;
    /**
     * Applies what a machine's own log says, for the sessions the server has not told this App
     * about.
     *
     * A session arrives here before the server knows it exists, which is the whole point: the
     * machine has it, the App can be shown it, and the server catching up is a separate progress.
     * Keyed by the server's id when the entry carries one and by the tag when it does not — a
     * session has a tag from the moment it is spawned and an id only once the server has answered —
     * so an entry that brings the id replaces the row that was standing in on the tag.
     *
     * The same walk carries where the machine says it can be reached, because that is a fact from
     * the same log: one cursor covers both, and a reader that applied an entry never has to be told
     * it again.
     */
    applyLifecycle: (machineId: string, revision: number, entries: LifecycleEntry[]) => void;
    /** What each machine last said it was running, asked over a channel it answered on. */
    daemonVersions: Record<string, { running: string; onDisk: string | null; restartRequired: boolean; at: number }>;
    /** Replace the daemons' view. Pass null to clear it (the server answered). */
    /** Records what a machine said it is running. Null forgets it, for a machine that moved. */
    applyDaemonVersion: (machineId: string, versions: { running: string; onDisk: string | null; restartRequired: boolean } | null) => void;
    applyDaemonSessionList: (sessions: { happySessionId: string; isAlive: boolean; directory: string; agent: string; via: DaemonRoute; restartingSince?: number }[] | null) => void;
    channelOverride: Record<string, SessionChannel>;
    /** Pass null to return the session to automatic. */
    setSessionChannelOverride: (sessionId: string, channel: SessionChannel | null) => void;
    artifacts: Record<string, DecryptedArtifact>;  // New artifacts storage
    friends: Record<string, UserProfile>;  // All relationships (friends, pending, requested, etc.)
    users: Record<string, UserProfile | null>;  // Global user cache, null = 404/failed fetch
    feedItems: FeedItem[];  // Simple list of feed items
    feedHead: string | null;  // Newest cursor
    feedTail: string | null;  // Oldest cursor
    feedHasMore: boolean;
    feedLoaded: boolean;  // True after initial feed fetch
    friendsLoaded: boolean;  // True after initial friends fetch
    realtimeStatus: 'disconnected' | 'connecting' | 'connected' | 'error';
    realtimeMode: 'idle' | 'speaking';
    socketStatus: 'disconnected' | 'connecting' | 'connected' | 'error' | 'auth_error';
    socketLastConnectedAt: number | null;
    socketLastDisconnectedAt: number | null;
    isDataReady: boolean;
    nativeUpdateStatus: { available: boolean; updateUrl?: string } | null;
    applySessions: (sessions: (Omit<Session, 'presence'> & { presence?: "online" | number })[], fullRefresh?: boolean) => void;
    applyMachines: (machines: Machine[], replace?: boolean) => void;
    /** Replace the LAN sighting set with the result of one scan. */
    applyLanSightings: (sightings: LanSighting[]) => void;
    /** Records where a machine publishes itself on the LAN, or forgets it when it stops saying. */
    applyLanEndpoint: (machineId: string, endpoint: { baseUrls: string[]; at: number } | null) => void;
    /** Record the live LAN socket, or null once it is gone. */
    setDaemonSocketStatus: (id: string, status: DaemonConnectionState) => void;
    applyLoaded: () => void;
    applyReady: () => void;
    applyMessages: (sessionId: string, messages: NormalizedMessage[]) => { changed: string[], hasReadyEvent: boolean };
    applyMessagesLoaded: (sessionId: string) => void;
    setFetching: (sessionId: string, fetching: boolean) => void;
    applyHydratedCache: (sessionId: string, messages: Message[], reducerState: ReducerState, oldestSeq: number, hasOlderMessages: boolean, lastSeq: number) => void;
    setNewestSeq: (sessionId: string, newestSeq: number) => void;
    applyOlderMessages: (sessionId: string, olderMessages: NormalizedMessage[], newOldestSeq: number, hasOlderMessages: boolean) => void;
    /**
     * Replace a session's loaded window with a page that does not abut it.
     *
     * `applyMessages` merges by id and sorts by time, so handing it two ranges of a session that
     * are not adjacent silently joins them: the messages in between never arrive, and nothing
     * downstream can tell, because the window fields still describe one contiguous span. A channel
     * whose reads can land anywhere in a log (the daemon's) therefore has to say when it is
     * starting over, and this is that statement — the page becomes the whole window.
     */
    applyWindow: (sessionId: string, messages: NormalizedMessage[], oldestSeq: number, newestSeq: number, hasOlderMessages: boolean) => void;
    setLoadingOlder: (sessionId: string, loading: boolean) => void;
    applySettings: (settings: Settings, version: number) => void;
    applySettingsLocal: (settings: Partial<Settings>) => void;
    applyLocalSettings: (settings: Partial<LocalSettings>) => void;
    applyPurchases: (customerInfo: CustomerInfo) => void;
    applyProfile: (profile: Profile) => void;
    applyGitStatus: (sessionId: string, status: GitStatus | null) => void;
    applyNativeUpdateStatus: (status: { available: boolean; updateUrl?: string } | null) => void;
    isMutableToolCall: (sessionId: string, callId: string) => boolean;
    finalizeRunningTools: (sessionId: string) => void;
    resolveToolCallLazyContent: (sessionId: string, messageId: string, fullInput: Record<string, unknown>) => boolean;
    resolveToolCallLazyResult: (sessionId: string, messageId: string, fullResult: unknown) => boolean;
    setRealtimeStatus: (status: 'disconnected' | 'connecting' | 'connected' | 'error') => void;
    setRealtimeMode: (mode: 'idle' | 'speaking', immediate?: boolean) => void;
    clearRealtimeModeDebounce: () => void;
    setSocketStatus: (status: 'disconnected' | 'connecting' | 'connected' | 'error' | 'auth_error') => void;
    getActiveSessions: () => Session[];
    updateSessionDraft: (sessionId: string, draft: string | null) => void;
    updateSessionPermissionMode: (sessionId: string, mode: string) => void;
    updateSessionModelMode: (sessionId: string, mode: string) => void;
    clearSessionModelMode: (sessionId: string) => void;
    updateSessionMaxMode: (sessionId: string, maxMode: boolean) => void;
    clearSessionMaxMode: (sessionId: string) => void;
    updateSessionThinkingLevel: (sessionId: string, level: 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null) => void;
    clearSessionThinkingLevel: (sessionId: string) => void;
    updateSessionProfileId: (sessionId: string, profileId: string | null) => void;
    clearSessionProfileId: (sessionId: string) => void;
    /** Clear in-memory profileId override at turn end so remote metadata wins next resolution. MMKV is preserved for cold-start fallback. */
    releaseSessionProfileId: (sessionId: string) => void;
    updateSessionSandboxIsolation: (sessionId: string, isolation: string) => void;
    clearSessionSandboxIsolation: (sessionId: string) => void;
    /** Clear in-memory sandboxIsolation at turn end so remote metadata wins next resolution. MMKV is preserved for cold-start fallback. */
    releaseSessionSandboxIsolation: (sessionId: string) => void;
    // Artifact methods
    applyArtifacts: (artifacts: DecryptedArtifact[]) => void;
    addArtifact: (artifact: DecryptedArtifact) => void;
    updateArtifact: (artifact: DecryptedArtifact) => void;
    deleteArtifact: (artifactId: string) => void;
    deleteSession: (sessionId: string) => void;
    // Outbox (send status tracking)
    addOutboxEntry: (entry: Omit<OutboxEntry, 'status'>) => void;
    removeOutboxEntry: (localId: string) => void;
    markOutboxMessageAcked: (localId: string) => void;
    markOutboxMessageDelivered: (localId: string) => void;
    removeOutboxEntriesForSession: (sessionId: string) => void;
    failOutboxEntries: (localIds: string[], reason: string) => void;
    deleteSessionMessages: (sessionId: string) => void;
    // Project management methods
    getProjects: () => import('./projectManager').Project[];
    getProject: (projectId: string) => import('./projectManager').Project | null;
    getProjectForSession: (sessionId: string) => import('./projectManager').Project | null;
    getProjectSessions: (projectId: string) => string[];
    // Project git status methods
    getProjectGitStatus: (projectId: string) => import('./storageTypes').GitStatus | null;
    getSessionProjectGitStatus: (sessionId: string) => import('./storageTypes').GitStatus | null;
    updateSessionProjectGitStatus: (sessionId: string, status: import('./storageTypes').GitStatus | null) => void;
    // Friend management methods
    applyFriends: (friends: UserProfile[]) => void;
    applyRelationshipUpdate: (event: RelationshipUpdatedEvent) => void;
    getFriend: (userId: string) => UserProfile | undefined;
    getAcceptedFriends: () => UserProfile[];
    // User cache methods
    applyUsers: (users: Record<string, UserProfile | null>) => void;
    getUser: (userId: string) => UserProfile | null | undefined;
    assumeUsers: (userIds: string[]) => Promise<void>;
    // Feed methods
    applyFeedItems: (items: FeedItem[]) => void;
    clearFeed: () => void;
}

/**
 * The machine a host group belongs to.
 *
 * A host group is keyed by the session's display `host` string, not by machine — two machines
 * could in principle report the same hostname. Take the most common `machineId` among the group's
 * sessions so the group reflects the machine most of its sessions actually belong to, rather than
 * whichever session happened to sort first.
 */
function dominantMachineId(sessions: Session[]): string | undefined {
    const counts = new Map<string, number>();
    for (const session of sessions) {
        const id = session.metadata?.machineId;
        if (id) {
            counts.set(id, (counts.get(id) ?? 0) + 1);
        }
    }
    let dominant: string | undefined;
    let best = 0;
    for (const [id, count] of counts) {
        if (count > best) {
            best = count;
            dominant = id;
        }
    }
    return dominant;
}

// Helper function to build unified list view data from sessions and machines
/** The last mark logged per session, so the line appears when it changes rather than per rebuild. */
const listMarkLogged = new Map<string, string>();

/**
 * Whether restarting this session would change its build — the one rule for every list.
 *
 * The baseline is the machine's own report, in this order: the build on disk (what a restart would
 * spawn), the build the daemon is running, the fields written by the daemon, and only last the
 * server's copy of the machine — which is the one that goes stale on its own, and the one this rule
 * used to be built on. A copy that is missing or old makes "the versions differ" false, so sessions
 * older than their machine read as up to date.
 *
 * A restart in flight hides the mark, and that is not a special case bolted on: the mark is about
 * the *build*, and the build only changes when the new process says so — which is after the restart,
 * not at the tap. Without this the row would say "needs a restart" for the whole of the restart it
 * is already doing, which is the contradiction this mark was fixed for once before.
 *
 * Exported because two lists draw this mark and each had its own idea of when: one had the rule and
 * the other had none, so the same session showed a restart in one list and nothing in the other.
 */
export function sessionNeedsRestart(
    session: Session,
    machines: Record<string, {
        metadata?: { happyCliVersion?: string } | null;
        daemonState?: { startedWithCliVersion?: string } | null;
    }>,
    daemonVersions: Record<string, { running: string; onDisk: string | null; restartRequired: boolean; at: number }> = {},
): boolean {
    const machineId = session.metadata?.machineId;
    if (!machineId) return false;
    if (sessionIsRestarting(session)) return false;
    const machine = machines[machineId];
    const sessionVersion = session.metadata?.version;
    const live = daemonVersions[machineId];
    const machineVersion = live?.onDisk
        ?? live?.running
        ?? machine?.daemonState?.startedWithCliVersion
        ?? machine?.metadata?.happyCliVersion;
    return !!(sessionVersion && machineVersion && sessionVersion !== machineVersion);
}

function buildSessionListViewData(
    sessions: Record<string, Session>,
    machines: Record<string, { metadata?: { happyCliVersion?: string } | null; daemonState?: { startedWithCliVersion?: string } | null }>,
    /** What each machine said it is running, asked over whichever channel that machine answered on. */
    daemonVersions: Record<string, { running: string; onDisk: string | null; restartRequired: boolean; at: number }> = {},
    /**
     * The channels this device has, in the order it prefers them.
     *
     * Passed in rather than read here, because this function is given the pieces of the store it
     * builds from and not the store itself. What it is for is the one question this list asks about
     * a session and used to answer wrongly: whether anything is reaching it. It read the server's
     * `active` flag, so a session being served over the LAN while the server had not heard from it
     * was counted offline — in the same row that showed it online, and in the count directly above.
     */
    drivers: readonly ChannelDriver[] = [],
): SessionListViewItem[] {
    /** Whether anything is reaching this session, from any channel, the way the rest of the App asks. */
    const reached = (session: Session) => resolveSessionReach(session.id, session.metadata?.machineId, drivers).online;

    // Separate active and inactive sessions
    const activeSessions: Session[] = [];
    const inactiveSessions: Session[] = [];

    Object.values(sessions).forEach(session => {
        if (reached(session)) {
            activeSessions.push(session);
        } else {
            inactiveSessions.push(session);
        }
    });

    // Sort sessions by creation date (newest first).  Using createdAt instead of
    // updatedAt keeps relative ordering stable — project groups won't jump when a
    // session inside gets an update (e.g. draft, metadata sync).
    activeSessions.sort((a, b) => b.createdAt - a.createdAt);
    // Inactive sessions sort by last activity so the date headers make sense.
    inactiveSessions.sort((a, b) => b.updatedAt - a.updatedAt);

    /**
     * Whether restarting this session would change its build.
     *
     * The baseline is the machine's own report, the same one the session page uses and in the same
     * order: the build on disk (what a restart would spawn), then the build the daemon is running,
     * then the fields written by the daemon, and only last the server's copy of the machine — which
     * is the one that goes stale on its own, and the one this rule used to be built on. A copy that
     * is missing or old makes "the versions differ" false, so sessions older than their machine read
     * as up to date, which is what made this decision look arbitrary.
     */
    const getNeedsRestart = (s: Session): boolean => {
        const marked = sessionNeedsRestart(s, machines, daemonVersions);
        // The mark's inputs, once per change: three sources feed this baseline and a log is the only
        // way to tell a rule that decided wrongly from one that was handed nothing.
        const machineId = s.metadata?.machineId;
        const machine = machineId ? machines[machineId] : undefined;
        const live = machineId ? daemonVersions[machineId] : undefined;
        const summary = `${s.id} session=${s.metadata?.version ?? '-'} onDisk=${live?.onDisk ?? '-'} running=${live?.running ?? '-'} record=${machine?.daemonState?.startedWithCliVersion ?? '-'} server=${machine?.metadata?.happyCliVersion ?? '-'} marked=${marked}`;
        if (listMarkLogged.get(s.id) !== summary) {
            listMarkLogged.set(s.id, summary);
            console.log(`🔄 list restart mark: ${summary}`);
        }
        return marked;
    };

    // Helper: emit a date group, inserting project-group headers with host sub-groups.
    const emitSessionGroup = (group: Session[]) => {
        const byProject = new Map<string, Session[]>();
        const standard: Session[] = [];

        for (const s of group) {
            let pp = s.metadata?.projectPath;
            if (pp) {
                // Normalize path: replace home dir with ~ so same projects
                // on different machines group together.
                const hd = s.metadata?.homeDir;
                if (hd && pp.startsWith(hd)) {
                    pp = '~' + pp.slice(hd.length);
                }
                const arr = byProject.get(pp) || [];
                arr.push(s);
                byProject.set(pp, arr);
            } else {
                standard.push(s);
            }
        }

        // Standard sessions sort by last activity for the date headers.
        standard.sort((a, b) => b.updatedAt - a.updatedAt);
        for (const s of standard) {
            listData.push({ type: 'session', session: s, needsRestart: getNeedsRestart(s), online: reached(s) });
        }
        // Sort project groups by newest createdAt in each group (stable)
        const sortedProjects = [...byProject.entries()].sort(([, a], [, b]) => {
            const aOnline = a.some(reached);
            const bOnline = b.some(reached);
            if (aOnline !== bOnline) return aOnline ? -1 : 1;
            const aMax = Math.max(...a.map(s => s.createdAt));
            const bMax = Math.max(...b.map(s => s.createdAt));
            return bMax - aMax;
        });
        for (const [projectPath, sessions] of sortedProjects) {
            // Sub-group by host within this project
            const byHost = new Map<string, Session[]>();
            for (const s of sessions) {
                const host = s.metadata?.host ?? '';
                const arr = byHost.get(host) || [];
                arr.push(s);
                byHost.set(host, arr);
            }
            const homeDir = sessions[0]?.metadata?.homeDir;
            const branch = sessions.find(s => !!s.metadata?.branchName)?.metadata?.branchName
                        ?? sessions.find(s => !!s.metadata?.worktreeBranch)?.metadata?.worktreeBranch;
            listData.push({ type: 'worktree-group', projectPath, homeDir, branch });
            // Emit host sub-groups (sorted by newest session in each host)
            const sortedHosts = [...byHost.entries()].sort(([, a], [, b]) => {
                const aMax = Math.max(...a.map(s => s.createdAt));
                const bMax = Math.max(...b.map(s => s.createdAt));
                return bMax - aMax;
            });
            for (const [host, hostSessions] of sortedHosts) {
                // Main repo first, then worktrees
                hostSessions.sort((a, b) => {
                    const aWt = a.metadata?.isWorktree ?? true;
                    const bWt = b.metadata?.isWorktree ?? true;
                    if (aWt !== bWt) return aWt ? 1 : -1;
                    return b.createdAt - a.createdAt;
                });
                const onlineCount = hostSessions.filter(reached).length;
                listData.push({ type: 'host-group', projectPath, host, machineId: dominantMachineId(hostSessions), onlineCount, totalCount: hostSessions.length });
                for (const s of hostSessions) {
                    listData.push({ type: 'session', session: s, needsRestart: getNeedsRestart(s), online: reached(s) });
                }
            }
        }
    };

    // Build unified list view data
    const listData: SessionListViewItem[] = [];

    // Emit active sessions grouped by projectPath. Main repo first, then worktrees.
    // Sessions without projectPath stay in the active-sessions carousel.
    const emitProjectGroups = (sessions: Session[], toList: SessionListViewItem[]) => {
        const byProject = new Map<string, Session[]>();
        const noProject: Session[] = [];
        for (const s of sessions) {
            let pp = s.metadata?.projectPath;
            if (pp) {
                const hd = s.metadata?.homeDir;
                if (hd && pp.startsWith(hd)) {
                    pp = '~' + pp.slice(hd.length);
                }
                const arr = byProject.get(pp) || [];
                arr.push(s);
                byProject.set(pp, arr);
            } else {
                noProject.push(s);
            }
        }
        // Sort project groups by newest createdAt in each group (stable)
        const sortedProjects = [...byProject.entries()].sort(([, a], [, b]) => {
            const aOnline = a.some(reached);
            const bOnline = b.some(reached);
            if (aOnline !== bOnline) return aOnline ? -1 : 1;
            const aMax = Math.max(...a.map(s => s.createdAt));
            const bMax = Math.max(...b.map(s => s.createdAt));
            return bMax - aMax;
        });
        for (const [projectPath, projectSessions] of sortedProjects) {
            const homeDir = projectSessions[0]?.metadata?.homeDir;
            const branch = projectSessions.find(s => !!s.metadata?.branchName)?.metadata?.branchName
                        ?? projectSessions.find(s => !!s.metadata?.worktreeBranch)?.metadata?.worktreeBranch;
            toList.push({ type: 'worktree-group', projectPath, homeDir, branch });
            // Sub-group by host
            const byHost = new Map<string, Session[]>();
            for (const s of projectSessions) {
                const host = s.metadata?.host ?? '';
                const arr = byHost.get(host) || [];
                arr.push(s);
                byHost.set(host, arr);
            }
            const sortedHosts = [...byHost.entries()].sort(([, a], [, b]) => {
                const aMax = Math.max(...a.map(s => s.createdAt));
                const bMax = Math.max(...b.map(s => s.createdAt));
                return bMax - aMax;
            });
            for (const [host, hostSessions] of sortedHosts) {
                hostSessions.sort((a, b) => {
                    const aWt = a.metadata?.isWorktree ?? true;
                    const bWt = b.metadata?.isWorktree ?? true;
                    if (aWt !== bWt) return aWt ? 1 : -1;
                    return b.createdAt - a.createdAt;
                });
                const onlineCount = hostSessions.filter(reached).length;
                toList.push({ type: 'host-group', projectPath, host, machineId: dominantMachineId(hostSessions), onlineCount, totalCount: hostSessions.length });
                for (const s of hostSessions) {
                    toList.push({ type: 'session', session: s, needsRestart: getNeedsRestart(s), online: reached(s) });
                }
            }
        }
        return noProject;
    };
    const activeNoProject = emitProjectGroups(activeSessions, listData);
    if (activeNoProject.length > 0) {
        listData.push({ type: 'active-sessions', sessions: activeNoProject });
    }

    // Group inactive sessions by date
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);

    let currentDateGroup: Session[] = [];
    let currentDateString: string | null = null;

    for (const session of inactiveSessions) {
        const sessionDate = new Date(session.updatedAt);
        const dateString = sessionDate.toDateString();

        if (currentDateString !== dateString) {
            // Process previous group
            if (currentDateGroup.length > 0 && currentDateString) {
                const groupDate = new Date(currentDateString);
                const sessionDateOnly = new Date(groupDate.getFullYear(), groupDate.getMonth(), groupDate.getDate());

                let headerTitle: string;
                if (sessionDateOnly.getTime() === today.getTime()) {
                    headerTitle = 'Today';
                } else if (sessionDateOnly.getTime() === yesterday.getTime()) {
                    headerTitle = 'Yesterday';
                } else {
                    const diffTime = today.getTime() - sessionDateOnly.getTime();
                    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
                    headerTitle = `${diffDays} days ago`;
                }

                listData.push({ type: 'header', title: headerTitle });
                emitSessionGroup(currentDateGroup);
            }

            // Start new group
            currentDateString = dateString;
            currentDateGroup = [session];
        } else {
            currentDateGroup.push(session);
        }
    }

    // Process final group
    if (currentDateGroup.length > 0 && currentDateString) {
        const groupDate = new Date(currentDateString);
        const sessionDateOnly = new Date(groupDate.getFullYear(), groupDate.getMonth(), groupDate.getDate());

        let headerTitle: string;
        if (sessionDateOnly.getTime() === today.getTime()) {
            headerTitle = 'Today';
        } else if (sessionDateOnly.getTime() === yesterday.getTime()) {
            headerTitle = 'Yesterday';
        } else {
            const diffTime = today.getTime() - sessionDateOnly.getTime();
            const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
            headerTitle = `${diffDays} days ago`;
        }

        listData.push({ type: 'header', title: headerTitle });
        emitSessionGroup(currentDateGroup);
    }

    return listData;
}

/**
 * The two slices a machine's published addresses live in.
 *
 * Narrower than the whole store on purpose: these reducers are used both by the actions that take a
 * single parsed endpoint and by the log replay, which applies a blob of them as it walks a machine's
 * entries — and it must be the *same* rule in both, or the same claim would mean two things
 * depending on which channel carried it.
 */
type EndpointSlices = Pick<StorageState, 'lanEndpoints' | 'relayEndpoints'>;

/** The change to make, or null when the endpoint says nothing new. */
function reduceLanEndpoint(
    state: EndpointSlices,
    machineId: string,
    endpoint: { baseUrls: string[]; at: number } | null,
): Partial<EndpointSlices> | null {
    const change = advanceLanEndpoint(state.lanEndpoints[machineId], endpoint);
    if (change.kind === 'none') return null;
    if (change.kind === 'clear') {
        const { [machineId]: _gone, ...rest } = state.lanEndpoints;
        return { lanEndpoints: rest };
    }
    return { lanEndpoints: { ...state.lanEndpoints, [machineId]: change.endpoint } };
}

function reduceRelayEndpoint(
    state: EndpointSlices,
    machineId: string,
    endpoint: RelayEndpoint | null,
): Partial<EndpointSlices> | null {
    const change = advanceRelayEndpoint(state.relayEndpoints[machineId], endpoint);
    if (change.kind !== 'set') return null;
    const next = { ...state.relayEndpoints, [machineId]: change.endpoint };
    saveRelayEndpoints(next);
    return { relayEndpoints: next };
}

/**
 * Folds what a machine published about where it can be reached into the slices that hold addresses.
 *
 * One entry point for all three carriers — the server's copy of the blob, the machine's own log, and
 * the relay's directory — because they are the same claim about the same machine. Which channel it
 * arrived on is not allowed to change what the App believes.
 */
function withPublishedEndpoints(state: EndpointSlices, machineId: string, blob: unknown): EndpointSlices {
    // Both reducers read only their own slice, so they are computed against the same state and
    // merged once — and each answers null when the claim says nothing new.
    const lan = reduceLanEndpoint(state, machineId, parseLanEndpoints(machineId, blob));
    const relay = reduceRelayEndpoint(state, machineId, parseRelayEndpoint(machineId, blob));
    // Nothing to change: the *identity* matters as much as the values, because a caller that gets a
    // new object back will treat the whole slice as having moved.
    if (lan === null && relay === null) {
        return state;
    }
    return { ...state, ...(lan ?? {}), ...(relay ?? {}) };
}

export const storage = create<StorageState>()((set, get) => {
    let { settings, version } = loadSettings();
    let localSettings = loadLocalSettings();
    let purchases = loadPurchases();
    let profile = loadProfile();
    let sessionDrafts = loadSessionDrafts();
    let sessionPermissionModes = loadSessionPermissionModes();
    let sessionModelModes = loadSessionModelModes();
    let sessionMaxModes = loadSessionMaxModes();
    return {
        settings,
        settingsVersion: version,
        localSettings,
        purchases,
        profile,
        sessions: {},
        machines: {},
        lanSightings: {},
        relayEndpoints: loadRelayEndpoints(),
        lanEndpoints: {},
        candidateHealth: {},
        relayDirectory: {},
        relayUnknownTags: [],
        relayHubConnected: false,
        daemonSockets: {},
        lifecycleCursors: {},
        lifecycleDeleted: {},
        daemonSessionList: {},
        daemonVersions: {},
        channelOverride: {},
        artifacts: {},  // Initialize artifacts
        friends: {},  // Initialize relationships cache
        users: {},  // Initialize global user cache
        feedItems: [],  // Initialize feed items list
        feedHead: null,
        feedTail: null,
        feedHasMore: false,
        feedLoaded: false,  // Initialize as false
        friendsLoaded: false,  // Initialize as false
        sessionsData: null,  // Legacy - to be removed
        sessionListViewData: null,
        sessionMessages: {},
        outbox: {},
        sessionGitStatus: {},
        realtimeStatus: 'disconnected',
        realtimeMode: 'idle',
        socketStatus: 'disconnected',
        socketLastConnectedAt: null,
        socketLastDisconnectedAt: null,
        isDataReady: false,
        nativeUpdateStatus: null,
        isMutableToolCall: (sessionId: string, callId: string) => {
            const sessionMessages = get().sessionMessages[sessionId];
            if (!sessionMessages) {
                return true;
            }
            const toolCall = sessionMessages.reducerState.toolIdToMessageId.get(callId);
            if (!toolCall) {
                return true;
            }
            const toolCallMessage = sessionMessages.messagesMap[toolCall];
            if (!toolCallMessage || toolCallMessage.kind !== 'tool-call') {
                return true;
            }
            return toolCallMessage.tool?.name ? isMutableTool(toolCallMessage.tool?.name) : true;
        },
        finalizeRunningTools: (sessionId: string) => set((state) => {
            const sessionMessages = state.sessionMessages[sessionId];
            if (!sessionMessages) return state;

            const now = Date.now();
            let anyChanged = false;
            const newMessagesMap = { ...sessionMessages.messagesMap };

            for (const [id, msg] of Object.entries(newMessagesMap)) {
                if (msg.kind === 'tool-call' && msg.tool?.state === 'running') {
                    newMessagesMap[id] = {
                        ...msg,
                        tool: { ...msg.tool, state: 'completed', completedAt: now },
                    };
                    // Mirror into reducerState so incremental processing stays consistent
                    const reducerMsg = sessionMessages.reducerState.messages.get(id);
                    if (reducerMsg?.tool) {
                        reducerMsg.tool.state = 'completed';
                        reducerMsg.tool.completedAt = now;
                    }
                    anyChanged = true;
                }
            }

            if (!anyChanged) return state;

            return {
                ...state,
                sessionMessages: {
                    ...state.sessionMessages,
                    [sessionId]: { ...sessionMessages, messagesMap: newMessagesMap },
                },
            };
        }),
        /**
         * After a successful lazy-content RPC fetch, replace the truncated tool input
         * with the full args and clear the lazyContent flag in both the message map
         * and the reducer state. Returns true when the message was found and updated.
         */
        resolveToolCallLazyContent: (sessionId: string, messageId: string, fullInput: Record<string, unknown>): boolean => {
            let updated = false;
            set((state) => {
                const sessionMessages = state.sessionMessages[sessionId];
                if (!sessionMessages) return state;

                const msg = sessionMessages.messagesMap[messageId];
                if (!msg || msg.kind !== 'tool-call') return state;

                const updatedTool = { ...msg.tool, input: fullInput, lazyContent: false };
                const updatedMsg = { ...msg, tool: updatedTool };

                // Mirror into reducerState so the next cache save persists the full content
                const reducerMsg = sessionMessages.reducerState.messages.get(messageId);
                if (reducerMsg?.tool) {
                    reducerMsg.tool.input = fullInput;
                    reducerMsg.tool.lazyContent = false;
                }

                updated = true;
                return {
                    ...state,
                    sessionMessages: {
                        ...state.sessionMessages,
                        [sessionId]: {
                            ...sessionMessages,
                            messagesMap: { ...sessionMessages.messagesMap, [messageId]: updatedMsg },
                            messages: sessionMessages.messages.map(m => m.id === messageId ? updatedMsg : m),
                        },
                    },
                };
            });
            return updated;
        },
        /**
         * After a successful lazy-content RPC fetch, replace the truncated tool result
         * with the full result and remove the _lazyResult marker. Returns true when updated.
         */
        resolveToolCallLazyResult: (sessionId: string, messageId: string, fullResult: unknown): boolean => {
            let updated = false;
            set((state) => {
                const sessionMessages = state.sessionMessages[sessionId];
                if (!sessionMessages) return state;

                const msg = sessionMessages.messagesMap[messageId];
                if (!msg || msg.kind !== 'tool-call') return state;

                const updatedTool = { ...msg.tool, result: fullResult };
                const updatedMsg = { ...msg, tool: updatedTool };

                const reducerMsg = sessionMessages.reducerState.messages.get(messageId);
                if (reducerMsg?.tool) {
                    reducerMsg.tool.result = fullResult;
                }

                updated = true;
                return {
                    ...state,
                    sessionMessages: {
                        ...state.sessionMessages,
                        [sessionId]: {
                            ...sessionMessages,
                            messagesMap: { ...sessionMessages.messagesMap, [messageId]: updatedMsg },
                            messages: sessionMessages.messages.map(m => m.id === messageId ? updatedMsg : m),
                        },
                    },
                };
            });
            return updated;
        },
        getActiveSessions: () => {
            const state = get();
            // "Active" here feeds the voice hooks — a session that has gone away, and one that has
            // come back — so it has to mean what the rest of the App means by online, not what the
            // server last managed to hear.
            const drivers = channelDrivers(state, state.localSettings.channelPriority);
            return Object.values(state.sessions).filter(s => resolveSessionReach(s.id, s.metadata?.machineId, drivers).online);
        },
        applySessions: (sessions: (Omit<Session, 'presence'> & { presence?: "online" | number })[], fullRefresh?: boolean) => set((state) => {
            // Drafts: only from MMKV on initial load. Permission/model: read MMKV every time so restart/refresh keeps selection (metadata first, then existing, then MMKV, then server).
            const savedDrafts = Object.keys(state.sessions).length === 0 ? sessionDrafts : {};
            const savedPermissionModes = loadSessionPermissionModes();
            const savedModelModes = loadSessionModelModes();
            const savedMaxModes = loadSessionMaxModes();
            const savedProfileIds = loadSessionProfileIds();
            const savedSandboxIsolations = loadSessionSandboxIsolations();

            // Full refresh: replace, don't merge — purges stale sessions deleted on server.
            // Delta refresh: merge new sessions into existing ones (current behavior).
            const mergedSessions: Record<string, Session> = fullRefresh ? {} : { ...state.sessions };

            // Update sessions with calculated presence using centralized resolver
            sessions.forEach(session => {
                // A machine's log is the closest thing there is to "this session is gone", and a
                // server that has not been told yet would offer it back on every fetch. Skipped
                // rather than deleted afterwards, so nothing downstream ever sees it return.
                if (state.lifecycleDeleted[session.id]) {
                    return;
                }
                // Use centralized resolver for consistent state management
                const presence = resolveSessionOnlineState(session);

                // Draft: existing || saved || session. Permission: same as model — user's explicit local choice
                // (existing/saved) takes priority over server-pushed metadata so an ACP permission change in the UI
                // is not immediately overwritten by config_options_update / current_mode_update from the agent.
                const existingDraft = fullRefresh ? undefined : state.sessions[session.id]?.draft;
                const savedDraft = savedDrafts[session.id];
                const existingPermissionMode = fullRefresh ? undefined : state.sessions[session.id]?.permissionMode;
                const savedPermissionMode = savedPermissionModes[session.id];
                const defaultPermissionMode: PermissionModeKey = isSandboxEnabled(session.metadata) ? 'bypassPermissions' : 'default';
                const metadataPermission = session.metadata?.currentOperatingModeCode?.trim();
                const resolvedPermissionMode: PermissionModeKey =
                    (existingPermissionMode && existingPermissionMode !== 'default' ? existingPermissionMode : undefined) ??
                    (savedPermissionMode && savedPermissionMode !== 'default' ? savedPermissionMode : undefined) ??
                    (metadataPermission && metadataPermission !== 'default' ? metadataPermission : undefined) ??
                    (session.permissionMode && session.permissionMode !== 'default' ? session.permissionMode : undefined) ??
                    (metadataPermission ? metadataPermission : undefined) ??
                    defaultPermissionMode;
                const existing = fullRefresh ? undefined : state.sessions[session.id];
                const metadataModel = session.metadata?.currentModelCode?.trim();
                const existingModelMode = existing?.modelMode;
                const savedModelMode = savedModelModes[session.id];
                // User's explicit local choice (existingModelMode / savedModelMode) takes priority over
                // server-pushed metadata so a model change in the UI is not immediately overwritten.
                // metadataModel (what the agent is currently running) is used only as a fallback.
                const resolvedModelMode = existingModelMode ?? savedModelMode ?? (metadataModel && metadataModel !== '' ? metadataModel : undefined) ?? session.modelMode ?? undefined;
                const existingMaxMode = existing?.maxMode;
                const savedMaxMode = savedMaxModes[session.id];
                const metadataMaxMode = session.metadata?.currentMaxMode;
                const resolvedMaxMode =
                    existingMaxMode !== undefined && existingMaxMode !== null
                        ? existingMaxMode
                        : savedMaxMode !== undefined
                            ? savedMaxMode
                            : metadataMaxMode !== undefined
                                ? metadataMaxMode
                                : session.maxMode ?? undefined;
                const existingProfileId = existing?.profileId;
                const savedProfileId = savedProfileIds[session.id];
                // '__none__' sentinel means user explicitly chose 'No Profile'.
                // Do NOT fall back to metadata in that case.
                const savedIsNone = savedProfileId === '__none__';
                const metadataProfileId = savedIsNone ? undefined : (session.metadata?.profileId ?? undefined);
                const resolvedProfileId = existingProfileId ?? metadataProfileId ?? (savedIsNone ? null : savedProfileId) ?? session.profileId ?? undefined;
                // Sandbox isolation: local preference > metadata
                const existingSandboxIsolation = state.sessions[session.id]?.sandboxIsolation;
                const savedSandboxIsolation = savedSandboxIsolations[session.id];
                const metadataSandboxIsolation = session.metadata?.currentSandboxIsolation
                    ?? (isSandboxEnabled(session.metadata)
                        ? (session.metadata?.sandbox as Record<string, unknown> | null)?.sessionIsolation as string | undefined
                        : undefined);
                const resolvedSandboxIsolation = existingSandboxIsolation ?? savedSandboxIsolation ?? metadataSandboxIsolation ?? undefined;
                // todos: derived by replay (reducer) when messages load; not synced to server. Preserve here so
                // list fetches do not overwrite; replay will update session.todos when that session's messages load.
                const existingTodos = existing?.todos;
                const resolvedTodos = existingTodos ?? session.todos ?? undefined;
                // Not from the server at all: this is what the machine pushed over its own channel,
                // and a sessions fetch carries no opinion about it — so a fetch keeps what is held,
                // or the field would be wiped every time one ran, and a restart lasts longer than
                // the gap between fetches.
                //
                // The payload wins when it *does* have an opinion, which is how a push is carried
                // in: including an explicit null, which is the machine calling a restart off. Reading
                // it the other way round would make that clear arrive and be ignored.
                const resolvedRestartingAt = session.restartingAt !== undefined
                    ? session.restartingAt
                    : existing?.restartingAt ?? null;

                mergedSessions[session.id] = {
                    ...session,
                    presence,
                    draft: existingDraft || savedDraft || session.draft || null,
                    permissionMode: resolvedPermissionMode,
                    modelMode: resolvedModelMode,
                    maxMode: resolvedMaxMode,
                    profileId: resolvedProfileId,
                    sandboxIsolation: resolvedSandboxIsolation,
                    todos: resolvedTodos,
                    restartingAt: resolvedRestartingAt
                };
            });

            // Build active set from all sessions (including existing ones), by the same answer the
            // rows are drawn from: this is what puts a session above the "offline" divider in the
            // list, and the server's flag alone put one there while the LAN was serving it.
            const drivers = channelDrivers(state, state.localSettings.channelPriority);
            const activeSet = new Set<string>();
            Object.values(mergedSessions).forEach(session => {
                if (resolveSessionReach(session.id, session.metadata?.machineId, drivers).online) {
                    activeSet.add(session.id);
                }
            });

            // Separate active and inactive sessions
            const activeSessions: Session[] = [];
            const inactiveSessions: Session[] = [];

            // Process all sessions from merged set
            Object.values(mergedSessions).forEach(session => {
                if (activeSet.has(session.id)) {
                    activeSessions.push(session);
                } else {
                    inactiveSessions.push(session);
                }
            });

            // Sort both arrays by creation date for stable ordering
            activeSessions.sort((a, b) => b.createdAt - a.createdAt);
            inactiveSessions.sort((a, b) => b.createdAt - a.createdAt);

            // Build flat list data for FlashList
            const listData: SessionListItem[] = [];

            if (activeSessions.length > 0) {
                listData.push('online');
                listData.push(...activeSessions);
            }

            // Legacy sessionsData - to be removed
            // Machines are now integrated into sessionListViewData

            if (inactiveSessions.length > 0) {
                listData.push('offline');
                listData.push(...inactiveSessions);
            }

            // console.log(`📊 Storage: applySessions called with ${sessions.length} sessions, active: ${activeSessions.length}, inactive: ${inactiveSessions.length}`);

            // Process AgentState updates for sessions that already have messages loaded
            const updatedSessionMessages = { ...state.sessionMessages };

            sessions.forEach(session => {
                // On full refresh, old state doesn't exist; skip AgentState diff.
                const oldSession = fullRefresh ? undefined : state.sessions[session.id];
                const newSession = mergedSessions[session.id];

                // Check if sessionMessages exists AND agentStateVersion is newer
                const existingSessionMessages = updatedSessionMessages[session.id];
                if (existingSessionMessages && newSession.agentState &&
                    (!oldSession || newSession.agentStateVersion > (oldSession.agentStateVersion || 0))) {

                    // Check for NEW permission requests before processing
                    const currentRealtimeSessionId = getCurrentRealtimeSessionId();
                    const voiceSession = getVoiceSession();

                    // console.log('[REALTIME DEBUG] Permission check:', {
                    //     currentRealtimeSessionId,
                    //     sessionId: session.id,
                    //     match: currentRealtimeSessionId === session.id,
                    //     hasVoiceSession: !!voiceSession,
                    //     oldRequests: Object.keys(oldSession?.agentState?.requests || {}),
                    //     newRequests: Object.keys(newSession.agentState?.requests || {})
                    // });

                    if (currentRealtimeSessionId === session.id && voiceSession) {
                        const oldRequests = oldSession?.agentState?.requests || {};
                        const newRequests = newSession.agentState?.requests || {};

                        // Find NEW permission requests only
                        for (const [requestId, request] of Object.entries(newRequests)) {
                            if (!oldRequests[requestId]) {
                                // This is a NEW permission request
                                const toolName = request.tool;
                                // console.log('[REALTIME DEBUG] Sending permission notification for:', toolName);
                                voiceSession.sendTextMessage(
                                    `Claude is requesting permission to use the ${toolName} tool`
                                );
                            }
                        }
                    }

                    // If the agent state cleared all requests (turn end / mode switch),
                    // cancel any stale pending-permission messages. Only trigger on a
                    // real transition: previously had requests → now empty.
                    const oldRequestCnt = Object.keys(oldSession?.agentState?.requests ?? {}).length;
                    const newRequestCnt = Object.keys(newSession.agentState?.requests ?? {}).length;
                    if (oldRequestCnt > 0 && newRequestCnt === 0) {
                        for (const msg of Object.values(existingSessionMessages.messagesMap)) {
                            if (msg.kind === 'tool-call' && msg.tool?.permission?.status === 'pending') {
                                msg.tool.permission.status = 'canceled';
                            }
                        }
                    }

                    // Process new AgentState through reducer
                    const reducerResult = reducer(existingSessionMessages.reducerState, [], newSession.agentState);
                    const processedMessages = reducerResult.messages;

                    // Always update the session messages, even if no new messages were created
                    // This ensures the reducer state is updated with the new AgentState
                    const mergedMessagesMap = { ...existingSessionMessages.messagesMap };
                    processedMessages.forEach(message => {
                        mergedMessagesMap[message.id] = message;
                    });

                    const messagesArray = Object.values(mergedMessagesMap)
                        .sort((a, b) => b.createdAt - a.createdAt);

                    updatedSessionMessages[session.id] = {
                        messages: messagesArray,
                        messagesMap: mergedMessagesMap,
                        reducerState: existingSessionMessages.reducerState,
                        isLoaded: existingSessionMessages.isLoaded,
                        oldestSeq: existingSessionMessages.oldestSeq,
                        newestSeq: existingSessionMessages.newestSeq,
                        cachedBitmap: existingSessionMessages.cachedBitmap,
                        hasOlderMessages: existingSessionMessages.hasOlderMessages,
                        isLoadingOlder: existingSessionMessages.isLoadingOlder,
                        isFetching: existingSessionMessages.isFetching,
                    };

                    // IMPORTANT: Copy latestUsage from reducerState to Session for immediate availability
                    if (existingSessionMessages.reducerState.latestUsage) {
                        mergedSessions[session.id] = {
                            ...mergedSessions[session.id],
                            latestUsage: { ...existingSessionMessages.reducerState.latestUsage }
                        };
                    }
                }
            });

            // Build new unified list view data
            const sessionListViewData = buildSessionListViewData(
                mergedSessions,
                state.machines,
                state.daemonVersions,
                channelDrivers(state, state.localSettings.channelPriority),
            );

            // Update project manager with current sessions and machines
            const machineMetadataMap = new Map<string, any>();
            Object.values(state.machines).forEach(machine => {
                if (machine.metadata) {
                    machineMetadataMap.set(machine.id, machine.metadata);
                }
            });
            projectManager.updateSessions(Object.values(mergedSessions), machineMetadataMap);

            return {
                ...state,
                sessions: mergedSessions,
                sessionsData: listData,  // Legacy - to be removed
                sessionListViewData,
                sessionMessages: updatedSessionMessages
            };
        }),
        applyLoaded: () => set((state) => {
            const result = {
                ...state,
                sessionsData: []
            };
            return result;
        }),
        applyReady: () => set((state) => ({
            ...state,
            isDataReady: true,
            // If the sessions list hasn't been populated yet (cold start, no cache),
            // initialize to an empty array so the UI doesn't show the loading spinner.
            sessionListViewData: state.sessionListViewData ?? [],
        })),
        applyMessages: (sessionId: string, messages: NormalizedMessage[]) => {
            bump('storeWrites');
            bump('messagesApplied', messages.length);
            let changed = new Set<string>();
            let hasReadyEvent = false;
            set((state) => {

                // Resolve session messages state
                const existingSession = state.sessionMessages[sessionId] || {
                    messages: [],
                    messagesMap: {},
                    reducerState: createReducer(),
                    isLoaded: false,
                    oldestSeq: 0,
                    newestSeq: 0,
                    cachedBitmap: 0,
                    hasOlderMessages: false,
                    isLoadingOlder: false,
                    isFetching: false,
                };

                // Get the session's agentState if available
                const session = state.sessions[sessionId];
                const agentState = session?.agentState;

                // Messages are already normalized, no need to process them again
                const normalizedMessages = messages;

                // Run reducer with agentState
                const reducerResult = reducer(existingSession.reducerState, normalizedMessages, agentState);
                const processedMessages = reducerResult.messages;
                // Use reducer's own changed set (only newly created messages, not all messages)
                for (const id of reducerResult.changed) {
                    changed.add(id);
                }
                if (reducerResult.hasReadyEvent) {
                    hasReadyEvent = true;
                }

                // Merge messages
                const mergedMessagesMap = { ...existingSession.messagesMap };
                processedMessages.forEach(message => {
                    mergedMessagesMap[message.id] = message;
                });

                // Convert to array and sort by createdAt
                const messagesArray = Object.values(mergedMessagesMap)
                    .sort((a, b) => b.createdAt - a.createdAt);

                // Update session with todos and latestUsage
                // IMPORTANT: We extract latestUsage from the mutable reducerState and copy it to the Session object
                // This ensures latestUsage is available immediately on load, even before messages are fully loaded
                let updatedSessions = state.sessions;
                const needsUpdate = (reducerResult.todos !== undefined || reducerResult.tasks !== undefined || existingSession.reducerState.latestUsage) && session;

                if (needsUpdate) {
                    updatedSessions = {
                        ...state.sessions,
                        [sessionId]: {
                            ...session,
                            ...(reducerResult.todos !== undefined && { todos: reducerResult.todos }),
                            ...(reducerResult.tasks !== undefined && { tasks: reducerResult.tasks }),
                            // Copy latestUsage from reducerState to make it immediately available
                            latestUsage: existingSession.reducerState.latestUsage ? {
                                ...existingSession.reducerState.latestUsage
                            } : session.latestUsage
                        }
                    };
                }

                return {
                    ...state,
                    sessions: updatedSessions,
                    sessionMessages: {
                        ...state.sessionMessages,
                        [sessionId]: {
                            ...existingSession,
                            messages: messagesArray,
                            messagesMap: mergedMessagesMap,
                            reducerState: existingSession.reducerState, // Explicitly include the mutated reducer state
                            isLoaded: true
                        }
                    }
                };
            });

            return { changed: Array.from(changed), hasReadyEvent };
        },
        applyMessagesLoaded: (sessionId: string) => set((state) => {
            const existingSession = state.sessionMessages[sessionId];
            let result: StorageState;

                if (!existingSession) {
                    // First time loading - check for AgentState
                    const session = state.sessions[sessionId];
                    const agentState = session?.agentState;

                    // Create new reducer state
                    const reducerState = createReducer();

                    // Process AgentState if it exists
                    let messages: Message[] = [];
                    let messagesMap: Record<string, Message> = {};

                    if (agentState) {
                        // Process AgentState through reducer to get initial permission messages
                        const reducerResult = reducer(reducerState, [], agentState);
                        const processedMessages = reducerResult.messages;

                        processedMessages.forEach(message => {
                            messagesMap[message.id] = message;
                        });

                        messages = Object.values(messagesMap)
                            .sort((a, b) => b.createdAt - a.createdAt);
                    }

                    // Extract latestUsage from reducerState if available and update session
                    let updatedSessions = state.sessions;
                    if (session && reducerState.latestUsage) {
                        updatedSessions = {
                            ...state.sessions,
                            [sessionId]: {
                                ...session,
                                latestUsage: { ...reducerState.latestUsage }
                            }
                        };
                    }

                    result = {
                        ...state,
                        sessions: updatedSessions,
                        sessionMessages: {
                            ...state.sessionMessages,
                            [sessionId]: {
                                reducerState,
                                messages,
                                messagesMap,
                                isLoaded: true,
                                oldestSeq: 0,
                                newestSeq: 0,
                                cachedBitmap: 0,
                                hasOlderMessages: false,
                                isLoadingOlder: false,
                                isFetching: false,
                            } satisfies SessionMessages
                        }
                    };
                } else {
                    result = {
                        ...state,
                        sessionMessages: {
                            ...state.sessionMessages,
                            [sessionId]: {
                                ...existingSession,
                                isLoaded: true,
                                isFetching: false,
                            } satisfies SessionMessages
                        }
                    };
                }

            return result;
        }),
        setFetching: (sessionId: string, fetching: boolean) => set((state) => {
            const existing = state.sessionMessages[sessionId];
            if (!existing) return state;
            return {
                ...state,
                sessionMessages: {
                    ...state.sessionMessages,
                    [sessionId]: { ...existing, isFetching: fetching },
                },
            };
        }),
        applyHydratedCache: (sessionId: string, messages: Message[], reducerState: ReducerState, oldestSeq: number, hasOlderMessages: boolean, lastSeq: number) => set((state) => {
            const messagesMap: Record<string, Message> = {};
            for (const msg of messages) {
                messagesMap[msg.id] = msg;
            }
            const sorted = [...messages].sort((a, b) => b.createdAt - a.createdAt);
            const totalSeq = state.sessions[sessionId]?.seq ?? 0;
            const cachedBitmap = computeBitmap(oldestSeq, lastSeq, totalSeq);

            return {
                ...state,
                sessionMessages: {
                    ...state.sessionMessages,
                    [sessionId]: {
                        messages: sorted,
                        messagesMap,
                        reducerState,
                        isLoaded: true,
                        oldestSeq,
                        newestSeq: lastSeq,
                        cachedBitmap,
                        hasOlderMessages,
                        isLoadingOlder: false,
                        isFetching: false,
                    } satisfies SessionMessages,
                },
            };
        }),
        applyWindow: (sessionId: string, messages: NormalizedMessage[], oldestSeq: number, newestSeq: number, hasOlderMessages: boolean) => set((state) => {
            bump('storeWrites');
            bump('messagesApplied', messages.length);
            const session = state.sessions[sessionId];
            const held = state.sessionMessages[sessionId];

            // The page MERGES into whatever is held rather than replacing it. A channel is a
            // source, and no source has the right to discard messages this App already showed —
            // the replace shape was what made a fresh daemon's short log shrink a long
            // server-sourced window ("switched channels and the conversation got shorter and
            // older"). Identity is `localId` where there is one (the field every delivery agrees
            // on) and the delivery id otherwise; a page carrying nothing new leaves the window
            // exactly as it was instead of rolling it back.
            // The merge result when it took the append-only fast path, for the reducer decision
            // below; `as unknown as` because `Message` and `NormalizedMessage` differ only in
            // which fields are optional, and the merge treats both as `Identified`.
            let appendOnlyMerge: ReturnType<typeof mergePageIntoWindow<{ id: string }>> | null = null;
            if (held && held.messages.length > 0) {
                const merged = mergePageIntoWindow(held.messages as unknown as Message[], messages as unknown as Message[]);
                const mergedOldest = held.oldestSeq > 0 && oldestSeq > 0
                    ? Math.min(held.oldestSeq, oldestSeq)
                    : Math.max(held.oldestSeq, oldestSeq);
                const mergedNewest = Math.max(held.newestSeq, newestSeq);
                const mergedHasOlder = held.hasOlderMessages || hasOlderMessages;
                if (!merged && mergedOldest === held.oldestSeq && mergedNewest === held.newestSeq && mergedHasOlder === held.hasOlderMessages) {
                    // Nothing this page carries is new, and the edges did not move.
                    return state;
                }
                if (merged) {
                    messages = merged.messages as unknown as NormalizedMessage[];
                    // Append-only pages (everything the page added is at or after the window's
                    // newest) can run through the held reducer state; anything else falls back
                    // to the full rebuild below.
                    const heldNewestAt = held.messages.length > 0 ? held.messages[0].createdAt : Infinity;
                    if (merged.added.every((message) => (message.createdAt ?? 0) >= heldNewestAt)) {
                        appendOnlyMerge = merged;
                    }
                }
                oldestSeq = mergedOldest;
                newestSeq = mergedNewest;
                hasOlderMessages = mergedHasOlder;
            }
            // The state the reducer starts from, and the messages it is asked to process. The
            // common case — a follow read whose page is entirely newer than what is held — runs
            // only the added subset through the HELD reducer state: the same thing the append
            // path has always done, and what keeps an active session's read cycle from
            // re-reducing a hundred-and-fifty messages to learn about three new ones. A page
            // that interleaves with what is held keeps the full rebuild below: the reducer is a
            // sequence processor, and out-of-order entries against a state that never saw their
            // neighbours is how tool states go wrong.
            let reducerState: ReducerState = createReducer();
            let reduceInput = messages;
            if (appendOnlyMerge && appendOnlyMerge !== null) {
                reducerState = held.reducerState;
                reduceInput = appendOnlyMerge.added as unknown as NormalizedMessage[];
            }
            const reducerResult = reducer(reducerState, reduceInput, session?.agentState ?? undefined);

            // The incremental path starts from what is already held and overlays what the reducer
            // produced for the added messages — exactly what `applyMessages` does for an append.
            // Building the map from the reducer's output alone collapses the window: a run over
            // an *added subset* returns that subset, not the projection of everything held, so
            // the screen would show only the newest few messages and nothing else.
            const messagesMap: Record<string, Message> = appendOnlyMerge && held ? { ...held.messagesMap } : {};
            for (const msg of reducerResult.messages) {
                messagesMap[msg.id] = msg;
            }
            const sorted = Object.values(messagesMap).sort((a, b) => b.createdAt - a.createdAt);
            const totalSeq = session?.seq ?? 0;
            const cachedBitmap = computeBitmap(oldestSeq, newestSeq, totalSeq);

            return {
                ...state,
                sessionMessages: {
                    ...state.sessionMessages,
                    [sessionId]: {
                        messages: sorted,
                        messagesMap,
                        reducerState,
                        isLoaded: true,
                        oldestSeq,
                        newestSeq,
                        cachedBitmap,
                        hasOlderMessages,
                        isLoadingOlder: false,
                        isFetching: false,
                    } satisfies SessionMessages,
                },
            };
        }),
        setNewestSeq: (sessionId: string, newestSeq: number) => set((state) => {
            const existing = state.sessionMessages[sessionId];
            if (!existing) return state;
            const newNewestSeq = Math.max(existing.newestSeq, newestSeq);
            // Unchanged means no state to write: returning a new object here re-rendered every
            // subscriber, including the message list, to show exactly what it already showed.
            if (newNewestSeq === existing.newestSeq) return state;
            const totalSeq = state.sessions[sessionId]?.seq ?? 0;
            const cachedBitmap = computeBitmap(existing.oldestSeq, newNewestSeq, totalSeq);
            return {
                ...state,
                sessionMessages: {
                    ...state.sessionMessages,
                    [sessionId]: { ...existing, newestSeq: newNewestSeq, cachedBitmap },
                },
            };
        }),
        applyOlderMessages: (sessionId: string, olderMessages: NormalizedMessage[], newOldestSeq: number, hasOlderMessages: boolean) => set((state) => {
            const existing = state.sessionMessages[sessionId];
            if (!existing) return state;
            // The window is often patched with an empty batch (a read that establishes the floor
            // without adding messages); when that changes nothing, the state does not change either.
            if (olderMessages.length === 0 && existing.oldestSeq === newOldestSeq && existing.hasOlderMessages === hasOlderMessages) {
                return state;
            }

            // Run a fresh temporary reducer on just the older batch.
            // The main reducerState is left intact so incremental (new) messages keep working.
            const tempReducer = createReducer();
            const session = state.sessions[sessionId];
            const reducerResult = reducer(tempReducer, olderMessages, session?.agentState ?? undefined);

            const mergedMap = { ...existing.messagesMap };
            for (const msg of reducerResult.messages) {
                // Only add if not already present – never overwrite newer rendered versions
                if (!mergedMap[msg.id]) {
                    mergedMap[msg.id] = msg;
                }
            }

            const sorted = Object.values(mergedMap).sort((a, b) => b.createdAt - a.createdAt);

            const totalSeq = state.sessions[sessionId]?.seq ?? 0;
            const cachedBitmap = computeBitmap(newOldestSeq, existing.newestSeq, totalSeq);

            return {
                ...state,
                sessionMessages: {
                    ...state.sessionMessages,
                    [sessionId]: {
                        ...existing,
                        messages: sorted,
                        messagesMap: mergedMap,
                        oldestSeq: newOldestSeq,
                        cachedBitmap,
                        hasOlderMessages,
                        isLoadingOlder: false,
                        isFetching: false,
                    } satisfies SessionMessages,
                },
            };
        }),
        setLoadingOlder: (sessionId: string, loading: boolean) => set((state) => {
            const existing = state.sessionMessages[sessionId];
            if (!existing) return state;
            return {
                ...state,
                sessionMessages: {
                    ...state.sessionMessages,
                    [sessionId]: { ...existing, isLoadingOlder: loading },
                },
            };
        }),
        applySettingsLocal: (settings: Partial<Settings>) => set((state) => {
            saveSettings(applySettings(state.settings, settings), state.settingsVersion ?? 0);
            return {
                ...state,
                settings: applySettings(state.settings, settings)
            };
        }),
        applySettings: (settings: Settings, version: number) => set((state) => {
            if (state.settingsVersion === null || state.settingsVersion < version) {
                saveSettings(settings, version);
                return {
                    ...state,
                    settings,
                    settingsVersion: version
                };
            } else {
                return state;
            }
        }),
        applyLocalSettings: (delta: Partial<LocalSettings>) => set((state) => {
            const updatedLocalSettings = applyLocalSettings(state.localSettings, delta);
            saveLocalSettings(updatedLocalSettings);
            return {
                ...state,
                localSettings: updatedLocalSettings
            };
        }),
        applyPurchases: (customerInfo: CustomerInfo) => set((state) => {
            // Transform CustomerInfo to our Purchases format
            const purchases = customerInfoToPurchases(customerInfo);

            // Always save and update - no need for version checks
            savePurchases(purchases);
            return {
                ...state,
                purchases
            };
        }),
        applyProfile: (profile: Profile) => set((state) => {
            // Always save and update profile
            saveProfile(profile);
            return {
                ...state,
                profile
            };
        }),
        applyGitStatus: (sessionId: string, status: GitStatus | null) => set((state) => {
            // Update project git status as well
            projectManager.updateSessionProjectGitStatus(sessionId, status);

            return {
                ...state,
                sessionGitStatus: {
                    ...state.sessionGitStatus,
                    [sessionId]: status
                }
            };
        }),
        applyNativeUpdateStatus: (status: { available: boolean; updateUrl?: string } | null) => set((state) => ({
            ...state,
            nativeUpdateStatus: status
        })),
        setRealtimeStatus: (status: 'disconnected' | 'connecting' | 'connected' | 'error') => set((state) => ({
            ...state,
            realtimeStatus: status
        })),
        setRealtimeMode: (mode: 'idle' | 'speaking', immediate?: boolean) => {
            if (immediate) {
                // Clear any pending debounce and set immediately
                if (realtimeModeDebounceTimer) {
                    clearTimeout(realtimeModeDebounceTimer);
                    realtimeModeDebounceTimer = null;
                }
                set((state) => ({ ...state, realtimeMode: mode }));
            } else {
                // Debounce mode changes to avoid flickering
                if (realtimeModeDebounceTimer) {
                    clearTimeout(realtimeModeDebounceTimer);
                }
                realtimeModeDebounceTimer = setTimeout(() => {
                    realtimeModeDebounceTimer = null;
                    set((state) => ({ ...state, realtimeMode: mode }));
                }, REALTIME_MODE_DEBOUNCE_MS);
            }
        },
        clearRealtimeModeDebounce: () => {
            if (realtimeModeDebounceTimer) {
                clearTimeout(realtimeModeDebounceTimer);
                realtimeModeDebounceTimer = null;
            }
        },
        setSocketStatus: (status: 'disconnected' | 'connecting' | 'connected' | 'error' | 'auth_error') => set((state) => {
            const now = Date.now();
            const updates: Partial<StorageState> = {
                socketStatus: status
            };

            // Update timestamp based on status
            if (status === 'connected') {
                updates.socketLastConnectedAt = now;
            } else if (status === 'disconnected' || status === 'error') {
                updates.socketLastDisconnectedAt = now;
            }

            return {
                ...state,
                ...updates
            };
        }),
        updateSessionDraft: (sessionId: string, draft: string | null) => set((state) => {
            const session = state.sessions[sessionId];
            if (!session) return state;

            // Don't store empty strings, convert to null
            const normalizedDraft = draft?.trim() ? draft : null;

            // Collect all drafts for persistence
            const allDrafts: Record<string, string> = {};
            Object.entries(state.sessions).forEach(([id, sess]) => {
                if (id === sessionId) {
                    if (normalizedDraft) {
                        allDrafts[id] = normalizedDraft;
                    }
                } else if (sess.draft) {
                    allDrafts[id] = sess.draft;
                }
            });

            // Persist drafts
            saveSessionDrafts(allDrafts);

            const updatedSessions = {
                ...state.sessions,
                [sessionId]: {
                    ...session,
                    draft: normalizedDraft
                }
            };

            // Rebuild sessionListViewData to update the UI immediately
            const sessionListViewData = buildSessionListViewData(
                updatedSessions,
                state.machines,
                            state.daemonVersions,
                            channelDrivers(state, state.localSettings.channelPriority),
            );

            return {
                ...state,
                sessions: updatedSessions,
                sessionListViewData
            };
        }),
        updateSessionPermissionMode: (sessionId: string, mode: string) => set((state) => {
            const session = state.sessions[sessionId];
            if (!session) return state;

            const updatedSessions = {
                ...state.sessions,
                [sessionId]: {
                    ...session,
                    permissionMode: mode
                }
            };
            const allModes: Record<string, string> = {};
            Object.entries(updatedSessions).forEach(([id, sess]) => {
                if (sess.permissionMode && sess.permissionMode !== 'default') {
                    allModes[id] = sess.permissionMode;
                }
            });
            saveSessionPermissionModes(allModes);

            return {
                ...state,
                sessions: updatedSessions
            };
        }),
        updateSessionModelMode: (sessionId: string, mode: string) => set((state) => {
            const session = state.sessions[sessionId];
            if (!session) return state;

            const updatedSessions = {
                ...state.sessions,
                [sessionId]: {
                    ...session,
                    modelMode: mode
                }
            };
            const allModelModes: Record<string, string> = {};
            Object.entries(updatedSessions).forEach(([id, sess]) => {
                if (sess.modelMode != null && sess.modelMode !== '') {
                    allModelModes[id] = sess.modelMode;
                }
            });
            saveSessionModelModes(allModelModes);

            return {
                ...state,
                sessions: updatedSessions
            };
        }),
        clearSessionModelMode: (sessionId: string) => set((state) => {
            const session = state.sessions[sessionId];
            if (!session) return state;

            // Clear persisted override so the next applySessions uses CLI's metadata.currentModelCode
            const modelModes = loadSessionModelModes();
            delete modelModes[sessionId];
            saveSessionModelModes(modelModes);

            return {
                ...state,
                sessions: {
                    ...state.sessions,
                    [sessionId]: { ...session, modelMode: undefined }
                }
            };
        }),
        updateSessionMaxMode: (sessionId: string, maxMode: boolean) => set((state) => {
            const session = state.sessions[sessionId];
            if (!session) return state;

            const updatedSessions = {
                ...state.sessions,
                [sessionId]: {
                    ...session,
                    maxMode,
                },
            };
            const allMaxModes: Record<string, boolean> = {};
            Object.entries(updatedSessions).forEach(([id, sess]) => {
                if (sess.maxMode !== undefined && sess.maxMode !== null) {
                    allMaxModes[id] = sess.maxMode;
                }
            });
            saveSessionMaxModes(allMaxModes);

            return {
                ...state,
                sessions: updatedSessions,
            };
        }),
        clearSessionMaxMode: (sessionId: string) => set((state) => {
            const session = state.sessions[sessionId];
            if (!session) return state;

            const maxModes = loadSessionMaxModes();
            delete maxModes[sessionId];
            saveSessionMaxModes(maxModes);

            return {
                ...state,
                sessions: {
                    ...state.sessions,
                    [sessionId]: { ...session, maxMode: undefined },
                },
            };
        }),
        updateSessionThinkingLevel: (sessionId: string, level: 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null) => set((state) => {
            const session = state.sessions[sessionId];
            if (!session) return state;

            return {
                ...state,
                sessions: {
                    ...state.sessions,
                    [sessionId]: {
                        ...session,
                        thinkingLevel: level ?? undefined,
                    },
                },
            };
        }),
        clearSessionThinkingLevel: (sessionId: string) => set((state) => {
            const session = state.sessions[sessionId];
            if (!session) return state;

            return {
                ...state,
                sessions: {
                    ...state.sessions,
                    [sessionId]: { ...session, thinkingLevel: undefined },
                },
            };
        }),
        updateSessionProfileId: (sessionId: string, profileId: string | null) => set((state) => {
            const session = state.sessions[sessionId];

            // Persist to MMKV. '__none__' sentinel for explicit "No Profile" choice.
            const profileIds = loadSessionProfileIds();
            if (profileId !== null) {
                profileIds[sessionId] = profileId;
            } else {
                profileIds[sessionId] = '__none__';
            }
            saveSessionProfileIds(profileIds);

            if (!session) return state;

            return {
                ...state,
                sessions: {
                    ...state.sessions,
                    [sessionId]: {
                        ...session,
                        profileId: profileId ?? undefined,
                    },
                },
            };
        }),
        clearSessionProfileId: (sessionId: string) => set((state) => {
            const session = state.sessions[sessionId];

            // Always clear MMKV so it doesn't leak a stale entry.
            const profileIds = loadSessionProfileIds();
            delete profileIds[sessionId];
            saveSessionProfileIds(profileIds);

            if (!session) return state;

            return {
                ...state,
                sessions: {
                    ...state.sessions,
                    [sessionId]: { ...session, profileId: undefined },
                },
            };
        }),
        releaseSessionProfileId: (sessionId: string) => set((state) => {
            const session = state.sessions[sessionId];
            if (!session) return state;

            // Only clear in-memory state — keep MMKV for cold-start fallback.
            // remote (metadata.profileId) will win on next applySessions resolution.
            return {
                ...state,
                sessions: {
                    ...state.sessions,
                    [sessionId]: { ...session, profileId: undefined },
                },
            };
        }),
        updateSessionSandboxIsolation: (sessionId: string, isolation: string) => set((state) => {
            const session = state.sessions[sessionId];
            if (!session) return state;

            const updatedSessions = {
                ...state.sessions,
                [sessionId]: {
                    ...session,
                    sandboxIsolation: isolation
                }
            };
            const allIsolations: Record<string, string> = {};
            Object.entries(updatedSessions).forEach(([id, sess]) => {
                if (sess.sandboxIsolation && sess.sandboxIsolation !== 'off') {
                    allIsolations[id] = sess.sandboxIsolation;
                }
            });
            saveSessionSandboxIsolations(allIsolations);

            return {
                ...state,
                sessions: updatedSessions
            };
        }),
        clearSessionSandboxIsolation: (sessionId: string) => set((state) => {
            const session = state.sessions[sessionId];
            if (!session) return state;

            // Clear in-memory and MMKV
            const updatedSessions = {
                ...state.sessions,
                [sessionId]: {
                    ...session,
                    sandboxIsolation: undefined
                }
            };
            const allIsolations: Record<string, string> = {};
            Object.entries(updatedSessions).forEach(([id, sess]) => {
                if (sess.sandboxIsolation && sess.sandboxIsolation !== 'off') {
                    allIsolations[id] = sess.sandboxIsolation;
                }
            });
            saveSessionSandboxIsolations(allIsolations);

            return {
                ...state,
                sessions: updatedSessions
            };
        }),
        releaseSessionSandboxIsolation: (sessionId: string) => set((state) => {
            const session = state.sessions[sessionId];
            if (!session) return state;

            // Only clear in-memory — keep MMKV for cold-start fallback.
            // remote (metadata.currentSandboxIsolation) will win on next applySessions resolution.
            return {
                ...state,
                sessions: {
                    ...state.sessions,
                    [sessionId]: { ...session, sandboxIsolation: undefined },
                },
            };
        }),
        // Project management methods
        getProjects: () => projectManager.getProjects(),
        getProject: (projectId: string) => projectManager.getProject(projectId),
        getProjectForSession: (sessionId: string) => projectManager.getProjectForSession(sessionId),
        getProjectSessions: (projectId: string) => projectManager.getProjectSessions(projectId),
        // Project git status methods
        getProjectGitStatus: (projectId: string) => projectManager.getProjectGitStatus(projectId),
        getSessionProjectGitStatus: (sessionId: string) => projectManager.getSessionProjectGitStatus(sessionId),
        updateSessionProjectGitStatus: (sessionId: string, status: GitStatus | null) => {
            projectManager.updateSessionProjectGitStatus(sessionId, status);
            // Trigger a state update to notify hooks
            set((state) => ({ ...state }));
        },
        applyMachines: (machines: Machine[], replace: boolean = false) => set((state) => {
            // Either replace all machines or merge updates
            let mergedMachines: Record<string, Machine>;

            if (replace) {
                // Replace entire machine state (used by fetchMachines)
                mergedMachines = {};
                machines.forEach(machine => {
                    mergedMachines[machine.id] = machine;
                });
            } else {
                // Merge individual updates (used by update-machine)
                mergedMachines = { ...state.machines };
                machines.forEach(machine => {
                    mergedMachines[machine.id] = machine;
                });
            }

            // Rebuild sessionListViewData to reflect machine changes
            const sessionListViewData = buildSessionListViewData(
                state.sessions,
                state.machines,
                            state.daemonVersions,
                            channelDrivers(state, state.localSettings.channelPriority),
            );

            return {
                ...state,
                machines: mergedMachines,
                sessionListViewData
            };
        }),
        setDaemonSocketStatus: (id, status) => set((state) => {
            const previous = state.daemonSockets[id];
            // A publish that says the same thing is not a change. `publish` builds a fresh object
            // on every call, and during a retrying connection it is called once per transition on
            // top of the ones that changed nothing — each one used to wake the list rebuild below.
            if (previous
                && previous.phase === status.phase
                && previous.baseUrl === status.baseUrl
                && previous.attempt === status.attempt
                && previous.retryAt === status.retryAt
                && previous.connectedAt === status.connectedAt) {
                return state;
            }
            return { daemonSockets: { ...state.daemonSockets, [id]: status } };
        }),
        clearLanSightings: () => set((state) => (Object.keys(state.lanSightings).length === 0 ? state : { ...state, lanSightings: {} })),
        // Replaced wholesale, unlike the LAN's sightings: the relay is answering a question rather
        // than reporting one observation, so what it leaves out is genuinely gone — a machine that
        // dropped is *not* still reachable, and carrying its entry over would keep offering a
        // connection that cannot be made.
        applyRelayDirectory: (entries, unknownTags) => set((state) => {
            const next: Record<string, RelayDirectoryEntry> = {};
            for (const entry of entries) {
                next[entry.machineId] = entry;
            }
            return { ...state, relayDirectory: next, relayUnknownTags: unknownTags };
        }),
        setRelayHubConnected: (connected) => set((state) => (
            state.relayHubConnected === connected ? state : { ...state, relayHubConnected: connected }
        )),
        applyRelayEndpoint: (machineId, endpoint) => set((state) => reduceRelayEndpoint(state, machineId, endpoint) ?? state),
        applyLanEndpoint: (machineId, endpoint) => set((state) => reduceLanEndpoint(state, machineId, endpoint) ?? state),
        candidateSucceeded: (machineId, route, baseUrl) => set((state) => {
            const key = candidateKey(machineId, route, baseUrl);
            const held = state.candidateHealth[key];
            // Every read writes its outcome, and a read at an address that was already proven says
            // nothing new. Without this, every poll is a store update, and every store update that
            // touches what the list depends on is a full rebuild of it.
            if (held?.phase === 'live' && held.failures === 0) {
                return state;
            }
            return { candidateHealth: { ...state.candidateHealth, [key]: candidateSucceeded(held, Date.now()) } };
        }),
        candidateFailed: (machineId, route, baseUrl) => set((state) => {
            const key = candidateKey(machineId, route, baseUrl);
            const held = state.candidateHealth[key];
            const health = candidateFailedAt(held, Date.now());
            // The dwell swallows a failure inside it, and a swallowed failure must not be a write
            // either: the same reasoning as above, one layer down.
            if (held && health.phase === held.phase && health.failures === held.failures
                && health.since === held.since && health.retryAt === held.retryAt) {
                return state;
            }
            return { candidateHealth: { ...state.candidateHealth, [key]: health } };
        }),
        rearmCandidateHealth: () => set((state) => (
            Object.keys(state.candidateHealth).length === 0
                ? state
                : { candidateHealth: rearmAll(state.candidateHealth, Date.now()) }
        )),
        applyLanSightings: (sightings: LanSighting[]) => set((state) => {
            const now = Date.now();
            const next: Record<string, LanSighting> = {};
            // Carry over recent sightings a scan didn't report: mDNS is lossy, and dropping a
            // machine on a single missed scan would make the list flicker between lan and offline.
            for (const [id, sighting] of Object.entries(state.lanSightings)) {
                if (now - sighting.at < LAN_SIGHTING_TTL_MS) {
                    next[id] = sighting;
                }
            }
            for (const sighting of sightings) {
                next[sighting.machineId] = sighting;
            }
            return { ...state, lanSightings: next };
        }),
        applyDaemonVersion: (machineId: string, versions: { running: string; onDisk: string | null; restartRequired: boolean } | null) => set((state) => {
            const at = Date.now();
            if (versions === null) {
                if (!(machineId in state.daemonVersions)) return state;
                const next = { ...state.daemonVersions };
                delete next[machineId];
                return { ...state, daemonVersions: next };
            }
            const daemonVersions = { ...state.daemonVersions, [machineId]: { ...versions, at } };
            // The list is built by an action, not by a selector, so nothing else recomputes it when
            // this arrives — and the row's restart mark is decided inside that build. Recording a
            // version without rebuilding the list would leave the mark computed from a snapshot in
            // which the machine had never answered.
            return {
                ...state,
                daemonVersions,
                sessionListViewData: buildSessionListViewData(
                    state.sessions,
                    state.machines,
                    daemonVersions,
                    channelDrivers(state, state.localSettings.channelPriority),
                ),
            };
        }),
        applyLifecycle: (machineId, revision, entries) => set((state) => {
            const cursor = { ...state.lifecycleCursors, [machineId]: revision };
            if (entries.length === 0) {
                // A cursor that moved without entries is a reader with nothing to do; recording it
                // keeps the next ask as small as this one was.
                return state.lifecycleCursors[machineId] === revision ? state : { ...state, lifecycleCursors: cursor };
            }
            const sessions = { ...state.sessions };
            const deleted = { ...state.lifecycleDeleted };
            // Addresses travel in this log too, so they are applied by the same walk, at the same
            // point in the sequence, under the same cursor: a machine that moves is one entry, and a
            // reader that applied it does not need to be told again.
            let endpoints: EndpointSlices = state;
            for (const entry of entries) {
                if (entry.op === 'reachable') {
                    endpoints = withPublishedEndpoints(endpoints, machineId, { p2p: { endpoints: entry.endpoints, at: entry.at } });
                    continue;
                }
                const key = entry.sessionId ?? entry.tag;
                if (entry.op === 'deleted') {
                    // Both names are remembered, not just removed: the tag's placeholder goes with
                    // the id — an entry that named both is one session under two names — and either
                    // name coming back from the server is what this refuses to re-add.
                    delete sessions[key];
                    delete sessions[entry.tag];
                    deleted[key] = entry.at;
                    deleted[entry.tag] = entry.at;
                    continue;
                }
                // The server's copy is richer than anything buildable from a log entry, so it wins
                // wherever it already exists — this is here for what the server has not said.
                if (!sessions[key]) {
                    sessions[key] = {
                        id: key,
                        seq: 0,
                        createdAt: entry.at,
                        updatedAt: entry.at,
                        // Not active: nothing has reported it as running. What the machine has said
                        // is that the session exists, and that is all this row claims.
                        active: false,
                        activeAt: entry.at,
                        metadata: {
                            // The sentinel this App already renders as a localized "Creating…"
                            // rather than as a path, for a session that exists but is not ready.
                            path: '\u200bcreating\u200b',
                            host: '',
                            machineId,
                            ...(entry.directory ? { worktreePath: entry.directory } : {}),
                        } as any,
                        metadataVersion: 0,
                        agentState: null,
                        agentStateVersion: 0,
                        thinking: false,
                        thinkingAt: 0,
                        presence: entry.at,
                    };
                }
            }
            return {
                ...state,
                ...endpoints,
                sessions,
                lifecycleDeleted: deleted,
                lifecycleCursors: cursor,
                // The list is built by an action, so a session that arrived without the server has
                // to be built into it here — the same reason the restart mark rebuilds.
                sessionListViewData: buildSessionListViewData(
                    sessions,
                    state.machines,
                    state.daemonVersions,
                    channelDrivers(state, state.localSettings.channelPriority),
                ),
            };
        }),
        applyDaemonSessionList: (sessions: { happySessionId: string; isAlive: boolean; directory: string; agent: string; via: DaemonRoute; restartingSince?: number }[] | null) => set((state) => {
            if (sessions === null) {
                if (Object.keys(state.daemonSessionList).length === 0) {
                    return state;
                }
                return { ...state, daemonSessionList: {} };
            }
            const at = Date.now();
            const next: Record<string, { isAlive: boolean; directory: string; agent: string; via: DaemonRoute; at: number; restartingSince?: number }> = {};
            // The same fact the daemon pushes, arriving the other way: a device that reads a
            // listing instead of holding a socket has to be told, and a restarting session is
            // listed with no live process — which is why the field travels with the listing at all.
            const withRestarts = { ...state.sessions };
            for (const session of sessions) {
                next[session.happySessionId] = {
                    isAlive: session.isAlive,
                    directory: session.directory,
                    agent: session.agent,
                    via: session.via,
                    at,
                    ...(session.restartingSince !== undefined ? { restartingSince: session.restartingSince } : {}),
                };
                const known = withRestarts[session.happySessionId];
                if (known && session.restartingSince !== undefined) {
                    withRestarts[session.happySessionId] = { ...known, restartingAt: session.restartingSince };
                }
            }
            return { ...state, sessions: withRestarts, daemonSessionList: next };
        }),
        setSessionChannelOverride: (sessionId: string, channel: SessionChannel | null) => set((state) => {
            if (channel === null) {
                if (!(sessionId in state.channelOverride)) {
                    return state;
                }
                const { [sessionId]: _cleared, ...rest } = state.channelOverride;
                return { ...state, channelOverride: rest };
            }
            return { ...state, channelOverride: { ...state.channelOverride, [sessionId]: channel } };
        }),
        // Artifact methods
        applyArtifacts: (artifacts: DecryptedArtifact[]) => set((state) => {
            console.log(`🗂️ Storage.applyArtifacts: Applying ${artifacts.length} artifacts`);
            const mergedArtifacts = { ...state.artifacts };
            artifacts.forEach(artifact => {
                mergedArtifacts[artifact.id] = artifact;
            });
            console.log(`🗂️ Storage.applyArtifacts: Total artifacts after merge: ${Object.keys(mergedArtifacts).length}`);
            
            return {
                ...state,
                artifacts: mergedArtifacts
            };
        }),
        addArtifact: (artifact: DecryptedArtifact) => set((state) => {
            const updatedArtifacts = {
                ...state.artifacts,
                [artifact.id]: artifact
            };
            
            return {
                ...state,
                artifacts: updatedArtifacts
            };
        }),
        updateArtifact: (artifact: DecryptedArtifact) => set((state) => {
            const updatedArtifacts = {
                ...state.artifacts,
                [artifact.id]: artifact
            };
            
            return {
                ...state,
                artifacts: updatedArtifacts
            };
        }),
        deleteArtifact: (artifactId: string) => set((state) => {
            const { [artifactId]: _, ...remainingArtifacts } = state.artifacts;
            
            return {
                ...state,
                artifacts: remainingArtifacts
            };
        }),
        deleteSessionMessages: (sessionId: string) => set((state) => {
            const { [sessionId]: _deleted, ...remaining } = state.sessionMessages;
            return { ...state, sessionMessages: remaining };
        }),
        deleteSession: (sessionId: string) => set((state) => {
            // Remove session from sessions
            const { [sessionId]: deletedSession, ...remainingSessions } = state.sessions;
            
            // Remove session messages if they exist
            const { [sessionId]: deletedMessages, ...remainingSessionMessages } = state.sessionMessages;
            
            // Remove session git status if it exists
            const { [sessionId]: deletedGitStatus, ...remainingGitStatus } = state.sessionGitStatus;
            
            // Clear drafts and permission/model from MMKV
            const drafts = loadSessionDrafts();
            delete drafts[sessionId];
            saveSessionDrafts(drafts);
            const modes = loadSessionPermissionModes();
            delete modes[sessionId];
            saveSessionPermissionModes(modes);
            const modelModes = loadSessionModelModes();
            delete modelModes[sessionId];
            saveSessionModelModes(modelModes);
            const maxModes = loadSessionMaxModes();
            delete maxModes[sessionId];
            saveSessionMaxModes(maxModes);
            const profileIds = loadSessionProfileIds();
            delete profileIds[sessionId];
            saveSessionProfileIds(profileIds);

            // Rebuild sessionListViewData without the deleted session
            const sessionListViewData = buildSessionListViewData(remainingSessions, state.machines, state.daemonVersions, channelDrivers(state, state.localSettings.channelPriority));
            
            return {
                ...state,
                sessions: remainingSessions,
                sessionMessages: remainingSessionMessages,
                sessionGitStatus: remainingGitStatus,
                sessionListViewData
            };
        }),
        // Outbox (send status tracking)
        addOutboxEntry: (entry: Omit<OutboxEntry, 'status'>) => set((state) => ({
            ...state,
            outbox: { ...state.outbox, [entry.localId]: { ...entry, status: 'sending' } },
        })),
        removeOutboxEntry: (localId: string) => set((state) => {
            const { [localId]: _, ...rest } = state.outbox;
            return { ...state, outbox: rest };
        }),
        markOutboxMessageAcked: (localId: string) => set((state) => {
            const entry = state.outbox[localId];
            if (!entry) return state;
            return { ...state, outbox: { ...state.outbox, [localId]: { ...entry, status: 'acked' as const } } };
        }),
        markOutboxMessageDelivered: (localId: string) => set((state) => {
            const entry = state.outbox[localId];
            if (!entry) return state;
            return { ...state, outbox: { ...state.outbox, [localId]: { ...entry, status: 'delivered' as const } } };
        }),
        removeOutboxEntriesForSession: (sessionId: string) => set((state) => {
            const updated = { ...state.outbox };
            let changed = false;
            for (const key of Object.keys(updated)) {
                if (updated[key].sessionId === sessionId && (updated[key].status === 'sending' || updated[key].status === 'acked')) {
                    delete updated[key];
                    changed = true;
                }
            }
            return changed ? { ...state, outbox: updated } : state;
        }),
        failOutboxEntries: (localIds: string[], reason: string) => set((state) => {
            const updated = { ...state.outbox };
            for (const localId of localIds) {
                if (updated[localId]) {
                    updated[localId] = { ...updated[localId], status: 'failed', failReason: reason };
                }
            }
            return { ...state, outbox: updated };
        }),
        // Friend management methods
        applyFriends: (friends: UserProfile[]) => set((state) => {
            const mergedFriends = { ...state.friends };
            friends.forEach(friend => {
                mergedFriends[friend.id] = friend;
            });
            return {
                ...state,
                friends: mergedFriends,
                friendsLoaded: true  // Mark as loaded after first fetch
            };
        }),
        applyRelationshipUpdate: (event: RelationshipUpdatedEvent) => set((state) => {
            const { fromUserId, toUserId, status, action, fromUser, toUser } = event;
            const currentUserId = state.profile.id;
            
            // Update friends cache
            const updatedFriends = { ...state.friends };
            
            // Determine which user profile to update based on perspective
            const otherUserId = fromUserId === currentUserId ? toUserId : fromUserId;
            const otherUser = fromUserId === currentUserId ? toUser : fromUser;
            
            if (action === 'deleted' || status === 'none') {
                // Remove from friends if deleted or status is none
                delete updatedFriends[otherUserId];
            } else if (otherUser) {
                // Update or add the user profile with current status
                updatedFriends[otherUserId] = otherUser;
            }
            
            return {
                ...state,
                friends: updatedFriends
            };
        }),
        getFriend: (userId: string) => {
            return get().friends[userId];
        },
        getAcceptedFriends: () => {
            const friends = get().friends;
            return Object.values(friends).filter(friend => friend.status === 'friend');
        },
        // User cache methods
        applyUsers: (users: Record<string, UserProfile | null>) => set((state) => ({
            ...state,
            users: { ...state.users, ...users }
        })),
        getUser: (userId: string) => {
            return get().users[userId];  // Returns UserProfile | null | undefined
        },
        assumeUsers: async (userIds: string[]) => {
            // This will be implemented in sync.ts as it needs access to credentials
            // Just a placeholder here for the interface
            const { sync } = await import('./sync');
            return sync.assumeUsers(userIds);
        },
        // Feed methods
        applyFeedItems: (items: FeedItem[]) => set((state) => {
            // Always mark feed as loaded even if empty
            if (items.length === 0) {
                return {
                    ...state,
                    feedLoaded: true  // Mark as loaded even when empty
                };
            }

            // Create a map of existing items for quick lookup
            const existingMap = new Map<string, FeedItem>();
            state.feedItems.forEach(item => {
                existingMap.set(item.id, item);
            });

            // Process new items
            const updatedItems = [...state.feedItems];
            let head = state.feedHead;
            let tail = state.feedTail;

            items.forEach(newItem => {
                // Remove items with same repeatKey if it exists
                if (newItem.repeatKey) {
                    const indexToRemove = updatedItems.findIndex(item =>
                        item.repeatKey === newItem.repeatKey
                    );
                    if (indexToRemove !== -1) {
                        updatedItems.splice(indexToRemove, 1);
                    }
                }

                // Add new item if it doesn't exist
                if (!existingMap.has(newItem.id)) {
                    updatedItems.push(newItem);
                }

                // Update head/tail cursors
                if (!head || newItem.counter > parseInt(head.substring(2), 10)) {
                    head = newItem.cursor;
                }
                if (!tail || newItem.counter < parseInt(tail.substring(2), 10)) {
                    tail = newItem.cursor;
                }
            });

            // Sort by counter (desc - newest first)
            updatedItems.sort((a, b) => b.counter - a.counter);

            return {
                ...state,
                feedItems: updatedItems,
                feedHead: head,
                feedTail: tail,
                feedLoaded: true  // Mark as loaded after first fetch
            };
        }),
        clearFeed: () => set((state) => ({
            ...state,
            feedItems: [],
            feedHead: null,
            feedTail: null,
            feedHasMore: false,
            feedLoaded: false,  // Reset loading flag
            friendsLoaded: false  // Reset loading flag
        })),
    }
});

/**
 * Keeps the list view data in step with what it is built from.
 *
 * The list is built by hand, inside whichever action remembered to build it, so a change that
 * arrived by a path nobody thought about — a session update delivered over the daemon channel, say
 * — left the rows showing whatever they were last built with. That is how a session that had just
 * been restarted kept its "restart needed" mark: the state was new, the list was old.
 *
 * Every writer is covered here instead of one at a time. The inputs are compared by
 * identity, so a rebuild that only writes the list does not trigger another one.
 *
 * The session's own restarting state rides on the sessions themselves, so a push that changes it
 * is already a change to one of these inputs. What a channel is reaching is not on a session, so
 * the channel state is compared here too — a LAN socket coming up is the difference between a row
 * that reads offline and the same row reading online.
 */
const builtFrom: {
    sessions: unknown;
    machines: unknown;
    daemonVersions: unknown;
    daemonSockets: unknown;
    lanSightings: unknown;
    relayDirectory: unknown;
    socketStatus: unknown;
    daemonSessionList: unknown;
    channelPriority: unknown;
    /**
     * What the list's channel-derived output is made of, for the last build.
     *
     * A channel write is not a list change unless an answer the list draws changed. `daemonSockets`
     * gets a new identity on every retry transition — opening, retrying, opening — and a
     * reconnecting channel can produce those several times a second. Rebuilding the whole list for
     * each one (and re-rendering every row with it) is what made the list unresponsive while a
     * channel was merely trying. This signature is the answers, so a transition nobody can see
     * costs nothing.
     */
    channelSignature: string | null;
} = {
    sessions: null,
    machines: null,
    daemonVersions: null,
    daemonSockets: null,
    lanSightings: null,
    relayDirectory: null,
    socketStatus: null,
    daemonSessionList: null,
    channelPriority: null,
    channelSignature: null,
};

/**
 * The part of the list that comes from channels, as one comparable string.
 *
 * Exactly the facts the list draws from them: for each session, whether anything is reaching it
 * and whether restarting it would change its build. Both are cheap reads — a few map lookups per
 * driver — which is what makes this cheaper than rebuilding the list to find out it is the same.
 */
function channelSignatureOf(state: {
    sessions: Record<string, Session>;
    machines: Record<string, { metadata?: { happyCliVersion?: string } | null; daemonState?: { startedWithCliVersion?: string } | null }>;
    daemonVersions: Record<string, { running: string; onDisk: string | null; restartRequired: boolean; at: number }>;
}, drivers: readonly ChannelDriver[]): string {
    const parts: string[] = [];
    for (const session of Object.values(state.sessions)) {
        const online = resolveSessionReach(session.id, session.metadata?.machineId, drivers).online ? '1' : '0';
        const restart = sessionNeedsRestart(session, state.machines, state.daemonVersions) ? '1' : '0';
        parts.push(`${session.id}:${online}:${restart}`);
    }
    parts.sort();
    return parts.join('|');
}

storage.subscribe((state) => {
    const contentChanged = builtFrom.sessions !== state.sessions
        || builtFrom.machines !== state.machines
        || builtFrom.daemonVersions !== state.daemonVersions;
    const channelChanged = builtFrom.daemonSockets !== state.daemonSockets
        || builtFrom.lanSightings !== state.lanSightings
        || builtFrom.relayDirectory !== state.relayDirectory
        || builtFrom.socketStatus !== state.socketStatus
        || builtFrom.daemonSessionList !== state.daemonSessionList
        || builtFrom.channelPriority !== state.localSettings.channelPriority;
    if (!contentChanged && !channelChanged) {
        return;
    }
    const drivers = channelDrivers(state, state.localSettings.channelPriority);
    const signature = channelSignatureOf(state, drivers);
    builtFrom.sessions = state.sessions;
    builtFrom.machines = state.machines;
    builtFrom.daemonVersions = state.daemonVersions;
    builtFrom.daemonSockets = state.daemonSockets;
    builtFrom.lanSightings = state.lanSightings;
    builtFrom.relayDirectory = state.relayDirectory;
    builtFrom.socketStatus = state.socketStatus;
    builtFrom.daemonSessionList = state.daemonSessionList;
    builtFrom.channelPriority = state.localSettings.channelPriority;
    const signatureChanged = signature !== builtFrom.channelSignature;
    builtFrom.channelSignature = signature;
    if (!contentChanged && !signatureChanged) {
        return;
    }
    storage.setState({
        sessionListViewData: buildSessionListViewData(
            state.sessions,
            state.machines,
            state.daemonVersions,
            drivers,
        ),
    });
});

export function useSessions() {
    return storage(useShallow((state) => state.isDataReady ? state.sessionsData : null));
}

export function useSession(id: string): Session | null {
    return storage(useShallow((state) => state.sessions[id] ?? null));
}

const emptyArray: unknown[] = [];

export function useOutboxEntry(localId: string | null | undefined): OutboxEntry | null {
    return storage((state) => (localId ? state.outbox[localId] ?? null : null));
}

export function useSessionMessages(sessionId: string): { messages: Message[], isLoaded: boolean, hasOlderMessages: boolean, isLoadingOlder: boolean, isFetching: boolean, oldestSeq: number, newestSeq: number, cachedBitmap: number } {
    return storage(useShallow((state) => {
        const session = state.sessionMessages[sessionId];
        return {
            messages: session?.messages ?? emptyArray as Message[],
            isLoaded: session?.isLoaded ?? false,
            hasOlderMessages: session?.hasOlderMessages ?? false,
            isLoadingOlder: session?.isLoadingOlder ?? false,
            isFetching: session?.isFetching ?? false,
            oldestSeq: session?.oldestSeq ?? 0,
            newestSeq: session?.newestSeq ?? 0,
            cachedBitmap: session?.cachedBitmap ?? 0,
        };
    }));
}

export function useSessionIsFetching(sessionId: string): boolean {
    return storage(state => state.sessionMessages[sessionId]?.isFetching ?? false);
}

export function useMessage(sessionId: string, messageId: string): Message | null {
    return storage(useShallow((state) => {
        const session = state.sessionMessages[sessionId];
        return session?.messagesMap[messageId] ?? null;
    }));
}

export function useSessionUsage(sessionId: string) {
    return storage(useShallow((state) => {
        const session = state.sessionMessages[sessionId];
        return session?.reducerState?.latestUsage ?? null;
    }));
}

export function useSettings(): Settings {
    return storage(useShallow((state) => state.settings));
}

export function useSettingMutable<K extends keyof Settings>(name: K): [Settings[K], (value: Settings[K]) => void] {
    const setValue = React.useCallback((value: Settings[K]) => {
        sync.applySettings({ [name]: value });
    }, [name]);
    const value = useSetting(name);
    return [value, setValue];
}

export function useSetting<K extends keyof Settings>(name: K): Settings[K] {
    return storage(useShallow((state) => state.settings[name]));
}

export function useLocalSettings(): LocalSettings {
    return storage(useShallow((state) => state.localSettings));
}

export function useAllMachines(): Machine[] {
    return storage(useShallow((state) => {
        if (!state.isDataReady) return [];
        return (Object.values(state.machines).sort((a, b) => b.createdAt - a.createdAt)).filter((v) => v.active);
    }));
}

export function useMachine(machineId: string): Machine | null {
    return storage(useShallow((state) => state.machines[machineId] ?? null));
}

/** Every machine the server has told this App about, by id. */
export function useMachines(): Record<string, Machine> {
    return storage(useShallow((state) => state.machines));
}

/**
 * Presence for every machine the app currently knows about, by machineId — the server's view
 * (`Machine.active`) joined with the LAN scanner's (`lanSightings`).
 *
 * Deliberately one map rather than a `useMachinePresence(machineId)` hook: the session list
 * renders host groups inside a map/switch, where a per-item hook call would break the rules of
 * hooks. Callers read this once and index into it.
 *
 * Machines known only through a LAN sighting are included, so a daemon we have no server record
 * for still resolves to `lan` instead of disappearing.
 */
/** Machines the LAN scanner can currently see, by machineId. */
/** Where machines publish themselves on this network; a second source beside the mDNS sightings. */
export function useLanEndpoints(): Record<string, { baseUrls: string[]; at: number }> {
    return storage(useShallow((state) => state.lanEndpoints));
}

export function useLanSightings(): Record<string, LanSighting> {
    return storage(useShallow((state) => state.lanSightings));
}

/**
 * The live socket on one daemon route, or null when none is open. Distinct from a sighting: a
 * sighting means a daemon is reachable, this means a channel to one is actually established.
 */
/** Everything that is connected (or trying to be), by `machineId:route`. */
/**
 * How this App is reaching this session right now: whether anything is, and over which channel.
 *
 * One answer for the whole app. Everything that draws a session or counts it asks this, so a badge,
 * a status line, a group's "2/3 online" and the sort order cannot disagree about the same session —
 * which they did, because each of them worked it out from the raw channel state on its own.
 */
/**
 * Whether anything is reaching this session — the only part of the reach a list row draws.
 *
 * Subscribing to the whole `SessionReach` made every row re-render whenever any channel report
 * changed `seenAt` (a timestamp that moves on each daemon/relay answer), even though a row shows
 * only the online bit. Measured on a device: ~40 rows at ~1.1 renders/s each, continuously, with
 * the JS thread starved for tens of seconds. A boolean selector re-renders a row only when the
 * answer actually changes.
 */
export function useSessionOnline(sessionId: string, machineId: string | undefined): boolean {
    return storage((state) => resolveSessionReach(
        sessionId,
        machineId,
        channelDrivers(state, state.localSettings.channelPriority),
        Date.now(),
    ).online);
}

export function useSessionReach(sessionId: string, machineId: string | undefined): SessionReach {
    return storage(useShallow((state) => resolveSessionReach(
        sessionId,
        machineId,
        channelDrivers(state, state.localSettings.channelPriority),
        Date.now(),
    )));
}

/** What each machine last said it is running. Empty until a machine has answered on a channel. */
/** How far each machine's lifecycle log has been replayed. */
export function useLifecycleCursors(): Record<string, number> {
    return storage(useShallow((state) => state.lifecycleCursors));
}

export function useDaemonVersions(): Record<string, { running: string; onDisk: string | null; restartRequired: boolean; at: number }> {
    return storage(useShallow((state) => state.daemonVersions));
}


export function useDaemonSockets(): Record<string, DaemonConnectionState> {
    return storage(useShallow((state) => state.daemonSockets));
}

/**
 * The connections over one route, by machineId.
 *
 * A route is a transport, so "is the LAN up?" is a question about the machines it reaches: several
 * may be connected at once, and, since the unit is the daemon, none of them is *the* LAN connection.
 */
export function daemonConnectionsOn(
    sockets: Record<string, DaemonConnectionState>,
    route: DaemonRoute
): Record<string, DaemonConnectionState> {
    const on: Record<string, DaemonConnectionState> = {};
    for (const [id, state] of Object.entries(sockets)) {
        if (state.route === route) {
            on[id] = state;
        }
    }
    return on;
}

/** What the relay is holding, by machineId, with the sessions each machine published. */
export function useRelayDirectory(): Record<string, RelayDirectoryEntry> {
    return storage(useShallow((state) => state.relayDirectory));
}

/** Tags the relay holds that this device has no key for. */
export function useRelayUnknownTags(): string[] {
    return storage(useShallow((state) => state.relayUnknownTags));
}

/** Whether the App's one relay connection is up. */
export function useRelayHubConnected(): boolean {
    return storage((state) => state.relayHubConnected);
}

/** Public relay routes per machine id; presence means the machine published one. */
export function useRelayEndpoints(): Record<string, RelayEndpoint> {
    return storage(useShallow((state) => state.relayEndpoints));
}

/** The manually forced channel for a session, or null for automatic. */
export function useSessionChannelOverride(sessionId: string): SessionChannel | null {
    return storage(useShallow((state) => state.channelOverride[sessionId] ?? null));
}

/** What a LAN daemon reported about its sessions; empty unless the server could not answer. */
export function useLanSessionList(): Record<string, { isAlive: boolean; directory: string; agent: string; at: number }> {
    return storage(useShallow((state) => state.daemonSessionList));
}

/**
 * Every machine the app knows, by machineId, WITHOUT the `active` filter `useAllMachines` applies.
 * The session list groups by machine, and a machine that is currently server-inactive (but perhaps
 * LAN-reachable) still needs its real name rather than a bare machineId.
 */
export function useMachinesMap(): Record<string, Machine> {
    return storage(useShallow((state) => state.machines));
}

/** How a machine is being reached right now, from the channels. */
export function useMachinePresence(machineId: string | undefined): MachinePresence {
    const presence = useMachinePresenceMap();
    return machineId ? presence[machineId] ?? 'offline' : 'offline';
}

export function useMachinePresenceMap(): Record<string, MachinePresence> {
    const machines = storage(useShallow((state) => state.machines));
    const channelState = storage(useShallow(selectChannelState));
    const priority = storage(useShallow((state) => state.localSettings.channelPriority));
    const previous = React.useRef<Record<string, MachinePresence>>({});
    const next = React.useMemo(() => {
        // The channels that are switched on, in the order this device prefers them — decided in one
        // place now instead of here, in the header and in the resolver, each slightly differently.
        const drivers = channelDrivers(channelState, priority);
        // A machine is listed if anything knows about it, including one the server has never heard
        // of: a daemon advertising on this network is a machine, and dropping it would be a machine
        // that exists everywhere except the list.
        const ids = new Set([
            ...Object.keys(machines),
            ...Object.keys(channelState.lanSightings),
            ...Object.keys(channelState.relayDirectory),
        ]);
        const map: Record<string, MachinePresence> = {};
        for (const id of ids) {
            map[id] = resolveMachinePresence(drivers, id);
        }
        return map;
    }, [machines, channelState, priority]);
    // A channel transition rebuilds this map even when no machine's answer moved — a socket going
    // from retrying to opening is a new `daemonSockets` object and the same presence for every
    // machine. Handing that new object to the list re-renders it for nothing, so the previous map
    // is kept whenever the answers are equal.
    return React.useMemo(() => {
        const keys = Object.keys(next);
        const same = keys.length === Object.keys(previous.current).length
            && keys.every((id) => previous.current[id] === next[id]);
        if (!same) {
            previous.current = next;
        }
        return previous.current;
    }, [next]);
}

/**
 * A builder for a machine's per-channel glyphs, from the channels themselves.
 *
 * A builder rather than a hook per machine, because both callers draw badges *inside* a list of
 * machines, where a hook cannot be called per row. One question, asked of the same drivers, from
 * whatever row is being drawn.
 */
export function useMachineBadgeInputs(): (machineId: string) => { reach: MachineReach; capability: MachineCapability; link: MachineLink } {
    const channelState = storage(useShallow(selectChannelState));
    const priority = storage(useShallow((state) => state.localSettings.channelPriority));
    return React.useCallback(
        (machineId: string) => machineBadgeInputs(channelDrivers(channelState, priority), machineId),
        [channelState, priority],
    );
}

export function useSessionListViewData(): SessionListViewItem[] | null {
    return storage((state) => state.isDataReady ? state.sessionListViewData : null);
}

export function useAllSessions(): Session[] {
    return storage(useShallow((state) => {
        if (!state.isDataReady) return [];
        return Object.values(state.sessions).sort((a, b) => b.updatedAt - a.updatedAt);
    }));
}

export function useLocalSettingMutable<K extends keyof LocalSettings>(name: K): [LocalSettings[K], (value: LocalSettings[K]) => void] {
    const setValue = React.useCallback((value: LocalSettings[K]) => {
        storage.getState().applyLocalSettings({ [name]: value });
    }, [name]);
    const value = useLocalSetting(name);
    return [value, setValue];
}

// Project management hooks
export function useProjects() {
    return storage(useShallow((state) => state.getProjects()));
}

export function useProject(projectId: string | null) {
    return storage(useShallow((state) => projectId ? state.getProject(projectId) : null));
}

export function useProjectForSession(sessionId: string | null) {
    return storage(useShallow((state) => sessionId ? state.getProjectForSession(sessionId) : null));
}

export function useProjectSessions(projectId: string | null) {
    return storage(useShallow((state) => projectId ? state.getProjectSessions(projectId) : []));
}

export function useProjectGitStatus(projectId: string | null) {
    return storage(useShallow((state) => projectId ? state.getProjectGitStatus(projectId) : null));
}

export function useSessionProjectGitStatus(sessionId: string | null) {
    return storage(useShallow((state) => sessionId ? state.getSessionProjectGitStatus(sessionId) : null));
}

export function useLocalSetting<K extends keyof LocalSettings>(name: K): LocalSettings[K] {
    return storage(useShallow((state) => state.localSettings[name]));
}

// Artifact hooks
export function useArtifacts(): DecryptedArtifact[] {
    return storage(useShallow((state) => {
        if (!state.isDataReady) return [];
        // Filter out draft artifacts from the main list
        return Object.values(state.artifacts)
            .filter(artifact => !artifact.draft)
            .sort((a, b) => b.updatedAt - a.updatedAt);
    }));
}

export function useAllArtifacts(): DecryptedArtifact[] {
    return storage(useShallow((state) => {
        if (!state.isDataReady) return [];
        // Return all artifacts including drafts
        return Object.values(state.artifacts).sort((a, b) => b.updatedAt - a.updatedAt);
    }));
}

export function useDraftArtifacts(): DecryptedArtifact[] {
    return storage(useShallow((state) => {
        if (!state.isDataReady) return [];
        // Return only draft artifacts
        return Object.values(state.artifacts)
            .filter(artifact => artifact.draft === true)
            .sort((a, b) => b.updatedAt - a.updatedAt);
    }));
}

export function useArtifact(artifactId: string): DecryptedArtifact | null {
    return storage(useShallow((state) => state.artifacts[artifactId] ?? null));
}

export function useArtifactsCount(): number {
    return storage(useShallow((state) => {
        // Count only non-draft artifacts
        return Object.values(state.artifacts).filter(a => !a.draft).length;
    }));
}

export function useEntitlement(id: KnownEntitlements): boolean {
    return storage(useShallow((state) => state.purchases.entitlements[id] ?? false));
}

export function useRealtimeStatus(): 'disconnected' | 'connecting' | 'connected' | 'error' {
    return storage(useShallow((state) => state.realtimeStatus));
}

export function useRealtimeMode(): 'idle' | 'speaking' {
    return storage(useShallow((state) => state.realtimeMode));
}


/**
 * The slice of the store every channel answer is built from.
 *
 * One selector rather than the same nine fields listed at each call site: what the drivers read is
 * a fact about the channel layer, and a hook that named a different subset would be answering from
 * a different picture of the same store.
 */
const selectChannelState = (state: StorageState): ChannelState => ({
    socketStatus: state.socketStatus,
    sessions: state.sessions,
    machines: state.machines,
    daemonSockets: state.daemonSockets,
    daemonSessionList: state.daemonSessionList,
    lanSightings: state.lanSightings,
    lanEndpoints: state.lanEndpoints,
    candidateHealth: state.candidateHealth,
    relayEndpoints: state.relayEndpoints,
    relayDirectory: state.relayDirectory,
    relayHubConnected: state.relayHubConnected,
});

/**
 * Per enabled channel, in priority order, how its link is doing. LAN is hidden until a daemon has
 * been discovered, since it only exists on the local network; the server and the relay always
 * show, grey when down.
 */
export function useChannelLinks(): { channel: SessionChannel; state: ChannelLinkState }[] {
    const priority = storage(useShallow((state) => state.localSettings.channelPriority));
    // Built from the same state every other channel answer is built from, so the header cannot say a
    // channel is up that the rest of the App would not use — which is what happened while it read
    // the store's fields itself and the resolver read its own.
    const channelState = storage(useShallow(selectChannelState));
    return React.useMemo(() => channelLinks(channelDrivers(channelState, priority)), [channelState, priority]);
}


export function useSocketStatus() {
    return storage(useShallow((state) => ({
        status: state.socketStatus,
        lastConnectedAt: state.socketLastConnectedAt,
        lastDisconnectedAt: state.socketLastDisconnectedAt
    })));
}

export function useSessionGitStatus(sessionId: string): GitStatus | null {
    return storage(useShallow((state) => state.sessionGitStatus[sessionId] ?? null));
}

export function useIsDataReady(): boolean {
    return storage(useShallow((state) => state.isDataReady));
}

export function useProfile() {
    return storage(useShallow((state) => state.profile));
}

export function useFriends() {
    return storage(useShallow((state) => state.friends));
}

export function useFriendRequests() {
    return storage(useShallow((state) => {
        // Filter friends to get pending requests (where status is 'pending')
        return Object.values(state.friends).filter(friend => friend.status === 'pending');
    }));
}

export function useAcceptedFriends() {
    return storage(useShallow((state) => {
        return Object.values(state.friends).filter(friend => friend.status === 'friend');
    }));
}

export function useFeedItems() {
    return storage(useShallow((state) => state.feedItems));
}
export function useFeedLoaded() {
    return storage((state) => state.feedLoaded);
}
export function useFriendsLoaded() {
    return storage((state) => state.friendsLoaded);
}

export function useFriend(userId: string | undefined) {
    return storage(useShallow((state) => userId ? state.friends[userId] : undefined));
}

export function useUser(userId: string | undefined) {
    return storage(useShallow((state) => userId ? state.users[userId] : undefined));
}

export function useRequestedFriends() {
    return storage(useShallow((state) => {
        // Filter friends to get sent requests (where status is 'requested')
        return Object.values(state.friends).filter(friend => friend.status === 'requested');
    }));
}
