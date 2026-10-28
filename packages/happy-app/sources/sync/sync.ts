import { readResponseTextCooperatively } from '@/utils/readBody';
import { yieldTask } from '@/utils/yieldTask';
import Constants from 'expo-constants';
import { apiSocket } from '@/sync/apiSocket';
import { AuthCredentials } from '@/auth/tokenStorage';
import { Encryption } from '@/sync/encryption/encryption';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { reinitSodium } from '@/encryption/libsodium';
import { storage } from './storage';
import { ApiEphemeralUpdateSchema, ApiMessage, ApiUpdateContainerSchema } from './apiTypes';
import type { ApiEphemeralActivityUpdate } from './apiTypes';
import { Session, Machine } from './storageTypes';
import type { GitStatus, Metadata } from './storageTypes';
import { InvalidateSync } from '@/utils/sync';
import { ActivityUpdateAccumulator } from './reducer/activityUpdateAccumulator';
import { randomUUID } from 'expo-crypto';
import * as Crypto from 'expo-crypto';
import { hmac_sha256 } from '@/encryption/hmac_sha256';
import sodium from '@/encryption/libsodium.lib';
import { relayBaseUrlFor, relayTagFor } from './lan/relayTag';
import * as Notifications from 'expo-notifications';
import * as Network from 'expo-network';
import { registerPushToken } from './apiPush';
import { Platform, AppState, InteractionManager, type AppStateStatus } from 'react-native';
import { isRunningOnMac, isRunningInTauri } from '@/utils/platform';
import { NormalizedMessage, normalizeRawMessage, RawRecord } from './typesRaw';
import type { MessageMeta } from './typesMessageMeta';
import { applySettings, Settings, settingsDefaults, settingsParse, SUPPORTED_SCHEMA_VERSION } from './settings';
import { Profile, profileParse } from './profile';
import { loadPendingSettings, savePendingSettings, loadWrappedMachineKeys, saveWrappedMachineKeys, loadLanWindows, saveLanWindows, type PersistedLanWindow } from './persistence';
import { initializeTracking, tracking } from '@/track';
import { parseToken } from '@/utils/parseToken';
import { RevenueCat, LogLevel, PaywallResult } from './revenueCat';
import { trackPaywallPresented, trackPaywallPurchased, trackPaywallCancelled, trackPaywallRestored, trackPaywallError } from '@/track';
import { getServerUrl } from './serverConfig';
import { config } from '@/config';
import { log } from '@/log';
import { gitStatusSync } from './gitStatusSync';
import { projectManager } from './projectManager';
import { AsyncLock } from '@/utils/lock';
import { voiceHooks } from '@/realtime/hooks/voiceHooks';
import { Message } from './typesMessage';
import { EncryptionCache } from './encryption/encryptionCache';
import { fetchIdentity, fetchLifecycle, LanRequestError, restartSessionAt, sessionControlAt, type LanRestartVerdict, type LifecycleEntry } from './lan/client';
import { accountProofHeaders } from '@/auth/accountProof';
import { getLanCredential } from './lan/credentials';
import { readSessionOverLan, listSessionsOverLan, toNormalizedMessages, type LanConnection, type LanSessionRead } from './lan/sessionChannel';
import { decryptLanEntries } from './lan/history';
import { SessionReadScheduler } from './sessionReadScheduler';
import { openLanSocket, type LanSocketHandle } from './lan/socket';
import { DEFAULT_RELAY_URL, RelayHub, relayHubUrl, relayOriginOf, type HubMachine, type SocketLike } from './lan/relayHub';
import type { RelayDirectoryEntry } from './lan/relayDirectory';
import { normalizeChannelPriority, pickChannel } from './lan/channelOrder';
import { channelEnabled, enabledChannels } from '@/utils/enabledChannels';
import { channelDrivers as buildChannelDrivers } from './channels/measure';
import { channelAvailability } from './channels/resolve';
import { candidateInputsFor, orderedCandidates } from './channels/candidates';
import { carryOperation, type HealthRecorder } from './channels/execute';
import { fetchToolContent } from './lan/client';
import { getToolCallFullContent as getToolCallFullContentFromServer, type GetToolCallFullContentResponse } from './ops';
import { readRoutes } from './channels/readRoute';
import { endpointBaseUrl, type ChannelDriver, type ChannelOperation } from './channels/types';
import { sendBatch, type SendResult } from './channels/ops';
import type { ChannelReason } from './channels/types';
import { FetchSlots } from './fetchSlots';
import { DaemonConnections, type DaemonTarget } from './lan/daemonConnections';
import { judgeDaemonPage, pageMovedTheLog, planDaemonRead } from './lan/windowPlan';
import type { DaemonRoute, LanSessionLogEntry, SessionChannel } from './lan/types';
import { parseLanEndpoints, parseRelayEndpoint } from './lan/relay';
import { fetchWithTimeout } from '@/utils/fetchWithTimeout';
import { systemPrompt } from './prompt/systemPrompt';
import { fetchArtifact, fetchArtifacts, createArtifact, updateArtifact } from './apiArtifacts';
import { DecryptedArtifact, Artifact, ArtifactCreateRequest, ArtifactUpdateRequest } from './artifactTypes';
import { ArtifactEncryption } from './encryption/artifactEncryption';
import { getFriendsList, getUserProfile } from './apiFriends';
import { fetchFeed } from './apiFeed';
import { FeedItem } from './feedTypes';
import { UserProfile } from './friendTypes';
import { resolveMessageModeMeta, resolveMessageProfileEnv } from './messageMeta';
import { loadMessageCache, saveMessageCache, clearMessageCache, clearAllMessageCaches, preloadSessionCacheDB, getCachedLastSeq } from './cache/messageCache';
import { mergePageIntoWindow } from './messageIdentity';
import { MAX_CACHED_MESSAGES } from './cache/limits';
import { preloadSessionsListCache, loadSessionsListCache, saveSessionsListCache, clearSessionsListCache } from './cache/sessionsListCache';
import { olderAfterSeq } from './cacheSegment';
import { overrideSessionCacheDB, IndexedDBSessionCacheDB } from './cache/sessionCacheDB';
import {
    getSessionThinkingPatchFromMessageContent,
    isSessionTurnStartMessageContent,
} from './sessionThinkingLifecycle';

type V3GetSessionMessagesResponse = {
    messages: ApiMessage[];
    hasMore: boolean;
};


type OutboxMessage = {
    localId: string;
    content: string;
};

/** Why a session is on the channel it is on; the UI turns these into words. */
/**
 * What the last daemon read of a session established: the connection it used, the anchor that
 * follows the log forward, and the one that walks back from the window it loaded. Runtime state
 * only — a restart reads the newest page and establishes all three again.
 */
type LanLink = {
    machineId: string;
    /** Boundary above the newest message held: follow the log forward from here. */
    cursor: string;
    /** Boundary below the oldest message held: read further back from here. */
    older: string;
    hasOlder: boolean;
    connection: LanConnection;
};

/**
 * A message's seq when it has one. Log entries written before the server acknowledged them carry
 * no seq, so the window's edges are best-effort on this channel — the anchors, not these, are what
 * daemon paging actually uses.
 */
const minSeqOf = (messages: { seq?: number }[]): number => {
    const seqs = messages.map((m) => m.seq).filter((seq): seq is number => seq !== undefined);
    return seqs.length > 0 ? Math.min(...seqs) : 0;
};

const maxSeqOf = (messages: { seq?: number }[]): number => {
    const seqs = messages.map((m) => m.seq).filter((seq): seq is number => seq !== undefined);
    return seqs.length > 0 ? Math.max(...seqs) : 0;
};

export type { ChannelReason } from './channels/types';

/**
 * Frame-level tracing for the update pipeline, off unless the dev page turns debug mode on.
 *
 * These fire per frame and per message; a busy session produces thousands a minute, and each line
 * also walks the logger's listener list — a re-render for whatever log view is open. Takes a thunk
 * so the payload is never serialised when tracing is off, which is the whole cost of the call.
 */
function traceUpdate(message: () => string): void {
    if (storage.getState().localSettings.debugMode) {
        log.log(message());
    }
}

/**
 * The evaluation of this module that currently owns the App.
 *
 * A hot reload constructs a new Sync while the previous one's objects are still reachable from
 * timers and listeners. Stopping the previous one at evaluation time covers the normal case; this
 * is the backstop for an instance that was missed — a stale scheduler tick checks it and stops
 * itself instead of scheduling reads no screen asked for.
 */
let activeSyncInstance: object | null = null;

class Sync {
    private static readonly BACKGROUND_SEND_TIMEOUT_MS = 30_000;
    private static readonly DESKTOP_SESSION_REFRESH_COOLDOWN_MS = 15_000;
    /** Minimum interval between full session list fetches (rate-limit). */
    private static readonly SESSION_REFRESH_COOLDOWN_MS = 30_000;
    /** Periodic fallback refresh interval when no events arrive. */
    private static readonly SESSION_REFRESH_INTERVAL_MS = 300_000; // 5 min
    /** Interval between full (non-delta) session list refreshes to clean up stale cache. */
    private static readonly FULL_REFRESH_INTERVAL_MS = 600_000; // 10 min
    /**
     * How often machines the server channel is carrying are asked what build they run.
     *
     * Deliberately far apart. This is the one question the App cannot be told the answer to — a
     * rebuild on disk is invisible until someone asks — and the answer changes only when a person
     * changes it, so the cost of being late is a restart mark that appears a few minutes later,
     * against a poll that would otherwise be permanent.
     */
    private static readonly MACHINE_VERSION_SWEEP_MS = 10 * 60_000;
    /** Ignore stale ephemeral thinking=false shortly after turn-start (debounced session-alive). */
    private static readonly TURN_START_EPHEMERAL_GRACE_MS = 8_000;

    // ---- Fetch instrumentation ----
    private fetchMetrics = {
        count: 0,
        totalMs: 0,
        errors: 0,
        byPath: new Map<string, { count: number; totalMs: number; errors: number }>(),
    };
    private lastFetchMetricsLog = Date.now();
    private static readonly FETCH_METRICS_LOG_INTERVAL_MS = 60_000; // log summary every 60s

    /** Wrapper that instruments a fetch call and logs periodic summaries. */
    private async instrumentedFetch(url: string, init?: RequestInit): Promise<Response> {
        const t0 = performance.now();
        // Tauri's @tauri-apps/plugin-http uses reqwest with no default timeout.
        // Add a 30s deadline to prevent hung connections from stalling the app.
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30_000);
        const signal = controller.signal;
        if (init?.signal) {
            init.signal.addEventListener('abort', () => controller.abort(), { once: true });
        }
        let response: Response;
        try {
            response = await fetch(url, { ...init, signal });
        } catch (e) {
            clearTimeout(timeoutId);
            this.fetchMetrics.count++;
            this.fetchMetrics.errors++;
            const path = this.fetchMetricsPath(url);
            const p = this.fetchMetrics.byPath.get(path) ?? { count: 0, totalMs: 0, errors: 0 };
            p.count++; p.errors++;
            this.fetchMetrics.byPath.set(path, p);
            throw e;
        }
        clearTimeout(timeoutId);
        const elapsed = Math.round(performance.now() - t0);
        this.fetchMetrics.count++;
        this.fetchMetrics.totalMs += elapsed;
        const path = this.fetchMetricsPath(url);
        const p = this.fetchMetrics.byPath.get(path) ?? { count: 0, totalMs: 0, errors: 0 };
        p.count++; p.totalMs += elapsed;
        if (!response.ok) p.errors++;
        this.fetchMetrics.byPath.set(path, p);

        // Periodic summary
        if (Date.now() - this.lastFetchMetricsLog >= Sync.FETCH_METRICS_LOG_INTERVAL_MS) {
            this.lastFetchMetricsLog = Date.now();
            const lines: string[] = [
                `📊 HTTP stats (${Math.round((Date.now() - this.lastFetchMetricsLog + Sync.FETCH_METRICS_LOG_INTERVAL_MS) / 1000)}s window):`,
            ];
            for (const [path, m] of this.fetchMetrics.byPath) {
                const avg = Math.round(m.totalMs / m.count);
                lines.push(`  ${path}: ${m.count} req, avg ${avg}ms, ${m.errors} err`);
            }
            console.warn(lines.join('\n'));
        }

        return response;
    }

    private fetchMetricsPath(url: string): string {
        try { return new URL(url).pathname.replace(/\/[a-zA-Z0-9_-]{20,}/g, '/:id'); } catch { return url; }
    }
    // ---- End fetch instrumentation ----
    encryption!: Encryption;
    serverID!: string;
    anonID!: string;
    private credentials!: AuthCredentials;
    public encryptionCache = new EncryptionCache();
    private sessionsSync: InvalidateSync;
    private messagesSync = new Map<string, InvalidateSync>();
    private sendSync = new Map<string, InvalidateSync>();
    private sendAbortControllers = new Map<string, AbortController>();
    private sessionLastSeq = new Map<string, number>();
    private sessionLastFetchTime = new Map<string, number>(); // debounce re-fetches
    private sessionLastWsMessageAt = new Map<string, number>(); // track last WS delivery per session
    private pendingOutbox = new Map<string, OutboxMessage[]>();
    // In session-protocol mode user messages arrive back as session envelopes without localId.
    // We track sent message texts here so we can re-attach the localId when the echo arrives,
    // enabling deduplication with the already-displayed optimistic message.
    private sentMessageLocalIds = new Map<string, Array<{ localId: string; text: string }>>();
    // Once a (serverMsgId → localId) pair is claimed by either fetchMessages or handleUpdate,
    // record it here so the OTHER path can reuse the same localId rather than creating a duplicate.
    private claimedServerMessageIds = new Map<string, string>(); // serverMsgId → localId
    private sessionMessageQueue = new Map<string, NormalizedMessage[]>();
    private sessionQueueProcessing = new Set<string>();
    private _loggedMissingSessionForSid = new Set<string>();
    private sessionMessageLocks = new Map<string, AsyncLock>();
    /** Sessions whose persisted window has been consulted (and applied) in this process. */
    private hydratedSessions = new Set<string>();
    /** In-flight hydrations, so two opens of one session read the cache once. */
    private hydratingSessions = new Map<string, Promise<void>>();
    /**
     * How long a message lock may be held before it is treated as abandoned.
     *
     * Longer than the read path's own cap (a LAN page is bounded at 45s): a fetch legitimately
     * holding the lock that long is slow, not stuck. Past it, no `finally` is coming — the shape a
     * request the OS cancelled without rejecting leaves behind — and the next caller resets it.
     */
    /**
     * A read that has held the session's lock longer than this is reset.
     *
     * Measured on a device: one run held the lock 53 seconds (a page whose decrypt stalled), and
     * every open of that session — including the hydrate that would have shown cached messages
     * first — queued behind it, which is the "blank conversation after a reload" shape. The read
     * is abandoned, not cancelled; a fetch that does finish still applies its result.
     */
    private static readonly STUCK_MESSAGE_LOCK_MS = 10_000;
    private sessionSendLocks = new Map<string, AsyncLock>();
    /** Limit concurrent message fetches to avoid network congestion (e.g. 150 sessions all requesting at once on reconnect). */
    private static readonly MAX_CONCURRENT_MESSAGE_FETCHES = 5;
    /**
     * Past every timeout on the read path (a LAN read is capped at 45s), so a slot still held after
     * this is a fetch that will never release it — a suspended request whose abort was lost.
     */
    private static readonly MESSAGE_FETCH_LEASE_MS = 90_000;
    /**
     * How long a background trip has to last before what was in flight is treated as void. Matches
     * the socket's own trust window: past it, iOS has certainly suspended the JS thread, and a
     * fetch that was mid-request will not be resumed by anything this App can wait for.
     */
    private static readonly SUSPENDED_TRUST_MS = 45_000;
    /**
     * How long a trip through `background` has to last before its in-flight work is distrusted.
     *
     * Not the 45s above: iOS suspends the process within a few seconds of a real background, and a
     * fetch that was mid-request then may never settle. Waiting 45s to forget it is what leaves a
     * session's lock held and every later read queued behind a request that will never answer.
     * The floor exists because a pull-down of Control Center reports `inactive` and can bounce back
     * within a second; that is not a suspension and its sockets are still good.
     */
    private static readonly BACKGROUND_RECOVERY_MIN_MS = 5_000;
    private messageFetchSlots = new FetchSlots(Sync.MAX_CONCURRENT_MESSAGE_FETCHES, Sync.MESSAGE_FETCH_LEASE_MS);
    private messageFetchQueue: ((token: number) => void)[] = [];
    private sessionDataKeys = new Map<string, Uint8Array>(); // Store session data encryption keys internally
    private machineDataKeys = new Map<string, Uint8Array>(); // Store machine data encryption keys internally
    private artifactDataKeys = new Map<string, Uint8Array>(); // Store artifact data encryption keys internally
    /**
     * How often the visible session's fallback poll runs.
     *
     * One tick per two seconds, for one session: cheap, because the cursor means only newly
     * written entries come back. It used to be one such timer per session, which turned a server
     * outage into a fetch storm.
     */
    private static readonly LAN_POLL_INTERVAL_MS = 2_000;

    /**
     * How long the server socket must have been down before its return refreshes everything.
     *
     * A flap of a few seconds missed nothing a visible session's catch-up does not cover; a gap of
     * half a minute may have missed list and side-data events, so the refetch is worth its cost.
     */
    private static readonly RECONNECT_REFRESH_MS = 30_000;

    /**
     * The one thing that decides which session is read, and the single fallback poll for the one
     * on screen. Transports report changes; they do not own timers of their own.
     */
    private readScheduler = new SessionReadScheduler({
        read: (sessionId) => {
            if (activeSyncInstance === this) {
                this.getMessagesSync(sessionId).invalidate();
            }
        },
        shouldPoll: (sessionId) => activeSyncInstance === this && this.visibleNeedsPolling(sessionId),
        isActive: () => activeSyncInstance === this,
        intervalMs: Sync.LAN_POLL_INTERVAL_MS,
        log: (message) => { log.log(message); },
    });
    /**
     * Per-session LAN state: where to resume reading, and the connection that position came from.
     * Both are kept with the machine that issued them — a cursor addresses a position in one
     * machine's log, and a token only authenticates against that machine.
     */
    private daemonLinks = new Map<string, LanLink>();
    /** The same anchors as `daemonLinks`, kept across restarts so a window can be trusted. */
    private lanWindows = loadLanWindows();
    /**
     * The connection each machine was last reached over, keyed by machine rather than by session.
     *
     * A connection is a property of the machine — one address, one token, good for every session
     * it serves — but the per-session link above is keyed by session, so a session that had never
     * been read before had no connection of its own and paid a full mDNS browse to find one. A
     * browse is not returned early; it collects until its timeout elapses, so that was a flat 4s
     * per previously-unread session, on a channel polled every two seconds.
     */
    private lanMachineConnections = new Map<string, LanConnection>();
    /** Pending coalesced cache writes, one per session. */
    private cacheSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
    /**
     * The live daemon socket per route, when one is open. The two routes are independent: a LAN
     * socket and a relay socket can be up at once, each carrying the sessions that resolve to its
     * route. Keyed by baseUrl within a route because the daemon's socket is machine-wide: one
     * connection carries every session on that machine, and the App demultiplexes on `body.sid`
     * exactly as it does for the server channel.
     */
    /**
     * How to reach one machine's daemon over the relay, or nothing when the hub cannot carry it.
     *
     * Returning nothing is deliberate rather than falling back to a per-machine socket: with the
     * relay as the hub, a machine it is not holding is simply not reachable that way, and a socket
     * opened around the hub would be a second, unmanaged path to the same daemon.
     */
    private relayStreamFor(machineId: string): ((path: string, query: string) => SocketLike) | undefined {
        const hub = this.relayHub;
        const tag = this.machineTags.get(machineId);
        // Falling back to the per-machine path while the hub is down is deliberate: a relay that
        // does not speak the hub protocol at all (an older deployment) would otherwise leave the
        // channel unusable everywhere, and one connection per machine is still the shape that
        // works. The hub is preferred the moment it is up, which is the normal case.
        if (!hub || !tag || !hub.isConnected()) {
            return undefined;
        }
        return (path, query) => hub.stream(tag, `${path}${query}`);
    }

    /**
     * The one connection per daemon route, and the only thing in the App that opens or closes one.
     * Everything here says what it wants; the manager makes that true (see `daemonConnections`).
     */
    private connections = new DaemonConnections({
        open: (target, handlers) => openLanSocket({
            baseUrl: target.baseUrl,
            machineKey: target.machineKey,
            // A machine behind the relay is reached on the hub's one connection, as a stream the
            // relay routes to that machine. The protocol is identical — same upgrade path, same
            // frames — because the transport is the only thing that differs.
            connect: target.route === 'relay' ? this.relayStreamFor(target.machineId) : undefined,
            // The daemon forwards the session's own keepAlive now, so the LAN channel can say
            // "thinking" the way the server channel always has. Only while the server is not
            // delivering it: with both up, every heartbeat would land twice, and each application
            // rebuilds the session list — the channel exists for the case where the first is gone.
            onEphemeral: (payload) => {
                if (storage.getState().socketStatus === 'connected') {
                    return;
                }
                this.handleEphemeralUpdate(payload);
            },
            ...handlers,
        }),
        onUpdate: (target, payload) => { this.onDaemonUpdate(target.route, payload); },
        onDelivered: (_target, result) => { this.onLanDelivered(result); },
        onReady: (target) => { this.onDaemonConnectionReady(target); },
        onDropped: (target) => { this.onDaemonConnectionDropped(target); },
        onAddressUnusable: (target, reason) => {
            // A socket that will not open or stay open is evidence about the *address*, and the
            // candidate list ranks a socket's own address first. Recording it is what lets the
            // next reconcile move the socket to a sighting at the machine's new address instead
            // of retrying the old one for as long as the App runs.
            log.log(`📡 ${target.route} address did not work for ${target.machineId.slice(0, 8)} (${target.baseUrl}): ${reason}`);
            storage.getState().candidateFailed(target.machineId, target.route, target.baseUrl);
        },
        onHeartbeatUnsupported: (target) => { this.onDaemonHeartbeatUnsupported(target); },
        onStateChange: (id, state) => {
            storage.getState().setDaemonSocketStatus(id, state);
            // A connection that has just come live is the moment the App is talking to that machine
            // anyway — the cheapest possible time to ask what it is running, and the moment its
            // answer is most likely to have changed.
            if (state.phase === 'live') {
                const machineId = id.split(':')[0];
                void this.refreshDaemonVersions([machineId]);
            }
        },
        // Only the LAN: over the relay the hub is the one that can see a daemon go, and it says so.
        heartbeatRoutes: ['lan'],
        log: (message) => { log.log(message); },
    });
    /**
     * The session key each LAN read unwrapped, by session. The live socket is handed entries with
     * no read and no wrapped key around them, so this is the only place it can come from.
     */
    private lanSessionKeys = new Map<string, Uint8Array>();
    /** LAN sends awaiting the session's verdict, so a lost one cannot sit "sending" forever. */
    private lanSendTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
    /**
     * When this App last asked a machine to start a session that had no process.
     *
     * One window, not one attempt forever: a session that exits again has to be wakeable, and two
     * flushes inside the window must not start it twice. Nothing else has to be running for a wake
     * — the daemon serves it, and after a reboot the daemon is the only thing up.
     */
    private lastSessionWakeAt = new Map<string, number>();
    /** How many times a single outgoing message has been answered with "no process". One retry. */
    private deliveryWakeAttempts = new Map<string, number>();
    private static readonly SESSION_WAKE_WINDOW_MS = 20_000;

    /** How long a LAN send waits for the session's verdict before it is treated as lost. */
    private static readonly LAN_DELIVERY_TIMEOUT_MS = 15_000;
    /**
     * The second look, after the verdict's window has passed: long enough for one read to come back
     * with the session's own record that it took the message in.
     */
    private static readonly LAN_DELIVERY_PROOF_MS = 30_000;
    /** Accumulated base64 dataEncryptionKey values from all fetchSessions responses.
     *  Merged across delta fetches so the cache always has the full key set. */
    private sessionEncryptionKeySources = new Map<string, string>();
    private settingsSync: InvalidateSync;
    private profileSync: InvalidateSync;
    private purchasesSync: InvalidateSync;
    private machinesSync: InvalidateSync;
    private pushTokenSync: InvalidateSync;
    private nativeUpdateSync: InvalidateSync;
    private artifactsSync: InvalidateSync;
    private friendsSync: InvalidateSync;
    private friendRequestsSync: InvalidateSync;
    private feedSync: InvalidateSync;
    private activityAccumulator: ActivityUpdateAccumulator;
    private pendingSettings: Partial<Settings> = loadPendingSettings();
    private appState: AppStateStatus = AppState.currentState;
    /** When the App went to the background, so a resume can tell a hop from a suspension. */
    private backgroundedAt: number | null = null;
    /**
     * Whether the last non-active transition was a real `background`, not the transient `inactive`
     * iOS reports for a notification shade or an app-switch animation. Only the former suspends
     * the process, and only the former invalidates a socket.
     */
    private wentToBackground = false;
    private appStateSubscription: ReturnType<typeof AppState.addEventListener> | null = null;
    private networkStateSubscription: ReturnType<typeof Network.addNetworkStateListener> | null = null;
    /** Undoes the server-socket reconnect subscription, for a superseded evaluation. */
    private reconnectedCleanup: (() => void) | null = null;
    currentVisibleSessionId: string | null = null;
    private lastDesktopSessionRefreshAt = 0;
    private lastSessionRefreshAt = 0;
    /** Timestamp of the last successful session fetch; used as delta base. */
    private lastSessionRefreshNonDeltaAt = 0;
    /** When true, the next fetchSessions must NOT overwrite lastSessionRefreshNonDeltaAt
     *  with Date.now() — the pending full refresh still needs to run on the double-invalidation cycle. */
    private _forceFullRefreshPending = false;
    private lastFullRefreshAt = 0;
    /** Per-session cooldown for single-session fetches (15s). */
    private sessionRefreshCooldowns = new Map<string, number>();
    /** Last user interaction timestamp (desktop idle detection). */
    private lastUserActivityAt = Date.now();
    /** Per-session turn-start time; used to drop lagging session-alive thinking=false. */
    private sessionTurnStartAt = new Map<string, number>();
    /** Last known network connectivity; null until first change event fires. */
    private lastNetworkConnected: boolean | null = null;
    /** Last known network type; used to detect interface switches (e.g. WiFi → Cellular). */
    private lastNetworkType: Network.NetworkStateType | null = null;
    /**
     * The device's own address last time we looked.
     *
     * The one fact that changes when a phone moves between two WiFi networks: `isConnected` stays
     * true and `type` stays WIFI, so the network listener below has no transition to report. Every
     * LAN address this App holds was derived against the old network, which is why a resume that
     * finds a different address has to be treated as a network move even though the OS never said
     * one happened.
     */
    private lastDeviceIp: string | null = null;
    private backgroundSendTimeout: ReturnType<typeof setTimeout> | null = null;
    private backgroundSendNotificationId: string | null = null;
    private backgroundSendStartedAt: number | null = null;
    private backgroundTaskId: number | null = null;
    private sessionsRefreshInterval: ReturnType<typeof setInterval> | null = null;
    revenueCatInitialized = false;

    // Generic locking mechanism
    private recalculationLockCount = 0;
    private lastRecalculationTime = 0;

    constructor() {
        // This evaluation owns the background work from here; any earlier instance's scheduler
        // will notice and stop itself.
        activeSyncInstance = this;
        // On web (browser + Tauri/Linux), expo-sqlite is unavailable – use IndexedDB for persistent cache
        // so desktop/Linux doesn't refetch on every launch (same behaviour as iOS SQLite cache).
        if (Platform.OS === 'web') {
            overrideSessionCacheDB(new IndexedDBSessionCacheDB());
        }

        // Every session-list fetch defers behind the interaction already under way — event-driven
        // ones (a reconnect, a push) included, not just the periodic timer. A full fetch is a
        // ~1MB response whose parse and decrypt are JS-thread work, and a reconnect tends to
        // happen exactly when a person has just come back and is tapping into a conversation:
        // without this the tap waited behind the whole cycle. What the screen shows meanwhile is
        // the cached list, which is what a session list is for.
        this.sessionsSync = new InvalidateSync(async () => {
            await new Promise<void>((resolve) => {
                InteractionManager.runAfterInteractions(() => resolve());
            });
            await this.fetchSessions();
        });
        this.settingsSync = new InvalidateSync(this.syncSettings);
        this.profileSync = new InvalidateSync(this.fetchProfile);
        this.purchasesSync = new InvalidateSync(this.syncPurchases);
        this.machinesSync = new InvalidateSync(this.fetchMachines);
        this.nativeUpdateSync = new InvalidateSync(this.fetchNativeUpdate);
        this.artifactsSync = new InvalidateSync(this.fetchArtifactsList);
        this.friendsSync = new InvalidateSync(this.fetchFriends);
        this.friendRequestsSync = new InvalidateSync(this.fetchFriendRequests);
        this.feedSync = new InvalidateSync(this.fetchFeed);

        const registerPushToken = async () => {
            if (__DEV__) {
                return;
            }
            await this.registerPushToken();
        }
        this.pushTokenSync = new InvalidateSync(registerPushToken);
        this.activityAccumulator = new ActivityUpdateAccumulator(this.flushActivityUpdates.bind(this), 2000);

        // Remove any previously registered listener (e.g. after Metro hot reload)
        // before adding a new one, so listeners don't accumulate.
        this.appStateSubscription?.remove();

        // Listen for app state changes to refresh purchases
        this.appStateSubscription = AppState.addEventListener('change', (nextAppState) => {
            this.appState = nextAppState;
            if (nextAppState === 'active') {
                const shouldFailAfterResume = this.backgroundSendStartedAt !== null
                    && this.hasPendingOutboxMessages()
                    && (Date.now() - this.backgroundSendStartedAt) >= Sync.BACKGROUND_SEND_TIMEOUT_MS;
                void this.cancelBackgroundSendTimeoutNotification();
                this.clearBackgroundSendWatchdog();
                if (shouldFailAfterResume) {
                    void this.notifyMessageSendFailed();
                    this.failPendingOutboxMessages('Message failed to send in background after 30s. Please retry.');
                }
                log.log('📱 App became active');
                // Ask where this device is now. A trip through `background` is the usual place a
                // network change hides: the listener was suspended, and a move between two WiFi
                // networks never produced a transition for it to report anyway.
                void this.detectNetworkMove();
                // In-flight fetches cannot be trusted across a real suspension, and the timers that
                // would have retried them are about to restart against locks they still hold.
                const suspendedFor = this.backgroundedAt === null ? 0 : Date.now() - this.backgroundedAt;
                const resumedFromBackground = this.wentToBackground;
                this.backgroundedAt = null;
                this.wentToBackground = false;
                // A real trip through `background` suspends JS even when it is short, and it takes
                // the machine sockets with it. They read as open here — iOS kills the socket, not
                // the variable — so each one has to prove itself before anything is written on it.
                // The server socket is handled below; the daemon's LAN/relay sockets were not
                // handled at all, which is the minute-wide gap in which pushes stop, sends go into
                // a dead socket and the delivery timers have nothing to wait for.
                if (resumedFromBackground && suspendedFor >= Sync.BACKGROUND_RECOVERY_MIN_MS) {
                    this.recoverFetchesAfterSuspend();
                    this.connections.probeAfterResume();
                    this.relayHub?.probeAfterResume();
                    // A message waiting for a delivery verdict was waiting for a pong that died
                    // with the suspension. Requeue it now instead of at its own timeout, so the
                    // send ladder can use whatever channel the probe actually finds.
                    this.recoverPendingOutbox();
                }
                // A long suspension is long enough for a machine to have moved, and this device to
                // have moved with it. Nothing that failed before it is worth believing now.
                if (suspendedFor >= Sync.SUSPENDED_TRUST_MS) {
                    storage.getState().rearmCandidateHealth();
                }
                // Probe the socket first — a live connection responds in < 200ms.
                // If probe fails (1.5s timeout) a fresh connect is triggered.
                // Only invalidate syncs after the probe settles so data fetches
                // don't race against a dead socket.
                void apiSocket.resumeReconnection().then(() => {
                    this.#invalidateAllSyncs();
                    // Refresh the currently visible session's messages immediately.
                    // After background/foreground the session screen is still mounted
                    // so onSessionVisible doesn't fire — the scheduler's visible session is the
                    // thing to wake, not the screen lifecycle (which would re-announce the focus).
                    this.readScheduler.markStale();
                });
            } else {
                log.log(`📱 App state changed to: ${nextAppState}`);
                // `inactive` is an overlay (Control Center, an app-switch animation) and can come
                // back in a second; only `background` is a suspension, and only its sockets are
                // suspect on the way back.
                if (nextAppState === 'background') {
                    this.wentToBackground = true;
                }
                // A coalesced cache write may be waiting on a timer that suspension will not run.
                // This is the last reliable moment before the App can be killed, so write now.
                this.backgroundedAt = Date.now();
                this.flushPendingCacheSaves();
                // Stop reconnection timers while suspended to avoid waking the
                // JS thread unnecessarily. A live connected socket is preserved so a short trip
                // to the background can resume on it — but `osSuspend` also arms a delayed reset,
                // because past the server's heartbeat timeout this socket is certainly closed
                // while `connected` still reads true.
                apiSocket.pauseReconnection({ osSuspend: true });
                this.maybeStartBackgroundSendWatchdog();
            }
        });

        // Network reachability monitoring (iOS/Android only; expo-network behaves
        // differently on web and the socket handles reconnection there anyway).
        this.networkStateSubscription?.remove();
        if (Platform.OS !== 'web') {
            this.networkStateSubscription = Network.addNetworkStateListener(({ isConnected, type }) => {
                const connected = isConnected ?? false;
                const prevConnected = this.lastNetworkConnected;
                const prevType = this.lastNetworkType;
                this.lastNetworkConnected = connected;
                this.lastNetworkType = type ?? null;

                if (prevConnected === null) {
                    // First event is the current state, not a transition — skip.
                    return;
                }

                if (connected && !prevConnected) {
                    log.log('🌐 Network became reachable, triggering reconnect');
                    apiSocket.resumeReconnection();
                    this.onNetworkChanged('regained');
                } else if (!connected && prevConnected) {
                    log.log('🌐 Network lost, pausing reconnection');
                    apiSocket.pauseReconnection();
                    this.onNetworkChanged('lost');
                } else if (connected && type !== prevType) {
                    // Network interface switched (e.g. WiFi → Cellular) while staying
                    // connected. The underlying TCP connection may have been silently
                    // dropped; probe immediately to confirm liveness.
                    log.log(`🌐 Network interface changed (${prevType} → ${type}), probing connection`);
                    apiSocket.resumeReconnection();
                    this.onNetworkChanged('switched');
                }
            });
        }

        // On web/Tauri, AppState never fires — bridge window visibility and OS
        // focus events to the same pause/resume logic used on iOS.
        if (Platform.OS === 'web') {
            this.#setupDesktopLifecycle();
        }

        // Periodic session list refresh so long-running foreground sessions
        // pick up new sessions from other devices without needing a restart.
        // Cooldown in fetchSessions prevents this from running back-to-back
        // with event-driven invalidations.
        // Skips refresh when the user has been idle for > 10 minutes (desktop).
        /**
         * The last time the machines reached through the server were asked what they run.
         *
         * The daemon's own channels notify: a connection coming live is the moment the App is
         * talking to that machine anyway, and that is when it asks. The server channel has no such
         * moment — it cannot tell the App that a machine was rebuilt and restarted, because to the
         * server a machine that changed looks exactly like one that has been sitting still. So on
         * the server channel the question is asked on a timer instead, and the timer is long: a
         * build changes when a person changes it, not on any schedule worth polling for.
         */
        let lastMachineVersionSweep = Date.now();

        this.sessionsRefreshInterval = setInterval(() => {
            // Check socket health first — a silent TCP drop (socket.connected === true
            // but no data flowing) won't self-recover without a nudge.
            apiSocket.checkHealthAndReconnect();

            // The refresh waits for the UI to be idle. It is never urgent, and running it while a
            // screen is being opened was measured on a device as an extra 200-260ms before the
            // session's first render — the navigation was queued behind a list fetch.
            InteractionManager.runAfterInteractions(() => {
                // Only while the server channel is carrying the App at all — that is the channel
                // with nothing to notify with. A machine on a live LAN or relay socket has already
                // been asked, by that socket coming live, and asking it again on a timer would be
                // the poll this is trying not to be.
                if (Date.now() - lastMachineVersionSweep > Sync.MACHINE_VERSION_SWEEP_MS
                    && storage.getState().socketStatus === 'connected') {
                    lastMachineVersionSweep = Date.now();
                    void this.refreshDaemonVersions(this.machinesWithoutLiveSocket());
                }

                const idleMs = Date.now() - this.lastUserActivityAt;
                if (idleMs > 600_000) {
                    log.log(`🕐 Skipping periodic session refresh — idle for ${Math.round(idleMs / 1000)}s`);
                    return;
                }
                // Every FULL_REFRESH_INTERVAL, do a full fetch to purge stale sessions
                // that were deleted/archived on the server and won't appear in deltas.
                if (Date.now() - this.lastFullRefreshAt >= Sync.FULL_REFRESH_INTERVAL_MS) {
                    this.#refreshSessionsFull();
                    return; // refreshSessionsFull already invalidates
                }
                this.sessionsSync.invalidate();
            });
        }, Sync.SESSION_REFRESH_INTERVAL_MS);
    }

    /** Invalidate all data syncs (called on app resume / window becoming visible). */
    #invalidateAllSyncs() {
        // The list and the presence behind it first: they are what the screens being resumed draw.
        // Everything else updates state that is already on screen, and must not take the JS thread
        // at the same instant a session hydrates — measured on a device, a hydration that took
        // 50ms on a quiet thread took six seconds beside feed/artifacts/friends/machines landing
        // together. Spacing them out costs a second of freshness nobody is waiting on.
        this.sessionsSync.invalidate();
        this.machinesSync.invalidate();
        this.#invalidateBackgroundSyncs();
    }

    /** Syncs whose answers update a screen that is already rendered, spaced out behind an open. */
    #invalidateBackgroundSyncs(delayMs: number = 800) {
        const background = [
            this.profileSync,
            this.purchasesSync,
            this.pushTokenSync,
            this.nativeUpdateSync,
            this.artifactsSync,
            this.friendsSync,
            this.friendRequestsSync,
            this.feedSync,
        ];
        background.forEach((sync, index) => {
            // After the current interaction (a tap, a navigation animation), not in the middle of
            // it: these are updates to a screen that is already drawn.
            InteractionManager.runAfterInteractions(() => {
                setTimeout(() => sync.invalidate(), delayMs + index * 250);
            });
        });
    }

    /**
     * Full (non-delta) session list refresh to clean up stale cached state.
     * Delta fetches never remove sessions that were deleted or archived on another
     * device — a periodic full fetch is needed to purge them from local cache.
     */
    #refreshSessionsFull(force = false) {
        const now = Date.now();
        if (!force && now - this.lastFullRefreshAt < Sync.FULL_REFRESH_INTERVAL_MS) {
            return;
        }
        this.lastFullRefreshAt = now;
        log.log('🔄 Full sessions refresh — resetting delta base for cache cleanup');
        this.lastSessionRefreshNonDeltaAt = 0;
        this._forceFullRefreshPending = true; // prevent fetchSessions from overwriting with Date.now()
        if (force) {
            this.lastSessionRefreshAt = 0; // bypass fetch cooldown for user-triggered refresh
        }
        this.sessionsSync.invalidate();
    }

    #refreshSessionsAfterDesktopProbe() {
        const now = Date.now();
        if (now - this.lastDesktopSessionRefreshAt < Sync.DESKTOP_SESSION_REFRESH_COOLDOWN_MS) {
            log.log('🖥️ Desktop sessions refresh skipped — cooldown active');
            return;
        }

        this.lastDesktopSessionRefreshAt = now;
        log.log('🖥️ Desktop sessions refresh — invalidating sessions sync after confirmed connection');
        this.#refreshSessionsFull();
    }

    #refreshVisibleSessionAfterDesktopProbe() {
        const sessionId = this.currentVisibleSessionId;
        if (!sessionId) {
            return;
        }

        const now = Date.now();
        if (now - this.lastDesktopSessionRefreshAt < Sync.DESKTOP_SESSION_REFRESH_COOLDOWN_MS) {
            log.log('🖥️ Desktop visible session refresh skipped — cooldown active');
            return;
        }

        this.lastDesktopSessionRefreshAt = now;
        log.log(`🖥️ Desktop visible session refresh — invalidating messages for ${sessionId} after confirmed connection`);
        this.onSessionVisible(sessionId);
    }

    /**
     * Desktop (Tauri / browser) lifecycle management.
     *
     * visibilitychange is the primary signal:
     *   hidden  → pauseReconnection  (window minimised or tab hidden)
     *   visible → resumeReconnection + full sync invalidation
     *
     * Tauri WINDOW_FOCUS/WINDOW_BLUR fire when the OS window gains or loses focus
     * without a visibility change (window was visible but behind another app). On
     * focus we only probe the socket — no full invalidation needed.
     */
    async #setupDesktopLifecycle() {
        const recoverDesktopPendingWork = () => {
            log.log('🖥️ Desktop focused — recovering pending sends');
            this.recoverPendingOutbox();
        };

        // In Tauri a DOM blur arrives immediately after the OS window regains focus,
        // so pausing straight away tears down the socket that the focus handler's
        // resumeReconnection just created and the connection never leaves 'connecting'.
        // Defer the pause so a focus arriving within the grace window cancels it.
        const BLUR_PAUSE_GRACE_MS = 5_000;
        let blurPauseTimer: ReturnType<typeof setTimeout> | null = null;

        const cancelPendingBlurPause = () => {
            if (blurPauseTimer !== null) {
                clearTimeout(blurPauseTimer);
                blurPauseTimer = null;
            }
        };

        const onDesktopBlur = () => {
            cancelPendingBlurPause();
            blurPauseTimer = setTimeout(() => {
                blurPauseTimer = null;
                log.log('🖥️ Desktop blurred — pausing socket');
                apiSocket.pauseReconnection();
            }, BLUR_PAUSE_GRACE_MS);
        };

        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                log.log('🖥️ Window hidden — pausing reconnection');
                cancelPendingBlurPause();
                apiSocket.pauseReconnection();
            } else {
                log.log('🖥️ Window visible — resuming and invalidating syncs');
                cancelPendingBlurPause();
                void apiSocket.resumeReconnection().then(() => {
                    this.#invalidateAllSyncs();
                    // Refresh the currently visible session's messages immediately.
                    // After sleep/wake the session screen is still mounted so
                    // onSessionVisible doesn't fire — the scheduler's visible session is the
                    // thing to wake, not the screen lifecycle (which would re-announce the focus).
                    this.readScheduler.markStale();
                });
                recoverDesktopPendingWork();
                // Full refresh after desktop wake to clean up stale cache.
                const FULL_REFRESH_DESKTOP_WAKE_DELAY_MS = 3_000;
                setTimeout(() => this.#refreshSessionsFull(), FULL_REFRESH_DESKTOP_WAKE_DELAY_MS);
            }
        });

        window.addEventListener('focus', () => {
            if (!isRunningInTauri()) {
                log.log('🖥️ Window focused — resuming socket and recovering pending sends');
                cancelPendingBlurPause();
                void apiSocket.resumeReconnection();
                recoverDesktopPendingWork();
            }
        });
        window.addEventListener('blur', () => {
            // In Tauri the DOM blur doesn't track the OS window; WINDOW_BLUR does.
            if (isRunningInTauri()) return;
            onDesktopBlur();
        });

        // Track user activity for idle detection on desktop.
        // Skips periodic session refreshes when the user hasn't interacted
        // with the app for a while (e.g. app running in background on another
        // virtual desktop / space).
        const markActivity = () => { this.lastUserActivityAt = Date.now(); };
        document.addEventListener('mousemove', markActivity, { passive: true });
        document.addEventListener('keydown', markActivity, { passive: true });
        document.addEventListener('scroll', markActivity, { passive: true });
        document.addEventListener('touchstart', markActivity, { passive: true });

        // Match native `expo-network` behaviour: desktop has no reachability API, but the browser
        // exposes online/offline. Without this, a broken connect can sit in `error` until the next
        // visibility/focus event while socket.io backoff waits.
        let onlineDebounce: ReturnType<typeof setTimeout> | null = null;
        window.addEventListener('online', () => {
            if (onlineDebounce !== null) {
                clearTimeout(onlineDebounce);
            }
            onlineDebounce = setTimeout(() => {
                onlineDebounce = null;
                log.log('🌐 Window: network online — reinit sodium + resume socket');
                reinitSodium();
                apiSocket.resumeReconnection();
            }, 300);
        });
        window.addEventListener('offline', () => {
            if (onlineDebounce !== null) {
                clearTimeout(onlineDebounce);
                onlineDebounce = null;
            }
            log.log('🌐 Window: network offline — pausing socket');
            apiSocket.pauseReconnection();
        });

        if (isRunningInTauri()) {
            const { getCurrentWindow } = await import('@tauri-apps/api/window');
            const { TauriEvent } = await import('@tauri-apps/api/event');
            const appWindow = getCurrentWindow();
            appWindow.listen(TauriEvent.WINDOW_FOCUS, () => {
                if (!document.hidden) {
                    log.log('🖥️ Window focused (Tauri) — probing connection');
                    cancelPendingBlurPause();
                    void apiSocket.resumeReconnection().then((connected) => {
                        if (connected) {
                            this.#refreshSessionsAfterDesktopProbe();
                            this.#refreshVisibleSessionAfterDesktopProbe();
                        }
                    });
                    recoverDesktopPendingWork();
                }
            });
            appWindow.listen(TauriEvent.WINDOW_BLUR, onDesktopBlur);
        }
    }

    async create(credentials: AuthCredentials, encryption: Encryption) {
        this.credentials = credentials;
        this.encryption = encryption;
        this.anonID = encryption.anonID;
        this.serverID = parseToken(credentials.token);
        await this.#init();

        // Await settings sync to have fresh settings
        await this.settingsSync.awaitQueue();

        // Await profile sync to have fresh profile
        await this.profileSync.awaitQueue();

        // Await purchases sync to have fresh purchases
        await this.purchasesSync.awaitQueue();
    }

    async restore(credentials: AuthCredentials, encryption: Encryption) {
        // NOTE: No awaiting anything here, we're restoring from a disk (ie app restarted)
        // Purchases sync is invalidated in #init() and will complete asynchronously
        this.credentials = credentials;
        this.encryption = encryption;
        this.anonID = encryption.anonID;
        this.serverID = parseToken(credentials.token);
        await this.#init();
    }

    /**
     * The machine key for a machine whose record has been decrypted, or null if it has not been
     * fetched yet. It is the 32-byte secret wrapped in the machine's `dataEncryptionKey`; the
     * App needs it both to decrypt `daemonState` and to answer the LAN API's challenge.
     */
    getMachineKey(machineId: string): Uint8Array | null {
        return this.machineDataKeys.get(machineId) ?? null;
    }

    async #init() {
        // Preload session cache DB (expo-sqlite) in background so opening a session doesn't block on first use.
        // Must not await here or init never completes and UI stays black (setInitState never runs).
        void preloadSessionCacheDB();
        void preloadSessionsListCache();

        // Subscribe to updates
        this.subscribeToUpdates();

        // Machine keys from the last run, so the LAN can authenticate before the machines request
        // returns. A key that no longer unwraps (another account, rotated) is simply skipped.
        for (const [machineId, wrapped] of Object.entries(loadWrappedMachineKeys())) {
            const key = await this.encryption.decryptEncryptionKey(wrapped);
            if (key && !this.machineDataKeys.has(machineId)) {
                this.machineDataKeys.set(machineId, key);
            }
        }
        void this.deriveRelayRoutes();

        // A machine on this network gets its live channel as soon as it is seen. Waiting for a
        // session to ask for the LAN was circular: the declaration that makes a session prefer it
        // arrives over the very socket this would open, and until then only the slow server list
        // could say so.
        if (!this.daemonSocketWatch) {
            this.daemonSocketWatch = storage.subscribe((state, previous) => {
                if (
                    state.lanSightings !== previous.lanSightings ||
                    // A published address is where a socket can be opened for a machine no browse
                    // ever finds, so it is as much a reason to reconcile as a sighting is — and
                    // without it here, a machine that publishes its address gets no socket at all.
                    state.lanEndpoints !== previous.lanEndpoints ||
                    // Health is what ranks one address over another for a socket. A machine whose
                    // address moved is reachable at the new one while the socket keeps retrying
                    // the old one — until the failure is recorded and this asks again.
                    state.candidateHealth !== previous.candidateHealth ||
                    state.socketStatus !== previous.socketStatus ||
                    state.channelOverride !== previous.channelOverride
                ) {
                    this.reconcileDaemonSockets();
                }
                if (state.localSettings.channelPriority !== previous.localSettings.channelPriority) {
                    // The relay being switched on or off is the hub's lifetime, not just a filter.
                    this.ensureRelayHub();
                    // A new order changes where every session reads from, so re-resolve them now
                    // instead of at each one's next scheduled fetch.
                    const serverWas = channelEnabled(previous.localSettings.channelPriority, 'server');
                    const serverNow = channelEnabled(state.localSettings.channelPriority, 'server');
                    if (serverWas !== serverNow) {
                        // Switching the server off has to drop the connection, not just stop
                        // choosing it: until the socket is gone the App is still talking to
                        // happy-server, which is the thing the setting is there to stop.
                        apiSocket.setServerEnabled(serverNow);
                    }
                    this.reconcileDaemonSockets();
                    // A new channel order changes where the open conversation is read from; the
                    // hidden ones read on open. Invalidating every message sync here made one
                    // setting change into a read of every session at once.
                    this.readScheduler.markStale();
                }
            });
            this.reconcileDaemonSockets();
        }

        // Sync initial PostHog opt-out state with stored settings
        if (tracking) {
            const currentSettings = storage.getState().settings;
            if (currentSettings.analyticsOptOut) {
                tracking.optOut();
            } else {
                tracking.optIn();
            }
        }

        // Load cached session list before network fetch so UI shows instantly.
        // Split into two phases:
        //   1. Apply cached sessions (already decrypted JSON) + mark ready
        //   2. Restore encryption keys in background (needed for NEW WS messages)
        // This avoids showing an empty-state placeholder while libsodium decrypts.
        let cachedEncryptionKeys: Record<string, string> | undefined;
        try {
            const cached = await loadSessionsListCache();
            if (cached && cached.sessions.length > 0) {
                log.log(`📦 sessionsListCache: applying ${cached.sessions.length} cached sessions (cachedAt=${cached.cachedAt})`);
                this.applySessions(cached.sessions);
                if (!this.lastSessionRefreshNonDeltaAt) {
                    this.lastSessionRefreshNonDeltaAt = cached.cachedAt;
                }
                cachedEncryptionKeys = cached.encryptionKeys;
            }
        } catch (e) {
            log.log(`📦 sessionsListCache: error applying cached list: ${e}`);
        }
        // Show cached data NOW — do NOT wait for encryption key decryption.
        // The sessions in the cache are already decrypted (metadata, agentState),
        // so the UI can render immediately. Encryption key restoration runs in
        // the background below and handles future WebSocket-delivered messages.
        storage.getState().applyReady();

        // Phase 2: Restore encryption keys in background.
        // Cached sessions are already visible (applyReady was called above).
        // The encryption keys are needed for NEW WebSocket messages; if a message
        // arrives before restoration completes, handleUpdate calls
        // fetchSessions(true) to recover — a brief recovery on first launch is
        // preferable to a visible delay every cold start.
        if (cachedEncryptionKeys && Object.keys(cachedEncryptionKeys).length > 0) {
            void (async () => {
                const keyMap = new Map<string, Uint8Array | null>();
                for (const [sid, encKey] of Object.entries(cachedEncryptionKeys!)) {
                    try {
                        const decrypted = await this.encryption.decryptEncryptionKey(encKey);
                        if (decrypted) {
                            keyMap.set(sid, decrypted);
                            this.sessionEncryptionKeySources.set(sid, encKey);
                        }
                    } catch { /* skip corrupt keys */ }
                }
                if (keyMap.size > 0) {
                    await this.encryption.initializeSessions(keyMap);
                    log.log(`📦 sessionsListCache: restored ${keyMap.size} encryption keys from cache (background)`);
                }
            })();
        }

        // Invalidate sync
        log.log('🔄 #init: Invalidating syncs');
        // The same split as a resume: the list, its machines and its settings now; the rest as
        // state updates after the first screen and the first session open have had the thread.
        this.#invalidateAllSyncs();
        this.settingsSync.invalidate();
        log.log('🔄 #init: Essential syncs invalidated, the rest staggered');

        // Wait for both sessions and machines to load, then mark as ready.
        // Use a timeout so we still call applyReady() if fetch keeps failing (e.g. network/401);
        // otherwise the UI would stay in loading state forever because backoff retries indefinitely.
        const READY_TIMEOUT_MS = 20_000;
        const readyPromise = Promise.all([
            this.sessionsSync.awaitQueue(),
            this.machinesSync.awaitQueue(),
            this.settingsSync.awaitQueue(),
        ]);
        const timeoutPromise = new Promise<void>((resolve) => {
            setTimeout(() => {
                log.log('🔄 #init: ready timeout reached, applying ready anyway so UI can show');
                resolve();
            }, READY_TIMEOUT_MS);
        });
        Promise.race([readyPromise, timeoutPromise]).then(() => {
            storage.getState().applyReady();
        }).catch((error) => {
            log.log(`🔄 #init: initial sync error, applying ready so UI can show: ${String(error)}`);
            storage.getState().applyReady();
        });

        // Schedule a full refresh after startup settles to clean up stale cache entries.
        const FULL_REFRESH_STARTUP_DELAY_MS = 10_000;
        setTimeout(() => {
            log.log('🔄 #init: scheduling full session refresh after startup settle');
            this.#refreshSessionsFull();
        }, FULL_REFRESH_STARTUP_DELAY_MS);
    }


    onSessionVisible = (sessionId: string) => {
        if (activeSyncInstance !== this) {
            return;
        }
        this.currentVisibleSessionId = sessionId;
        // The scheduler owns the fallback poll and the read order from here; setting the visible
        // session also wakes it once for the first read.
        this.readScheduler.setVisible(sessionId);
        // Start the cached window now, before the sync invalidation is scheduled: the tap's first
        // frame must not be a function of the network, a fetch slot or another fetch's lock.
        void this.hydrateSession(sessionId);
        this.getMessagesSync(sessionId).invalidate();

        // Only for a session whose CLI does not publish its working tree: those still have to be
        // asked over the socket, and that is the round trip this is replacing.
        if (!this.gitStatusPublished(sessionId)) {
            gitStatusSync.getSync(sessionId).invalidate();
        }

        // Rate-limited single-session refresh: when the user opens a cached
        // session, invalidate the sessions list sync so the delta fetch picks
        // up the latest metadata/agentState. Cooldown: 15s per session.
        const now = Date.now();
        const lastRefresh = this.sessionRefreshCooldowns.get(sessionId) ?? 0;
        if (now - lastRefresh >= 15_000) {
            this.sessionRefreshCooldowns.set(sessionId, now);
            this.sessionsSync.invalidate();
        }

        // If this session still has pending outbox messages, recover from stale
        // request state after the user returns to the session.
        if ((this.pendingOutbox.get(sessionId)?.length ?? 0) > 0) {
            this.recoverPendingOutbox();
        }

        // Notify voice assistant about session visibility
        const session = storage.getState().sessions[sessionId];
        if (session) {
            voiceHooks.onSessionFocus(sessionId, session.metadata || undefined);
        }
    }

    onSessionHidden = (sessionId: string) => {
        if (activeSyncInstance !== this) {
            return;
        }
        if (this.currentVisibleSessionId === sessionId) {
            this.currentVisibleSessionId = null;
            // The one fallback timer follows the screen. A hidden session refreshes when it is
            // opened again, not on a timer of its own.
            this.readScheduler.setVisible(null);
        }
    }

    /**
     * Persist the current in-memory state for a session to SQLite.
     * Called after resolving lazy tool content so the full content is saved to cache.
     */
    /**
     * How long a burst of changes is allowed to coalesce before it is written.
     *
     * Long enough that a turn's worth of messages costs one write rather than one per message,
     * short enough that a force-quit shortly after reading loses little. Backgrounding flushes
     * immediately, which is the case a timer alone would lose.
     */
    private static readonly CACHE_SAVE_DEBOUNCE_MS = 1_500;

    /**
     * Schedules a cache write for a session, coalescing a burst into one.
     *
     * Persisting used to happen only after a *successful* server fetch, so a fetch that failed —
     * routine on a slow network, and the normal state of affairs during an outage — left whatever
     * had arrived meanwhile in memory alone. Killing the App then lost it, which is exactly the
     * "restart and it has to fetch everything again" jank. Tying the write to the store changing,
     * rather than to one channel's request succeeding, is what keeps the data and what keeps the
     * cache indifferent to which channel delivered it.
     */
    private scheduleCacheSave(sessionId: string): void {
        if (this.cacheSaveTimers.has(sessionId)) {
            return;
        }
        const timer = setTimeout(() => {
            this.cacheSaveTimers.delete(sessionId);
            void this.saveSessionCache(sessionId);
        }, Sync.CACHE_SAVE_DEBOUNCE_MS);
        // Node/web only; keeps the timer from holding the process open in tests.
        (timer as unknown as { unref?: () => void }).unref?.();
        this.cacheSaveTimers.set(sessionId, timer);
    }

    /** Writes every pending save now, for the paths where a timer would not survive. */
    private flushPendingCacheSaves(): void {
        const pending = Array.from(this.cacheSaveTimers.keys());
        for (const sessionId of pending) {
            const timer = this.cacheSaveTimers.get(sessionId);
            if (timer) {
                clearTimeout(timer);
                this.cacheSaveTimers.delete(sessionId);
            }
        }
        for (const sessionId of pending) {
            void this.saveSessionCache(sessionId);
        }
    }

    saveSessionCache = async (
        sessionId: string,
        /**
         * What the caller just learned about the cache window. Omitted means "persist whatever the
         * store holds", which is right for a channel that only appends. A paged server fetch
         * knows better — `applyMessages` does not write `oldestSeq`/`hasOlderMessages`, so the
         * store can lag behind what the fetch actually established — and passes its own numbers.
         */
        watermark?: { lastSeq: number; oldestSeq: number; hasOlderMessages: boolean },
        /** Set for a daemon-channel write: where the window it just saved sits in the log. */
        window?: PersistedLanWindow,
    ): Promise<void> => {
        // This write supersedes any queued one: it is either the same state or a more precise
        // statement of it (a paged fetch knows the window better than the store does), so leaving
        // the timer armed would only write again a second later.
        const queued = this.cacheSaveTimers.get(sessionId);
        if (queued) {
            clearTimeout(queued);
            this.cacheSaveTimers.delete(sessionId);
        }

        const state = storage.getState();
        const session = state.sessions[sessionId];
        const sessionMsgs = state.sessionMessages[sessionId];
        if (!session || !sessionMsgs) return;
        const lastSeq = watermark?.lastSeq ?? this.sessionLastSeq.get(sessionId) ?? 0;
        const oldestSeq = watermark?.oldestSeq ?? sessionMsgs.oldestSeq;
        const hasOlderMessages = watermark?.hasOlderMessages ?? sessionMsgs.hasOlderMessages ?? false;
        // A session on a daemon channel is one the CLI keeps a log for, whatever the server has
        // managed to tell us about it.
        const servedByDaemon = this.preferredChannel(sessionId) !== 'server';
        // The store may hold a whole session in memory; the cache keeps the newest window and lets
        // the channel page the rest back if it is needed. `messages` is sorted newest-first.
        const cachedMessages = sessionMsgs.messages.length > MAX_CACHED_MESSAGES
            ? sessionMsgs.messages.slice(0, MAX_CACHED_MESSAGES)
            : sessionMsgs.messages;
        const saved = await saveMessageCache(session, cachedMessages, sessionMsgs.reducerState, lastSeq, oldestSeq, hasOlderMessages, servedByDaemon);
        // The window's anchors are written only once the messages they describe are on disk, and
        // never before. A crash between the two then leaves anchors *older* than the window they
        // belong to, which costs a re-read that dedup absorbs — the other order would leave them
        // newer, and a restart would skip everything between them and what it holds.
        if (saved && window) {
            this.lanWindows[sessionId] = window;
            saveLanWindows(this.lanWindows);
        }
    }

    /**
     * Clear the local message cache for a session and trigger a full refetch.
     * Only meaningful for Cursor sessions; safe to call on any session.
     */
    rebuildMessageCache = async (sessionId: string): Promise<void> => {
        log.log(`🔄 rebuildMessageCache: clearing cache for ${sessionId}`);

        // Clear the persisted cache
        await clearMessageCache(sessionId);

        // The window's anchors describe the cache that was just dropped, so they go with it. Kept,
        // they would claim a window the App no longer holds and skip everything between.
        delete this.lanWindows[sessionId];
        this.daemonLinks.delete(sessionId);
        saveLanWindows(this.lanWindows);

        // Reset in-memory seq so the next fetch starts from 0
        this.sessionLastSeq.delete(sessionId);
        this.serverNewestSeq.delete(sessionId);
        this.serverSessionSeq.delete(sessionId);

        // Clear the in-memory Zustand messages so the UI shows a loading state
        storage.getState().deleteSessionMessages(sessionId);
        // The hydration markers belong to the window that was just dropped.
        this.hydratedSessions.delete(sessionId);
        this.hydratingSessions.delete(sessionId);

        // Trigger a fresh full fetch
        this.onSessionVisible(sessionId);
    }

    private getMessagesSync(sessionId: string): InvalidateSync {
        let sync = this.messagesSync.get(sessionId);
        if (!sync) {
            sync = new InvalidateSync(() => this.fetchMessages(sessionId));
            this.messagesSync.set(sessionId, sync);
        }
        return sync;
    }

    private getSendSync(sessionId: string): InvalidateSync {
        let sync = this.sendSync.get(sessionId);
        if (!sync) {
            sync = new InvalidateSync(() => this.flushOutbox(sessionId));
            this.sendSync.set(sessionId, sync);
        }
        return sync;
    }

    private recoverPendingOutbox() {
        if (!this.hasPendingOutboxMessages()) {
            return;
        }

        for (const controller of this.sendAbortControllers.values()) {
            controller.abort();
        }
        this.sendAbortControllers.clear();

        for (const sessionId of this.pendingOutbox.keys()) {
            this.getSendSync(sessionId).invalidate();
        }
    }

    private enqueueMessages(sessionId: string, messages: NormalizedMessage[]) {
        if (messages.length === 0) {
            return;
        }

        // Track last WS delivery so fetchSessions can skip redundant HTTP fetches
        this.sessionLastWsMessageAt.set(sessionId, Date.now());

        let queue = this.sessionMessageQueue.get(sessionId);
        if (!queue) {
            queue = [];
            this.sessionMessageQueue.set(sessionId, queue);
        }
        queue.push(...messages);

        this.scheduleQueuedMessagesProcessing(sessionId);
    }

    private getSessionMessageLock(sessionId: string): AsyncLock {
        let lock = this.sessionMessageLocks.get(sessionId);
        if (!lock) {
            lock = new AsyncLock();
            this.sessionMessageLocks.set(sessionId, lock);
        }
        return lock;
    }

    private getSessionSendLock(sessionId: string): AsyncLock {
        let lock = this.sessionSendLocks.get(sessionId);
        if (!lock) {
            lock = new AsyncLock();
            this.sessionSendLocks.set(sessionId, lock);
        }
        return lock;
    }

    private scheduleQueuedMessagesProcessing(sessionId: string) {
        if (this.sessionQueueProcessing.has(sessionId)) {
            return;
        }

        this.sessionQueueProcessing.add(sessionId);
        const lock = this.getSessionMessageLock(sessionId);
        void lock.inLock(() => {
            while (true) {
                const pending = this.sessionMessageQueue.get(sessionId);
                if (!pending || pending.length === 0) {
                    break;
                }
                const batch = pending.splice(0, pending.length);
                this.applyMessages(sessionId, batch);
            }
        }).finally(() => {
            this.sessionQueueProcessing.delete(sessionId);
            const pending = this.sessionMessageQueue.get(sessionId);
            if (pending && pending.length > 0) {
                this.scheduleQueuedMessagesProcessing(sessionId);
            }
        });
    }

    private hasPendingOutboxMessages() {
        if (this.sendAbortControllers.size > 0) {
            return true;
        }
        for (const messages of this.pendingOutbox.values()) {
            if (messages.length > 0) {
                return true;
            }
        }
        return false;
    }

    private async maybeStartBackgroundSendWatchdog() {
        if (Platform.OS === 'web' || this.appState === 'active') {
            return;
        }
        if (!this.hasPendingOutboxMessages() || this.backgroundSendTimeout) {
            return;
        }

        // Request iOS background execution time so the JS thread isn't
        // suspended before messages are sent. Works with personal team profiles.
        if (Platform.OS === 'ios' && this.backgroundTaskId === null) {
            try {
                const { beginBackgroundTask } = await import('./iosBackgroundTask');
                const result = await beginBackgroundTask('Send pending messages');
                if (result.success) {
                    this.backgroundTaskId = result.taskId;
                    log.log(`📨 Background task started (id=${result.taskId})`);
                }
            } catch (e) {
                log.log(`📨 Failed to start background task: ${e}`);
            }
        }

        log.log('📨 Pending messages detected in background. Starting 30s send watchdog.');
        this.backgroundSendStartedAt = Date.now();
        this.backgroundSendTimeout = setTimeout(() => {
            this.backgroundSendTimeout = null;
            void this.handleBackgroundSendTimeout();
        }, Sync.BACKGROUND_SEND_TIMEOUT_MS);
        void this.scheduleBackgroundSendTimeoutNotification();
    }

    private clearBackgroundSendWatchdog() {
        if (this.backgroundSendTimeout) {
            clearTimeout(this.backgroundSendTimeout);
            this.backgroundSendTimeout = null;
        }
        this.backgroundSendStartedAt = null;
        if (this.backgroundTaskId !== null) {
            void import('./iosBackgroundTask').then(m => m.endBackgroundTask(this.backgroundTaskId!));
            this.backgroundTaskId = null;
        }
    }

    private async scheduleBackgroundSendTimeoutNotification() {
        if (Platform.OS === 'web' || this.backgroundSendNotificationId) {
            return;
        }
        try {
            this.backgroundSendNotificationId = await Notifications.scheduleNotificationAsync({
                content: {
                    title: 'Message not sent',
                    body: 'A message is still sending in the background. It will fail in 30 seconds if not delivered.',
                    sound: true
                },
                trigger: {
                    type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
                    seconds: Math.ceil(Sync.BACKGROUND_SEND_TIMEOUT_MS / 1000)
                }
            });
        } catch (error) {
            log.log(`Failed to schedule background send timeout notification: ${error}`);
        }
    }

    private async cancelBackgroundSendTimeoutNotification() {
        if (!this.backgroundSendNotificationId) {
            return;
        }
        try {
            await Notifications.cancelScheduledNotificationAsync(this.backgroundSendNotificationId);
        } catch (error) {
            log.log(`Failed to cancel background send timeout notification: ${error}`);
        } finally {
            this.backgroundSendNotificationId = null;
        }
    }

    private async notifyMessageSendFailed() {
        if (Platform.OS === 'web') {
            return;
        }
        try {
            await Notifications.scheduleNotificationAsync({
                content: {
                    title: 'Message failed',
                    body: 'A message failed to send while the app was in background. Open Happy and retry.',
                    sound: true
                },
                trigger: null
            });
        } catch (error) {
            log.log(`Failed to schedule message failure notification: ${error}`);
        }
    }

    private failPendingOutboxMessages(reasonText: string) {
        for (const controller of this.sendAbortControllers.values()) {
            controller.abort();
        }
        this.sendAbortControllers.clear();

        const failedLocalIds: string[] = [];
        for (const [, pending] of this.pendingOutbox) {
            for (const msg of pending) {
                failedLocalIds.push(msg.localId);
            }
        }
        this.pendingOutbox.clear();

        // Mark outbox entries as failed so UI can show retry
        if (failedLocalIds.length > 0) {
            storage.getState().failOutboxEntries(failedLocalIds, reasonText);
        }
    }

    private async handleBackgroundSendTimeout() {
        if (this.backgroundTaskId !== null) {
            const { endBackgroundTask } = await import('./iosBackgroundTask');
            await endBackgroundTask(this.backgroundTaskId);
            this.backgroundTaskId = null;
        }

        if (!this.hasPendingOutboxMessages()) {
            await this.cancelBackgroundSendTimeoutNotification();
            this.backgroundSendStartedAt = null;
            return;
        }

        await this.cancelBackgroundSendTimeoutNotification();
        await this.notifyMessageSendFailed();
        this.failPendingOutboxMessages('Message failed to send in background after 30s. Please retry.');
        this.backgroundSendStartedAt = null;
    }

    async sendMessage(sessionId: string, text: string, displayText?: string, existingLocalId?: string, files?: { name: string; size: number; mimeType: string; data: string; width?: number; height?: number }[]) {

        // Get encryption
        const encryption = this.encryption.getSessionEncryption(sessionId);
        if (!encryption) { // Should never happen
            console.error(`Session ${sessionId} not found`);
            return;
        }

        // Get session data from storage
        const session = storage.getState().sessions[sessionId];
        if (!session) {
            console.error(`Session ${sessionId} not found in storage`);
            return;
        }

        const { permissionMode, model, maxMode, effort, sandboxIsolation } = resolveMessageModeMeta(session);
        const settings = storage.getState().settings;
        const environmentVariables = resolveMessageProfileEnv(session, settings.profiles ?? []);

        // Reuse existing localId on retry so the same bubble is reused; generate fresh one otherwise.
        const localId = existingLocalId ?? randomUUID();

        // Track in outbox immediately (before encryption, so UI shows "sending" right away).
        // addOutboxEntry is keyed by localId, so this resets a 'failed' entry back to 'sending'.
        storage.getState().addOutboxEntry({ localId, sessionId, text, displayText, createdAt: Date.now() });

        // Track sent text → localId so we can re-attach localId when the session-envelope echo
        // arrives without one (session protocol mode: raw role:'user' messages are re-emitted as
        // session envelopes by the CLI, dropping the original localId).
        const sentPending = this.sentMessageLocalIds.get(sessionId) ?? [];
        sentPending.push({ localId, text });
        this.sentMessageLocalIds.set(sessionId, sentPending);

        // Determine sentFrom based on platform
        let sentFrom: string;
        if (Platform.OS === 'web') {
            sentFrom = 'web';
        } else if (Platform.OS === 'android') {
            sentFrom = 'android';
        } else if (Platform.OS === 'ios') {
            // Check if running on Mac (Catalyst or Designed for iPad on Mac)
            if (isRunningOnMac()) {
                sentFrom = 'mac';
            } else {
                sentFrom = 'ios';
            }
        } else {
            sentFrom = 'web'; // fallback
        }

        const fallbackModel: string | null = null;

        // Create user message content with metadata
        const hasFiles = files && files.length > 0;
        const content: RawRecord = {
            role: 'user',
            content: hasFiles ? {
                type: 'content',
                blocks: [
                    ...(text.trim() ? [{ type: 'text' as const, text }] : []),
                    ...(files ?? []).map((f) => ({
                        type: 'file' as const,
                        name: f.name,
                        size: f.size,
                        mimeType: f.mimeType,
                        data: f.data,
                        ...(f.width ? { width: f.width } : {}),
                        ...(f.height ? { height: f.height } : {}),
                    })),
                ],
            } : {
                type: 'text',
                text
            },
            meta: {
                sentFrom,
                permissionMode,
                model,
                fallbackModel,
                appendSystemPrompt: systemPrompt,
                ...(maxMode !== undefined ? { maxMode } : {}),
                ...(effort !== undefined ? { effort } : {}),
                ...(sandboxIsolation !== undefined ? { sandboxIsolation } : {}),
                profileId: session.profileId ?? null,
                ...(environmentVariables ? { environmentVariables } : {}),
                ...(displayText && { displayText }), // Add displayText if provided
                appMessageId: localId, // Carried through CLI round-trip for O(1) dedup
            }
        };

        // Optimistically insert the user message immediately so the UI responds without waiting
        // for the server round-trip. We construct the NormalizedMessage directly instead of going
        // through normalizeRawMessage because session-protocol mode (dev/preview) returns null
        // for role:'user' raw records (they're expected to arrive back as session envelopes).
        const createdAt = Date.now();
        const optimisticMessage: NormalizedMessage = {
            id: localId,
            localId,
            createdAt,
            role: 'user',
            content: hasFiles ? {
                type: 'content',
                blocks: [
                    ...(text.trim() ? [{ type: 'text' as const, text }] : []),
                    ...(files ?? []).map((f) => ({
                        type: 'file' as const,
                        name: f.name,
                        size: f.size,
                        mimeType: f.mimeType,
                        data: f.data,
                        ...(f.width ? { width: f.width } : {}),
                        ...(f.height ? { height: f.height } : {}),
                    })),
                ],
            } : { type: 'text', text },
            isSidechain: false,
            meta: content.meta as MessageMeta | undefined,
        };
        // Apply the optimistic message directly (bypass the queue/lock) so it appears in the UI
        // immediately without waiting for fetchMessages to release its lock.
        // applyMessages is a synchronous Zustand set, safe to call from any context.
        // Skip on retry (existingLocalId set): the bubble is already in the list.
        if (!existingLocalId) {
            this.applyMessages(sessionId, [optimisticMessage]);
        }

        // Serialize encryption + outbox-push per session so concurrent sendMessage calls
        // cannot reorder messages (encryption is async; whichever finishes first would otherwise
        // reach the outbox first, inverting the send order).
        try {
            await this.getSessionSendLock(sessionId).inLock(async () => {
                const encryptedRawRecord = await encryption.encryptRawRecord(content);
                let pending = this.pendingOutbox.get(sessionId);
                if (!pending) {
                    pending = [];
                    this.pendingOutbox.set(sessionId, pending);
                }
                pending.push({
                    localId,
                    content: encryptedRawRecord
                });
            });
        } catch (err) {
            console.warn(`📤 sendMessage encrypt failed for ${sessionId.slice(-8)}: ${err instanceof Error ? err.message : String(err)}`);
            storage.getState().failOutboxEntries([localId], 'Encryption failed');
            return;
        }

        this.getSendSync(sessionId).invalidate();
        this.maybeStartBackgroundSendWatchdog();
    }

    applySettings = (delta: Partial<Settings>) => {
        storage.getState().applySettingsLocal(delta);

        // Save pending settings
        this.pendingSettings = { ...this.pendingSettings, ...delta };
        savePendingSettings(this.pendingSettings);

        // Sync PostHog opt-out state if it was changed
        if (tracking && 'analyticsOptOut' in delta) {
            const currentSettings = storage.getState().settings;
            if (currentSettings.analyticsOptOut) {
                tracking.optOut();
            } else {
                tracking.optIn();
            }
        }

        // Invalidate settings sync
        this.settingsSync.invalidate();
    }

    refreshPurchases = () => {
        this.purchasesSync.invalidate();
    }

    refreshProfile = async () => {
        await this.profileSync.invalidateAndAwait();
    }

    purchaseProduct = async (productId: string): Promise<{ success: boolean; error?: string }> => {
        try {
            // Check if RevenueCat is initialized
            if (!this.revenueCatInitialized) {
                return { success: false, error: 'RevenueCat not initialized' };
            }

            // Fetch the product
            const products = await RevenueCat.getProducts([productId]);
            if (products.length === 0) {
                return { success: false, error: `Product '${productId}' not found` };
            }

            // Purchase the product
            const product = products[0];
            const { customerInfo } = await RevenueCat.purchaseStoreProduct(product);

            // Update local purchases data
            storage.getState().applyPurchases(customerInfo);

            return { success: true };
        } catch (error: any) {
            // Check if user cancelled
            if (error.userCancelled) {
                return { success: false, error: 'Purchase cancelled' };
            }

            // Return the error message
            return { success: false, error: error.message || 'Purchase failed' };
        }
    }

    getOfferings = async (): Promise<{ success: boolean; offerings?: any; error?: string }> => {
        try {
            // Check if RevenueCat is initialized
            if (!this.revenueCatInitialized) {
                return { success: false, error: 'RevenueCat not initialized' };
            }

            // Fetch offerings
            const offerings = await RevenueCat.getOfferings();

            // Return the offerings data
            return {
                success: true,
                offerings: {
                    current: offerings.current,
                    all: offerings.all
                }
            };
        } catch (error: any) {
            return { success: false, error: error.message || 'Failed to fetch offerings' };
        }
    }

    presentPaywall = async (): Promise<{ success: boolean; purchased?: boolean; error?: string }> => {
        try {
            // Check if RevenueCat is initialized
            if (!this.revenueCatInitialized) {
                const error = 'RevenueCat not initialized';
                trackPaywallError(error);
                return { success: false, error };
            }

            // Track paywall presentation
            trackPaywallPresented();

            // Present the paywall
            const result = await RevenueCat.presentPaywall();

            // Handle the result
            switch (result) {
                case PaywallResult.PURCHASED:
                    trackPaywallPurchased();
                    // Refresh customer info after purchase
                    await this.syncPurchases();
                    return { success: true, purchased: true };
                case PaywallResult.RESTORED:
                    trackPaywallRestored();
                    // Refresh customer info after restore
                    await this.syncPurchases();
                    return { success: true, purchased: true };
                case PaywallResult.CANCELLED:
                    trackPaywallCancelled();
                    return { success: true, purchased: false };
                case PaywallResult.NOT_PRESENTED:
                    // Don't track error for NOT_PRESENTED as it's a platform limitation
                    return { success: false, error: 'Paywall not available on this platform' };
                case PaywallResult.ERROR:
                default:
                    const errorMsg = 'Failed to present paywall';
                    trackPaywallError(errorMsg);
                    return { success: false, error: errorMsg };
            }
        } catch (error: any) {
            const errorMessage = error.message || 'Failed to present paywall';
            trackPaywallError(errorMessage);
            return { success: false, error: errorMessage };
        }
    }

    async assumeUsers(userIds: string[]): Promise<void> {
        if (!this.credentials || userIds.length === 0) return;
        
        const state = storage.getState();
        // Filter out users we already have in cache (including null for 404s)
        const missingIds = userIds.filter(id => !(id in state.users));
        
        if (missingIds.length === 0) return;
        
        log.log(`👤 Fetching ${missingIds.length} missing users...`);
        
        // Fetch missing users in parallel
        const results = await Promise.all(
            missingIds.map(async (id) => {
                try {
                    const profile = await getUserProfile(this.credentials!, id);
                    return { id, profile };  // profile is null if 404
                } catch (error) {
                    console.error(`Failed to fetch user ${id}:`, error);
                    return { id, profile: null };  // Treat errors as 404
                }
            })
        );
        
        // Convert to Record<string, UserProfile | null>
        const usersMap: Record<string, UserProfile | null> = {};
        results.forEach(({ id, profile }) => {
            usersMap[id] = profile;
        });
        
        storage.getState().applyUsers(usersMap);
        log.log(`👤 Applied ${results.length} users to cache (${results.filter(r => r.profile).length} found, ${results.filter(r => !r.profile).length} not found)`);
    }

    //
    // Private
    //

    private fetchSessions = async (force = false) => {
        if (!this.credentials) {
            log.log('📥 fetchSessions: no credentials, skipping');
            return;
        }

        // Rate-limit: don't fetch more than once per cooldown period.
        // 'force' bypasses the cooldown — used by recovery paths (e.g. handleUpdate
        // when encryption keys are missing for a session whose messages are arriving
        // via WebSocket). Without this, a message arriving within the 30s cooldown
        // window would be silently dropped with no path to recovery.
        const now = Date.now();
        if (!force && !this._forceFullRefreshPending && now - this.lastSessionRefreshAt < Sync.SESSION_REFRESH_COOLDOWN_MS) {
            log.log(`⏱️ fetchSessions: skipped — cooldown (${now - this.lastSessionRefreshAt}ms since last)`);
            return;
        }
        this.lastSessionRefreshAt = now;

        // With the server channel switched off this App does not talk to happy-server, so the list
        // is asked of the daemons that can be reached instead. Without this the request below would
        // still go out and fail, which is the connection the setting exists to stop — the fallback
        // in the catch would reach the same place, but only after trying.
        if (!channelEnabled(this.channelPriority(), 'server')) {
            // In the background, not awaited: the list the App is showing is the cached one, and a
            // daemon list — which begins with an mDNS browse — is an update to that state, not a
            // prerequisite for rendering it. Awaiting it here made a local-first screen wait on
            // network I/O whose answer only adds rows.
            void this.fetchSessionListFromDaemons().catch((error) => {
                log.log(`📡 fetchSessions: daemon session list failed: ${String(error)}`);
            });
            return;
        }

        // Full refresh when delta base is 0 (either first fetch or reset by #refreshSessionsFull).
        const fullRefresh = this.lastSessionRefreshNonDeltaAt === 0;

        try {
            const t0 = performance.now();
            const API_ENDPOINT = getServerUrl();
            const params = new URLSearchParams();
            if (this.lastSessionRefreshNonDeltaAt && this.encryption.hasAnySessionEncryption) {
                params.set('changedSince', String(this.lastSessionRefreshNonDeltaAt));
            }
            params.set('limit', '200');
            const qs = params.toString();
            log.log(`📥 fetchSessions: GET ${API_ENDPOINT}/v2/sessions?${qs}`);
            const fetchStart = performance.now();
            // The deadline covers the body, not just the headers. `instrumentedFetch` clears its
            // 30s timer when the response arrives, and a device log then showed the 1.1MB body
            // still being read 85 seconds later — a request that never ends and is never retried.
            // The signal is forwarded, so aborting here aborts the read too.
            const bodyController = new AbortController();
            const bodyDeadline = setTimeout(() => bodyController.abort(), 30_000);
            const response = await this.instrumentedFetch(`${API_ENDPOINT}/v2/sessions?${qs}`, {
                headers: {
                    'Authorization': `Bearer ${this.credentials.token}`,
                    'Content-Type': 'application/json',
                    'Accept-Encoding': 'gzip, deflate',
                },
                signal: bodyController.signal,
            });
            const networkMs = Math.round(performance.now() - fetchStart);

            if (!response.ok) {
                const body = await response.text();
                log.log(`📥 fetchSessions: failed status=${response.status} body=${body.slice(0, 200)}`);
                throw new Error(`Failed to fetch sessions: ${response.status}`);
            }

            const parseStart = performance.now();
            // Split the read from the parse: `response.json()` hides both, and a device log showed
            // "parse 18s" for a 1.1MB list with no way to tell a slow body from a slow parser.
            const textStart = performance.now();
            const body = await readResponseTextCooperatively(response);
            clearTimeout(bodyDeadline);
            const rawText = body.text;
            const textMs = Math.round(performance.now() - textStart);
            const jsonStart = performance.now();
            const data = JSON.parse(rawText) as { sessions?: unknown };
            const jsonMs = Math.round(performance.now() - jsonStart);
            log.log(`📥 fetchSessions body: read ${textMs}ms (${Math.round(rawText.length / 1024)}KB, ${body.streamed ? 'streamed' : 'whole'}), parse ${jsonMs}ms`);
            // Payload size comes from the header. This used to call JSON.stringify(data).length,
            // which re-serialised the entire (multi-hundred-KB) response on every fetch purely to
            // produce a log line.
            //
            // The header is not always there — the server answers chunked, so this logged 0KB and
            // the largest cost in the app was invisible. Summing the encrypted field lengths is
            // O(sessions) over strings already in memory, and gives a real number without
            // re-serialising anything.
            const contentLength = response.headers.get('content-length');
            const respSizeKb = contentLength ? Math.round(parseInt(contentLength) / 1024) : 0;
            const ciphertextKb = Math.round(
                ((data.sessions as Array<{ metadata?: string | null; agentState?: string | null; dataEncryptionKey?: string | null; lastMessage?: { content?: { c?: string } } | null }> | undefined) ?? [])
                    .reduce((total, s) =>
                        total
                        + (s.metadata?.length ?? 0)
                        + (s.agentState?.length ?? 0)
                        + (s.dataEncryptionKey?.length ?? 0)
                        + (s.lastMessage?.content?.c?.length ?? 0), 0) / 1024,
            );
            const xferKb = respSizeKb || ciphertextKb;
            const parseMs = Math.round(performance.now() - parseStart);
            const rawSessions = data.sessions;
            if (!Array.isArray(rawSessions)) {
                log.log(`📥 fetchSessions: API did not return sessions array (got ${typeof rawSessions})`);
            }
            const sessions = (rawSessions ?? []) as Array<{
                id: string;
                tag: string;
                seq: number;
                metadata: string;
                metadataVersion: number;
                agentState: string | null;
                agentStateVersion: number;
                dataEncryptionKey: string | null;
                active: boolean;
                activeAt: number;
                createdAt: number;
                updatedAt: number;
                lastMessage: ApiMessage | null;
            }>;

            // --- Cache: collect encryption keys for persistence ---
            // Merge new keys into the accumulated map so delta fetches don't overwrite
            // keys for sessions that weren't in the current response.
            for (const session of sessions) {
                if (session.dataEncryptionKey) {
                    this.sessionEncryptionKeySources.set(session.id, session.dataEncryptionKey);
                }
            }

            // Initialize all session encryptions first
            const keyDecryptStart = performance.now();
            const sessionKeys = new Map<string, Uint8Array | null>();
            // Retry decryption up to 3 times with backoff — libsodium WASM can be
            // unstable after Linux sleep/wake, causing transient crypto_box_open_easy failures.
            const decryptWithRetry = async (encryptedKey: string, sessionId: string, maxRetries = 3): Promise<Uint8Array | null> => {
                for (let attempt = 0; attempt < maxRetries; attempt++) {
                    const decrypted = await this.encryption.decryptEncryptionKey(encryptedKey);
                    if (decrypted) return decrypted;
                    if (attempt < maxRetries - 1) {
                        console.warn(`[encryption] Decrypt retry ${attempt + 1}/${maxRetries} for session ${sessionId}`);
                        await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
                    }
                }
                return null;
            };
            for (const session of sessions) {
                // One event-loop hop per session. A burst of these decrypts is otherwise a long
                // unbroken stay on the JS thread, and it starts exactly when the user comes back
                // to the App (a reconnect is what asked for the list). Measured on a device: 91
                // sessions = 17.5s of decrypt, during which a tap from the list starved for
                // seconds behind the batch. A hop per session bounds any one wait to one
                // session's worth of work.
                await yieldTask();
                if (session.dataEncryptionKey) {
                    let decrypted = await decryptWithRetry(session.dataEncryptionKey, session.id);
                    if (!decrypted) {
                        console.error(`Failed to decrypt data encryption key for session ${session.id}`);
                        continue;
                    }
                    sessionKeys.set(session.id, decrypted);
                } else {
                    sessionKeys.set(session.id, null);
                }
            }
            await this.encryption.initializeSessions(sessionKeys);
            const keyDecryptMs = Math.round(performance.now() - keyDecryptStart);

            // Decrypt sessions
            const metadataDecryptStart = performance.now();
            let decryptedSessions: (Omit<Session, 'presence'> & { presence?: "online" | number })[] = [];
            for (const session of sessions) {
                // Same hop as the key loop above: metadata + agentState per session is the
                // larger half of the batch (17.5s of 91), and it is paid on the JS thread.
                await yieldTask();
                // Get session encryption (should always exist after initialization)
                const sessionEncryption = this.encryption.getSessionEncryption(session.id);
                if (!sessionEncryption) {
                    console.error(`Session encryption not found for ${session.id} - this should never happen`);
                    continue;
                }

                // Decrypt metadata using session-specific encryption
                let metadata = await sessionEncryption.decryptMetadata(session.metadataVersion, session.metadata);

                // Decrypt agent state using session-specific encryption
                let agentState = await sessionEncryption.decryptAgentState(session.agentStateVersion, session.agentState);

                // Put it all together
                const processedSession = {
                    ...session,
                    thinking: false,
                    thinkingAt: 0,
                    metadata,
                    agentState
                };
                decryptedSessions.push(processedSession);
            }

            // Apply to storage — full refresh replaces stale cache, delta merges.
            const applyStart = performance.now();
            this.applySessions(decryptedSessions, fullRefresh);
            this.applyPublishedGitStatus(decryptedSessions);
            // The server answered, so the LAN's view of the list is no longer the fallback.
            storage.getState().applyDaemonSessionList(null);
            // Record timestamp for next delta fetch.
            // During forceFullRefresh, only the actual full fetch (fullRefresh=true)
            // should clear the flag — the stale in-flight fetch must not overwrite
            // the delta base or the flag.
            if (this._forceFullRefreshPending) {
                if (!fullRefresh) return; // stale fetch: don't overwrite anything
                this._forceFullRefreshPending = false; // real full refresh succeeded
            }
            this.lastSessionRefreshNonDeltaAt = Date.now();
            const applyMs = Math.round(performance.now() - applyStart);
            const metadataDecryptMs = Math.round(performance.now() - metadataDecryptStart);
            const totalMs = Math.round(performance.now() - t0);
            const decryptTotalMs = keyDecryptMs + metadataDecryptMs;
            console.warn(
                `⏱️ fetchSessions: ${totalMs}ms total | ` +
                `network ${networkMs}ms | parse ${parseMs}ms (${respSizeKb}KB${xferKb !== respSizeKb ? `, ${xferKb}KB on wire` : ''}) | ` +
                `decrypt ${decryptTotalMs}ms (keys ${keyDecryptMs}ms + meta ${metadataDecryptMs}ms) | ` +
                `apply ${applyMs}ms | ${decryptedSessions.length} sessions (delta)`
            );
            // Save full merged state (cached + delta), not just the delta results.
            const fullState = storage.getState().sessions;
            const allValues = Object.values(fullState).map(({ presence, ...s }) => s);
            // Use the accumulated key map (merged across all fetches since startup)
            // rather than only the current response's keys. Delta fetches return a
            // subset — without merging, they'd overwrite the full key set in cache.
            const accumulatedKeys: Record<string, string> = {};
            for (const [sid, key] of this.sessionEncryptionKeySources) {
                accumulatedKeys[sid] = key;
            }
            void saveSessionsListCache(allValues, accumulatedKeys);
            this._loggedMissingSessionForSid.clear();

            // Eagerly catch up messages for the currently visible session only. A daemon socket
            // pushes `log-grew` for every session on its machine, so a background agent's messages
            // arrive without a fetch; and a session the user is not looking at hydrates from the
            // hot window when opened. Invalidating every "active" session here was the fetch storm
            // that delayed the one session the user was actually opening — on a daemon channel the
            // active flag is stale (every online session reads active), so it matched six or more.
            void (async () => {
                const visibleId = this.currentVisibleSessionId;
                if (!visibleId) return;
                for (const session of decryptedSessions) {
                    if (session.id !== visibleId) continue;
                    try {
                        const cached = await getCachedLastSeq(session.id);
                        if (cached != null && cached < session.seq) {
                            const gapSize = session.seq - cached;
                            const lastWsAt = this.sessionLastWsMessageAt.get(session.id) ?? 0;
                            const wsGap = Date.now() - lastWsAt;
                            if (gapSize < 100 && wsGap < 5000) {
                                log.log(`📥 fetchSessions: skipping redundant message fetch for ${session.id} (gap=${gapSize}, WS delivered ${wsGap}ms ago, cached=${cached} < seq=${session.seq})`);
                                continue;
                            }
                            if (!this.encryption.getSessionEncryption(session.id)) {
                                log.log(`📥 fetchSessions: skipping message sync for ${session.id} — encryption not ready`);
                                continue;
                            }
                            log.log(`📥 fetchSessions: cached lastSeq ${cached} < session.seq ${session.seq} for ${session.id}, invalidating message sync`);
                            this.getMessagesSync(session.id).invalidate();
                        }
                    } catch (e) {
                        log.log(`📥 fetchSessions: getCachedLastSeq for ${session.id}: ${e}`);
                    }
                }
            })();
        } catch (err) {
            log.log(`📥 fetchSessions failed: ${err instanceof Error ? err.message : String(err)}`);
            // Deliberately leave the store untouched. This used to call applySessions([]) "so the
            // UI shows an empty state instead of an endless spinner" — but on a full refresh
            // applySessions replaces the whole map, so any transient failure wiped every session
            // the user had. That is exactly what iOS does to an in-flight request when the app
            // backgrounds, and a full refresh of a large account is slow enough (~1MB / 15s for
            // 104 sessions) that backgrounding mid-fetch reliably emptied the list while the
            // separate, smaller fetchMachines kept the machine list populated.
            //
            // Ask the LAN what it knows before giving up. The session list itself is untouched
            // (the app's own copy survives, and `sessionsListCache` covers a cold start), but the
            // daemon can say which sessions exist and are alive right now — including one this app
            // has never seen, which is exactly the case a cached list cannot cover.
            // Fire and forget, for the same reason as the server-disabled branch above: this is a
            // state update fed by the LAN, and the screen already has the cached list. Awaiting it
            // put a 4-second mDNS browse behind every failed server fetch, which read as the list
            // itself being slow.
            void this.fetchSessionListFromDaemons().catch((lanError) => {
                log.log(`📡 fetchSessions: LAN list failed: ${String(lanError)}`);
            });
            // No spinner risk: sessionListViewData is initialised to [] on applyReady, so an
            // empty store already renders the empty state. _forceFullRefreshPending is also only
            // cleared inside the try, so a failed attempt stays pending and the next invalidation
            // retries the full refresh.
        }
    }

    private decryptSingleSession = async (raw: {
        id: string; tag: string; seq: number;
        metadata: string; metadataVersion: number;
        agentState: string | null; agentStateVersion: number;
        dataEncryptionKey: string | null;
        active: boolean; activeAt: number;
        createdAt: number; updatedAt: number;
    }): Promise<(Omit<Session, 'presence'> & { presence?: 'online' | number }) | null> => {
        try {
            if (raw.dataEncryptionKey) {
                const key = await this.encryption.decryptEncryptionKey(raw.dataEncryptionKey);
                if (key) {
                    const keyMap = new Map<string, Uint8Array | null>();
                    keyMap.set(raw.id, key);
                    await this.encryption.initializeSessions(keyMap);
                    // Accumulate so the next cache save includes this key.
                    this.sessionEncryptionKeySources.set(raw.id, raw.dataEncryptionKey);
                }
            }
            const sessionEncryption = this.encryption.getSessionEncryption(raw.id);
            if (!sessionEncryption) {
                // No encryption key yet — return raw session with null metadata.
                return { ...raw, metadata: null, agentState: null, thinking: false, thinkingAt: 0 };
            }
            const metadata = await sessionEncryption.decryptMetadata(raw.metadataVersion, raw.metadata);
            const agentState = await sessionEncryption.decryptAgentState(raw.agentStateVersion, raw.agentState);
            return { ...raw, metadata, agentState, thinking: false, thinkingAt: 0 };
        } catch {
            return null;
        }
    }

    public refreshMachines = async () => {
        return this.fetchMachines();
    }

    public refreshSessions = async () => {
        // User-triggered refresh → force full fetch to purge stale sessions
        this.#refreshSessionsFull(true);
        return this.sessionsSync.invalidateAndAwait();
    }

    public getCredentials() {
        return this.credentials;
    }

    // Artifact methods
    public fetchArtifactsList = async (): Promise<void> => {
        log.log('📦 fetchArtifactsList: Starting artifact sync');
        if (!this.credentials) {
            log.log('📦 fetchArtifactsList: No credentials, skipping');
            return;
        }

        try {
            log.log('📦 fetchArtifactsList: Fetching artifacts from server');
            const artifacts = await fetchArtifacts(this.credentials);
            log.log(`📦 fetchArtifactsList: Received ${artifacts.length} artifacts from server`);
            const decryptedArtifacts: DecryptedArtifact[] = [];

            for (const artifact of artifacts) {
                try {
                    // Decrypt the data encryption key
                    const decryptedKey = await this.encryption.decryptEncryptionKey(artifact.dataEncryptionKey);
                    if (!decryptedKey) {
                        console.error(`Failed to decrypt key for artifact ${artifact.id}`);
                        continue;
                    }

                    // Store the decrypted key in memory
                    this.artifactDataKeys.set(artifact.id, decryptedKey);

                    // Create artifact encryption instance
                    const artifactEncryption = new ArtifactEncryption(decryptedKey);

                    // Decrypt header
                    const header = await artifactEncryption.decryptHeader(artifact.header);
                    
                    decryptedArtifacts.push({
                        id: artifact.id,
                        title: header?.title || null,
                        sessions: header?.sessions,  // Include sessions from header
                        draft: header?.draft,        // Include draft flag from header
                        body: undefined, // Body not loaded in list
                        headerVersion: artifact.headerVersion,
                        bodyVersion: artifact.bodyVersion,
                        seq: artifact.seq,
                        createdAt: artifact.createdAt,
                        updatedAt: artifact.updatedAt,
                        isDecrypted: !!header,
                    });
                } catch (err) {
                    console.error(`Failed to decrypt artifact ${artifact.id}:`, err);
                    // Add with decryption failed flag
                    decryptedArtifacts.push({
                        id: artifact.id,
                        title: null,
                        body: undefined,
                        headerVersion: artifact.headerVersion,
                        seq: artifact.seq,
                        createdAt: artifact.createdAt,
                        updatedAt: artifact.updatedAt,
                        isDecrypted: false,
                    });
                }
            }

            log.log(`📦 fetchArtifactsList: Successfully decrypted ${decryptedArtifacts.length} artifacts`);
            storage.getState().applyArtifacts(decryptedArtifacts);
            log.log('📦 fetchArtifactsList: Artifacts applied to storage');
        } catch (error) {
            log.log(`📦 fetchArtifactsList: Error fetching artifacts: ${error}`);
            console.error('Failed to fetch artifacts:', error);
            throw error;
        }
    }

    public async fetchArtifactWithBody(artifactId: string): Promise<DecryptedArtifact | null> {
        if (!this.credentials) return null;

        try {
            const artifact = await fetchArtifact(this.credentials, artifactId);

            // Decrypt the data encryption key
            const decryptedKey = await this.encryption.decryptEncryptionKey(artifact.dataEncryptionKey);
            if (!decryptedKey) {
                console.error(`Failed to decrypt key for artifact ${artifactId}`);
                return null;
            }

            // Store the decrypted key in memory
            this.artifactDataKeys.set(artifact.id, decryptedKey);

            // Create artifact encryption instance
            const artifactEncryption = new ArtifactEncryption(decryptedKey);

            // Decrypt header and body
            const header = await artifactEncryption.decryptHeader(artifact.header);
            const body = artifact.body ? await artifactEncryption.decryptBody(artifact.body) : null;

            return {
                id: artifact.id,
                title: header?.title || null,
                sessions: header?.sessions,  // Include sessions from header
                draft: header?.draft,        // Include draft flag from header
                body: body?.body || null,
                headerVersion: artifact.headerVersion,
                bodyVersion: artifact.bodyVersion,
                seq: artifact.seq,
                createdAt: artifact.createdAt,
                updatedAt: artifact.updatedAt,
                isDecrypted: !!header,
            };
        } catch (error) {
            console.error(`Failed to fetch artifact ${artifactId}:`, error);
            return null;
        }
    }

    public async createArtifact(
        title: string | null, 
        body: string | null,
        sessions?: string[],
        draft?: boolean
    ): Promise<string> {
        if (!this.credentials) {
            throw new Error('Not authenticated');
        }

        try {
            // Generate unique artifact ID
            const artifactId = this.encryption.generateId();

            // Generate data encryption key
            const dataEncryptionKey = ArtifactEncryption.generateDataEncryptionKey();
            
            // Store the decrypted key in memory
            this.artifactDataKeys.set(artifactId, dataEncryptionKey);
            
            // Encrypt the data encryption key with user's key
            const encryptedKey = await this.encryption.encryptEncryptionKey(dataEncryptionKey);
            
            // Create artifact encryption instance
            const artifactEncryption = new ArtifactEncryption(dataEncryptionKey);
            
            // Encrypt header and body
            const encryptedHeader = await artifactEncryption.encryptHeader({ title, sessions, draft });
            const encryptedBody = await artifactEncryption.encryptBody({ body });
            
            // Create the request
            const request: ArtifactCreateRequest = {
                id: artifactId,
                header: encryptedHeader,
                body: encryptedBody,
                dataEncryptionKey: encodeBase64(encryptedKey, 'base64'),
            };
            
            // Send to server
            const artifact = await createArtifact(this.credentials, request);
            
            // Add to local storage
            const decryptedArtifact: DecryptedArtifact = {
                id: artifact.id,
                title,
                sessions,
                draft,
                body,
                headerVersion: artifact.headerVersion,
                bodyVersion: artifact.bodyVersion,
                seq: artifact.seq,
                createdAt: artifact.createdAt,
                updatedAt: artifact.updatedAt,
                isDecrypted: true,
            };
            
            storage.getState().addArtifact(decryptedArtifact);
            
            return artifactId;
        } catch (error) {
            console.error('Failed to create artifact:', error);
            throw error;
        }
    }

    public async updateArtifact(
        artifactId: string, 
        title: string | null, 
        body: string | null,
        sessions?: string[],
        draft?: boolean
    ): Promise<void> {
        if (!this.credentials) {
            throw new Error('Not authenticated');
        }

        try {
            // Get current artifact to get versions and encryption key
            const currentArtifact = storage.getState().artifacts[artifactId];
            if (!currentArtifact) {
                throw new Error('Artifact not found');
            }

            // Get the data encryption key from memory or fetch it
            let dataEncryptionKey = this.artifactDataKeys.get(artifactId);
            
            // Fetch full artifact if we don't have version info or encryption key
            let headerVersion = currentArtifact.headerVersion;
            let bodyVersion = currentArtifact.bodyVersion;
            
            if (headerVersion === undefined || bodyVersion === undefined || !dataEncryptionKey) {
                const fullArtifact = await fetchArtifact(this.credentials, artifactId);
                headerVersion = fullArtifact.headerVersion;
                bodyVersion = fullArtifact.bodyVersion;
                
                // Decrypt and store the data encryption key if we don't have it
                if (!dataEncryptionKey) {
                    const decryptedKey = await this.encryption.decryptEncryptionKey(fullArtifact.dataEncryptionKey);
                    if (!decryptedKey) {
                        throw new Error('Failed to decrypt encryption key');
                    }
                    this.artifactDataKeys.set(artifactId, decryptedKey);
                    dataEncryptionKey = decryptedKey;
                }
            }

            // Create artifact encryption instance
            const artifactEncryption = new ArtifactEncryption(dataEncryptionKey);

            // Prepare update request
            const updateRequest: ArtifactUpdateRequest = {};
            
            // Check if header needs updating (title, sessions, or draft changed)
            if (title !== currentArtifact.title || 
                JSON.stringify(sessions) !== JSON.stringify(currentArtifact.sessions) ||
                draft !== currentArtifact.draft) {
                const encryptedHeader = await artifactEncryption.encryptHeader({ 
                    title, 
                    sessions, 
                    draft 
                });
                updateRequest.header = encryptedHeader;
                updateRequest.expectedHeaderVersion = headerVersion;
            }

            // Only update body if it changed
            if (body !== currentArtifact.body) {
                const encryptedBody = await artifactEncryption.encryptBody({ body });
                updateRequest.body = encryptedBody;
                updateRequest.expectedBodyVersion = bodyVersion;
            }

            // Skip if no changes
            if (Object.keys(updateRequest).length === 0) {
                return;
            }

            // Send update to server
            const response = await updateArtifact(this.credentials, artifactId, updateRequest);
            
            if (!response.success) {
                // Handle version mismatch
                if (response.error === 'version-mismatch') {
                    throw new Error('Artifact was modified by another client. Please refresh and try again.');
                }
                throw new Error('Failed to update artifact');
            }

            // Update local storage
            const updatedArtifact: DecryptedArtifact = {
                ...currentArtifact,
                title,
                sessions,
                draft,
                body,
                headerVersion: response.headerVersion !== undefined ? response.headerVersion : headerVersion,
                bodyVersion: response.bodyVersion !== undefined ? response.bodyVersion : bodyVersion,
                updatedAt: Date.now(),
            };
            
            storage.getState().updateArtifact(updatedArtifact);
        } catch (error) {
            console.error('Failed to update artifact:', error);
            throw error;
        }
    }

    private fetchMachines = async () => {
        if (!this.credentials) {
            log.log('🖥️ fetchMachines: no credentials, skipping');
            return;
        }

        const API_ENDPOINT = getServerUrl();
        log.log(`🖥️ fetchMachines: GET ${API_ENDPOINT}/v1/machines`);
        const response = await fetchWithTimeout(`${API_ENDPOINT}/v1/machines`, {
            headers: {
                'Authorization': `Bearer ${this.credentials.token}`,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            const body = await response.text();
            log.log(`🖥️ fetchMachines: failed status=${response.status} body=${body.slice(0, 200)}`);
            return;
        }

        const data = await response.json();
        const count = Array.isArray(data) ? data.length : 0;
        log.log(`🖥️ fetchMachines: got ${count} machines from server`);
        const machines = data as Array<{
            id: string;
            metadata: string;
            metadataVersion: number;
            daemonState?: string | null;
            daemonStateVersion?: number;
            dataEncryptionKey?: string | null; // Add support for per-machine encryption keys
            seq: number;
            active: boolean;
            activeAt: number;  // Changed from lastActiveAt
            createdAt: number;
            updatedAt: number;
        }>;

        // First, collect and decrypt encryption keys for all machines
        const machineKeysMap = new Map<string, Uint8Array | null>();
        const wrappedKeys: Record<string, string> = {};
        for (const machine of machines) {
            if (machine.dataEncryptionKey) {
                const decryptedKey = await this.encryption.decryptEncryptionKey(machine.dataEncryptionKey);
                if (!decryptedKey) {
                    console.error(`Failed to decrypt data encryption key for machine ${machine.id}`);
                    continue;
                }
                machineKeysMap.set(machine.id, decryptedKey);
                this.machineDataKeys.set(machine.id, decryptedKey);
                wrappedKeys[machine.id] = machine.dataEncryptionKey;
            } else {
                machineKeysMap.set(machine.id, null);
            }
        }

        saveWrappedMachineKeys({ ...loadWrappedMachineKeys(), ...wrappedKeys });
        // A key that arrives after the sighting is what makes the machine usable; nothing else re-checks.
        this.reconcileDaemonSockets();

        // Initialize machine encryptions
        await this.encryption.initializeMachines(machineKeysMap);

        // Process all machines first, then update state once
        const decryptedMachines: Machine[] = [];

        for (const machine of machines) {
            // Get machine-specific encryption (might exist from previous initialization)
            const machineEncryption = this.encryption.getMachineEncryption(machine.id);
            if (!machineEncryption) {
                console.error(`Machine encryption not found for ${machine.id} - this should never happen`);
                continue;
            }

            try {

                // Use machine-specific encryption (which handles fallback internally)
                const metadata = machine.metadata
                    ? await machineEncryption.decryptMetadata(machine.metadataVersion, machine.metadata)
                    : null;

                const daemonState = machine.daemonState
                    ? await machineEncryption.decryptDaemonState(machine.daemonStateVersion || 0, machine.daemonState)
                    : null;

                decryptedMachines.push({
                    id: machine.id,
                    seq: machine.seq,
                    createdAt: machine.createdAt,
                    updatedAt: machine.updatedAt,
                    active: machine.active,
                    activeAt: machine.activeAt,
                    metadata,
                    metadataVersion: machine.metadataVersion,
                    daemonState,
                    daemonStateVersion: machine.daemonStateVersion || 0
                });
            } catch (error) {
                console.error(`Failed to decrypt machine ${machine.id}:`, error);
                // Still add the machine with null metadata
                decryptedMachines.push({
                    id: machine.id,
                    seq: machine.seq,
                    createdAt: machine.createdAt,
                    updatedAt: machine.updatedAt,
                    active: machine.active,
                    activeAt: machine.activeAt,
                    metadata: null,
                    metadataVersion: machine.metadataVersion,
                    daemonState: null,
                    daemonStateVersion: 0
                });
            }
        }

        for (const machine of decryptedMachines) {
            storage.getState().applyRelayEndpoint(machine.id, parseRelayEndpoint(machine.id, machine.daemonState));
            storage.getState().applyLanEndpoint(machine.id, parseLanEndpoints(machine.id, machine.daemonState));
        }
        // Replace entire machine state with fetched machines
        storage.getState().applyMachines(decryptedMachines, true);
        log.log(`🖥️ fetchMachines completed - processed ${decryptedMachines.length} machines`);
    }

    private fetchFriends = async () => {
        if (!this.credentials) return;
        
        try {
            log.log('👥 Fetching friends list...');
            const friendsList = await getFriendsList(this.credentials);
            storage.getState().applyFriends(friendsList);
            log.log(`👥 fetchFriends completed - processed ${friendsList.length} friends`);
        } catch (error) {
            console.error('Failed to fetch friends:', error);
            // Silently handle error - UI will show appropriate state
        }
    }

    private fetchFriendRequests = async () => {
        // Friend requests are now included in the friends list with status='pending'
        // This method is kept for backward compatibility but does nothing
        log.log('👥 fetchFriendRequests called - now handled by fetchFriends');
    }

    private fetchFeed = async () => {
        if (!this.credentials) return;

        try {
            log.log('📰 Fetching feed...');
            const state = storage.getState();
            const existingItems = state.feedItems;
            const head = state.feedHead;
            
            // Load feed items - if we have a head, load newer items
            let allItems: FeedItem[] = [];
            let hasMore = true;
            let cursor = head ? { after: head } : undefined;
            let loadedCount = 0;
            const maxItems = 500;
            
            // Keep loading until we reach known items or hit max limit
            while (hasMore && loadedCount < maxItems) {
                const response = await fetchFeed(this.credentials, {
                    limit: 100,
                    ...cursor
                });
                
                // Check if we reached known items
                const foundKnown = response.items.some(item => 
                    existingItems.some(existing => existing.id === item.id)
                );
                
                allItems.push(...response.items);
                loadedCount += response.items.length;
                hasMore = response.hasMore && !foundKnown;
                
                // Update cursor for next page
                if (response.items.length > 0) {
                    const lastItem = response.items[response.items.length - 1];
                    cursor = { after: lastItem.cursor };
                }
            }
            
            // If this is initial load (no head), also load older items
            if (!head && allItems.length < 100) {
                const response = await fetchFeed(this.credentials, {
                    limit: 100
                });
                allItems.push(...response.items);
            }
            
            // Collect user IDs from friend-related feed items
            const userIds = new Set<string>();
            allItems.forEach(item => {
                if (item.body && (item.body.kind === 'friend_request' || item.body.kind === 'friend_accepted')) {
                    userIds.add(item.body.uid);
                }
            });
            
            // Fetch missing users
            if (userIds.size > 0) {
                await this.assumeUsers(Array.from(userIds));
            }
            
            // Filter out items where user is not found (404)
            const users = storage.getState().users;
            const compatibleItems = allItems.filter(item => {
                // Keep text items
                if (item.body.kind === 'text') return true;
                
                // For friend-related items, check if user exists and is not null (404)
                if (item.body.kind === 'friend_request' || item.body.kind === 'friend_accepted') {
                    const userProfile = users[item.body.uid];
                    // Keep item only if user exists and is not null
                    return userProfile !== null && userProfile !== undefined;
                }
                
                return true;
            });
            
            // Apply only compatible items to storage
            storage.getState().applyFeedItems(compatibleItems);
            log.log(`📰 fetchFeed completed - loaded ${compatibleItems.length} compatible items (${allItems.length - compatibleItems.length} filtered)`);
        } catch (error) {
            console.error('Failed to fetch feed:', error);
        }
    }

    private syncSettings = async () => {
        if (!this.credentials) return;

        const API_ENDPOINT = getServerUrl();
        const maxRetries = 3;
        let retryCount = 0;

        // Apply pending settings
        if (Object.keys(this.pendingSettings).length > 0) {

            while (retryCount < maxRetries) {
                let version = storage.getState().settingsVersion;
                let settings = applySettings(storage.getState().settings, this.pendingSettings);
                const response = await fetchWithTimeout(`${API_ENDPOINT}/v1/account/settings`, {
                    method: 'POST',
                    body: JSON.stringify({
                        settings: await this.encryption.encryptRaw(settings),
                        expectedVersion: version ?? 0
                    }),
                    headers: {
                        'Authorization': `Bearer ${this.credentials.token}`,
                        'Content-Type': 'application/json'
                    }
                });
                const data = await response.json() as {
                    success: false,
                    error: string,
                    currentVersion: number,
                    currentSettings: string | null
                } | {
                    success: true
                };
                if (data.success) {
                    this.pendingSettings = {};
                    savePendingSettings({});
                    break;
                }
                if (data.error === 'version-mismatch') {
                    // Parse server settings
                    const serverSettings = data.currentSettings
                        ? settingsParse(await this.encryption.decryptRaw(data.currentSettings))
                        : { ...settingsDefaults };

                    // Merge: server base + our pending changes (our changes win)
                    const mergedSettings = applySettings(serverSettings, this.pendingSettings);

                    // Update local storage with merged result at server's version
                    storage.getState().applySettings(mergedSettings, data.currentVersion);

                    // Sync tracking state with merged settings
                    if (tracking) {
                        mergedSettings.analyticsOptOut ? tracking.optOut() : tracking.optIn();
                    }

                    // Log and retry
                    console.log('settings version-mismatch, retrying', {
                        serverVersion: data.currentVersion,
                        retry: retryCount + 1,
                        pendingKeys: Object.keys(this.pendingSettings)
                    });
                    retryCount++;
                    continue;
                } else {
                    throw new Error(`Failed to sync settings: ${data.error}`);
                }
            }
        }

        // If exhausted retries, throw to trigger outer backoff delay
        if (retryCount >= maxRetries) {
            throw new Error(`Settings sync failed after ${maxRetries} retries due to version conflicts`);
        }

        // Run request
        const response = await fetchWithTimeout(`${API_ENDPOINT}/v1/account/settings`, {
            headers: {
                'Authorization': `Bearer ${this.credentials.token}`,
                'Content-Type': 'application/json'
            }
        });
        if (!response.ok) {
            throw new Error(`Failed to fetch settings: ${response.status}`);
        }
        const data = await response.json() as {
            settings: string | null,
            settingsVersion: number
        };

        // Parse response
        let parsedSettings: Settings;
        if (data.settings) {
            parsedSettings = settingsParse(await this.encryption.decryptRaw(data.settings));
        } else {
            parsedSettings = { ...settingsDefaults };
        }

        // Log
        console.log('settings', JSON.stringify({
            settings: parsedSettings,
            version: data.settingsVersion
        }));

        // Apply settings to storage
        storage.getState().applySettings(parsedSettings, data.settingsVersion);

        // Sync PostHog opt-out state with settings
        if (tracking) {
            if (parsedSettings.analyticsOptOut) {
                tracking.optOut();
            } else {
                tracking.optIn();
            }
        }
    }

    private fetchProfile = async () => {
        if (!this.credentials) return;

        const API_ENDPOINT = getServerUrl();
        const response = await fetchWithTimeout(`${API_ENDPOINT}/v1/account/profile`, {
            headers: {
                'Authorization': `Bearer ${this.credentials.token}`,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch profile: ${response.status}`);
        }

        const data = await response.json();
        const parsedProfile = profileParse(data);

        // Log profile data for debugging
        console.log('profile', JSON.stringify({
            id: parsedProfile.id,
            timestamp: parsedProfile.timestamp,
            firstName: parsedProfile.firstName,
            lastName: parsedProfile.lastName,
            hasAvatar: !!parsedProfile.avatar,
            hasGitHub: !!parsedProfile.github
        }));

        // Apply profile to storage
        storage.getState().applyProfile(parsedProfile);
    }

    private fetchNativeUpdate = async () => {
        try {
            // Skip in development
            if ((Platform.OS !== 'android' && Platform.OS !== 'ios') || !Constants.expoConfig?.version) {
                return;
            }
            if (Platform.OS === 'ios' && !Constants.expoConfig?.ios?.bundleIdentifier) {
                return;
            }
            if (Platform.OS === 'android' && !Constants.expoConfig?.android?.package) {
                return;
            }

            const serverUrl = getServerUrl();

            // Get platform and app identifiers
            const platform = Platform.OS;
            const version = Constants.expoConfig?.version!;
            const appId = (Platform.OS === 'ios' ? Constants.expoConfig?.ios?.bundleIdentifier! : Constants.expoConfig?.android?.package!);

            const response = await fetchWithTimeout(`${serverUrl}/v1/version`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    platform,
                    version,
                    app_id: appId,
                }),
            });

            if (!response.ok) {
                console.log(`[fetchNativeUpdate] Request failed: ${response.status}`);
                return;
            }

            const data = await response.json();
            console.log('[fetchNativeUpdate] Data:', data);

            // Apply update status to storage
            if (data.update_required && data.update_url) {
                storage.getState().applyNativeUpdateStatus({
                    available: true,
                    updateUrl: data.update_url
                });
            } else {
                storage.getState().applyNativeUpdateStatus({
                    available: false
                });
            }
        } catch (error) {
            console.log('[fetchNativeUpdate] Error:', error);
            storage.getState().applyNativeUpdateStatus(null);
        }
    }

    private syncPurchases = async () => {
        try {
            // Initialize RevenueCat if not already done
            if (!this.revenueCatInitialized) {
                // Get the appropriate API key based on platform
                let apiKey: string | undefined;

                if (Platform.OS === 'ios') {
                    apiKey = config.revenueCatAppleKey;
                } else if (Platform.OS === 'android') {
                    apiKey = config.revenueCatGoogleKey;
                } else if (Platform.OS === 'web') {
                    apiKey = config.revenueCatStripeKey;
                }

                if (!apiKey) {
                    console.log(`RevenueCat: No API key found for platform ${Platform.OS}`);
                    return;
                }

                // Configure RevenueCat
                if (__DEV__) {
                    RevenueCat.setLogLevel(LogLevel.DEBUG);
                }

                // Initialize with the public ID as user ID
                RevenueCat.configure({
                    apiKey,
                    appUserID: this.serverID, // In server this is a CUID, which we can assume is globaly unique even between servers
                    useAmazon: false,
                });

                this.revenueCatInitialized = true;
                console.log('RevenueCat initialized successfully');
            }

            // Sync purchases
            await RevenueCat.syncPurchases();

            // Fetch customer info
            const customerInfo = await RevenueCat.getCustomerInfo();

            // Apply to storage (storage handles the transformation)
            storage.getState().applyPurchases(customerInfo);

        } catch (error) {
            console.error('Failed to sync purchases:', error);
            // Don't throw - purchases are optional
        }
    }

    private flushOutbox = async (sessionId: string) => {
        const pending = this.pendingOutbox.get(sessionId);
        if (!pending || pending.length === 0) {
            return;
        }

        /**
         * Entries leave the queue when they *settle*, not when they are written.
         *
         * A write is not an outcome. On the daemon channels it proves only that this side handed
         * bytes to a socket — a socket whose peer may already be gone, in which case the write
         * succeeds, the session never sees the message, and the entry used to be dropped from the
         * queue here on the strength of that write alone. The user's next message then went
         * through fine, which is what made this look like "the first message is always lost".
         * Keeping it queued means a later flush — the delivery timer below, a fresh connection, or
         * simply the next message — can send it again, and the session dedups repeats on `localId`,
         * so sending it twice costs nothing.
         */
        const outstanding = pending.filter((msg) => storage.getState().outbox[msg.localId]?.status === 'sending');
        if (outstanding.length !== pending.length) {
            pending.length = 0;
            pending.push(...outstanding);
        }
        if (pending.length === 0) {
            this.pendingOutbox.delete(sessionId);
            return;
        }
        const batch = pending.slice();

        // A session the machine itself reports as not running cannot take a message, and writing
        // one anyway is what times out: the socket accepts it, no process is there to read it.
        // Starting the process is the daemon's own call, so it works when this is the only session
        // and it is down — which is the state a reboot leaves every session in.
        if (this.sessionReportedDown(sessionId)) {
            const wake = await this.wakeSession(sessionId);
            if (wake === 'failed') {
                for (const msg of batch) {
                    storage.getState().failOutboxEntries(
                        [msg.localId],
                        'The session is not running, and this machine could not start it.',
                    );
                }
                pending.splice(0, batch.length);
                if (pending.length === 0) {
                    this.pendingOutbox.delete(sessionId);
                }
                return;
            }
        }

        // The walk itself lives in `channels/ops.ts`, where its order and what each rung's answer
        // means are pinned down by tests rather than by reading this method. What stays here is the
        // queue: what leaving it means, and what each outcome settles.
        const controller = new AbortController();
        this.sendAbortControllers.set(sessionId, controller);
        let result: SendResult;
        try {
            result = await sendBatch({
                daemon: this.daemonSendTarget(sessionId)?.handle ?? null,
                server: apiSocket,
                sessionId,
                batch,
                signal: controller.signal,
            });
        } finally {
            this.sendAbortControllers.delete(sessionId);
        }

        if (result.kind === 'unconfirmed') {
            // A write over the machine's own channel is not a delivery. There the server echoes the
            // message back so a fast-ack is a claim it will honour; here nothing confirms the write
            // but the session itself, and treating the write as the delivery is exactly what hides
            // a dropped message. Each entry waits for that verdict, and fails if it never arrives.
            for (const msg of batch) {
                this.awaitLanDelivery(msg.localId);
            }
            return;
        }
        if (result.kind === 'failed') {
            this.maybeStartBackgroundSendWatchdog();
            throw result.error;
        }

        pending.splice(0, batch.length);
        // Server confirmed – mark as acked (green check). The echo (fast-ack or text-matched
        // session-protocol echo) will remove it.
        for (const msg of batch) {
            storage.getState().markOutboxMessageAcked(msg.localId);
        }
        if (result.over === 'socket') {
            // WS send has no seq ack — pull receive cursor forward via HTTP.
            this.getMessagesSync(sessionId).invalidate();
        } else if (result.advanceTo !== undefined) {
            // The one path that says where the session now stands: the server answered with the seqs
            // it assigned, so the receive cursor moves with it rather than being pulled.
            const currentLastSeq = this.sessionLastSeq.get(sessionId) ?? 0;
            if (result.advanceTo > currentLastSeq) {
                this.sessionLastSeq.set(sessionId, result.advanceTo);
            }
        }

        if (pending.length === 0) {
            this.pendingOutbox.delete(sessionId);
        }
        if (!this.hasPendingOutboxMessages()) {
            this.clearBackgroundSendWatchdog();
            await this.cancelBackgroundSendTimeoutNotification();
            this.backgroundSendStartedAt = null;
        } else if (this.appState !== 'active') {
            this.maybeStartBackgroundSendWatchdog();
        }
    }

    /**
     * How long a waiter for a fetch slot waits before looking again.
     *
     * The pool reclaims an expired lease on its own, but only when someone asks it for a slot — and
     * the queue of waiters was pumped *only* by a release. So a holder that never released (a fetch
     * suspended mid-request on iOS, or one waiting on a wedged SQLite call, whose `finally` never
     * ran) left every waiter behind it parked for the life of the process, even though its own slot
     * had long since been reclaimed: opening a session printed "acquiring lock" and then nothing.
     * A waiter that looks again on its own is what makes the lease worth having.
     */
    private static readonly FETCH_SLOT_RETRY_MS = 2_000;

    /** The one timer that keeps looking while waiters exist, so waiting is not tied to a release. */
    private fetchSlotTimer: ReturnType<typeof setTimeout> | null = null;

    private acquireMessageFetchSlot = (): Promise<number> => {
        const token = this.messageFetchSlots.tryAcquire(Date.now());
        if (token !== null) {
            return Promise.resolve(token);
        }
        return new Promise<number>((resolve) => {
            this.messageFetchQueue.push(resolve);
            this.armMessageFetchPump();
        });
    };

    private releaseMessageFetchSlot = (token: number): void => {
        // False means the lease was reclaimed while this fetch was still running: the slot already
        // belongs to someone else, and freeing it again would let one more fetch through than the
        // limit allows.
        if (!this.messageFetchSlots.release(token)) {
            return;
        }
        this.pumpMessageFetchQueue();
    };

    /** Keeps one timer alive for as long as anyone is waiting, and no longer. */
    private armMessageFetchPump = (): void => {
        if (this.fetchSlotTimer !== null || this.messageFetchQueue.length === 0) {
            return;
        }
        this.fetchSlotTimer = setTimeout(() => {
            this.fetchSlotTimer = null;
            this.pumpMessageFetchQueue();
            this.armMessageFetchPump();
        }, Sync.FETCH_SLOT_RETRY_MS);
        (this.fetchSlotTimer as unknown as { unref?: () => void }).unref?.();
    };

    private pumpMessageFetchQueue = (): void => {
        while (this.messageFetchQueue.length > 0) {
            const token = this.messageFetchSlots.tryAcquire(Date.now());
            if (token === null) {
                return;
            }
            const next = this.messageFetchQueue.shift();
            if (!next) {
                this.messageFetchSlots.release(token);
                return;
            }
            next(token);
        }
    };

    /**
     * The daemon channel's reaction to the network moving under it.
     *
     * The server channel hears about a network change twice over — socket.io's transport fails on
     * its own, and this listener probes — but a daemon socket is a plain WebSocket to an address
     * that belongs to the network we were on. On WiFi → cellular that address is not reachable and
     * the socket is not told; worse, a session whose socket still looks alive has neither a push
     * (the socket is dead) nor a poll (polling stops while a socket is up), so it simply goes
     * quiet. What is stale is everything about *how* to reach a machine: the address, the token
     * bound to the connection, the socket, and the sightings that described the old network.
     */
    /**
     * Treats a changed device address as the network move it is.
     *
     * `expo-network` reports connectivity and interface type, not which network: a phone that
     * joins another WiFi is still connected, still `WIFI`, and the listener stays silent. Its own
     * address is the difference, and it is the fact every LAN candidate was evaluated against —
     * so a change here re-arms what the last network taught us, exactly as a reported switch does.
     */
    private async detectNetworkMove(): Promise<void> {
        if (Platform.OS === 'web') {
            return;
        }
        let ip: string;
        try {
            ip = await Network.getIpAddressAsync();
        } catch {
            return; // no address to compare is not evidence of a move
        }
        if (!ip || ip === '0.0.0.0') {
            return;
        }
        const previous = this.lastDeviceIp;
        this.lastDeviceIp = ip;
        if (previous !== null && previous !== ip) {
            log.log(`🌐 Device address changed (${previous} → ${ip}); treating it as a network move`);
            this.onNetworkChanged('switched');
        }
    }

    private onNetworkChanged(reason: 'lost' | 'regained' | 'switched'): void {
        // Only what is *known* about reaching a machine is discarded — the cached address and the
        // token bound to it, and the sightings, which describe the network we were on. The sockets
        // are deliberately left alone: a socket that the change actually broke will say so through
        // its own close event, which is the same path that already clears it and reconnects, and a
        // socket it did not break is still the channel. Tearing them down here made every network
        // hiccup close and reopen the connection, and `expo-network` reports those hiccups often
        // enough for that to be the bulk of the socket churn.
        this.lanMachineConnections.clear();
        // And what each address has done, for the same reason: an address that did not answer on the
        // last network is not evidence about this one. This is one of the few things that re-arms a
        // demoted address, and it is why a device that moves networks recovers without waiting out a
        // backoff.
        storage.getState().rearmCandidateHealth();
        if (reason !== 'regained') {
            // A device that never lost connectivity may have moved networks without a gap — but a
            // return to connectivity is the same network it left.
            storage.getState().clearLanSightings();
        }
        // Rate-limited: the listener is chatty, and invalidating every session on each report is a
        // storm of reads for information that has not changed twice.
        const now = Date.now();
        if (now - this.lastNetworkChangeHandledAt < Sync.NETWORK_CHANGE_COOLDOWN_MS) {
            return;
        }
        this.lastNetworkChangeHandledAt = now;
        this.reconcileDaemonSockets();
        // A network change invalidating every session causes a fetch storm that delays the
        // session the user is actually looking at. Use the scheduler instead.
        this.readScheduler.markStale();
    }

    /** A network report is a hint, not an event: several arrive for one change. */
    private static readonly NETWORK_CHANGE_COOLDOWN_MS = 10_000;
    private lastNetworkChangeHandledAt = 0;

    /**
     * What the channel currently holds for a session, for the Dev Tools page.
     *
     * A conversation that is missing messages cannot be diagnosed from the outside: "delivered but
     * not opened", "the window never covered it" and "the reader believes it is up to date" all look
     * the same from a log of reads. These are the numbers that tell them apart.
     */
    channelDiagnostics(sessionId: string | null): {
        channel: string;
        window: string;
        hasOlder: boolean;
        readTo: string | null;
        pushedTo: string | null;
        logHead: string | null;
        lastRead: string;
    } | null {
        if (!sessionId) {
            return null;
        }
        const state = storage.getState();
        const messages = state.sessionMessages[sessionId];
        const link = this.daemonLinks.get(sessionId);
        const lastRead = state.sessionMessages[sessionId]?.isFetching ? 'in flight' : 'idle';
        return {
            channel: this.preferredChannel(sessionId),
            window: messages ? `${messages.oldestSeq}–${messages.newestSeq} (${messages.messages.length} messages)` : 'none',
            hasOlder: messages?.hasOlderMessages ?? false,
            readTo: link?.cursor ?? null,
            pushedTo: this.pushedPositions.get(sessionId) ?? null,
            logHead: this.lastHintHeads.get(sessionId) ?? null,
            lastRead,
        };
    }

    /** The fetch pool as the Dev Tools page reads it: a stuck pool is otherwise invisible. */
    fetchSlotStats(): { inFlight: number; queued: number; oldestMs: number } {
        return {
            inFlight: this.messageFetchSlots.inFlight,
            queued: this.messageFetchQueue.length,
            oldestMs: this.messageFetchSlots.oldestHeldFor(Date.now()),
        };
    }

    /**
     * Stops what a superseded module evaluation left running.
     *
     * Metro replaces this module on a hot reload without tearing down the old instance's timers or
     * listeners. The two then share the store and the socket: the old one kept a two-second poll
     * alive for a session no longer on screen (observed as `read scheduled … (visible)` for a
     * session the user had already left) and both reacted to every push. One evaluation owns the
     * background work; the next stops it before taking over.
     */
    stopBackgroundWork(): void {
        this.readScheduler.stop();
        if (this.sessionsRefreshInterval !== null) {
            clearInterval(this.sessionsRefreshInterval);
            this.sessionsRefreshInterval = null;
        }
        for (const timer of this.cacheSaveTimers.values()) {
            clearTimeout(timer);
        }
        this.cacheSaveTimers.clear();
        for (const timer of this.logGrewReadTimers.values()) {
            clearTimeout(timer);
        }
        this.logGrewReadTimers.clear();
        for (const timer of this.messageReadDeadlines.values()) {
            clearTimeout(timer);
        }
        this.messageReadDeadlines.clear();
        for (const timer of this.pushedEntryTimers.values()) {
            clearTimeout(timer);
        }
        this.pushedEntryTimers.clear();
        this.pushedEntryBatches.clear();
        this.reconnectedCleanup?.();
        this.reconnectedCleanup = null;
        this.appStateSubscription?.remove();
        this.appStateSubscription = null;
        this.networkStateSubscription?.remove();
        this.networkStateSubscription = null;
        for (const sync of this.messagesSync.values()) {
            sync.stop();
        }
        this.messagesSync.clear();
        for (const sync of this.sendSync.values()) {
            sync.stop();
        }
        this.sendSync.clear();
    }

    recoverFetchesAfterSuspend(): void {
        const waiting = this.messageFetchQueue.length;
        this.messageFetchSlots.reset();
        this.pumpMessageFetchQueue();
        // A hydration suspended mid-read will never settle either; drop it so the next open reads
        // again instead of awaiting a promise from the previous JS execution.
        this.hydratingSessions.clear();
        for (const lock of this.sessionMessageLocks.values()) {
            lock.reset();
        }
        log.log(`📱 Cleared fetch state after a suspension (${waiting} queued, ${this.sessionMessageLocks.size} session locks)`);
    }

    /**
     * Retry a previously failed outbox message identified by its localId.
     * Reuses the same localId so the existing bubble is reused (no duplicate).
     */
    retryMessage = async (localId: string): Promise<void> => {
        const entry = storage.getState().outbox[localId];
        if (!entry || entry.status !== 'failed') return;

        // Pass existingLocalId so sendMessage resets the outbox entry to 'sending'
        // and skips creating a second optimistic bubble.
        await this.sendMessage(entry.sessionId, entry.text, entry.displayText, localId);
    }

    /**
     * Returns true if a fetchMessages error is a transient network/HTTP failure
     * worth retrying via InvalidateSync's backoff. Logical errors (decryption,
     * normalization, malformed data) return false — retrying them would spin
     * forever with no chance of success.
     */
    private isRetryableMessageFetchError(err: unknown): boolean {
        if (!(err instanceof Error)) return false;
        const msg = err.message.toLowerCase();
        // HTTP status errors (5xx/4xx) — server may be transiently unavailable.
        if (/failed to fetch messages/.test(msg)) return true;
        // Network-level failures and timeouts.
        if (/network|fetch failed|timeout|econnrefused|econnreset|etimedout|enotfound|abort/i.test(msg)) return true;
        return false;
    }

    /**
     * If we later see the server echo a user message that matches one of our optimistic
     * outbox entries, treat it as delivered even if the original POST is still retrying.
     * This prevents Linux/Tauri foreground sends from spinning forever after a lost response.
     */
    private markOutboxMessageDelivered(sessionId: string, localId: string) {
        storage.getState().removeOutboxEntry(localId);

        const pending = this.pendingOutbox.get(sessionId);
        if (pending) {
            const remaining = pending.filter((message) => message.localId !== localId);
            if (remaining.length !== pending.length) {
                if (remaining.length === 0) {
                    this.pendingOutbox.delete(sessionId);

                    // If the queue is now empty but the original request is still hung,
                    // abort it so InvalidateSync can settle and future sends are not blocked.
                    const controller = this.sendAbortControllers.get(sessionId);
                    if (controller) {
                        controller.abort();
                    }
                } else {
                    this.pendingOutbox.set(sessionId, remaining);
                }
            }
        }

        if (!this.hasPendingOutboxMessages()) {
            this.clearBackgroundSendWatchdog();
            void this.cancelBackgroundSendTimeoutNotification();
            this.backgroundSendStartedAt = null;
        }
    }

    /**
     * In session-protocol mode, user messages are echoed back as session envelopes without
     * the original localId. This method checks if an incoming user message (with localId=null)
     * matches a recently sent message and, if so, claims and returns the original localId.
     * Returns null if no match found.
     */
    private claimSentMessageLocalId(sessionId: string, text: string): string | null {
        const pending = this.sentMessageLocalIds.get(sessionId);
        if (!pending || pending.length === 0) return null;
        const idx = pending.findIndex(e => e.text === text);
        if (idx === -1) return null;
        const localId = pending[idx].localId;
        pending.splice(idx, 1);
        if (pending.length === 0) {
            this.sentMessageLocalIds.delete(sessionId);
        }
        return localId;
    }

    /**
     * Resolve a localId for an incoming server message (serverMsgId) that arrived without one.
     *
     * Race-condition-safe: handleUpdate and fetchMessages may both process the same server
     * message. The first caller claims the localId from sentMessageLocalIds and registers the
     * mapping in claimedServerMessageIds. The second caller finds it already registered and
     * reuses it – preventing the reducer from creating a second, duplicate message.
     */
    private resolveLocalIdForIncoming(sessionId: string, serverMsgId: string, text: string, incomingLocalId?: string | null): string | null {
        // Already claimed by another code path → reuse the same localId.
        const existing = this.claimedServerMessageIds.get(serverMsgId);
        if (existing) return existing;

        // O(1) direct match: CLI echoed back the app's localId via envelope.id → server localId
        let localId: string | null = null;
        if (incomingLocalId) {
            localId = this.claimSentMessageLocalIdByValue(sessionId, incomingLocalId);
            if (localId) {
                console.log(`[Sync] resolveLocalId: ${serverMsgId} → ${localId} (direct localId match)`);
            }
        }
        // Fallback: text-based matching (legacy path for old CLI versions)
        if (!localId) {
            localId = this.claimSentMessageLocalId(sessionId, text);
        }
        if (localId) {
            this.claimedServerMessageIds.set(serverMsgId, localId);
            // Text match = session-protocol echo. Mark as acked (green).
            // The CLI pop echo (via echoedMessageId) will remove.
            storage.getState().markOutboxMessageAcked(localId);
        }
        return localId;
    }

    /** Direct localId lookup in sentMessageLocalIds — O(n) by value, avoids text ambiguity. */
    private claimSentMessageLocalIdByValue(sessionId: string, localId: string): string | null {
        const pending = this.sentMessageLocalIds.get(sessionId);
        if (!pending || pending.length === 0) return null;
        const idx = pending.findIndex(e => e.localId === localId);
        if (idx === -1) return null;
        pending.splice(idx, 1);
        if (pending.length === 0) {
            this.sentMessageLocalIds.delete(sessionId);
        }
        return localId;
    }

    /**
     * Fetch the latest page of messages for a session (up to 100).
     * Uses session.seq to compute the starting point so we only fetch the
     * newest 100 messages on cold start instead of paginating the full history.
     * Incremental updates (after a cache hit) still fetch from lastSeq forward.
     */
    /**
     * Applies the persisted window to the store, before anything takes the message lock.
     *
     * This used to run *inside* that lock, so a tap waited for whatever fetch was already in
     * flight for the same session — usually the one that hung and is the reason the lock is stuck.
     * Reading local state has no business waiting for network work, and the screen's first frame is
     * exactly this read; the lock now protects only the network half.
     *
     * It is also retried when a session is marked hydrated but holds nothing: the old code marked
     * before the read, so a cancelled read (backgrounding, a reload) left the session permanently
     * skipped — the "opens empty every time" shape.
     */
    private hydrateSession = async (sessionId: string): Promise<void> => {
        const inFlight = this.hydratingSessions.get(sessionId);
        if (inFlight) {
            return inFlight;
        }
        const state = storage.getState();
        const session = state.sessions[sessionId];
        if (!session) {
            return;
        }
        const existing = state.sessionMessages[sessionId]?.messages ?? [];
        if (existing.length > 0 && this.hydratedSessions.has(sessionId)) {
            // A window is already on screen and it came from this process's cache. Nothing to do.
            return;
        }
        if (existing.length > 0) {
            // Messages are held, but nothing has been hydrated in this process — after a reload
            // that is a live push that beat the cache to the store, not a window. Measured on a
            // device: ten pushed messages arrived 170ms after a tap and the cache's sixty-message
            // window was then refused ("already holds 10; nothing to load") for the rest of the
            // process. The cache is read and merged into what is held.
        }
        this.hydratedSessions.delete(sessionId);

        type Loaded = Awaited<ReturnType<typeof loadMessageCache>>;
        const apply = (cached: Loaded, startedAt: number): void => {
            if (!cached) {
                return;
            }
            // A live delivery may have landed while the cache was being read. That window is not
            // newer than the cache — it is usually a few pushed messages that belong *inside* the
            // cached one. It used to win by default, and after a reload that meant the screen kept
            // ten pushed messages and refused the sixty-message window it had on disk. Merge by
            // identity so neither side is dropped.
            const heldWindow = storage.getState().sessionMessages[sessionId];
            const held = heldWindow?.messages ?? [];
            const merged = held.length > 0 ? mergePageIntoWindow(held, cached.messages) : null;
            if (held.length > 0 && !merged) {
                this.hydratedSessions.add(sessionId);
                log.log(`💬 hydrate: ${sessionId} already held all ${held.length} cached message(s)`);
                return;
            }
            const messages = merged ? merged.messages : cached.messages;
            // The edges of the union, so a merged window never claims to be smaller — or newer —
            // than what it already held.
            const lastSeq = held.length > 0
                ? Math.max(cached.lastSeq, heldWindow?.newestSeq ?? 0)
                : cached.lastSeq;
            const oldestSeq = cached.oldestSeq > 0 && (heldWindow?.oldestSeq ?? 0) > 0
                ? Math.min(cached.oldestSeq, heldWindow!.oldestSeq)
                : Math.max(cached.oldestSeq, heldWindow?.oldestSeq ?? 0);
            const hasOlderMessages = cached.hasOlderMessages || (heldWindow?.hasOlderMessages ?? false);
            storage.getState().applyHydratedCache(
                sessionId,
                messages,
                cached.reducerState,
                oldestSeq,
                hasOlderMessages,
                lastSeq,
            );
            this.sessionLastSeq.set(sessionId, Math.max(cached.lastSeq, this.sessionLastSeq.get(sessionId) ?? 0));
            // Marked only once the window is in the store. Marking first meant a cancelled read
            // disabled the cache for the rest of the process.
            this.hydratedSessions.add(sessionId);
            log.log(
                `💬 hydrate: applied ${messages.length} cached messages for ${sessionId}` +
                ` in ${Date.now() - startedAt}ms (lastSeq=${lastSeq}, oldestSeq=${oldestSeq}` +
                `${merged ? `, +${merged.added.length} from cache` : ''})`
            );
        };

        const run = (async () => {
            const startedAt = Date.now();
            try {
                const pending = loadMessageCache(session, this.preferredChannel(sessionId) !== 'server');
                // The hot window resolves before the first await, so this deadline only ever bites
                // the SQLite fallback — and on a device that fallback was measured at 19–31s while
                // the cache connection was contended. Waiting that long is what an empty screen is;
                // the channel can fill the session, and the read is left running so its result is
                // still applied if it lands while the store is empty.
                const outcome = await Promise.race([
                    pending,
                    new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 2_000)),
                ]);
                if (outcome === 'timeout') {
                    log.log(`💬 hydrate: cache read for ${sessionId} still running after 2s; the channel will fill it`);
                    void pending
                        .then((cached) => { apply(cached, startedAt); })
                        .catch(() => { /* the channel is already carrying this session */ });
                    return;
                }
                if (!outcome) {
                    log.log(`💬 hydrate: no cache for ${sessionId} (will read from the channel)`);
                    return;
                }
                apply(outcome, startedAt);
            } catch (error) {
                log.log(`💬 hydrate: failed for ${sessionId}: ${String(error)}`);
            } finally {
                this.hydratingSessions.delete(sessionId);
            }
        })();
        this.hydratingSessions.set(sessionId, run);
        return run;
    };

    /**
     * The deadline for a message read that fell through to the server.
     *
     * A disconnected socket is the server saying it is not answering, so an HTTP read to it is not
     * going to fare better — and that read holds this session's only read lock, which means every
     * tick behind it waits too. Measured on a device during a daemon restart with the server down:
     * one request sat on its thirty-second deadline and the session showed nothing new the whole
     * time. A short deadline lets the next tick try the channel that is actually up.
     */
    private serverReadOptions(): RequestInit | undefined {
        if (apiSocket.isConnected) {
            return undefined;
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5_000);
        (timer as unknown as { unref?: () => void }).unref?.();
        return { signal: controller.signal };
    }

    /** Deadlines for in-flight server message reads, so `stopBackgroundWork` can clear them. */
    private messageReadDeadlines = new Map<string, ReturnType<typeof setTimeout>>();
    /**
     * Sessions whose daemon route answered and could not serve them, and until when.
     *
     * The resolver's input, so that "which channel is this session on" has one answer: while the
     * mark is live the session resolves to the server with `daemon-absent`; when it ages out the
     * daemon is tried again.
     */
    private daemonUnavailableUntil = new Map<string, number>();
    private static readonly DAEMON_ABSENT_RETRY_MS = 60_000;

    /**
     * The highest server-seq this App actually holds, per session — the server axis's watermark.
     *
     * Written only where server bytes were applied (this path and its fetch result); a daemon
     * read advancing its own counter must not move it, which is the whole point of the field:
     * the store's `newestSeq` cannot say this, because both channels write it.
     */
    private serverNewestSeq = new Map<string, number>();
    /**
     * The last seq the server itself reported for a session, learned from a server-served list.
     *
     * `session.seq` in the store cannot be trusted for the axis: when the server cannot answer,
     * the session list is served by a daemon, whose per-session counter is a different numbering.
     * This map remembers the server's number past such a fallback, so the up-to-date guard keeps
     * comparing like with like even while the list itself is daemon-numbered.
     */
    private serverSessionSeq = new Map<string, number>();
    /**
     * Which axis the session list in the store is currently numbered on. A daemon-served list
     * sets 'daemon', a server answer sets 'server'.
     */
    private sessionsListAxis: 'server' | 'daemon' = 'server';

    /**
     * The server-axis position of a session, for guards and fetch anchors.
     *
     * When the list came from the server, its `seq` is exactly that and is always the freshest
     * such number this App has. When the list came from a daemon, the store's `seq` is on the
     * daemon's axis and comparing against it would be meaningless in both directions — the last
     * number the server itself reported is used instead, and zero (never seen) means "no basis
     * to skip a fetch", which is the only safe answer.
     */
    private serverAxisSeq(sessionId: string, storeSeq: number): number {
        if (this.sessionsListAxis === 'server') {
            return storeSeq;
        }
        return this.serverSessionSeq.get(sessionId) ?? 0;
    }

    private fetchMessages = async (sessionId: string) => {
        // The cached window first, outside the lock: this is the tap's first frame.
        await this.hydrateSession(sessionId);
        log.log(`💬 fetchMessages starting for session ${sessionId} - acquiring lock`);
        const lock = this.getSessionMessageLock(sessionId);
        const held = lock.heldFor(Date.now());
        if (held > Sync.STUCK_MESSAGE_LOCK_MS) {
            log.log(`💬 fetchMessages: resetting a message lock held ${Math.round(held / 1000)}s for ${sessionId}`);
            lock.reset();
        }
        const lockRequestedAt = Date.now();
        await lock.inLock(async () => {
            const waited = Date.now() - lockRequestedAt;
            if (waited > 500) {
                log.log(`💬 fetchMessages: waited ${waited}ms for the message lock (${sessionId})`);
            }
            const slot = await this.acquireMessageFetchSlot();
            log.log(`💬 fetchMessages: got lock for ${sessionId}`);
            try {
                // A channel is chosen per session, and everything after this point is the same
                // whichever one it was: the read's bytes go through `ingestChannelRead`.
                //
                // The daemon's channel is read on the daemon — but only while the daemon can serve
                // the session. A machine that is not running it answers nothing for it: the session
                // belongs to a process that lives elsewhere, or died, or has no log on that machine
                // at all. Polling there forever leaves the conversation at whatever the cache holds,
                // which is what a session that "will not load" is — and the server is the other
                // channel that session may be on, so a tick the daemon could not serve falls through
                // to it rather than returning with nothing.
                //
                // A pin is the one exception: it exists to make the daemon path testable, so it must
                // mean the daemon and nothing else.
                if (this.preferredChannel(sessionId) !== 'server') {
                    const served = await this.fetchMessagesViaDaemon(sessionId);
                    // No silent fallback inside a read: the channel is the resolver's answer,
                    // and a read that disagrees with it is how one session ended up with two
                    // current channels (logged as `relay (by-priority)` and `asking the server`
                    // in the same breath). A failure is reported back to the resolver — the next
                    // tick resolves to the server explicitly, with the reason on record.
                    if (!served) {
                        log.log(`📡 fetchMessages: daemon could not serve ${sessionId}; the resolver will place it`);
                    }
                    return;
                }

                const encryption = this.encryption.getSessionEncryption(sessionId);
                if (!encryption) {
                    log.log(`💬 fetchMessages: Session encryption not ready for ${sessionId}, skipping`);
                    return;
                }

                const cachedLastSeq = this.sessionLastSeq.get(sessionId) ?? 0;
                const currentSession = storage.getState().sessions[sessionId];
                // The server's own numbering, and nothing else. The store's newestSeq mixes axes —
                // daemon reads and the daemon's session list both carry the daemon's counter —
                // so comparing it against the server's said "already up to date" about messages
                // this App had never seen (measured: local 3260 vs server 3082 on one session),
                // and anchoring a fetch from it asked the server for a position past its end,
                // which it answered with nothing. The server-axis watermark below is written
                // only by this path, so the comparison is at last apples to apples.
                const sessionSeq = this.serverAxisSeq(sessionId, currentSession?.seq ?? 0);
                const storedNewestSeq = this.serverNewestSeq.get(sessionId) ?? 0;

                // Already up-to-date: skip the API call and loading indicator entirely.
                if (storedNewestSeq > 0 && storedNewestSeq >= sessionSeq && sessionSeq > 0) {
                    log.log(`💬 fetchMessages: already up-to-date for ${sessionId} (serverNewestSeq=${storedNewestSeq} >= serverSeq=${sessionSeq}), skipping fetch`);
                    return;
                }

                // Only show the loading indicator now that we know a network request is needed.
                // Cold-start uses the full-screen loader (isLoaded=false), not this bottom spinner.
                // Skip the spinner when the seq increment is caused by our own outgoing message
                // (already shown optimistically) — avoids a spurious flash while the send is in flight.
                const alreadyLoaded = storage.getState().sessionMessages[sessionId]?.isLoaded ?? false;
                const hasPendingOutbox = (this.pendingOutbox.get(sessionId)?.length ?? 0) > 0;
                if (alreadyLoaded && !hasPendingOutbox) {
                    storage.getState().setFetching(sessionId, true);
                }

                // Always anchor to the latest 100 messages from session.seq.
                // If storedNewestSeq is recent (gap < 100), afterSeq = storedNewestSeq (incremental).
                // If storedNewestSeq is stale (gap > 100), afterSeq = sessionSeq - 100 (jump to latest).
                // Using the store's newestSeq (not sessionLastSeq) ensures a missed-message gap
                // is re-fetched from the last message actually in the list, not from a seq that
                // was only ever seen over the wire.
                const latestAnchor = Math.max(0, sessionSeq - 100);
                const afterSeq = storedNewestSeq > 0
                    ? Math.max(storedNewestSeq, latestAnchor)
                    : latestAnchor;

                log.log(`💬 fetchMessages: requesting after_seq=${afterSeq} for ${sessionId} (storedNewestSeq=${storedNewestSeq}, sessionSeq=${sessionSeq})`);
                // The deadline covers the body as well as the request. The socket's own abort
                // stops a request that never answered, but a response that arrived and then
                // stalled mid-body is past it: nothing rejects the `json()` read, and a read that
                // neither completes nor fails holds this session's lock, fetch slot and sync for
                // as long as it sits there. Measured on a device against a sick server: one read
                // wedged a session for minutes with every later invalidate swallowed behind it.
                const read = (async () => {
                    const response = await apiSocket.request(
                        `/v3/sessions/${sessionId}/messages?after_seq=${afterSeq}&limit=100`,
                        this.serverReadOptions(),
                    );
                    if (!response.ok) {
                        throw new Error(`Failed to fetch messages for ${sessionId}: ${response.status}`);
                    }
                    return await response.json() as V3GetSessionMessagesResponse;
                })();
                read.catch(() => { /* the race below may already have moved on */ });
                let data: V3GetSessionMessagesResponse;
                try {
                    data = await Promise.race([
                        read,
                        new Promise<never>((_, reject) => {
                            this.messageReadDeadlines.set(
                                sessionId,
                                setTimeout(() => reject(new Error('server read stalled past its deadline')), 35_000),
                            );
                        }),
                    ]);
                } finally {
                    const timer = this.messageReadDeadlines.get(sessionId);
                    if (timer) {
                        clearTimeout(timer);
                        this.messageReadDeadlines.delete(sessionId);
                    }
                }
                const messages = Array.isArray(data.messages) ? data.messages : [];

                let maxSeq = afterSeq;
                let minSeqInPage = afterSeq > 0 ? afterSeq + 1 : 1;
                for (const message of messages) {
                    if (message.seq > maxSeq) maxSeq = message.seq;
                    if (message.seq < minSeqInPage) minSeqInPage = message.seq;
                }

                const decryptedMessages = await encryption.decryptMessages(messages);
                const normalizedMessages: NormalizedMessage[] = [];
                for (let i = 0; i < decryptedMessages.length; i++) {
                    const decrypted = decryptedMessages[i];
                    if (!decrypted) continue;
                    let normalized = normalizeRawMessage(decrypted.id, decrypted.localId, decrypted.createdAt, decrypted.content);
                    if (!normalized) continue;
                    // Carry the server-assigned seq for cache dedup.
                    normalized = { ...normalized, seq: messages[i]?.seq };
                    // Session envelopes carry their own server-assigned localId (different from
                    // the original user message localId), so resolve by text for ALL user messages.
                    if (normalized.role === 'user') {
                        // A user message can be plain text or a block list (file attachments), and
                        // only the former carries `text` — read it through the discriminant.
                        const previewText = normalized.content.type === 'text' ? normalized.content.text : '';
                        const claimedLocalId = this.resolveLocalIdForIncoming(sessionId, normalized.id, previewText, decrypted.localId);
                        if (claimedLocalId) {
                            normalized = { ...normalized, localId: claimedLocalId };
                        }
                    }
                    normalizedMessages.push(normalized);

                    this.applySessionThinkingFromRawContent(sessionId, decrypted.content);
                    // A page can be a hundred entries and each one is a JSON parse plus the
                    // reducer's normalization — all on the JS thread. One hop per 25 bounds any
                    // interaction's wait to a chunk instead of the whole page (the daemon path
                    // was given the same treatment; this is the server path).
                    if ((i + 1) % 25 === 0) {
                        await yieldTask();
                    }
                }

                this.ingestChannelRead(sessionId, { messages: normalizedMessages });

                // The server answered, so this session is back on the primary channel — stop the
                // polling an outage started.
                this.stopDaemonPolling(sessionId);

                this.sessionLastSeq.set(sessionId, maxSeq);

                // Determine pagination state.
                // - Incremental update (cachedLastSeq > 0): new messages arrive at the top;
                //   the bottom of our loaded window (oldestSeq) does NOT change.
                //   Preserve whatever applyHydratedCache already set.
                // - Cold start (cachedLastSeq = 0): compute from this page's min seq.
                let oldestSeq: number;
                let hasOlderMessages: boolean;
                if (cachedLastSeq > 0) {
                    const existingState = storage.getState().sessionMessages[sessionId];
                    oldestSeq = existingState?.oldestSeq ?? 0;
                    hasOlderMessages = existingState?.hasOlderMessages ?? false;
                } else {
                    oldestSeq = messages.length > 0 ? minSeqInPage : 1;
                    hasOlderMessages = oldestSeq > 1;
                }

                log.log(`💬 fetchMessages completed for ${sessionId}: ${normalizedMessages.length} messages, maxSeq=${maxSeq}, oldestSeq=${oldestSeq}, hasOlderMessages=${hasOlderMessages}, sessionSeq=${sessionSeq}`);

                // If we're still behind session.seq, kick off another fetch — but only if
                // the last re-invalidation wasn't too recent (debounce 2s) to avoid tight
                // spin-loops when the agent produces messages faster than fetches return.
                if (maxSeq < sessionSeq) {
                    const lastRevalidate = this.sessionLastFetchTime.get(sessionId) ?? 0;
                    const elapsed = Date.now() - lastRevalidate;
                    if (elapsed >= 2000) {
                        this.sessionLastFetchTime.set(sessionId, Date.now());
                        log.log(`💬 fetchMessages: still behind (maxSeq=${maxSeq} < sessionSeq=${sessionSeq}), re-invalidating`);
                        this.getMessagesSync(sessionId).invalidate();
                    } else {
                        log.log(`💬 fetchMessages: still behind but debounced (maxSeq=${maxSeq} < sessionSeq=${sessionSeq}, elapsed=${elapsed}ms), skipping re-invalidate`);
                    }
                }

                // Only patch store for cold-start path; incremental path already has correct values.
                if (cachedLastSeq === 0) {
                    const stateAfter = storage.getState().sessionMessages[sessionId];
                    if (stateAfter) {
                        storage.getState().applyOlderMessages(sessionId, [], oldestSeq, hasOlderMessages);
                    }
                }

                // Update the high-water mark for the progress bar.
                storage.getState().setNewestSeq(sessionId, maxSeq);
                // The server axis moved: both the watermark of what is held and the last
                // position the server itself reported for this session. The latter is what the
                // up-to-date guard compares against while the session list is daemon-numbered.
                this.serverNewestSeq.set(sessionId, Math.max(this.serverNewestSeq.get(sessionId) ?? 0, maxSeq));
                this.serverSessionSeq.set(sessionId, Math.max(this.serverSessionSeq.get(sessionId) ?? 0, maxSeq));

                // --- Cache: persist once the page has settled ---
                // With the window this fetch established, not the store's — `applyMessages` does not
                // write `oldestSeq`/`hasOlderMessages`, so the store can still lag what the page
                // actually proved until `applyOlderMessages` above has run.
                void this.saveSessionCache(sessionId, {
                    lastSeq: maxSeq,
                    oldestSeq,
                    hasOlderMessages,
                });
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                log.log(`💬 fetchMessages failed for session ${sessionId}: ${msg}`);
                if (err instanceof Error && err.stack) {
                    log.log(`💬 fetchMessages stack: ${err.stack}`);
                }
                // Re-throw network/HTTP errors so InvalidateSync's backoff retries
                // automatically. This is the self-heal path: when the network comes
                // back (or the server recovers), the message sync retries on its own.
                // Logical errors (decrypt/normalize) are swallowed — retrying them
                // would spin forever without any chance of success.
                // A session committed to the server must not fall back, so a pin to `server`
                // actually proves something when it is used to test that the LAN stays out of the
                // way. Note this is the *pin*, not the preference: a session the preference puts
                // on the server should still reach for the LAN when the server fails, which is
                // how a machine that has just come onto the network gets picked up.
                const routes = this.daemonRoutesEnabled();
                if (this.isRetryableMessageFetchError(err) && storage.getState().channelOverride[sessionId] !== 'server' && (routes.lan || routes.relay)) {
                    // The server is unreachable. Before handing this over to the retry backoff,
                    // try the other channel: the daemon that owns this session keeps its own log
                    // of everything the session process saw, and it may be sitting on this very
                    // network. This is the channel switch, and it is driven by the failure itself
                    // rather than by a status flag — so it covers every reason the server can be
                    // unreachable, not just the ones a status enum happens to model.
                    try {
                        const read = await this.fetchSessionFromDaemon(sessionId);
                        if (read) {
                            log.log(`📡 fetchMessages: server unreachable — read ${read.messages.length} message(s) over the LAN for ${sessionId}`);
                            // The LAN only serves snapshots, so without this the session would
                            // freeze at the moment of the switch. Keep reading until the server
                            // answers again (stopped in the success path below).
                            this.startDaemonPolling(sessionId);
                        }
                    } catch (lanError) {
                        // The LAN is best-effort. A failure here must not mask the original error.
                        //
                        // Which endpoint was tried, because "Load failed" is what a webview says for
                        // every transport-level refusal — no CORS headers on the far side, an address
                        // on a network this device is not on, a port that is closed — and the three
                        // have nothing in common but the message. The route is what tells them apart.
                        const machineId = storage.getState().sessions[sessionId]?.metadata?.machineId;
                        const relay = machineId ? storage.getState().relayEndpoints[machineId]?.baseUrl : undefined;
                        const lan = machineId ? this.lanMachineConnections.get(machineId)?.baseUrl : undefined;
                        log.log(`📡 fetchMessages: fallback failed for ${sessionId} (machine ${machineId ?? '?'}, relay ${relay ?? '-'}, lan ${lan ?? '-'}, via ${this.preferredChannel(sessionId)}): ${String(lanError)}`);
                    }
                    // Still re-throw: the LAN log only covers what that process has seen since it
                    // started, so it supplements the server rather than replacing it, and the
                    // backoff keeps trying for the fuller channel.
                    throw err;
                }
            } finally {
                storage.getState().applyMessagesLoaded(sessionId);
                this.releaseMessageFetchSlot(slot);
            }
        });
    }

    /**
     * Fetch the next older page of messages (100 before the currently oldest loaded seq).
     * Called when the user scrolls to the top of the message list.
     */
    fetchOlderMessages = async (sessionId: string): Promise<void> => {
        const stateNow = storage.getState().sessionMessages[sessionId];
        if (!stateNow?.hasOlderMessages || stateNow.isLoadingOlder) return;

        // A session on a daemon channel scrolls back through the daemon's log, not the server's.
        // Same window, same prepend, different transport — the window fields and the UI gate are
        // shared, so only the page request differs.
        if (this.preferredChannel(sessionId) !== 'server') {
            await this.fetchOlderViaDaemon(sessionId);
            return;
        }

        storage.getState().setLoadingOlder(sessionId, true);

        const lock = this.getSessionMessageLock(sessionId);
        await lock.inLock(async () => {
            const slot = await this.acquireMessageFetchSlot();
            try {
                const encryption = this.encryption.getSessionEncryption(sessionId);
                if (!encryption) throw new Error(`Session encryption not ready for ${sessionId}`);

                const currentState = storage.getState().sessionMessages[sessionId];
                if (!currentState?.hasOlderMessages) return;

                const oldestSeq = currentState.oldestSeq;
                // Align to the segment boundary that precedes oldestSeq so that:
                //  1. The new oldestSeq lands on a segment start after the fetch.
                //  2. The bitmap can mark the entire newly-loaded segment as cached.
                // olderAfterSeq targets the segment CONTAINING (oldestSeq-1), not oldestSeq itself,
                // which avoids re-fetching the current page when oldestSeq is already a segment start.
                // Example: oldestSeq=401 → target=400 → segment 3 (301-400) → afterSeq=300 → fetch 301-400.
                const alignedAfterSeq = olderAfterSeq(oldestSeq);
                log.log(`💬 fetchOlderMessages: requesting after_seq=${alignedAfterSeq} limit=100 for ${sessionId} (oldestSeq=${oldestSeq})`);

                const response = await apiSocket.request(`/v3/sessions/${sessionId}/messages?after_seq=${alignedAfterSeq}&limit=100`);
                if (!response.ok) throw new Error(`Failed to fetch older messages: ${response.status}`);

                const data = await response.json() as V3GetSessionMessagesResponse;
                const messages = Array.isArray(data.messages) ? data.messages : [];

                // Keep only messages strictly before the current oldest to avoid overlap
                const olderApiMessages = messages.filter(m => m.seq < oldestSeq);

                // Compute new oldestSeq from the raw API messages (seq is always present there)
                let newOldestSeq = oldestSeq;
                for (const m of olderApiMessages) {
                    if (m.seq < newOldestSeq) newOldestSeq = m.seq;
                }

                const decryptedMessages = await encryption.decryptMessages(olderApiMessages);
                const normalizedMessages: NormalizedMessage[] = [];
                for (let i = 0; i < decryptedMessages.length; i++) {
                    const decrypted = decryptedMessages[i];
                    if (!decrypted) continue;
                    const normalized = normalizeRawMessage(decrypted.id, decrypted.localId, decrypted.createdAt, decrypted.content);
                    if (normalized) normalizedMessages.push(normalized);
                    if ((i + 1) % 25 === 0) {
                        await yieldTask();
                    }
                }

                const newHasOlderMessages = newOldestSeq > 1;

                log.log(`💬 fetchOlderMessages: got ${normalizedMessages.length} older messages for ${sessionId}, newOldestSeq=${newOldestSeq}, hasMore=${newHasOlderMessages}`);

                storage.getState().applyOlderMessages(sessionId, normalizedMessages, newOldestSeq, newHasOlderMessages);

                // Persist updated cache, with the window this page established.
                void this.saveSessionCache(sessionId, {
                    lastSeq: this.sessionLastSeq.get(sessionId) ?? 0,
                    oldestSeq: newOldestSeq,
                    hasOlderMessages: newHasOlderMessages,
                });
            } catch (err) {
                log.log(`💬 fetchOlderMessages failed for ${sessionId}: ${err}`);
            } finally {
                // In `finally`, because a path that returns early — a window that no longer wants
                // older messages — used to leave the flag set, and the spinner above the history
                // then turned for the life of the session with nothing loading.
                storage.getState().setLoadingOlder(sessionId, false);
                this.releaseMessageFetchSlot(slot);
            }
        });
    }

    /**
     * Scrolls back one page through the daemon's log.
     *
     * The anchor comes from the read that established the window — every daemon page carries both
     * of its edges — so this needs no seq arithmetic: the log is addressed by position, and the
     * position of the page before this one is what the last read already handed back. A session
     * whose window came from the cache and has never been read in this process has no anchor yet,
     * so the first scroll reads the newest page to establish one before walking back from it.
     */
    private async fetchOlderViaDaemon(sessionId: string): Promise<void> {
        storage.getState().setLoadingOlder(sessionId, true);
        const lock = this.getSessionMessageLock(sessionId);
        await lock.inLock(async () => {
            const slot = await this.acquireMessageFetchSlot();
            try {
                if (!this.daemonLinks.has(sessionId)) {
                    await this.fetchSessionFromDaemon(sessionId);
                }
                const link = this.daemonLinks.get(sessionId);
                const machineKey = link ? this.getMachineKey(link.machineId) : null;
                if (!link || !link.hasOlder || !machineKey) {
                    storage.getState().setLoadingOlder(sessionId, false);
                    return;
                }
                // Paging back stays on the route the window was read over — that is the address
                // this session is known to answer at — and the candidate list puts it first.
                const attempt = await readSessionOverLan({
                    sessionId,
                    machineId: link.machineId,
                    accountPublicKey: this.encryption.contentDataKey,
                    machineKey,
                    encryption: this.encryption,
                    page: { kind: 'older', before: link.older },
                    connection: link.connection,
                    candidates: this.readCandidates(link.machineId, [link.connection.route]),
                });
                const read = attempt.kind === 'read' ? attempt.read : null;
                // The same accounting the forward read does. Paging back is how a machine gets read
                // again after a quiet spell, and it used to be the one path that learned nothing
                // from what it found — so an address that failed here was not held against it, and
                // one that answered was not credited.
                if (attempt.kind === 'unreachable' && attempt.baseUrl) {
                    storage.getState().candidateFailed(link.machineId, link.connection.route, attempt.baseUrl);
                } else if (attempt.kind === 'read') {
                    storage.getState().candidateSucceeded(link.machineId, attempt.read.connection.route, attempt.read.connection.baseUrl);
                }
                if (!read) {
                    storage.getState().setLoadingOlder(sessionId, false);
                    return;
                }
                this.daemonLinks.set(sessionId, { ...link, older: read.older, hasOlder: read.hasOlder });
                const oldestSeq = read.messages.length > 0
                    ? minSeqOf(read.messages)
                    : storage.getState().sessionMessages[sessionId]?.oldestSeq ?? 0;
                storage.getState().applyOlderMessages(sessionId, read.messages, oldestSeq, read.hasOlder);
                void this.saveSessionCache(
                    sessionId,
                    { lastSeq: this.sessionLastSeq.get(sessionId) ?? 0, oldestSeq, hasOlderMessages: read.hasOlder },
                    { machineId: link.machineId, cursor: link.cursor, floor: read.older, hasOlder: read.hasOlder },
                );
                log.log(`📡 fetchOlderViaDaemon: ${read.messages.length} older read for ${sessionId} (hasOlder=${read.hasOlder})`);
            } catch (error) {
                log.log(`📡 fetchOlderViaDaemon failed for ${sessionId}: ${String(error)}`);
                storage.getState().setLoadingOlder(sessionId, false);
            } finally {
                this.releaseMessageFetchSlot(slot);
            }
        });
    }

    private registerPushToken = async () => {
        log.log('registerPushToken');
        // Only register on mobile platforms
        if (Platform.OS === 'web') {
            return;
        }

        // Request permission
        const { status: existingStatus } = await Notifications.getPermissionsAsync();
        let finalStatus = existingStatus;
        log.log('existingStatus: ' + JSON.stringify(existingStatus));

        if (existingStatus !== 'granted') {
            const { status } = await Notifications.requestPermissionsAsync();
            finalStatus = status;
        }
        log.log('finalStatus: ' + JSON.stringify(finalStatus));

        if (finalStatus !== 'granted') {
            console.log('Failed to get push token for push notification!');
            return;
        }

        // Get push token
        const projectId = Constants?.expoConfig?.extra?.eas?.projectId ?? Constants?.easConfig?.projectId;

        const tokenData = await Notifications.getExpoPushTokenAsync({ projectId });
        log.log('tokenData: ' + JSON.stringify(tokenData));

        // Register with server
        try {
            await registerPushToken(this.credentials, tokenData.data);
            log.log('Push token registered successfully');
        } catch (error) {
            log.log('Failed to register push token: ' + JSON.stringify(error));
        }
    }

    private subscribeToUpdates = () => {
        // Subscribe to message updates
        apiSocket.onMessage('update', this.handleUpdate.bind(this));
        apiSocket.onMessage('ephemeral', this.handleEphemeralUpdate.bind(this));

        // Subscribe to connection state changes
        this.reconnectedCleanup = apiSocket.onReconnected(() => {
            log.log('🔌 Socket reconnected');
            // Only a gap long enough to have missed events is worth refetching everything. The
            // server socket can flap every few seconds (observed on a device), and invalidating
            // the session list, the machine list and four side syncs on each flap kept the JS
            // thread busy exactly when a conversation was being opened — the navigation waited
            // behind work that the next event or the periodic refresh would have done anyway.
            const downFor = Date.now() - (storage.getState().socketLastDisconnectedAt ?? 0);
            // The list is always re-read, however short the outage. A `new-session` push that
            // arrived while the socket was down is gone for good, and the periodic refresh that
            // would eventually cover it runs every five minutes and is skipped entirely when the
            // person has been idle — which is exactly the "a session I created in another client
            // does not appear here" shape. One delta request behind a 30s cooldown is the cheap
            // half of this handler; the side syncs below are the expensive half and keep the gap
            // threshold.
            this.lastDesktopSessionRefreshAt = Date.now();
            this.sessionsSync.invalidate();
            if (downFor >= Sync.RECONNECT_REFRESH_MS) {
                this.machinesSync.invalidate();
                this.artifactsSync.invalidate();
                this.friendsSync.invalidate();
                this.friendRequestsSync.invalidate();
                this.feedSync.invalidate();
            }
            // Refresh the session the user is looking at, and only that one.
            //
            // This used to fan out over every session the store reports as *active*, which in this
            // fork never means "the agent is running" — `active` is set from the session online
            // flag, so with a daemon on the LAN keeping every session online it matched all of
            // them. On a cold start that was 38 sessions each hydrating from SQLite at once, and
            // because expo-sqlite serialises everything down one connection, a single-row read was
            // measured at ~1.3s purely from queueing behind the rest. The session the user was
            // actually opening was at the back of that queue, which is the blank conversation
            // after the navigation animation.
            //
            // Scoping it down loses nothing. A session that is not loaded yet hydrates from cache
            // when it is opened (`onSessionVisible`), and one that is already loaded receives
            // anything new over the socket — `new-message` updates are applied whether or not the
            // session is on screen.
            if (this.currentVisibleSessionId) {
                this.getMessagesSync(this.currentVisibleSessionId).invalidate();
                if (!this.gitStatusPublished(this.currentVisibleSessionId)) {
                    gitStatusSync.invalidate(this.currentVisibleSessionId);
                }
            }
            for (const sync of this.sendSync.values()) {
                sync.invalidate();
            }
            this.recoverPendingOutbox();
        });
    }

    private handleUpdate = async (update: unknown) => {
        traceUpdate(() => `🔄 Sync: handleUpdate called with: ${JSON.stringify(update).substring(0, 300)}`);
        const validatedUpdate = ApiUpdateContainerSchema.safeParse(update);
        if (!validatedUpdate.success) {
            console.log('❌ Sync: Invalid update received:', validatedUpdate.error);
            console.error('❌ Sync: Invalid update data:', update);
            return;
        }
        const updateData = validatedUpdate.data;
        traceUpdate(() => `🔄 Sync: Validated update type: ${updateData.body.t}`);

        if (updateData.body.t === 'new-message') {

            // Get encryption
            const encryption = this.encryption.getSessionEncryption(updateData.body.sid);
            if (!encryption) {
                // Session encryption not yet initialized (e.g. cache hasn't restored keys,
                // or a previous fetchSessions cooldown-blocked the recovery). Force-refetch
                // now to decrypt the dataEncryptionKey from the server response. Without
                // 'force' the cooldown would silently drop the recovery and leave the app
                // permanently unable to decrypt messages for this session.
                if (!this._loggedMissingSessionForSid.has(updateData.body.sid)) {
                    this._loggedMissingSessionForSid.add(updateData.body.sid);
                    log.log(`Session ${updateData.body.sid} not found (refetching sessions)`);
                }
                this.fetchSessions(true);
                return;
            }

            // Decrypt message
            let lastMessage: NormalizedMessage | null = null;
            let didFastPath = false;
            const sid = updateData.body.sid;
            if (updateData.body.message) {
                // Fast ack: if the incoming localId matches a pending sent message,
                // this is our own user message echo. Ack it without decrypting.
                const incomingLocalId = (updateData.body as { message: { localId?: string | null } }).message.localId ?? undefined;
                if (incomingLocalId && this.claimSentMessageLocalIdByValue(sid, incomingLocalId)) {
                    // Fast-ack: mark as acked (green). Only the CLI pop echo
                    // (via echoedMessageId in session-protocol user text) removes.
                    storage.getState().markOutboxMessageAcked(incomingLocalId);
                    const session2 = storage.getState().sessions[sid];
                    if (session2) {
                        this.applySessions([{ ...session2, updatedAt: updateData.createdAt, seq: updateData.body.message.seq }]);
                    }
                    this.sessionLastSeq.set(sid, updateData.body.message.seq);
                    didFastPath = true;
                } else {
                    const decrypted = await encryption.decryptMessage(updateData.body.message);
                    if (decrypted) {
                        lastMessage = normalizeRawMessage(decrypted.id, decrypted.localId, decrypted.createdAt, decrypted.content);

                        // Filter A2A inbox notification messages from appearing as user bubbles.
                        // Server-sent notifications have origin='a2a' and text starts with "A2A inbox".
                        if (lastMessage && lastMessage.role === 'user' && lastMessage.meta?.origin === 'a2a'
                            && (lastMessage as any).content?.text?.startsWith?.('A2A inbox')) {
                            lastMessage = null;
                        }

                        // CLI pop echo: mark as delivered (green check) via echoedMessageId.
                        // Also set localId so the reducer deduplicates with the optimistic bubble.
                        const echoedId = lastMessage?.meta?.echoedMessageId;
                        if (echoedId) {
                            storage.getState().markOutboxMessageDelivered(echoedId);
                            if (lastMessage && lastMessage.role === 'user') {
                                lastMessage = { ...lastMessage, localId: echoedId };
                                this.claimedServerMessageIds.set(lastMessage.id, echoedId);
                            }
                        } else if (lastMessage && lastMessage.role === 'user') {
                            // See the block-list note above: only the plain-text variant has `text`.
                            const previewText = lastMessage.content.type === 'text' ? lastMessage.content.text : '';
                            const claimedLocalId = this.resolveLocalIdForIncoming(sid, lastMessage.id, previewText, decrypted.localId);
                            if (claimedLocalId) {
                                lastMessage = { ...lastMessage, localId: claimedLocalId };
                            }
                        }
                    }

                    const thinkingPatch = this.applySessionThinkingFromRawContent(
                        updateData.body.sid,
                        decrypted?.content,
                        updateData.createdAt,
                    );
                    const shouldClearThinking = thinkingPatch?.thinking === false;

                    const session = storage.getState().sessions[updateData.body.sid];
                    if (session) {
                        this.applySessions([{
                            ...session,
                            updatedAt: updateData.createdAt,
                            seq: updateData.body.message.seq,
                        }]);
                    } else {
                        // Fetch sessions again if we don't have this session.
                        // Force-bypass cooldown: the message was already decrypted but the
                        // session is missing from storage — waiting 30s is unacceptable.
                        this.fetchSessions(true);
                    }

                    // Fast-path: apply message directly when seq is strictly consecutive.
                    // Lenient path: when there is a seq gap (e.g. session-protocol mode where
                    // the raw user message occupies a seq slot but normalizes to null), still
                    // enqueue the message immediately so it appears in the UI without waiting
                    // for fetchMessages. fetchMessages is still triggered to fill any real gaps;
                    // the reducer's messageIds deduplication handles re-delivery of the same msg.
                    const currentLastSeq = this.sessionLastSeq.get(updateData.body.sid);
                    const incomingSeq = updateData.body.message.seq;
                    const isFastPath = lastMessage !== null && currentLastSeq !== undefined && incomingSeq === currentLastSeq + 1;
                    if (isFastPath && lastMessage) {
                        traceUpdate(() => `🔄 Sync: Applying message (fast path): ${JSON.stringify(lastMessage).substring(0, 300)}`);
                        this.enqueueMessages(updateData.body.sid, [lastMessage]);
                        this.sessionLastSeq.set(updateData.body.sid, incomingSeq);
                        // Advance the store's newestSeq so fetchMessages' up-to-date check
                        // reflects messages actually applied (not just seen on the wire).
                        storage.getState().setNewestSeq(updateData.body.sid, incomingSeq);
                        didFastPath = true;
                    } else {
                        // Seq gap → trigger fetch to fill missing messages.
                        // Skip invalidate when the message normalized to null — the gap is
                        // caused by a null-normalized message (e.g. session-protocol user msg),
                        // not by actual missing data, so no fetch is needed.
                        //
                        // And skip it on a daemon channel, where this fetch is not the cheap no-op
                        // it is on the server: that path checks "am I already up to date" before
                        // asking, while the daemon branch reads before it can know. Every pushed
                        // message would therefore cost a read that finds nothing, because the
                        // message was just applied — the daemon's own `log-grew` hint, sent after
                        // a burst, is what fills a frame the socket actually missed.
                        if (lastMessage && this.preferredChannel(updateData.body.sid) === 'server') {
                            this.getMessagesSync(updateData.body.sid).invalidate();
                        }
                        // Enqueue immediately so the UI updates without waiting for fetchMessages.
                        // Neither sessionLastSeq nor newestSeq is advanced here — the gap must
                        // be filled by fetchMessages before the store is considered caught up.
                        if (lastMessage) {
                            traceUpdate(() => `🔄 Sync: Applying message (lenient path, seq gap): ${JSON.stringify(lastMessage).substring(0, 300)}`);
                            this.enqueueMessages(updateData.body.sid, [lastMessage]);
                        }
                    }
                    // Refresh git status only when turn is done (ready), not on every mutable tool
                    // result — and not at all for a session whose CLI publishes it: the last tool
                    // result already scheduled a fresh one.
                    if (shouldClearThinking && !this.gitStatusPublished(updateData.body.sid)) {
                        gitStatusSync.invalidate(updateData.body.sid);
                    }

                    // When the agent responds, clean up acked outbox entries for this session.
                    // The server already received and processed our message(s) — any sending/acked
                    // entries should be removed since the agent turn is now producing output.
                    if (lastMessage && lastMessage.role !== 'user') {
                        storage.getState().removeOutboxEntriesForSession(updateData.body.sid);
                    }
                }
            }

            // Fast path already applied the message and updated sessionLastSeq —
            // nothing more to read.
            //
            // A push says this session changed, not that anyone is looking at it. Calling
            // onSessionVisible here made every pushed message of every active session claim to be
            // the screen: it moved the scheduler's poll, re-ran the voice focus announcement
            // ("Session became focused" for conversations not on screen, several times a second),
            // refreshed git status and the session list. On a device with two agents running that
            // was a continuous stream of work on a thread the screen was waiting for.
            // Only the server channel needs a read here. On a daemon channel the push itself was
            // applied above and the daemon sends its own `log-grew` hint for a frame the socket
            // missed — reading on every push cost a full page per message (measured: a read per
            // 300ms per active session, each one a store write and a re-render of the list).
            if (!didFastPath && this.preferredChannel(updateData.body.sid) === 'server') {
                this.readScheduler.wake(updateData.body.sid, 'push');
            }

        } else if (updateData.body.t === 'new-session') {
            log.log('🆕 New session update received');
            const { id, createdAt, updatedAt } = updateData.body;
            if (id && createdAt && updatedAt) {
                // 1. Immediately insert a lightweight placeholder so the session
                //    appears in the list without waiting for any network round-trip.
                //    Minimal metadata with path set to a sentinel so getSessionName
                //    renders a localized "Creating…" label instead of "unknown".
                try {
                    storage.getState().applySessions([{
                        id,
                        seq: 0,
                        createdAt: createdAt,
                        updatedAt: updatedAt,
                        active: true,
                        activeAt: createdAt,
                        metadata: {
                            path: '​creating​', // zero-width-space sentinel
                            host: '',
                        } as any,
                        metadataVersion: 0,
                        agentState: null,
                        agentStateVersion: 0,
                        thinking: false,
                        thinkingAt: 0,
                        presence: 'online' as const,
                    }]);
                } catch { /* best-effort placeholder */ }

            }
            // 2. Full list sync via delta fetch picks up the new session's metadata.
            //    /v1/sessions/{id} was removed; delta is the canonical path.
            this.sessionsSync.invalidate();
        } else if (updateData.body.t === 'delete-session') {
            log.log('🗑️ Delete session update received');
            const sessionId = updateData.body.sid;

            // Remove session from storage
            storage.getState().deleteSession(sessionId);

            // Remove encryption keys from memory
            this.encryption.removeSessionEncryption(sessionId);

            // Remove from project manager
            projectManager.removeSession(sessionId);

            // Clear any cached git status
            gitStatusSync.clearForSession(sessionId);
            this.messagesSync.delete(sessionId);
            this.sendSync.delete(sessionId);
            this.pendingOutbox.delete(sessionId);
            this.sessionLastSeq.delete(sessionId);
            this.serverNewestSeq.delete(sessionId);
            this.serverSessionSeq.delete(sessionId);
            this.sentMessageLocalIds.delete(sessionId);
            // claimedServerMessageIds is keyed by serverId not sessionId, so we can't easily
            // bulk-delete by session. It's small and self-limiting (only live claims), so just
            // leave entries to expire naturally (they'll never match again after session deletion).
            this.sessionMessageLocks.delete(sessionId);
            this.hydratedSessions.delete(sessionId);
            this.hydratingSessions.delete(sessionId);
            this.sessionMessageQueue.delete(sessionId);
            this.sessionQueueProcessing.delete(sessionId);

            // Clear local message cache for the deleted session
            void clearMessageCache(sessionId);

            log.log(`🗑️ Session ${sessionId} deleted from local storage`);
        } else if (updateData.body.t === 'update-session') {
            const session = storage.getState().sessions[updateData.body.id];
            if (session) {
                // Get session encryption
                const sessionEncryption = this.encryption.getSessionEncryption(updateData.body.id);
                if (!sessionEncryption) {
                    // Encryption key not yet initialised for this session — the cache may
                    // have been missing the key or a previous fetch may have been cooldown-blocked.
                    // Force-fetch sessions to recover rather than silently dropping the update.
                    log.log(`Session encryption not found for ${updateData.body.id} — force-fetching sessions to recover`);
                    this.fetchSessions(true);
                    return;
                }

                const agentState = updateData.body.agentState && sessionEncryption
                    ? await sessionEncryption.decryptAgentState(updateData.body.agentState.version, updateData.body.agentState.value)
                    : session.agentState;
                const metadata = updateData.body.metadata && sessionEncryption
                    ? await sessionEncryption.decryptMetadata(updateData.body.metadata.version, updateData.body.metadata.value)
                    : session.metadata;

                // What the machine may say about a session, which no amount of the session's own
                // state can express: everything else here is ciphertext from the session process,
                // and during a restart there is no session process to send any. Absent means this
                // update says nothing about restarting — only an explicit null calls one off.
                const restartingAt = updateData.body.restartingAt !== undefined
                    ? updateData.body.restartingAt ?? null
                    : session.restartingAt;

                // Do not set seq from updateData.seq (global); keep session.seq as session-internal so it matches GET /v1/sessions
                this.applySessions([{
                    ...session,
                    restartingAt,
                    agentState,
                    agentStateVersion: updateData.body.agentState
                        ? updateData.body.agentState.version
                        : session.agentStateVersion,
                    metadata,
                    metadataVersion: updateData.body.metadata
                        ? updateData.body.metadata.version
                        : session.metadataVersion,
                    updatedAt: updateData.createdAt
                }]);

                // A working tree the session published is the badge, as soon as it says so — no
                // round trip, and no waiting for a turn boundary.
                if (metadata?.gitStatus) {
                    this.applyPublishedGitStatus([{ id: updateData.body.id, metadata }]);
                }

                // Git status is refreshed on ready/turn-end only (see new-message), not on every agentState push
                if (updateData.body.agentState) {
                    // Check for new permission requests and notify voice assistant
                    if (agentState?.requests && Object.keys(agentState.requests).length > 0) {
                        const requestIds = Object.keys(agentState.requests);
                        const firstRequest = agentState.requests[requestIds[0]];
                        const toolName = firstRequest?.tool;
                        voiceHooks.onPermissionRequested(updateData.body.id, requestIds[0], toolName, firstRequest?.arguments);
                    }

                    // Re-fetch messages when control returns to mobile (local -> remote mode switch)
                    // This catches up on any messages that were exchanged while desktop had control
                    const wasControlledByUser = session.agentState?.controlledByUser;
                    const isNowControlledByUser = agentState?.controlledByUser;
                    if (!wasControlledByUser && isNowControlledByUser) {
                        log.log(`🔄 Control returned to mobile for session ${updateData.body.id}, re-fetching messages`);
                        this.readScheduler.wake(updateData.body.id, 'control returned');
                    }
                }
            }
        } else if (updateData.body.t === 'update-account') {
            const accountUpdate = updateData.body;
            const currentProfile = storage.getState().profile;

            // Build updated profile with new data
            const updatedProfile: Profile = {
                ...currentProfile,
                firstName: accountUpdate.firstName !== undefined ? accountUpdate.firstName : currentProfile.firstName,
                lastName: accountUpdate.lastName !== undefined ? accountUpdate.lastName : currentProfile.lastName,
                avatar: accountUpdate.avatar !== undefined ? accountUpdate.avatar : currentProfile.avatar,
                github: accountUpdate.github !== undefined ? accountUpdate.github : currentProfile.github,
                timestamp: updateData.createdAt // Update timestamp to latest
            };

            // Apply the updated profile to storage
            storage.getState().applyProfile(updatedProfile);

            // Handle settings updates (new for profile sync)
            if (accountUpdate.settings?.value) {
                try {
                    const decryptedSettings = await this.encryption.decryptRaw(accountUpdate.settings.value);
                    const parsedSettings = settingsParse(decryptedSettings);

                    // Version compatibility check
                    const settingsSchemaVersion = parsedSettings.schemaVersion ?? 1;
                    if (settingsSchemaVersion > SUPPORTED_SCHEMA_VERSION) {
                        console.warn(
                            `⚠️ Received settings schema v${settingsSchemaVersion}, ` +
                            `we support v${SUPPORTED_SCHEMA_VERSION}. Update app for full functionality.`
                        );
                    }

                    storage.getState().applySettings(parsedSettings, accountUpdate.settings.version);
                    log.log(`📋 Settings synced from server (schema v${settingsSchemaVersion}, version ${accountUpdate.settings.version})`);
                } catch (error) {
                    console.error('❌ Failed to process settings update:', error);
                    // Don't crash on settings sync errors, just log
                }
            }
        } else if (updateData.body.t === 'update-machine') {
            const machineUpdate = updateData.body;
            const machineId = machineUpdate.machineId;  // Changed from .id to .machineId
            const machine = storage.getState().machines[machineId];

            // Create or update machine with all required fields
            const updatedMachine: Machine = {
                id: machineId,
                seq: updateData.seq,
                createdAt: machine?.createdAt ?? updateData.createdAt,
                updatedAt: updateData.createdAt,
                active: machineUpdate.active ?? true,
                activeAt: machineUpdate.activeAt ?? updateData.createdAt,
                metadata: machine?.metadata ?? null,
                metadataVersion: machine?.metadataVersion ?? 0,
                daemonState: machine?.daemonState ?? null,
                daemonStateVersion: machine?.daemonStateVersion ?? 0
            };

            // Get machine-specific encryption (might not exist if machine wasn't initialized on this device)
            const machineEncryption = this.encryption.getMachineEncryption(machineId);
            if (!machineEncryption) {
                // Machine was likely registered from another device; skip decrypting this update
                if (__DEV__) {
                    console.warn(`Sync: Skipping update-machine for ${machineId} (no encryption key on this device)`);
                }
                return;
            }

            // If metadata is provided, decrypt and update it
            const metadataUpdate = machineUpdate.metadata;
            if (metadataUpdate) {
                try {
                    const metadata = await machineEncryption.decryptMetadata(metadataUpdate.version, metadataUpdate.value);
                    updatedMachine.metadata = metadata;
                    updatedMachine.metadataVersion = metadataUpdate.version;
                } catch (error) {
                    console.error(`Failed to decrypt machine metadata for ${machineId}:`, error);
                }
            }

            // If daemonState is provided, decrypt and update it
            const daemonStateUpdate = machineUpdate.daemonState;
            if (daemonStateUpdate) {
                try {
                    const daemonState = await machineEncryption.decryptDaemonState(daemonStateUpdate.version, daemonStateUpdate.value);
                    updatedMachine.daemonState = daemonState;
                    updatedMachine.daemonStateVersion = daemonStateUpdate.version;
                } catch (error) {
                    console.error(`Failed to decrypt machine daemonState for ${machineId}:`, error);
                }
            }

            storage.getState().applyRelayEndpoint(machineId, parseRelayEndpoint(machineId, updatedMachine.daemonState));
            storage.getState().applyLanEndpoint(machineId, parseLanEndpoints(machineId, updatedMachine.daemonState));
            // Update storage using applyMachines which rebuilds sessionListViewData
            storage.getState().applyMachines([updatedMachine]);
        } else if (updateData.body.t === 'relationship-updated') {
            log.log('👥 Received relationship-updated update');
            const relationshipUpdate = updateData.body;
            
            // Apply the relationship update to storage
            storage.getState().applyRelationshipUpdate({
                fromUserId: relationshipUpdate.fromUserId,
                toUserId: relationshipUpdate.toUserId,
                status: relationshipUpdate.status,
                action: relationshipUpdate.action,
                fromUser: relationshipUpdate.fromUser,
                toUser: relationshipUpdate.toUser,
                timestamp: relationshipUpdate.timestamp
            });
            
            // Invalidate friends data to refresh with latest changes
            this.friendsSync.invalidate();
            this.friendRequestsSync.invalidate();
            this.feedSync.invalidate();
        } else if (updateData.body.t === 'new-artifact') {
            log.log('📦 Received new-artifact update');
            const artifactUpdate = updateData.body;
            const artifactId = artifactUpdate.artifactId;
            
            try {
                // Decrypt the data encryption key
                const decryptedKey = await this.encryption.decryptEncryptionKey(artifactUpdate.dataEncryptionKey);
                if (!decryptedKey) {
                    console.error(`Failed to decrypt key for new artifact ${artifactId}`);
                    return;
                }
                
                // Store the decrypted key in memory
                this.artifactDataKeys.set(artifactId, decryptedKey);
                
                // Create artifact encryption instance
                const artifactEncryption = new ArtifactEncryption(decryptedKey);
                
                // Decrypt header
                const header = await artifactEncryption.decryptHeader(artifactUpdate.header);
                
                // Decrypt body if provided
                let decryptedBody: string | null | undefined = undefined;
                if (artifactUpdate.body && artifactUpdate.bodyVersion !== undefined) {
                    const body = await artifactEncryption.decryptBody(artifactUpdate.body);
                    decryptedBody = body?.body || null;
                }
                
                // Add to storage
                const decryptedArtifact: DecryptedArtifact = {
                    id: artifactId,
                    title: header?.title || null,
                    body: decryptedBody,
                    headerVersion: artifactUpdate.headerVersion,
                    bodyVersion: artifactUpdate.bodyVersion,
                    seq: artifactUpdate.seq,
                    createdAt: artifactUpdate.createdAt,
                    updatedAt: artifactUpdate.updatedAt,
                    isDecrypted: !!header,
                };
                
                storage.getState().addArtifact(decryptedArtifact);
                log.log(`📦 Added new artifact ${artifactId} to storage`);
            } catch (error) {
                console.error(`Failed to process new artifact ${artifactId}:`, error);
            }
        } else if (updateData.body.t === 'update-artifact') {
            log.log('📦 Received update-artifact update');
            const artifactUpdate = updateData.body;
            const artifactId = artifactUpdate.artifactId;
            
            // Get existing artifact
            const existingArtifact = storage.getState().artifacts[artifactId];
            if (!existingArtifact) {
                console.error(`Artifact ${artifactId} not found in storage`);
                // Fetch all artifacts to sync
                this.artifactsSync.invalidate();
                return;
            }
            
            try {
                // Get the data encryption key from memory
                let dataEncryptionKey = this.artifactDataKeys.get(artifactId);
                if (!dataEncryptionKey) {
                    console.error(`Encryption key not found for artifact ${artifactId}, fetching artifacts`);
                    this.artifactsSync.invalidate();
                    return;
                }
                
                // Create artifact encryption instance
                const artifactEncryption = new ArtifactEncryption(dataEncryptionKey);
                
                // Update artifact with new data  
                const updatedArtifact: DecryptedArtifact = {
                    ...existingArtifact,
                    seq: updateData.seq,
                    updatedAt: updateData.createdAt,
                };
                
                // Decrypt and update header if provided
                if (artifactUpdate.header) {
                    const header = await artifactEncryption.decryptHeader(artifactUpdate.header.value);
                    updatedArtifact.title = header?.title || null;
                    updatedArtifact.sessions = header?.sessions;
                    updatedArtifact.draft = header?.draft;
                    updatedArtifact.headerVersion = artifactUpdate.header.version;
                }
                
                // Decrypt and update body if provided
                if (artifactUpdate.body) {
                    const body = await artifactEncryption.decryptBody(artifactUpdate.body.value);
                    updatedArtifact.body = body?.body || null;
                    updatedArtifact.bodyVersion = artifactUpdate.body.version;
                }
                
                storage.getState().updateArtifact(updatedArtifact);
                log.log(`📦 Updated artifact ${artifactId} in storage`);
            } catch (error) {
                console.error(`Failed to process artifact update ${artifactId}:`, error);
            }
        } else if (updateData.body.t === 'delete-artifact') {
            log.log('📦 Received delete-artifact update');
            const artifactUpdate = updateData.body;
            const artifactId = artifactUpdate.artifactId;
            
            // Remove from storage
            storage.getState().deleteArtifact(artifactId);
            
            // Remove encryption key from memory
            this.artifactDataKeys.delete(artifactId);
        } else if (updateData.body.t === 'new-feed-post') {
            log.log('📰 Received new-feed-post update');
            const feedUpdate = updateData.body;
            
            // Convert to FeedItem with counter from cursor
            const feedItem: FeedItem = {
                id: feedUpdate.id,
                body: feedUpdate.body,
                cursor: feedUpdate.cursor,
                createdAt: feedUpdate.createdAt,
                repeatKey: feedUpdate.repeatKey,
                counter: parseInt(feedUpdate.cursor.substring(2), 10)
            };
            
            // Check if we need to fetch user for friend-related items
            if (feedItem.body && (feedItem.body.kind === 'friend_request' || feedItem.body.kind === 'friend_accepted')) {
                await this.assumeUsers([feedItem.body.uid]);
                
                // Check if user fetch failed (404) - don't store item if user not found
                const users = storage.getState().users;
                const userProfile = users[feedItem.body.uid];
                if (userProfile === null || userProfile === undefined) {
                    // User was not found or 404, don't store this item
                    log.log(`📰 Skipping feed item ${feedItem.id} - user ${feedItem.body.uid} not found`);
                    return;
                }
            }
            
            // Apply to storage (will handle repeatKey replacement)
            storage.getState().applyFeedItems([feedItem]);
        }
    }

    private flushActivityUpdates = (updates: Map<string, ApiEphemeralActivityUpdate>) => {
        // log.log(`🔄 Flushing activity updates for ${updates.size} sessions - acquiring lock`);


        const sessions: Session[] = [];

        const now = Date.now();
        for (const [sessionId, update] of updates) {
            const session = storage.getState().sessions[sessionId];
            if (session) {
                let thinking = update.thinking ?? false;
                let thinkingAt = update.activeAt;
                const turnStartAt = this.sessionTurnStartAt.get(sessionId);
                if (
                    thinking === false
                    && turnStartAt !== undefined
                    && now - turnStartAt < Sync.TURN_START_EPHEMERAL_GRACE_MS
                ) {
                    thinking = session.thinking;
                    thinkingAt = session.thinkingAt;
                }
                sessions.push({
                    ...session,
                    active: update.active,
                    activeAt: update.activeAt,
                    thinking,
                    thinkingAt,
                });
            }
        }

        if (sessions.length > 0) {
            // console.log('flushing activity updates ' + sessions.length);
            this.applySessions(sessions);
            // log.log(`🔄 Activity updates flushed - updated ${sessions.length} sessions`);
        }
    }

    private handleEphemeralUpdate = (update: unknown) => {
        const validatedUpdate = ApiEphemeralUpdateSchema.safeParse(update);
        if (!validatedUpdate.success) {
            console.log('Invalid ephemeral update received:', validatedUpdate.error);
            console.error('Invalid ephemeral update received:', update);
            return;
        } else {
            // console.log('Ephemeral update received:', update);
        }
        const updateData = validatedUpdate.data;

        // Process activity updates through smart debounce accumulator
        if (updateData.type === 'activity') {
            // console.log('adding activity update ' + updateData.id);
            this.activityAccumulator.addUpdate(updateData);
        }

        // Handle machine activity updates
        if (updateData.type === 'machine-activity') {
            // Update machine's active status and lastActiveAt
            const machine = storage.getState().machines[updateData.id];
            if (machine) {
                const updatedMachine: Machine = {
                    ...machine,
                    active: updateData.active,
                    activeAt: updateData.activeAt
                };
                storage.getState().applyMachines([updatedMachine]);
            }
        }

        // daemon-status ephemeral updates are deprecated, machine status is handled via machine-activity
    }

    //
    // LAN channel
    //

    /**
     * Reads a session over the local network and merges what it finds into the store.
     *
     * The App is a reader on both channels and nothing here writes. This exists so a session can
     * still be read when the server is not answering: the daemon keeps its own log of everything
     * the session process saw, and serves it over the LAN.
     *
     * Dedup happens *here*, not in the reducer. The reducer keys on `msg.id`, but the same message
     * legitimately carries different ids on the two routes — the CLI logs its own outbound
     * messages under its local id, while the server hands them back under a server-assigned id.
     * `localId` is the one field both routes agree on, so messages already in the store are
     * indexed by it (and by id, for records that carry no localId) and the LAN set is filtered
     * against that index before it reaches the reducer. Without this, every message the CLI
     * itself sent would appear twice after a switch.
     *
     * Note the LAN log is *not* a complete history: the CLI only records what its process saw
     * since it started, so this is a supplement to the server's copy, never a replacement.
     *
     * Returns null when there is nothing to read over the LAN — see `readSessionOverLan` for the
     * cases that covers.
     */
    /** Every machine this App can reach, with the address it last reached it over and by which route. */
    /**
     * Every machine this device could ask something about.
     *
     * Ids, not addresses: which address to use is the channel's answer, and this used to be a second
     * address builder beside the drivers' — one that consulted neither the health of an address nor
     * the order the machine ranks them in.
     */
    private knownMachineIds(): string[] {
        const state = storage.getState();
        return [...new Set([
            ...Object.keys(state.machines),
            ...Object.keys(state.lanEndpoints),
            ...Object.keys(state.relayEndpoints),
            ...Object.keys(state.lanSightings),
            ...Object.keys(state.relayDirectory),
        ])];
    }

    /**
     * The same set, minus the machines this App is already on a live socket with.
     *
     * Those are the ones nothing has told us about lately: a machine the server channel is carrying,
     * or one whose own socket has dropped. A machine on a live LAN or relay socket is left out, since
     * that socket coming live is what asked it, and the answer it gave then is the freshest thing
     * anyone could have.
     */
    private machinesWithoutLiveSocket(): string[] {
        const sockets = Object.entries(storage.getState().daemonSockets);
        return this.knownMachineIds().filter((machineId) => !sockets.some(
            ([key, socket]) => key.startsWith(`${machineId}:`) && socket.phase === 'live'
        ));
    }

    /**
     * Asks each machine what build it is running, and records it. Never fatal.
     *
     * Asked on occasions, never on a schedule of its own: the caller decides, and each of the three
     * callers is something that happened — a socket came live, the server could not answer, or the
     * long server-channel sweep came round. A machine is asked once per occasion, with nothing
     * remembered about when it last answered, because there is no such thing as holding this answer
     * too freshly: whoever asks has a reason to.
     */
    private async refreshDaemonVersions(machineIds: string[]): Promise<void> {
        for (const machineId of machineIds) {
            if (this.daemonVersionChecks.has(machineId)) {
                continue;
            }
            this.daemonVersionChecks.add(machineId);
            try {
                const carried = await this.carryAtDaemon<{ running: string; onDisk: string | null; restartRequired: boolean }>({
                    machineId,
                    operation: 'identity',
                    run: async (baseUrl, token) => {
                        const identity = await fetchIdentity(baseUrl, token) as { versions?: { running: string; onDisk: string | null; restartRequired: boolean } };
                        return identity.versions ?? null;
                    },
                });
                if (carried.verdict) {
                    const versions = carried.verdict;
                    storage.getState().applyDaemonVersion(machineId, versions);
                    log.log(`📡 daemon ${machineId.slice(0, 8)} is running ${versions.running}${versions.restartRequired ? ' (restart required)' : ''}`);
                }
            } catch {
                // Best effort: a machine that will not answer is reported by its silence elsewhere.
            } finally {
                this.daemonVersionChecks.delete(machineId);
            }
        }
    }

    /** Machines whose version has been asked for, so a burst of reads does not ask repeatedly. */
    private daemonVersionChecks = new Set<string>();

    async fetchSessionFromDaemon(sessionId: string, forceRoute?: DaemonRoute): Promise<LanSessionRead | null> {
        const accountPublicKey = this.encryption?.contentDataKey;
        if (!accountPublicKey) {
            return null;
        }

        const machineId = storage.getState().sessions[sessionId]?.metadata?.machineId;
        const machineKey = machineId ? this.getMachineKey(machineId) : null;
        const remembered = this.daemonLinks.get(sessionId);
        const inMemory = remembered && remembered.machineId === machineId ? remembered : undefined;
        // What this App holds of the session's log, from this process or the last one. Without it a
        // restart has no way to tell whether the newest page abuts what it already holds, and a
        // window and a page that are not adjacent must never be joined.
        //
        // The persisted anchor is only usable together with the window it describes: it says "I
        // hold everything up to here", and a read from it returns only what came after. If the
        // cache is gone — cleared, never written, a fresh install — that anchor is a claim about
        // messages that are not there, and reading from it produces a window holding nothing but
        // whatever was appended since, which is to say a blank conversation with a live socket.
        const loadedWindow = storage.getState().sessionMessages[sessionId];
        const hasWindow = !!loadedWindow?.isLoaded && loadedWindow.messages.length > 0;
        const persisted = hasWindow ? this.lanWindows[sessionId] : undefined;
        const anchor = inMemory
            ? { cursor: inMemory.cursor, older: inMemory.older, hasOlder: inMemory.hasOlder }
            : persisted && persisted.machineId === machineId
                ? { cursor: persisted.cursor, older: persisted.floor, hasOlder: persisted.hasOlder }
                : null;
        const routes = this.readRoutes(sessionId, machineId, forceRoute);
        // The session's own connection when it has one, otherwise whatever this machine was last
        // reached over — same machine, so the same address and a token that covers it.
        const knownConnection = inMemory?.connection ?? (machineId ? this.lanMachineConnections.get(machineId) : undefined);
        const candidates = this.readCandidates(machineId, routes);
        /**
         * One read, with what it learned about the address written down.
         *
         * Only "nothing answered there" counts against an address: a daemon with no log for this
         * session, or one that refused this device, has said something about itself or the session
         * and nothing about whether the address works.
         */
        let lastReadFailure: string | null = null;
        // What this read already holds: the daemon answers with a whole bounded page, and
        // entries the store already has are dropped before the decryptor sees them. Without this
        // a poll re-decrypts and re-normalises hundreds of entries to learn about a handful.
        const knownIdentities = new Set<string>();
        for (const message of storage.getState().sessionMessages[sessionId]?.messages ?? []) {
            knownIdentities.add(message.id);
            const localId = 'localId' in message ? message.localId : null;
            if (localId) {
                knownIdentities.add(localId);
            }
        }
        const readPage = async (page: Parameters<typeof readSessionOverLan>[0]['page'], connection: LanConnection | null | undefined) => {
            const attempt = await readSessionOverLan({
                sessionId,
                machineId,
                accountPublicKey,
                machineKey,
                encryption: this.encryption,
                page,
                connection,
                candidates,
                isKnown: (id, localId) => knownIdentities.has(id) || (localId !== null && knownIdentities.has(localId)),
            });
            if (machineId && attempt.kind === 'unreachable' && attempt.baseUrl) {
                storage.getState().candidateFailed(machineId, routes.includes('relay') && attempt.baseUrl.includes('/r/') ? 'relay' : 'lan', attempt.baseUrl);
            } else if (machineId && attempt.kind === 'read') {
                storage.getState().candidateSucceeded(machineId, attempt.read.connection.route, attempt.read.connection.baseUrl);
            }
            if (attempt.kind !== 'read') {
                lastReadFailure = `${attempt.kind}${'reason' in attempt && typeof attempt.reason === 'string' ? `: ${attempt.reason}` : ''}`;
            }
            return attempt.kind === 'read' ? attempt.read : null;
        };

        // Converge from where this App is, and only fall back to the newest page when the log has
        // moved further than one page away. Reading forward one page per tick through a backlog is
        // what leaves a reader minutes behind on a long session; carrying the backlog is not the
        // point of the channel — seeing the newest is.
        const plan = planDaemonRead(anchor);
        let read = await readPage(plan.page, knownConnection);
        // Whether a window is replaced, re-read from the newest end, or merely extended — and the
        // refusal to empty a conversation on the strength of an empty page. Both invariants live in
        // `judgeDaemonPage`, where they are stated once and tested, rather than inline here.
        let verdict = judgeDaemonPage({
            planned: plan,
            hasWindow,
            read: read ? { hasNewer: read.hasNewer, reset: read.reset } : null,
        });
        if (verdict.kind === 'replace-from-tail') {
            // The page just read is not adjacent to what is held, so the window is not joined to it:
            // it is re-read from the newest end and *that* page is the window. A tail read that does
            // not come back leaves the window alone — there is nothing to replace it with, and what
            // is held is still what the user was looking at.
            const tail = await readPage({ kind: 'tail' }, read!.connection);
            if (!tail) {
                log.log(`📡 fetchSessionFromDaemon: no newest page for ${sessionId}; keeping the window`);
                return null;
            }
            read = tail;
            verdict = { kind: 'replace' };
        }
        const replace = verdict.kind === 'replace';
        if (read && replace && read.messages.length === 0 && hasWindow) {
            // A replacement is the whole window, so an empty one would empty the conversation. An
            // empty page is not evidence that the session has no messages — it is evidence that
            // this read learned nothing — so it is treated as a failed read instead, which leaves
            // what is held intact and lets the backoff try again. Only when a window is held: with
            // nothing to lose, an empty page is simply what the tail is.
            log.log(`📡 fetchSessionFromDaemon: empty replacement page for ${sessionId}; keeping the window`);
            return null;
        }
        // A replacement page that carries nothing newer than the window would only shrink it —
        // a fresh daemon with a short log replacing a long server-sourced window, which is the
        // "switched channels and the conversation got shorter and older" shape. `createdAt`,
        // not seq: the two channels number messages on different axes. The read still counts as
        // served below — key registration, cursors and outbox settling all carry on; only the
        // store's window is left alone.
        let keepWindow = false;
        if (read && replace && hasWindow) {
            const held = storage.getState().sessionMessages[sessionId]?.messages ?? [];
            const heldNewest = held.length > 0 ? held[held.length - 1].createdAt : 0;
            const pageNewest = read.messages.length > 0
                ? Math.max(...read.messages.map((message) => message.createdAt))
                : 0;
            if (pageNewest <= heldNewest) {
                keepWindow = true;
                log.log(`📡 fetchSessionFromDaemon: replacement page for ${sessionId} is not newer than the window; keeping the window`);
            }
        }
        if (!read) {
            // Every address was tried and none served this session. What that says about each one has
            // already been recorded per address, by the read that tried it — a route is no longer
            // marked down as a whole, which is what used to take a working address out of the
            // running along with a broken one.
            log.log(`📡 fetchSessionFromDaemon: no page for ${sessionId} on ${routes.join('>')}${machineId ? ` (${machineId.slice(0, 8)})` : ''}: ${lastReadFailure ?? 'no candidate answered'}`);
            return null;
        }
        this.settleReceivedMessages(read.received);
        const window = replace
            ? { cursor: read.cursor, older: read.older, hasOlder: read.hasOlder }
            : {
                // A follow read advances the forward anchor only. Its `older` edge belongs to the
                // page it read, which is newer than the window the user may have scrolled back to:
                // taking it would point the next "load older" at entries already on screen. The
                // window's own floor is what stands, wherever it was recovered from.
                cursor: read.cursor,
                older: anchor?.older ?? read.older,
                hasOlder: anchor?.hasOlder ?? read.hasOlder,
            };
        this.daemonLinks.set(sessionId, {
            machineId: read.machineId,
            ...window,
            connection: read.connection,
        });
        this.lanMachineConnections.set(read.machineId, read.connection);
        // The machine answered, so bring the live channel up alongside the poll, on the route that
        // answered. Fire-and-forget: polling is what keeps the session readable, and the socket
        // only removes the delay between a message being written and being seen.
        if (machineKey) {
            this.connections.want({
                route: read.connection.route,
                baseUrl: read.connection.baseUrl,
                machineId: read.machineId,
                machineKey,
            });
        }

        const oldestSeq = minSeqOf(read.messages);
        const newestSeq = maxSeqOf(read.messages);
        if (replace && !keepWindow) {
            // The page becomes the window: everything before it is "older", reachable by scrolling,
            // and nothing that was held is merged with it — merging is what would hide the range
            // between them.
            storage.getState().applyWindow(sessionId, read.messages, oldestSeq, newestSeq, read.hasOlder);
            this.sessionLastSeq.set(sessionId, Math.max(this.sessionLastSeq.get(sessionId) ?? 0, newestSeq));
        } else if (!replace) {
            // Adjacent by construction, so the shared pipeline's append and dedup apply: a repeat
            // of a page already applied lands as "nothing new". (A kept window takes neither
            // branch: the page had nothing newer than it.)
            // of a page already applied lands as "nothing new".
            this.ingestChannelRead(sessionId, { messages: read.messages, sessionKey: read.sessionKey });
            if (newestSeq > 0) {
                storage.getState().setNewestSeq(sessionId, newestSeq);
            }
        }
        // No "still behind" retry here, and none is needed: a page that came back cut short was
        // answered above by reading the newest one, and that page is the end of the log by
        // construction. Coming back for more is what walking a backlog means, and walking it is
        // what left a session opened after a day idle showing the start of the day.

        // The session key has to be registered on both paths: the live socket decrypts each pushed
        // entry with it, and a replaced window has had no `ingestChannelRead` to do it.
        if (read.sessionKey) {
            this.lanSessionKeys.set(sessionId, read.sessionKey);
            void this.encryption.initializeSessions(new Map([[sessionId, read.sessionKey]]));
        }
        // A page with no entries moved neither edge, so there is nothing to persist — and this is
        // the common case for a session that is simply being watched, where the alternative is
        // serialising the whole reducer state and rewriting the row every tick to say so.
        if (read.messages.length > 0) {
            void this.saveSessionCache(
                sessionId,
                { lastSeq: newestSeq, oldestSeq, hasOlderMessages: read.hasOlder },
                { machineId: read.machineId, cursor: window.cursor, floor: window.older, hasOlder: window.hasOlder },
            );
        }
        log.log(
            `📡 fetchSessionFromDaemon: ${read.messages.length} read ` +
            `(${read.decryptedCount}/${read.total} decrypted, tag ${read.tag}` +
            `${replace ? ', replaced window' : `, since ${inMemory?.cursor ?? anchor?.cursor}`}` +
            `${read.hasOlder ? ', older available' : ''}${read.reset ? ', anchor reset' : ''})`
        );
        return read;
    }

    /**
     * Asks a machine to restart one of its sessions, over a channel this App already has to it.
     *
     * Null when there is no such channel — no machine key, no address, or an address that did not
     * answer — and the caller then asks the server, which is what every restart used to do. That
     * single route is why a restart failed with "socket disconnected" while the machine was sitting
     * there answering reads on the LAN: what makes a session need restarting is that its machine has
     * been rebuilt, and at that moment the machine's own channel is the one that is up.
     *
     * The address tried first is the one this session was last reached over, because it is the only
     * address known to work for this machine; the relay is tried after it, for when that address has
     * moved since. Neither is discovered afresh: a restart is a rare, deliberate act and one that has
     * already failed is better reported than turned into a browse.
     */
    /**
     * One tool call's full input and result, from whichever channel has it.
     *
     * The message stream carries a truncated copy — that is what keeps a session's log, its pages
     * and its relay traffic small — and the detail view asks for the rest when the user opens it.
     * The machine keeps that rest beside the session's working tree and serves it to an
     * account-signed request; the session process serves the same payload over the server RPC.
     * Asking the machine first is what lets the detail view open when the server is the thing that
     * is down, which is the case the LAN channel exists for.
     */
    async getToolCallFullContent(sessionId: string, callId: string): Promise<GetToolCallFullContentResponse> {
        const machineId = storage.getState().sessions[sessionId]?.metadata?.machineId;
        if (machineId && this.getMachineKey(machineId)) {
            const carried = await this.carryAtDaemon<{ args?: unknown; result?: unknown }>({
                machineId,
                operation: 'read',
                // The daemon serves this one only to the account: the payload is plaintext, unlike
                // the ciphertext every other route carries.
                proofAction: { operation: 'tool-content', target: `${sessionId}:${callId}` },
                run: (baseUrl, token, proof) => fetchToolContent(baseUrl, token, sessionId, callId, proof),
            });
            if (carried.verdict) {
                return {
                    success: true,
                    // The file on disk was written from the tool's arguments, which are an object;
                    // the daemon passes the JSON through without inspecting it.
                    args: carried.verdict.args as Record<string, unknown> | undefined,
                    result: carried.verdict.result,
                };
            }
        }
        return getToolCallFullContentFromServer(sessionId, callId);
    }

    /**
     * Hands a control call to the session over a channel this App already has to its machine.
     *
     * Null when there is none, or when the machine has no live session by that id — and the caller
     * asks the server, which is where every one of these went before. The reason to prefer the
     * machine's own channel is the same one restart has: the session is running on that machine, and
     * the channel that is up is not always the server's.
     *
     * `params` is the ciphertext `sessionRPC` would have sent. The daemon forwards it without being
     * able to read it — which is why this can be offered over a plain-HTTP channel at all.
     */
    async sessionControl(
        sessionId: string,
        method: 'abort' | 'permission',
        params: string,
    ): Promise<'done' | 'refused' | 'unavailable'> {
        const outcome = await this.carrySessionAction<boolean>(sessionId, {
            operation: 'send',
            path: `/lan/sessions/${encodeURIComponent(sessionId)}/control`,
            proof: { operation: 'control', target: sessionId },
            run: (baseUrl, token, proof) => sessionControlAt(baseUrl, token, sessionId, method, params, proof).then((ok) => (ok ? true : null)),
        });
        if (outcome.verdict === true) {
            log.log(`🔄 ${method} ${sessionId}: handed to the session`);
        }
        // Three answers, because the callers act differently on them: carried, refused by a channel
        // that answered, and no channel able to take it at all.
        if (outcome.verdict === true) {
            return 'done';
        }
        return outcome.refused ? 'refused' : 'unavailable';
    }

    /** Whether this session's CLI publishes its working tree in metadata. */
    private gitStatusPublished(sessionId: string): boolean {
        return storage.getState().sessions[sessionId]?.metadata?.gitStatus !== undefined;
    }

    /**
     * Takes the working tree a session published and makes it the App's badge.
     *
     * The CLI computes it where the tree is; this is the other end of that. Equal values are
     * skipped rather than rewritten — the metadata arrives again on every reconnect and on every
     * list refresh, and an unchanged badge is not news.
     */
    private applyPublishedGitStatus(sessions: readonly { id: string; metadata?: Metadata | null }[]): void {
        const store = storage.getState();
        for (const session of sessions) {
            const status = session.metadata?.gitStatus;
            if (!status) {
                continue;
            }
            const current = store.sessionGitStatus[session.id];
            if (current && this.sameGitStatus(current, status)) {
                continue;
            }
            store.applyGitStatus(session.id, status);
        }
    }

    /** Everything the badge draws, without the timestamp that changes on every computation. */
    private sameGitStatus(a: GitStatus, b: GitStatus): boolean {
        return a.branch === b.branch
            && a.isDirty === b.isDirty
            && a.modifiedCount === b.modifiedCount
            && a.untrackedCount === b.untrackedCount
            && a.stagedCount === b.stagedCount
            && a.stagedLinesAdded === b.stagedLinesAdded
            && a.stagedLinesRemoved === b.stagedLinesRemoved
            && a.unstagedLinesAdded === b.unstagedLinesAdded
            && a.unstagedLinesRemoved === b.unstagedLinesRemoved
            && a.linesAdded === b.linesAdded
            && a.linesRemoved === b.linesRemoved
            && a.linesChanged === b.linesChanged
            && (a.upstreamBranch ?? null) === (b.upstreamBranch ?? null)
            && (a.aheadCount ?? 0) === (b.aheadCount ?? 0)
            && (a.behindCount ?? 0) === (b.behindCount ?? 0)
            && (a.stashCount ?? 0) === (b.stashCount ?? 0);
    }

    /**
     * An action a machine's own channels carry for a session: abort, answer a prompt, restart.
     *
     * One method for all of them, because they differ only in what they ask for. The rest is the
     * same and should not be written once per action: the order the channels are tried in, the
     * credential per address, the account's proof of *this* request over *this* path, and the rule
     * that an address which does not answer is a reason to try the machine's next one.
     *
     * It used to be written per action — control and restart held the same block twice — and both
     * took the first address on a route and never the second, so one unreachable address stood for
     * the whole channel.
     *
     * Returns the value the action produced, or null when no daemon channel carried it — which is
     * the caller's signal to ask the server.
     */
    private async carrySessionAction<T>(
        sessionId: string,
        action: {
            operation: ChannelOperation;
            path: string;
            /** The account's proof names this, not the path: a path changes with the route. */
            proof?: { operation: string; target: string };
            run: (baseUrl: string, token: string, proof: Record<string, string> | undefined) => Promise<T | null>;
            /**
             * How the *server* channel carries this action, when the server is the channel that
             * accepts it. Left out by callers whose action only a machine can do.
             */
            onServer?: () => Promise<T | null>;
        },
    ): Promise<{ verdict: T | null; asked: boolean; refused: boolean }> {
        const machineId = storage.getState().sessions[sessionId]?.metadata?.machineId;
        if (!machineId) {
            return { verdict: null, asked: false, refused: false };
        }
        // The same decision the session's messages are read over, so an action goes the way the
        // session is already being talked to — and the server is one of the channels here, not a
        // special case bolted on outside: which channel carries it is `accepts` and the order, and
        // a channel that fails is where the next one starts.
        const preferred = this.preferredChannel(sessionId);
        const enabled = this.daemonRoutesEnabled();
        const drivers = this.channelDrivers().filter(
            (driver): driver is ChannelDriver =>
                driver.channel === 'server' || enabled[driver.channel as DaemonRoute] === true,
        );
        // A real comparison: the preferred channel first, the rest in the order the device lists
        // them. `sort` needs an answer that does not depend on which side it is asked about.
        const rank = (channel: SessionChannel): number => (channel === preferred ? 0 : 1);
        const order = [...drivers].sort((a, b) => rank(a.channel) - rank(b.channel));

        const machineKey = this.getMachineKey(machineId);
        const outcome = await carryOperation<T>({
            drivers: order,
            operation: action.operation,
            machineId,
            attempt: async (endpoint) => {
                if (endpoint.kind === 'server') {
                    if (!action.onServer) {
                        // A machine's business only: the server has no way to carry this one.
                        return { kind: 'refused' };
                    }
                    try {
                        const value = await action.onServer();
                        return value === null ? { kind: 'absent' } : { kind: 'done', value };
                    } catch (error) {
                        // Not `refused`: the RPC may well have reached the daemon and started the
                        // work, and the answer is what did not come back. Calling that a refusal is
                        // how a restart that *did* happen gets reported as one no channel would do.
                        return { kind: 'unreachable', error };
                    }
                }
                if (!machineKey) {
                    return { kind: 'refused' };
                }
                const { token } = await getLanCredential(endpoint.baseUrl, machineKey);
                const proof = action.proof ? await accountProofHeaders(action.proof) : null;
                try {
                    const value = await action.run(endpoint.baseUrl, token, proof ?? undefined);
                    return value === null ? { kind: 'absent' } : { kind: 'done', value };
                } catch (error) {
                    if (error instanceof LanRequestError) {
                        return { kind: 'refused', status: error.status };
                    }
                    throw error;
                }
            },
            recorder: this.healthRecorder(),
        });
        return {
            verdict: outcome.kind === 'done' ? outcome.value : null,
            // Whether any channel took it on: one that answered and refused did not, one that was
            // asked and went quiet did — and to a caller those mean different things.
            asked: outcome.kind === 'done' || outcome.kind === 'unreachable' || outcome.kind === 'absent',
            // A channel *answered and said no*: about this device (a proof the machine would not
            // accept) or about the action it will not do. Asking another road is not a retry for
            // that — it is asking the same machine again, or substituting a different action, which
            // is how an abort that was refused came back as something else entirely.
            refused: outcome.kind === 'refused',
        };
    }

    /**
     * Asks a machine's own channels for something, without the caller naming a route or an address.
     *
     * The credential per address and the classification of a refusal live here rather than at each
     * call site, because they are the same question everywhere: a daemon that answers and refuses is
     * refusing *this device*, so every one of its addresses would say the same and the attempt is an
     * answer rather than an address failure. A thrown anything-else is silence, which is exactly what
     * the address health is for.
     *
     * `proofAction` is for the actions the account has to authorise (restart, control): the proof
     * names the action and its target, which is what the machine checks and what does not change with
     * the route the request takes.
     */
    private async carryAtDaemon<T>(args: {
        machineId: string;
        operation: ChannelOperation;
        proofAction?: { operation: string; target: string };
        /** Only these channels, in this order — the caller's policy, e.g. where the session is read. */
        drivers?: readonly ChannelDriver[];
        run: (baseUrl: string, token: string, proof: Record<string, string> | undefined) => Promise<T | null>;
    }): Promise<{ verdict: T | null; asked: boolean; refused: boolean }> {
        const machineKey = this.getMachineKey(args.machineId);
        if (!machineKey) {
            return { verdict: null, asked: false, refused: false };
        }
        const drivers = args.drivers ?? this.channelDrivers();
        const outcome = await carryOperation<T>({
            drivers,
            operation: args.operation,
            machineId: args.machineId,
            attempt: async (endpoint) => {
                const baseUrl = endpointBaseUrl(endpoint);
                if (!baseUrl) {
                    return { kind: 'refused' };
                }
                const { token } = await getLanCredential(baseUrl, machineKey);
                const proof = args.proofAction ? await accountProofHeaders(args.proofAction) : null;
                try {
                    const value = await args.run(baseUrl, token, proof ?? undefined);
                    // It answered. Whether the answer is what was wanted is its verdict about the
                    // request, not something to hold against the address.
                    return value === null ? { kind: 'absent' } : { kind: 'done', value };
                } catch (error) {
                    if (error instanceof LanRequestError) {
                        return { kind: 'refused', status: error.status };
                    }
                    throw error;
                }
            },
            recorder: this.healthRecorder(),
        });
        return {
            verdict: outcome.kind === 'done' ? outcome.value : null,
            // Whether any channel took it on. A channel that answered and refused did not; one that
            // was asked and went quiet did, and the two mean different things to a caller.
            asked: outcome.kind === 'done' || outcome.kind === 'unreachable' || outcome.kind === 'absent',
            // A channel answered and said no — about this device, or about the action. Asking another
            // road is not a retry for that.
            refused: outcome.kind === 'refused',
        };
    }

    /**
     * The addresses one read may try, asked of the channels themselves.
     *
     * The channels answer where they would send — ordered, health-filtered, and skipping an address a
     * read cannot afford to wait on — so the read path holds no address logic of its own any more.
     */
    private readCandidates(machineId: string | undefined, routes: readonly DaemonRoute[]): { baseUrl: string; route: 'lan' | 'relay' }[] {
        if (!machineId) {
            return [];
        }
        const now = Date.now();
        return this.channelDrivers()
            .filter((driver) => driver.channel !== 'server' && routes.includes(driver.channel as DaemonRoute))
            .flatMap((driver) => driver.endpoints(machineId, now, { forRead: true }))
            .flatMap((endpoint) => (endpoint.kind === 'address' ? [{ baseUrl: endpoint.baseUrl, route: endpoint.route }] : []));
    }

    /**
     * Which routes one read may use, asked of the channels rather than worked out here.
     *
     * `forceRoute` is the caller saying so outright. Otherwise a session on a channel reads on that
     * channel and only that one — a session on the relay does not browse for a machine known to be
     * elsewhere — and a session the server is carrying has no channel of its own, so every daemon
     * channel that would accept a read is offered, in the device's priority order.
     *
     * That order is the point of asking: the list used to be the literal `['lan', 'relay']` here,
     * so this was the one place a priority change did not reach.
     */
    private readRoutes(sessionId: string, machineId: string | undefined, forceRoute?: DaemonRoute): DaemonRoute[] {
        const drivers = this.channelDrivers().filter((driver) => driver.channel !== 'server');
        const now = Date.now();
        const pinned = storage.getState().channelOverride[sessionId];
        return readRoutes({
            forced: forceRoute,
            pinned: pinned && pinned !== 'server' ? (pinned as DaemonRoute) : pinned === 'server' ? 'server' : undefined,
            chosen: this.preferredChannel(sessionId),
            accepts: (route) => !machineId
                ? false
                : drivers.some((driver) => driver.channel === route && driver.accepts('read', machineId, now)),
        });
    }

    /** Where an attempt's outcome is written, so the next caller starts from what this one learned. */
    private healthRecorder(): HealthRecorder {
        return {
            succeeded: (machineId, route, baseUrl) => storage.getState().candidateSucceeded(machineId, route, baseUrl),
            failed: (machineId, route, baseUrl) => storage.getState().candidateFailed(machineId, route, baseUrl),
        };
    }

    /**
     * Replays what each machine says it has started and archived, from where this App left off.
     *
     * The App learns about a session here before the server knows it exists, which is the point:
     * the machine has it, so the App can be shown it, and the server catching up is a separate
     * progress. Asked on occasions rather than on a timer — a machine's own socket coming live, and
     * the hint it sends when its log moves — because the log changes a handful of times a day and a
     * poll would be all cost.
     *
     * Never fatal: an address that has moved is a reason to try again on the next occasion.
     */
    async pullMachineLifecycle(): Promise<void> {
        // One at a time: a machine that is not answering must not hold up the others, and the
        // requests are cheap enough that overlapping them buys nothing.
        //
        // Once per machine, not once per address. The cursor is the machine's, so replaying the same
        // log through a second address of the same daemon asks the same question twice and pays a
        // timeout for every address that does not answer.
        for (const machineId of this.knownMachineIds()) {
            try {
                const since = storage.getState().lifecycleCursors[machineId] ?? 0;
                const carried = await this.carryAtDaemon<{ revision: number; entries: LifecycleEntry[] }>({
                    machineId,
                    operation: 'lifecycle',
                    run: (baseUrl, token) => fetchLifecycle(baseUrl, token, since),
                });
                const answer = carried.verdict;
                if (!answer) {
                    continue;
                }
                if (answer.entries.length > 0) {
                    log.log(`🔄 lifecycle ${machineId.slice(0, 8)}: ${answer.entries.length} entr${answer.entries.length === 1 ? 'y' : 'ies'} (rev ${since} → ${answer.revision})`);
                }
                storage.getState().applyLifecycle(machineId, answer.revision, answer.entries);
            } catch {
                // The machine may be unreachable, or its daemon may predate the route.
            }
        }
    }

    async restartSession(sessionId: string, machineId: string): Promise<{ success: boolean; newSessionId?: string; error?: string } | null> {
        const machineKey = this.getMachineKey(machineId);
        if (!machineKey) {
            return null;
        }
        // The same ordering that governs where this session's messages are read from: a session
        // pinned to one channel is restarted on it, and one the App is reading over the LAN is
        // restarted there. The server is one of the carriers too — it is the one that can still be
        // asked when the session resolves to it, or when no machine route answered — so it is not
        // skipped before any carrier is tried.
        const outcome = await this.carrySessionAction<LanRestartVerdict>(sessionId, {
            operation: 'restart',
            path: `/lan/sessions/${encodeURIComponent(sessionId)}/restart`,
            proof: { operation: 'restart', target: sessionId },
            run: (baseUrl, token, proof) => restartSessionAt(baseUrl, token, sessionId, proof ?? undefined),
            // The server carries the same action by asking the daemon on this App's behalf. It is a
            // channel like the others: tried when its turn comes, and skipped when it cannot.
            onServer: () => apiSocket.machineRPC<LanRestartVerdict, { sessionId: string }>(
                machineId, 'restartSession', { sessionId },
            ),
        });
        if (outcome.verdict) {
            log.log(`🔄 restart ${sessionId}: ${outcome.verdict.success ? 'accepted' : outcome.verdict.error ?? 'refused'}`);
            return outcome.verdict;
        }
        if (outcome.asked) {
            // Somebody was asked and did not answer. The restart may well be under way — a machine
            // restarting a session takes longer than a request waits — so this is not a failure and
            // must not be reported as one.
            log.log(`🔄 restart ${sessionId}: asked, and the verdict did not come back`);
            return { success: true };
        }
        log.log(`🔄 restart ${sessionId}: no channel could carry it`);
        return null;
    }

    /**
     * Asks the daemons what sessions they have, over the LAN and the relay, and records it.
     *
     * Called when the server cannot answer. The LAN summary carries no metadata — that is
     * encrypted and only travels inside a message payload — so this cannot populate the session
     * list on its own. What it buys is knowing which sessions exist and are alive on a machine we
     * can still reach, including one this app has never seen.
     */
    async fetchSessionListFromDaemons(): Promise<number> {
        const accountPublicKey = this.encryption?.contentDataKey;
        if (!accountPublicKey) {
            return 0;
        }
        const routes = this.daemonRoutesEnabled();
        const answers = await listSessionsOverLan({
            accountPublicKey,
            // Resolved per machine: a key only answers its own machine's challenge.
            machineKeyFor: (machineId) => this.getMachineKey(machineId),
            relays: routes.relay ? Object.values(storage.getState().relayEndpoints) : [],
            browseLan: routes.lan,
        });
        if (answers.length === 0) {
            log.log('📡 fetchSessions: server unreachable, and no daemon answered on the LAN or the relay');
            return 0;
        }
        const sessions = answers.flatMap((answer) => answer.sessions.map((session) => ({ ...session, via: answer.via })));
        // Daemon-numbered from here until a server answer replaces it: a session's `seq` in this
        // list is the daemon's own counter, and comparisons against the server's axis must not
        // read it (see `serverAxisSeq`).
        this.sessionsListAxis = 'daemon';
        storage.getState().applyDaemonSessionList(sessions);
        for (const answer of answers) {
            log.log(`📡 fetchSessions: server unreachable — daemon ${answer.machineId.slice(0, 8)} reports ${answer.sessions.length} session(s) via ${answer.via}`);
        }
        // The same handshake that just read this machine's sessions can tell us what it is running —
        // the one fact about a machine that the server's copy of it cannot keep current, because a
        // version is a build id that changes whenever anything is rebuilt. The address is the one
        // that answered, so a machine reached over its relay is asked there too rather than being
        // looked for on a network it is not on.
        void this.refreshDaemonVersions(answers.map((answer) => answer.machineId));
        return sessions.length;
    }

    /**
     * Pin a session to one channel, or return it to automatic with null.
     *
     * Invalidates the message sync so the choice takes effect now rather than at the next
     * scheduled fetch — a control that appears to do nothing for several seconds is worse than
     * no control.
     */
    setSessionChannel(sessionId: string, channel: SessionChannel | null): void {
        storage.getState().setSessionChannelOverride(sessionId, channel);
        if (channel === 'server') {
            // Leaving the daemon channels: a poll started by an earlier fallback must not outlive the choice.
            this.stopDaemonPolling(sessionId);
        }
        log.log(`📡 channel for ${sessionId}: ${channel ?? 'auto'}`);
        this.getMessagesSync(sessionId).invalidate();
    }

    /**
     * Which channel a session should read and write on.
     *
     * A manual pin wins outright — that is what makes it a useful debug control, and a pin to
     * `server` is how you prove the LAN is staying out of the way.
     *
     * Otherwise the LAN wins whenever its machine is advertising on this network. It is the same
     * daemon on the local link with a live push instead of a poll and no round trip through the
     * server, so when it is there it is simply the better channel. A sighting is only present
     * while it is fresh, so a machine that leaves the network drops back to the server on the next
     * tick without anything having to notice the departure.
     *
     * Requires the machine key: without it the LAN cannot authenticate, so advertising is not
     * enough.
     */
    private preferredChannel(sessionId: string): SessionChannel {
        const [channel, reason] = this.resolveChannel(sessionId);
        if (this.channelReasons.get(sessionId) !== reason) {
            this.channelReasons.set(sessionId, reason);
            log.log(`📡 channel for ${sessionId}: ${channel} (${reason})`);
        }
        return channel;
    }

    /**
     * The channel drivers for the state and priority in hand.
     *
     * Rebuilt only when something a driver reads has moved: `resolveChannel` runs on paths that can
     * be hit per frame — the fast-ack path asks which channel a session is on — and building three
     * drivers per call would scan the socket map on every one of them.
     */
    private channelDrivers(): ChannelDriver[] {
        const state = storage.getState();
        const priority = state.localSettings.channelPriority;
        const key = [
            state.socketStatus,
            state.daemonSockets,
            state.lanSightings,
            // Read by the LAN driver, and the health is what decides whether it says yes: leaving
            // either out of the key is a cache that answers with a stale driver every time an
            // address is proven or demoted, which is the common case this work creates.
            state.lanEndpoints,
            state.candidateHealth,
            state.relayEndpoints,
            state.relayDirectory,
            state.relayHubConnected,
            state.sessions,
            state.machines,
            state.daemonSessionList,
            priority,
        ];
        const cached = this.channelDriversCache;
        if (cached && cached.key.length === key.length && cached.key.every((part, index) => part === key[index])) {
            return cached.drivers;
        }
        const drivers = buildChannelDrivers(state, priority);
        this.channelDriversCache = { key, drivers };
        return drivers;
    }

    private channelDriversCache: { key: unknown[]; drivers: ChannelDriver[] } | null = null;

    private channelReasons = new Map<string, string>();

    /** Which channel a session is on right now, and why. The single source for logic and UI alike. */
    describeChannel(sessionId: string): { channel: SessionChannel; reason: ChannelReason } {
        const [channel, reason] = this.resolveChannel(sessionId);
        return { channel, reason };
    }

    private resolveChannel(sessionId: string): [SessionChannel, ChannelReason] {
        const override = storage.getState().channelOverride[sessionId];
        if (override) {
            return [override, 'pinned'];
        }
        const session = storage.getState().sessions[sessionId];
        // A session that never declared the capability is running a build that cannot serve the LAN
        // at all: it keeps no message log for the LAN to read, and it cannot take a message
        // delivered back over it. Preferring the LAN for one would show an empty session and
        // swallow sends, so an undeclared session stays on the server until it restarts.
        if (!session) {
            return ['server', 'session-not-loaded'];
        }
        if (!session.agentState?.lanSocket) {
            return ['server', 'not-declared'];
        }
        const machineId = session.metadata?.machineId;
        if (!machineId) {
            return ['server', 'no-machine-id'];
        }
        if (!this.getMachineKey(machineId)) {
            return ['server', 'no-machine-key'];
        }
        // The three channels are peers, ordered by the (debug-configurable) priority list; a
        // channel that is switched off is simply not in it.
        //
        // What a channel may be chosen on is *this device's own measurements*, never the session's
        // claim that it supports one. A session declares the capability when it registers, which
        // says what its daemon can do in principle — not that this device can reach it, and not
        // that the daemon has anything to serve. So a daemon route is available only when the
        // device has seen the machine on it, holds a live socket to it, or has read this session
        // over it; and a route that has just failed to serve this session is not chosen again
        // until that failure ages out. Anything else puts a WiFi icon on a device that never
        // found a daemon on its network.
        const state = storage.getState();
        const priority = this.channelPriority();
        const serverDown = state.socketStatus === 'disconnected' || state.socketStatus === 'error';
        // Which channels could serve this session, from the same rule the header and the badges are
        // drawn from — they used to be worked out separately, and disagreed about the same session.
        const available = channelAvailability({
            drivers: this.channelDrivers(),
            machineId,
        });
        const { channel, reachable } = pickChannel(priority, available);
        if (!reachable) {
            // Nothing on this device has reached the machine. The session is not readable over any
            // daemon route, so it stays on the server path — which is where the content on screen
            // came from — rather than being labelled with a channel that was never established.
            // Unless the server is switched off, in which case that path is not this App's to
            // take either: the session is simply unreachable, and says so.
            return [enabledChannels(priority).server ? 'server' : priority[0], 'not-on-network'];
        }
        if ((channel === 'lan' || channel === 'relay') && (this.daemonUnavailableUntil.get(sessionId) ?? 0) > Date.now()) {
            // The daemon route for this session answered and had nothing recently — the resolver
            // says so explicitly instead of letting each read discover it again.
            return [enabledChannels(priority).server ? 'server' : channel, 'daemon-absent'];
        }
        if (channel === 'lan') {
            return ['lan', 'reachable'];
        }
        if (channel === 'relay') {
            // "Server unreachable" only describes a server that is meant to be there. One switched
            // off in the setting was not unreachable, it was not used.
            const serverOff = !enabledChannels(priority).server;
            return ['relay', serverDown && !serverOff ? 'server-down-relay' : 'by-priority'];
        }
        return ['server', priority.length === 1 || available.lan || available.relay ? 'by-priority' : 'not-on-network'];
    }

    /** Which routes a server-channel read may fall back to: only those switched on. */
    private fallbackVia(): 'lan' | 'relay' | 'any' {
        const routes = this.daemonRoutesEnabled();
        return routes.lan && routes.relay ? 'any' : routes.relay ? 'relay' : 'lan';
    }

    /** The enabled channels in preference order, from the device-local debug setting. */
    private channelPriority() {
        return normalizeChannelPriority(storage.getState().localSettings.channelPriority);
    }

    /** Whether any daemon route (LAN or relay) is switched on; with neither, the server is the only path. */
    private daemonRoutesEnabled(): { lan: boolean; relay: boolean } {
        const enabled = enabledChannels(this.channelPriority());
        return { lan: enabled.lan, relay: enabled.relay };
    }

    private daemonSocketWatch: (() => void) | null = null;

    /**
     * The one relay connection, when the relay is switched on.
     *
     * It replaces a per-machine socket, a per-machine address and a 30-second probe of each machine:
     * the relay holds every daemon that dialled in and publishes what sessions each has, so being
     * reachable is something the App is told rather than something it works out. `./lan/relayHub`
     * has the protocol; this owns the lifetime.
     */
    private relayHub: RelayHub | null = null;
    /**
     * The last directory the relay pushed, before this App has named its machines.
     *
     * The two halves arrive independently — the relay says which tags it holds, and the machine
     * keys say which tag belongs to which machine — and either can be first: a cold start has no
     * keys until the server answers, and no directory until the hub connects. Keeping the raw answer
     * is what lets a tag learned later be matched against a directory that has already arrived,
     * instead of leaving the hub connected and every machine in it unnamed.
     */
    private relayDirectoryRaw: HubMachine[] = [];
    private relayHubWatch: (() => void) | null = null;
    /** The relay address the current hub was opened for, so a new one is a new connection. */
    private relayHubEndpoint: string | null = null;
    /** Each machine's relay tag — the relay's name for it — derived from its key. */
    private machineTags = new Map<string, string>();
    /**
     * Machines whose daemon does not answer heartbeats, so a live socket to them is not proof that
     * anything is arriving.
     *
     * This is what keeps the polling fallback on: `stopDaemonPolling` is a claim that pushes are
     * arriving, and it can only be made about a connection that has been proven alive since it came
     * up. An old daemon — one whose CLI predates the heartbeat — is the case that is otherwise
     * indistinguishable from a dead socket, and it would leave every session on that machine with
     * neither a push nor a poll.
     */
    private unverifiedMachines = new Set<string>();

    /**
     * Names the machines the relay holds, now that both halves are known.
     *
     * Called from both directions — the directory arriving, and a machine key being learned — so a
     * hub that connected before the keys did is not left with a directory it cannot read.
     */
    private mapRelayDirectory(): void {
        this.relayMachines.clear();
        const entries: RelayDirectoryEntry[] = [];
        const unknownTags: string[] = [];
        const at = Date.now();
        for (const machine of this.relayDirectoryRaw) {
            // The relay names machines by tag — a hash it cannot invert — and this App is the one
            // that knows which machine a tag belongs to, because it derives the tag from the
            // machine's own key. A tag nothing matches is reported rather than dropped: it is a
            // machine that is up and that this device cannot name.
            const machineId = this.machineIdForTag(machine.tag);
            if (machineId) {
                entries.push({
                    machineId,
                    tag: machine.tag,
                    sessions: Array.isArray(machine.sessions) ? (machine.sessions as RelayDirectoryEntry['sessions']) : [],
                    ...(machine.reachable ? { reachable: machine.reachable } : {}),
                    at,
                });
            } else {
                unknownTags.push(machine.tag);
            }
        }
        for (const entry of entries) {
            this.relayMachines.set(entry.machineId, { tag: entry.tag, sessions: entry.sessions });
        }
        // Where each machine says it can be reached, merged exactly as the server's copy of the same
        // claim is. This is the relay doing the job the server would otherwise do, and it matters
        // most when the server is the thing that is gone: without it, a machine on this very network
        // has no address the App can try.
        for (const entry of entries) {
            if (entry.reachable) {
                const blob = { p2p: entry.reachable };
                storage.getState().applyLanEndpoint(entry.machineId, parseLanEndpoints(entry.machineId, blob));
                storage.getState().applyRelayEndpoint(entry.machineId, parseRelayEndpoint(entry.machineId, blob));
            }
        }
        // Worth a line of its own: a machine the relay is holding but this App cannot name has no
        // relay icon and no relay route, and it looks exactly like a machine that is not on the
        // relay at all. The count of unnamed tags is the difference, and the reason is always the
        // same one — the tag is a hash, and only the machine's key turns it back into a machine.
        const named = entries.map((entry) => entry.machineId.slice(0, 8)).join(' ');
        log.log(`📡 relay directory: ${this.relayDirectoryRaw.length} machine(s) held by the relay, ${entries.length} named, ${unknownTags.length} unnamed${named ? ` — ${named}` : ''}`);
        storage.getState().applyRelayDirectory(entries, unknownTags);
        this.reconcileDaemonSockets();
    }

    /** Which machine a relay tag belongs to, or null when this device holds no key for it. */
    private machineIdForTag(tag: string): string | null {
        for (const [machineId, known] of this.machineTags) {
            if (known === tag) {
                return machineId;
            }
        }
        return null;
    }
    /** The machines the relay is holding, by machineId, with what each published. */
    private relayMachines = new Map<string, HubMachine>();

    /**
     * Fill in each machine's relay route from its machine key.
     *
     * A route's usual source is the machine's published `daemonState`, which arrives through the
     * server — so with the server switched off, which is the one case the relay exists for, the App
     * has no address to try. It does not need one: the tag is a function of the machine key it has
     * held since pairing, and the relay's own address is a setting. What the server publishes still
     * wins where it exists, so this only fills a gap.
     */
    async deriveRelayRoutes(): Promise<void> {
        const relayUrl = this.relayOrigin();
        // The hub is the relay *connection*: it comes up whether or not this device can name a
        // machine yet, because the relay naming them is the point — and a cold start learns both
        // halves independently.
        this.ensureRelayHub();
        if (this.machineDataKeys.size === 0) {
            return;
        }
        for (const [machineId, machineKey] of this.machineDataKeys) {
            try {
                const tag = await relayTagFor(machineKey, {
                    hmacSha256: hmac_sha256,
                    sha256: async (data) => new Uint8Array(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, new Uint8Array(data))),
                    signKeyPairFromSeed: (seed) => sodium.crypto_sign_seed_keypair(seed),
                });
                this.machineTags.set(machineId, tag);
                // The address is kept for reads, which are plain HTTPS requests to the relay and
                // need one; the hub does not, since it addresses machines by tag. Marked `derived`
                // because that is all it is: a route we computed, not one the machine published —
                // it is worth trying, and it is not evidence the machine runs a relay client.
                if (storage.getState().relayEndpoints[machineId]?.source !== 'published') {
                    storage.getState().applyRelayEndpoint(machineId, {
                        machineId,
                        baseUrl: relayBaseUrlFor(relayUrl, tag),
                        source: 'derived',
                        at: Date.now(),
                    });
                    log.log(`🔁 derived the relay route for ${machineId.slice(0, 8)} from its key`);
                }
            } catch (error) {
                log.log(`🔁 could not derive a relay route for ${machineId.slice(0, 8)}: ${String(error)}`);
            }
        }
        this.ensureRelayHub();
    }

    /**
     * Opens or closes the one relay connection, to match whether the relay is switched on.
     *
     * The hub is the relay channel's whole transport: with it up, a machine the relay is holding is
     * reachable, and a machine it is not holding is not — no probe, no sighting, no per-machine
     * address. With it down, the relay channel says so rather than being guessed at.
     */
    /**
     * Where the relay is.
     *
     * Learned, not configured: a daemon knows the relay it dials out to and publishes the route it
     * built from it, so the App reads the address off the machines it already has. The built-in
     * default only covers a device that has not synced with the server yet — the one case where
     * nothing has been published and there is still a relay to be reached.
     */
    private relayOrigin(): string {
        for (const endpoint of Object.values(storage.getState().relayEndpoints)) {
            const origin = relayOriginOf(endpoint.baseUrl);
            if (origin) {
                return origin;
            }
        }
        return DEFAULT_RELAY_URL;
    }

    /** The relay this App is using. Learned from the machines; the built-in default until then. */
    relayAddress(): string {
        return this.relayOrigin();
    }

    private ensureRelayHub(): void {
        const relayUrl = this.relayOrigin();
        const priority = this.channelPriority();
        const wanted = enabledChannels(priority).relay;
        // Said out loud at startup, because "the relay is off in the priority" and "the relay cannot
        // be reached" look identical everywhere else — a section with nothing connected either way.
        log.log(
            wanted
                ? `🔁 relay hub: enabled, ${relayUrl} (priority ${priority.join('›')})`
                : `🔁 relay hub: the relay channel is off in the priority (${priority.join('›')})`,
        );
        if (!wanted) {
            this.relayHubWatch?.();
            this.relayHubWatch = null;
            this.relayHub?.close();
            this.relayHub = null;
            this.relayHubEndpoint = null;
            this.relayMachines.clear();
            this.reconcileDaemonSockets();
            return;
        }
        const endpoint = relayHubUrl(relayUrl as string);
        if (this.relayHub && this.relayHubEndpoint === endpoint) {
            return;
        }
        // A different relay is a different connection: keeping the old one would leave the App
        // talking to the relay it was told to stop using.
        if (this.relayHub) {
            this.relayHubWatch?.();
            this.relayHubWatch = null;
            this.relayHub.close();
            this.relayHub = null;
            this.relayMachines.clear();
        }
        this.relayHubEndpoint = endpoint;
        const hub = new RelayHub(endpoint, (message) => { log.log(message); });
        this.relayHub = hub;
        this.relayHubWatch = hub.onMachines((machines) => {
            this.relayDirectoryRaw = machines;
            this.mapRelayDirectory();
        });
        const statusWatch = hub.onStatus((connected) => {
            storage.getState().setRelayHubConnected(connected);
        });
        const machinesWatch = this.relayHubWatch;
        this.relayHubWatch = () => { machinesWatch(); statusWatch(); };
        hub.connect();
        log.log(`🔁 relay hub connecting to ${endpoint}`);
    }

    /**
     * Say which daemon connections should exist: one per machine this App can reach, per route.
     *
     * The App talks to every machine it has, the way it talks to the server — a machine is a daemon
     * with sessions on it, and a route is only how the bytes get there. So both routes are wanted
     * for as long as they are switched on and the machine is reachable over them, and neither
     * depends on how the server is doing this second. The relay socket used to exist only while the
     * server was down or a session was pinned to it, and there was only ever *one* socket per route,
     * whose machine was chosen by whichever sighting came first in a map — so the App could talk to
     * one of its machines at a time, replaced the connection whenever a different machine's session
     * was read, and any message written in between went to a daemon that had no such session.
     *
     * A read is itself evidence that a machine is reachable, so the machines being read are wanted
     * even between probes and scans: the connection a read established must not be torn down by the
     * next scan failing to mention it.
     */
    private reconcileDaemonSockets(): void {
        const state = storage.getState();
        const routes = this.daemonRoutesEnabled();
        const targets = new Map<string, DaemonTarget>();
        const add = (machineId: string, route: DaemonRoute, baseUrl: string) => {
            const machineKey = this.getMachineKey(machineId);
            if (machineKey) {
                targets.set(`${machineId}:${route}`, { machineId, route, baseUrl, machineKey });
            }
        };

        // What each channel wants a socket at, asked of the channels. This was four sources assembled
        // here — sightings, the best published address, the relay's directory, and the sessions being
        // read — each with its own idea of which address wins, and the loop order decided the answer:
        // a published address overwrote a mDNS sighting for the same machine simply by being added
        // second.
        //
        // Now the ranking is the one the channels already use for a read, so a socket sits where a
        // read would go. The relay is the case that needed its own guard: every machine with a key
        // has a derived relay address, and holding a stream open for each of those would be a
        // connection to a machine that never dialled in.
        const now = Date.now();
        for (const driver of this.channelDrivers()) {
            if (driver.channel === 'server' || routes[driver.channel as DaemonRoute] !== true) {
                continue;
            }
            for (const machineId of this.knownMachineIds()) {
                const target = driver.socketTarget(machineId, now);
                const baseUrl = target ? endpointBaseUrl(target) : null;
                if (baseUrl) {
                    add(machineId, driver.channel as DaemonRoute, baseUrl);
                }
            }
        }

        // And the sessions being read — but only where a channel named nothing. A read's address is
        // proof that it answers, and for a machine no sighting or published endpoint covers it is
        // the only address there is. It is not a better answer than the channel's, though: the
        // same machine is usually reachable under two equally good addresses (its mDNS name and
        // its IP), a read may hold either one, and letting it overwrite the ranking moved the live
        // socket from one to the other every time a scan or a read reconciled. Each move closes a
        // working socket and reopens it, which is the "connecting" the user watches.
        for (const link of this.daemonLinks.values()) {
            if (targets.has(`${link.machineId}:${link.connection.route}`)) {
                continue;
            }
            add(link.machineId, link.connection.route, link.connection.baseUrl);
        }

        this.connections.wantOnly([...targets.values()]);
    }

    /**
     * What a route's connection pushes at us: the daemon's two hints, and everything else straight
     * to `handleUpdate`, which is the same handler the server socket feeds.
     */
    private onDaemonUpdate(route: DaemonRoute, payload: unknown): void {
        const body = (payload as {
            body?: { t?: string; id?: string; entry?: LanSessionLogEntry; anchor?: string; head?: string };
        } | null)?.body;
        // The machine's own log moved — a session it started, or one it archived. A hint, not the
        // entry: this asks for what it missed with its own cursor, which is what keeps the replay
        // per-reader and what makes it an occasion rather than a poll.
        if (body?.t === 'lifecycle') {
            void this.pullMachineLifecycle();
            return;
        }
        // The daemon's hint that a session's local log grew. It is not a server update, so it never
        // reaches handleUpdate: it only means "read now" instead of waiting for the next poll tick.
        // It stays even though entries are pushed as well — it is what recovers a frame the socket
        // missed while it was down.
        if (body?.t === 'log-grew' && body.id) {
            if (this.preferredChannel(body.id) !== route) {
                return;
            }
            // The hint carries where the log now ends, so a reader that is already there has
            // nothing to do. Without this the App read the log every time anything was appended —
            // a round trip, a decrypt and a store write to learn that the entry had already arrived
            // over this very socket, which is a radio waking up every couple of seconds on a phone.
            this.lastHintHeads.set(body.id, body.head ?? '(none)');
            if (this.isAtLogHead(body.id, body.head)) {
                return;
            }
            this.scheduleLogGrewRead(body.id);
            return;
        }
        // An entry the session wrote to its log, pushed as it was appended. Applying it here is what
        // makes the LAN channel deliver a message rather than announce one: no round trip, and dedup
        // on `localId` means the overlapping read cannot double it. Only for sessions that resolve
        // to this route — a session pinned to the server reads the same bytes from there, and
        // applying both would be the one path the dedup is not set up to cover.
        if (body?.t === 'log-entry' && body.id && body.entry) {
            if (this.preferredChannel(body.id) === route) {
                // An agent streaming output appends entries in bursts; applying and rendering each
                // one separately re-rendered the whole visible list per entry, which is the
                // "message page takes seconds to update" shape. Entries are batched into one
                // store update instead.
                this.queuePushedEntry(body.id, body.entry, body.anchor);
            }
            return;
        }
        void this.handleUpdate(payload);
    }

    /**
     * Mark everything the session has taken in as delivered.
     *
     * The explicit verdict is one frame on a socket that may have been replaced since, so a lost
     * frame used to look like a lost message: the entry failed after its timeout while the session
     * had it all along, and the user was told to send it again. The session writes its own record of
     * what it received — `dir: 'in'` with the same `localId` — and that comes back on every read and
     * every push, so it is the proof.
     */
    private settleReceivedMessages(localIds: string[]): void {
        if (localIds.length === 0) {
            return;
        }
        const outbox = storage.getState().outbox;
        for (const localId of localIds) {
            const entry = outbox[localId];
            if (entry && entry.status === 'sending') {
                storage.getState().markOutboxMessageDelivered(localId);
                const timer = this.lanSendTimeouts.get(localId);
                if (timer) {
                    clearTimeout(timer);
                    this.lanSendTimeouts.delete(localId);
                }
            }
        }
    }

    /**
     * Where the App's reading of a session's log has got to, counting what has been pushed as well
     * as what has been read: an entry delivered over the socket is one the App holds, whether or not
     * a read was what brought it.
     */
    private pushedPositions = new Map<string, string>();

    /** Entries pushed but not yet applied, per session, and the timer that will apply them. */
    private pushedEntryBatches = new Map<string, { entries: LanSessionLogEntry[]; anchors: (string | undefined)[] }>();
    private pushedEntryTimers = new Map<string, ReturnType<typeof setTimeout>>();
    /** Long enough to merge a streaming burst, short enough to read as live. */
    private static readonly PUSH_BATCH_MS = 100;

    private queuePushedEntry(sessionId: string, entry: LanSessionLogEntry, anchor: string | undefined): void {
        let batch = this.pushedEntryBatches.get(sessionId);
        if (!batch) {
            batch = { entries: [], anchors: [] };
            this.pushedEntryBatches.set(sessionId, batch);
        }
        batch.entries.push(entry);
        batch.anchors.push(anchor);
        if (this.pushedEntryTimers.has(sessionId)) {
            return;
        }
        const timer = setTimeout(() => {
            this.pushedEntryTimers.delete(sessionId);
            const pending = this.pushedEntryBatches.get(sessionId);
            this.pushedEntryBatches.delete(sessionId);
            if (pending && pending.entries.length > 0) {
                void this.applyPushedEntries(sessionId, pending.entries, pending.anchors);
            }
        }, Sync.PUSH_BATCH_MS);
        (timer as unknown as { unref?: () => void }).unref?.();
        this.pushedEntryTimers.set(sessionId, timer);
    }

    /** One store update for a burst of pushed entries — see `queuePushedEntry`. */
    private async applyPushedEntries(sessionId: string, entries: LanSessionLogEntry[], anchors: (string | undefined)[]): Promise<void> {
        const sessionKey = this.lanSessionKeys.get(sessionId);
        if (!sessionKey) {
            // Same rule as a single pushed entry: without the key the position must not move.
            return;
        }
        try {
            const decrypted = await decryptLanEntries(this.encryption, sessionKey, entries);
            const messages = toNormalizedMessages(decrypted);
            if (messages.length > 0) {
                const fresh = this.ingestChannelRead(sessionId, { messages });
                log.log(`📡 LAN entries applied for ${sessionId}: ${fresh} new of ${messages.length} (batched)`);
            }
            const received: string[] = [];
            for (const entry of entries) {
                if (entry.dir === 'in' && entry.localId) {
                    received.push(entry.localId);
                }
            }
            this.settleReceivedMessages(received);
            let newest: string | undefined;
            for (const anchor of anchors) {
                if (anchor && (!newest || this.compareAnchors(anchor, newest) > 0)) {
                    newest = anchor;
                }
            }
            this.notePushedPosition(sessionId, newest);
        } catch (error) {
            log.log(`📡 LAN entries for ${sessionId} could not be applied: ${String(error)}`);
        }
    }

    /** The last head a hint reported, per session: what the positions above are compared against. */
    private lastHintHeads = new Map<string, string>();
    /** A pending read for a `log-grew` that may yet be answered by the socket itself. */
    private logGrewReadTimers = new Map<string, ReturnType<typeof setTimeout>>();
    /** When this session was last read because of a `log-grew`. */
    private lastLogGrewReadAt = new Map<string, number>();

    /**
     * How long a `log-grew` hint waits for the entry it is about to push.
     *
     * The hint and the entries travel the same socket, and the hint regularly arrives first. Reading
     * on the hint alone meant an active session was read — a hundred messages decrypted and applied
     * — every couple of seconds for messages that had already been pushed, which held the JS thread
     * and the cache queue and made the session the person was looking at the slowest one. Half a
     * second is longer than the gap between the two frames and far shorter than a person notices.
     */
    private static readonly LOG_GROW_GRACE_MS = 500;
    /**
     * The floor between two hint-driven reads of the same session.
     *
     * A hint that keeps finding the reader behind despite the socket delivering entries is a
     * genuine gap (a frame the socket missed), and one read closes it. Repeating the read every
     * time the daemon appends is not a gap — it is a reader chasing a writer, and the live socket
     * is what is carrying that traffic.
     */
    private static readonly LOG_GROW_READ_MIN_INTERVAL_MS = 5_000;

    private scheduleLogGrewRead(sessionId: string): void {
        if (this.logGrewReadTimers.has(sessionId)) {
            return;
        }
        const timer = setTimeout(() => {
            this.logGrewReadTimers.delete(sessionId);
            // By now the entry the hint was about has almost certainly been pushed and applied.
            const head = this.lastHintHeads.get(sessionId);
            if (head && head !== '(none)' && this.isAtLogHead(sessionId, head)) {
                return;
            }
            const last = this.lastLogGrewReadAt.get(sessionId) ?? 0;
            if (Date.now() - last < Sync.LOG_GROW_READ_MIN_INTERVAL_MS) {
                return;
            }
            this.lastLogGrewReadAt.set(sessionId, Date.now());
            this.messagesSync.get(sessionId)?.invalidate();
        }, Sync.LOG_GROW_GRACE_MS);
        (timer as unknown as { unref?: () => void }).unref?.();
        this.logGrewReadTimers.set(sessionId, timer);
    }

    private notePushedPosition(sessionId: string, anchor: string | undefined): void {
        if (!anchor || this.compareAnchors(anchor, this.pushedPositions.get(sessionId)) <= 0) {
            return;
        }
        this.pushedPositions.set(sessionId, anchor);
        // Follow forward from here rather than from wherever the last read stopped: the entries
        // between are already applied, and re-fetching them only to dedup them away is the round
        // trip this exists to avoid.
        const link = this.daemonLinks.get(sessionId);
        if (link && this.compareAnchors(anchor, link.cursor) > 0) {
            this.daemonLinks.set(sessionId, { ...link, cursor: anchor });
        }
    }

    /** `"<segment>:<byte>"`, compared as positions: the segment first, then the byte within it. */
    private compareAnchors(a: string, b: string | undefined): number {
        if (b === undefined) {
            return 1;
        }
        const parse = (value: string) => value.split(':').map((part) => Number.parseInt(part, 10));
        const [aSegment, aByte] = parse(a);
        const [bSegment, bByte] = parse(b);
        if (!Number.isFinite(aSegment) || !Number.isFinite(bSegment)) {
            return 0;
        }
        return aSegment === bSegment ? aByte - bByte : aSegment - bSegment;
    }

    /**
     * Whether this App already holds everything up to `head`.
     *
     * Only true with a window in place: without one there is nothing for a push to be a continuation
     * of, and the read that establishes it has to happen before "up to date" can mean anything.
     */
    private isAtLogHead(sessionId: string, head: string | undefined): boolean {
        if (!head || !this.daemonLinks.has(sessionId)) {
            return false;
        }
        const position = this.pushedPositions.get(sessionId) ?? this.daemonLinks.get(sessionId)?.cursor;
        const comparison = position ? this.compareAnchors(head, position) : 1;
        if (comparison <= 0) {
            log.log(`📡 log-grew for ${sessionId} is already covered; no read`);
            return true;
        }
        return false;
    }

    /** The session's verdict on a message sent over its connection. */
    private async onLanDelivered(result: { sessionId: string; localId: string; delivered: boolean }): Promise<void> {
        const timer = this.lanSendTimeouts.get(result.localId);
        if (timer) {
            clearTimeout(timer);
            this.lanSendTimeouts.delete(result.localId);
        }
        // A write is not a delivery, and the App cannot see whether the session could read the
        // message — so this verdict is the only thing separating a dropped message from one that
        // looks sent forever.
        if (result.delivered) {
            storage.getState().markOutboxMessageAcked(result.localId);
            return;
        }
        // "No process" is not a failed message. The daemon is up — it is who answered — and starting
        // the session is something it can do with no other session running. One retry: a process
        // that still is not there the second time is a refusal, and the message says so.
        const attempts = this.deliveryWakeAttempts.get(result.localId) ?? 0;
        if (attempts < 1) {
            this.deliveryWakeAttempts.set(result.localId, attempts + 1);
            const wake = await this.wakeSession(result.sessionId);
            if (wake !== 'failed') {
                this.getSendSync(result.sessionId).invalidate();
                return;
            }
        }
        storage.getState().failOutboxEntries(
            [result.localId],
            'The session could not read this message.',
        );
    }

    /**
     * Whether the machine that owns this session has said its process is not running.
     *
     * Only an explicit "not alive" counts. No report is not a down session — it is a machine this
     * device has not heard a roster from, and waking on that would restart sessions that are fine.
     */
    private sessionReportedDown(sessionId: string): boolean {
        const state = storage.getState();
        const listed = state.daemonSessionList[sessionId];
        if (listed) {
            return listed.isAlive === false;
        }
        const machineId = state.sessions[sessionId]?.metadata?.machineId;
        const published = machineId
            ? state.relayDirectory[machineId]?.sessions.find((session) => session.happySessionId === sessionId)
            : undefined;
        return published?.isAlive === false;
    }

    /**
     * Ask the owning machine to start this session's process.
     *
     * The daemon answers this with no session running at all: it is the process that LaunchDaemon
     * brings back, and the sessions are what it starts. A second ask inside the window is not a
     * second start — the first one is still the answer.
     */
    private async wakeSession(sessionId: string): Promise<'woken' | 'recent' | 'failed'> {
        const last = this.lastSessionWakeAt.get(sessionId) ?? 0;
        if (Date.now() - last < Sync.SESSION_WAKE_WINDOW_MS) {
            return 'recent';
        }
        const machineId = storage.getState().sessions[sessionId]?.metadata?.machineId;
        if (!machineId) {
            return 'failed';
        }
        this.lastSessionWakeAt.set(sessionId, Date.now());
        const verdict = await this.restartSession(sessionId, machineId);
        if (verdict?.success) {
            log.log(`🔄 wake ${sessionId}: the machine is starting its process`);
            return 'woken';
        }
        log.log(`🔄 wake ${sessionId}: ${verdict?.error ?? 'no channel could start it'}`);
        return 'failed';
    }

    /** A connection came up: the sessions on that machine no longer need their polling fallback. */
    /**
     * Whether a machine's connection change is one the session on screen is served by.
     *
     * Every socket flap used to re-read the visible session — and with several machines' relay
     * sockets cycling every few seconds, that was a re-read per flap, each one paying a full
     * channel round (LAN probe timeouts, relay, then the server) while holding the session's read
     * lock. A flap on a machine that does not own the visible session changes nothing for it.
     */
    private markVisibleStaleForMachine(machineId: string): void {
        const visible = this.readScheduler.visibleSessionId;
        if (!visible) {
            return;
        }
        if (storage.getState().sessions[visible]?.metadata?.machineId === machineId) {
            this.readScheduler.markStale();
        }
    }

    private onDaemonConnectionReady(target: DaemonTarget): void {
        // A socket that came up is proof about the address, and the same fact the read path
        // records: it keeps a working address at the front of the candidate list and clears a run
        // of failures the socket may have accumulated while the machine was restarting.
        storage.getState().candidateSucceeded(target.machineId, target.route, target.baseUrl);
        // The machine's own log, asked the moment its channel comes up: this is the fastest channel
        // there is, and the sessions it has are the ones the server may not know about yet.
        void this.pullMachineLifecycle();
        // A connection that is up is one worth asking again whether it can answer: a daemon that
        // has been updated since the last attempt will say so, and one that has not is written off
        // again after a single missed heartbeat.
        this.unverifiedMachines.delete(target.machineId);
        // A connection that came up may have missed pushes while it was down. The session on
        // screen is read once to close the gap; hidden sessions read when opened.
        this.markVisibleStaleForMachine(target.machineId);
        // Anything still waiting for a verdict may have been written into the socket this replaced.
        // The queue still holds it, so a connection coming up is the moment to try it again — this
        // is what turns "the message you sent while the channel was flapping" into a delay rather
        // than a loss, without the user having to send a second one to notice.
        const waiting = new Set<string>();
        for (const entry of Object.values(storage.getState().outbox)) {
            if (entry.status === 'sending') {
                waiting.add(entry.sessionId);
            }
        }
        for (const sessionId of waiting) {
            this.resendOutbox(sessionId);
        }
    }

    /**
     * The daemon behind a live connection never answered a heartbeat: it is connected, but nothing
     * proves it is still there, so the polling fallback stays on for its sessions.
     */
    private onDaemonHeartbeatUnsupported(target: DaemonTarget): void {
        this.unverifiedMachines.add(target.machineId);
        // The daemon cannot push; the visible session's scheduler poll is the fallback. Hidden
        // sessions on this machine read when opened — a timer each was a fetch storm.
        this.markVisibleStaleForMachine(target.machineId);
    }

    /** A connection went away: whatever it was carrying has just lost its push. */
    private onDaemonConnectionDropped(target: DaemonTarget): void {
        // Sessions that were being served at this address are told to read again, because the push
        // they were relying on is gone. The *token* is deliberately not touched: a socket dying
        // says nothing about a token the daemon still has on its books — the two are authenticated
        // separately, and the daemon refuses a token only when it no longer knows the nonce behind
        // it, which is a restart and not a dropped socket. Voiding on a drop made one socket's
        // death cost a handshake from every reader sharing the address, against a rate limit that
        // exists precisely to bound that. A token that really has gone stale is handled where it is
        // discovered: the read that gets a 401 replaces it and retries.
        // Named by the daemon, not by the address: a machine that dropped is the machine whose
        // sessions lost their push. The session on screen is re-read now; the others when they are
        // opened — invalidating every session on the machine was one transport's death becoming a
        // read of every conversation on it.
        this.markVisibleStaleForMachine(target.machineId);
        const known = this.lanMachineConnections.get(target.machineId);
        if (known && known.route === target.route) {
            this.lanMachineConnections.delete(target.machineId);
        }
    }

    /**
     * Applies one log entry the daemon pushed over the live socket.
     *
     * The frame carries the same entry a history read returns, so it goes through the same two
     * steps that read does — open it with the session key, normalize it — and then into
     * `ingestChannelRead`, which is where `localId` dedup lives. That overlap is the point: an
     * entry pushed while a read is in flight must not land twice.
     *
     * A key we do not hold yet is not an error: it arrives with the first read, and until then the
     * read is the only path that could have applied the entry anyway. A frame that will not open is
     * likewise a delay rather than a loss — the entry is still in the session's log, so the next
     * read delivers it.
     */
    private async applyPushedDaemonEntry(sessionId: string, entry: LanSessionLogEntry, anchor?: string): Promise<void> {
        if (entry.dir === 'in' && entry.localId) {
            this.settleReceivedMessages([entry.localId]);
        }
        const sessionKey = this.lanSessionKeys.get(sessionId);
        if (!sessionKey) {
            // The key arrives with the first read, and until then this entry cannot be opened — so
            // the position must not move either. Recording it here would say "I hold this entry"
            // about one that was dropped, and the hint that follows would then find the reader
            // already up to date and never fetch it: a message missing for good, which is what a
            // turn that stops at a tool call looks like from the outside.
            return;
        }
        try {
            const decrypted = await decryptLanEntries(this.encryption, sessionKey, [entry]);
            const messages = toNormalizedMessages(decrypted);
            if (messages.length > 0) {
                const fresh = this.ingestChannelRead(sessionId, { messages });
                log.log(`📡 LAN entry applied for ${sessionId}: ${fresh} new of ${messages.length} (over the socket)`);
            }
            // Consumed, whether or not it produced a message the reducer keeps: an entry that
            // normalises to nothing (an event, say) is still one the reader no longer needs.
            this.notePushedPosition(sessionId, anchor);
        } catch (error) {
            log.log(`📡 LAN entry for ${sessionId} could not be applied: ${String(error)}`);
        }
    }

    /**
     * Waits for the session to say whether it could read a message sent over the LAN.
     *
     * Bounded on purpose: a verdict that never comes — an older session that cannot read the
     * frame at all, or a socket that dies mid-flight — would otherwise leave the entry "sending"
     * indefinitely, which is a spinner the user cannot clear.
     */
    private awaitLanDelivery(localId: string): void {
        if (this.lanSendTimeouts.has(localId)) {
            return;
        }
        this.checkLanDelivery(localId, Sync.LAN_DELIVERY_TIMEOUT_MS, true);
    }

    /**
     * The daemon socket this session's messages may be written on — its own machine's, or none.
     *
     * A route holds one socket, and that socket belongs to one machine. Writing a session's message
     * to another machine's daemon is a message handed to a session that does not exist there: the
     * daemon looks the id up, finds nothing, answers `delivered: false`, and the message is gone
     * from every point of view except the outbox. That is exactly what the App did whenever its
     * relay socket was pointed at a different machine than the session's — with several machines
     * publishing routes, that was most of the time, and it read as "the first message is always
     * lost, the second one arrives".
     *
     * So the route's socket is used only when it is the session's own machine's, and otherwise this
     * says nothing is available: the caller falls back to the server, or leaves the message queued,
     * which are both outcomes where the message still exists.
     *
     * `trusted` rather than `current`, for the other half of the same problem: a socket that has
     * missed a heartbeat is one whose peer may be gone, and a write into it is accepted locally and
     * goes nowhere.
     */
    private daemonSendTarget(sessionId: string): { handle: LanSocketHandle; baseUrl: string; machineId: string } | null {
        const channel = this.preferredChannel(sessionId);
        if (channel === 'server') {
            return null;
        }
        const machineId = storage.getState().sessions[sessionId]?.metadata?.machineId;
        if (!machineId) {
            return null;
        }
        return this.connections.trusted(machineId, channel);
    }

    /**
     * Writes the session's unconfirmed messages again over the daemon channel, if one is usable.
     *
     * Kept apart from `flushOutbox` on purpose. A flush is a claim about the whole queue — it
     * records waits, falls back to the server, and can fail the entries — while this is the narrow
     * repair for one possibility: the earlier write was accepted by a socket whose peer was already
     * gone. Nothing here may start a wait cycle, or a message that never confirms would keep
     * extending its own deadline instead of failing at it. Doing nothing when no daemon connection
     * is usable is correct: the ordinary flush, on its next tick, is what reaches the other
     * channels.
     */
    private resendOutbox(sessionId: string): void {
        const pending = this.pendingOutbox.get(sessionId);
        if (!pending || pending.length === 0) {
            return;
        }
        const daemon = this.daemonSendTarget(sessionId);
        if (!daemon) {
            return;
        }
        for (const msg of pending) {
            daemon.handle.send({ sessionId, localId: msg.localId, content: msg.content });
        }
    }

    /**
     * Give the message a verdict, then proof, then let it fail.
     *
     * `settleReceivedMessages` settles an entry the moment the session's own log or a pushed entry
     * shows it was received — which is what the echo and the verdict also do. So this timer only has
     * to decide what to do when nothing has said anything: ask once more (a read brings back the
     * session's record even when the verdict frame was lost), and only then admit it did not arrive.
     * Failing on the verdict alone told the user to resend messages the session already had.
     */
    private checkLanDelivery(localId: string, waitMs: number, askAgain: boolean): void {
        const timer = setTimeout(() => {
            this.lanSendTimeouts.delete(localId);
            const entry = storage.getState().outbox[localId];
            if (!entry || entry.status !== 'sending') {
                return; // settled elsewhere: the verdict, the echo, or a read
            }
            if (askAgain) {
                // Send it again *and* look again. The look is what settles it when the message did
                // arrive and only the confirmation was lost; the send is what covers the other
                // case — a write into a socket whose peer was already gone, which reported success
                // and went nowhere. A repeat is free: the session dedups on `localId`.
                //
                // The resend deliberately bypasses the ordinary flush, so it cannot register a wait
                // cycle of its own: one message has one deadline, and this branch is its middle.
                this.resendOutbox(entry.sessionId);
                this.getMessagesSync(entry.sessionId).invalidate();
                this.checkLanDelivery(localId, Sync.LAN_DELIVERY_PROOF_MS, false);
                return;
            }
            storage.getState().failOutboxEntries(
                [localId],
                'No confirmation that the session received this message.',
            );
            log.log(`📡 LAN send ${localId} was never confirmed, and the session's log does not show it`);
        }, waitMs);
        (timer as unknown as { unref?: () => void }).unref?.();
        this.lanSendTimeouts.set(localId, timer);
    }

    /**
     * One tick of the LAN channel, run inside the same session lock and fetch slot the server path
     * takes — which polling used to bypass by calling the LAN read directly, so two ticks could
     * overlap and race each other into the store.
     *
     * A session on the LAN bypasses the server entirely — whether the preference put it there or a
     * pin did. The pin exists so the path can be exercised deliberately: without it the only other
     * way to reach the LAN is to break the server, so a broken channel stays invisible until the
     * day it is needed.
     */
    /**
     * Returns whether the daemon served this session — a page came back. False is the caller's
     * signal that the daemon has nothing for it, which is a different thing from "the conversation
     * is empty" and is answered by asking the server.
     */
    private fetchMessagesViaDaemon = async (sessionId: string): Promise<boolean> => {
        // Only while this session has nothing to show: the flag is what the view reads to tell
        // "nothing yet, still loading" from "this session has nothing", and setting it on every tick
        // made the indicator at the bottom of the list flicker on a two-second poll — a loader that
        // is on most of the time reads as one that never stops.
        if (storage.getState().sessionMessages[sessionId]?.messages.length === 0) {
            storage.getState().setFetching(sessionId, true);
        }
        const read = await this.fetchSessionFromDaemon(sessionId);
        if (read) {
            this.daemonUnavailableUntil.delete(sessionId);
        } else {
            // The daemon route answered for this session and had nothing (or nothing came back
            // at all). Recorded per session so the resolver — not the read path — decides where
            // the next tick goes, and the daemon is tried again once this ages out.
            this.daemonUnavailableUntil.set(sessionId, Date.now() + Sync.DAEMON_ABSENT_RETRY_MS);
        }
        log.log(
            read
                ? `📡 fetchMessages: on LAN — read ${read.messages.length} message(s), ${read.decryptedCount}/${read.total} decrypted`
                : '📡 fetchMessages: on LAN — nothing to read (no daemon for this session)'
        );
        // Polling is the fallback, not the mechanism. A socket that is up pushes `log-grew` the
        // moment anything is written to the log, so a tick would only re-ask a question already
        // answered — that is what made this run a full read twice a second forever.
        //
        // It still has to run when there is no socket, which is also the case the read just
        // reported: "no local history yet" is a 404 the daemon documents as retryable, and
        // treating it as final would strand the channel, since for a pinned session nothing else
        // would ever invalidate the sync.
        if (
            read
            && !this.unverifiedMachines.has(read.machineId)
            && this.connections.current(read.machineId, read.connection.route)?.baseUrl === read.connection.baseUrl
        ) {
            this.stopDaemonPolling(sessionId);
            return true;
        }
        if (!read && this.describeChannel(sessionId).reason !== 'pinned') {
            // The daemon has no log for this session; a two-second poll cannot create one, it
            // appears when the session writes. With the server down, *every* session the daemon
            // did not own was polled this way — a fetch storm that held the JS thread and the
            // cache, measured as repeated `fetchMessages starting` for six or more sessions a
            // second. A pinned session is the exception: it chose this channel deliberately and
            // nothing else would retry it.
            this.stopDaemonPolling(sessionId);
            return false;
        }
        this.startDaemonPolling(sessionId);
        return read !== null;
    };

    /**
     * Whether the visible session's push channel is missing, so its fallback poll is needed.
     *
     * This is not "the server is unreachable" — that was the old condition, and it made one
     * transport's state a reason to read every session. It is a fact about this session: the route
     * it is on cannot push right now, and its screen is waiting to look current. A live socket, or
     * a connected server for a server-routed session, means the push exists and no poll is needed.
     */
    private visibleNeedsPolling(sessionId: string): boolean {
        const channel = this.preferredChannel(sessionId);
        if (channel === 'server') {
            // There is no second route to poll here: the server socket reconnects on its own, and
            // repeating an HTTP read every two seconds while it is down only adds timeouts. The
            // session refreshes when the socket returns, or when the person opens it again.
            return false;
        }
        const machineId = storage.getState().sessions[sessionId]?.metadata?.machineId;
        if (!machineId) {
            return false;
        }
        // A daemon that cannot answer heartbeats cannot push either; reads are the only source.
        if (this.unverifiedMachines.has(machineId)) {
            return true;
        }
        // A live socket pushes; nothing to poll.
        if (this.connections.current(machineId, channel) !== null) {
            return false;
        }
        // No socket: the only useful poll is of a daemon that has served this session before.
        // A session the daemon has no log for is answered by the server, which is covered above —
        // polling the daemon every two seconds cannot create a log that is not there.
        return this.daemonLinks.get(sessionId)?.connection.route === channel;
    }

    /**
     * Kept for the call sites: a channel fallback no longer owns a timer. The scheduler polls the
     * visible session and nothing else; hidden sessions are read when they are opened.
     */
    private startDaemonPolling(_sessionId: string): void {
        this.readScheduler.markStale();
    }

    private stopDaemonPolling(_sessionId: string): void {
        // The scheduler's timer follows visibility, not per-session bookkeeping.
    }

    //
    // Apply store
    //

    /**
     * Everything that has to happen to messages a channel just delivered, whichever channel it was.
     *
     * A channel moves bytes: discover, authenticate, read. Deciding what those bytes *mean* — that
     * they are decryptable, that they are not already held, that they belong in the store — is
     * infrastructure, and it lives here so that a channel cannot forget a step. It could before:
     * session-key registration and cache persistence sat inside the server path, so the LAN could
     * deliver messages the App had no key on record for and would never persist, and both showed
     * up only as "the LAN channel is broken".
     *
     * Returns how many messages were actually new, for logging and for deciding whether anything
     * downstream needs to happen.
     *
     * Deliberately not here: persisting to the cache. A channel that only appends can persist
     * straight away, but a paged server fetch knows the cache window better once its page has
     * settled, so each channel calls `saveSessionCache` when its own read is complete.
     */
    private ingestChannelRead(
        sessionId: string,
        read: {
            messages: NormalizedMessage[];
            /**
             * The session key the read unwrapped, when the channel carried one. Registering it is
             * what lets the rest of the App treat the session as ready to read and write — the
             * server path does the same with the same key material.
             */
            sessionKey?: Uint8Array;
        },
    ): number {
        if (read.sessionKey) {
            // Kept as well as registered: the encryption object holds a decryptor, not the key, and
            // the live socket has to open an entry that arrived on its own with no read around it.
            this.lanSessionKeys.set(sessionId, read.sessionKey);
            void this.encryption.initializeSessions(new Map([[sessionId, read.sessionKey]]));
        }
        const fresh = this.withoutStoredDuplicates(sessionId, read.messages);
        if (fresh.length === 0) {
            return 0;
        }
        const applyStartedAt = Date.now();
        this.applyMessages(sessionId, fresh);
        const applyMs = Date.now() - applyStartedAt;
        if (applyMs > 30) {
            log.log(`⏱️ store apply for ${sessionId}: ${applyMs}ms for ${fresh.length} message(s)`);
        }
        // Persist because the store changed, not because a request succeeded — see
        // `scheduleCacheSave`. This is what makes the cache independent of which channel
        // delivered the messages, and of whether that channel's fetch also went through.
        this.scheduleCacheSave(sessionId);
        return fresh.length;
    }

    /**
     * Drops messages the store already holds.
     *
     * Neither channel can rely on the reducer for this across a switch. The reducer dedups on
     * `msg.id`, but the same message carries *different* ids on the two channels — the CLI logs
     * its own outbound messages under its local id, while the server hands them back under a
     * server-assigned id. `localId` is the one field both routes agree on, so it is the key here.
     * Without this, reading a session over the LAN and then switching back would duplicate every
     * message the CLI itself sent — and symmetrically, the LAN read would duplicate everything
     * the server had already delivered.
     */
    private withoutStoredDuplicates(sessionId: string, messages: NormalizedMessage[]): NormalizedMessage[] {
        const known = new Set<string>();
        for (const message of storage.getState().sessionMessages[sessionId]?.messages ?? []) {
            known.add(message.id);
            // Not every variant carries a localId (mode-switch messages do not), so narrow first.
            const localId = 'localId' in message ? message.localId : null;
            if (localId) {
                known.add(localId);
            }
        }
        return messages.filter(
            (message) => !known.has(message.id) && !(message.localId && known.has(message.localId))
        );
    }

    private applyMessages = (sessionId: string, messages: NormalizedMessage[]) => {
        const result = storage.getState().applyMessages(sessionId, messages);
        let m: Message[] = [];
        for (let messageId of result.changed) {
            const message = storage.getState().sessionMessages[sessionId].messagesMap[messageId];
            if (message) {
                m.push(message);
            }
        }
        if (m.length > 0) {
            voiceHooks.onMessages(sessionId, m);
        }
        if (result.hasReadyEvent) {
            voiceHooks.onReady(sessionId);
            // Do not clear thinking here: ready replays after abort/reconnect must not
            // override an active turn. turn-end / turn_aborted close thinking via durable messages.
        }
    }

    /**
     * Apply durable lifecycle thinking patch and track turn-start for ephemeral grace window.
     */
    private applySessionThinkingFromRawContent(
        sessionId: string,
        rawContent: unknown,
        thinkingAt?: number,
    ): { thinking: boolean } | null {
        if (isSessionTurnStartMessageContent(rawContent)) {
            this.sessionTurnStartAt.set(sessionId, Date.now());
        }

        const thinkingPatch = getSessionThinkingPatchFromMessageContent(rawContent);
        const session = storage.getState().sessions[sessionId];
        const wasThinking = session?.thinking ?? false;

        if (thinkingPatch?.thinking === false) {
            this.sessionTurnStartAt.delete(sessionId);
            // Keep local model/maxMode until this turn finishes (not on send), so UI does not
            // snap back to stale metadata mid-turn. Only release on active thinking -> idle transition.
            if (wasThinking) {
                storage.getState().clearSessionModelMode(sessionId);
                storage.getState().clearSessionMaxMode(sessionId);
                // Release local profile override so remote metadata wins next turn,
                // consistent with model/maxMode. CLI now syncs profileId to metadata
                // via updateMetadata on every message, so the remote value is current.
                storage.getState().releaseSessionProfileId(sessionId);
                // Release local sandbox isolation so remote metadata wins next turn.
                storage.getState().releaseSessionSandboxIsolation(sessionId);
            }
        }

        if (!thinkingPatch) {
            return null;
        }

        if (session && session.thinking !== thinkingPatch.thinking) {
            const at = thinkingAt ?? Date.now();
            this.applySessions([{
                ...session,
                ...thinkingPatch,
                thinkingAt: thinkingPatch.thinking ? at : 0,
            }]);
            if (thinkingPatch.thinking === false) {
                storage.getState().finalizeRunningTools(sessionId);
            }
        }

        return thinkingPatch;
    }

    private applySessions = (sessions: (Omit<Session, "presence"> & {
        presence?: "online" | number;
    })[], fullRefresh?: boolean) => {
        const active = storage.getState().getActiveSessions();
        const channelBefore = new Map(sessions.map((s) => [s.id, this.preferredChannel(s.id)]));
        // The server's own list: its seqs are the server axis, the freshest such numbers this App
        // can hold, and the axis flag retires whatever the daemon fallback last wrote.
        this.sessionsListAxis = 'server';
        for (const applied of sessions) {
            this.serverSessionSeq.set(applied.id, applied.seq);
        }
        storage.getState().applySessions(sessions, fullRefresh);
        this.applyPublishedGitStatus(sessions);
        const newActive = storage.getState().getActiveSessions();
        this.applySessionDiff(active, newActive);

        // The channel is only chosen when a read starts, so a session already open on the server
        // would stay there after its CLI restarts and declares the LAN. Re-read it on the new one.
        for (const [sessionId, before] of channelBefore) {
            if (before === 'server' && this.preferredChannel(sessionId) !== 'server') {
                this.messagesSync.get(sessionId)?.invalidate();
            }
        }
    }

    private applySessionDiff = (active: Session[], newActive: Session[]) => {
        let wasActive = new Set(active.map(s => s.id));
        let isActive = new Set(newActive.map(s => s.id));
        for (let s of active) {
            if (!isActive.has(s.id)) {
                voiceHooks.onSessionOffline(s.id, s.metadata ?? undefined);
            }
        }
        for (let s of newActive) {
            if (!wasActive.has(s.id)) {
                voiceHooks.onSessionOnline(s.id, s.metadata ?? undefined);
            }
        }
    }

}

// Global singleton instance. A reload evaluates this module again; the previous instance is
// stopped first so its timers and listeners do not keep working beside the new one.
const previousSync = (globalThis as unknown as { __happyActiveSync?: { stop?: () => void } }).__happyActiveSync;
previousSync?.stop?.();
export const sync = new Sync();
(globalThis as unknown as { __happyActiveSync?: { stop?: () => void } }).__happyActiveSync = {
    stop: () => sync.stopBackgroundWork(),
};

//
// Init sequence
//

let isInitialized = false;
export async function syncCreate(credentials: AuthCredentials) {
    if (isInitialized) {
        console.warn('Sync already initialized: ignoring');
        return;
    }
    isInitialized = true;
    await syncInit(credentials, false);
}

export async function syncRestore(credentials: AuthCredentials) {
    if (isInitialized) {
        console.warn('Sync already initialized: ignoring');
        return;
    }
    isInitialized = true;
    await syncInit(credentials, true);
}

async function syncInit(credentials: AuthCredentials, restore: boolean) {

    // Initialize sync engine
    const secretKey = decodeBase64(credentials.secret, 'base64url');
    if (secretKey.length !== 32) {
        throw new Error(`Invalid secret key length: ${secretKey.length}, expected 32`);
    }
    const encryption = await Encryption.create(secretKey);

    // Initialize tracking
    initializeTracking(encryption.anonID);

    // Initialize sessions engine FIRST — loads cache, applies cached data,
    // registers socket message handlers (subscribeToUpdates). Only AFTER the
    // cache is loaded and handlers are registered do we start the socket.
    // Otherwise the socket connects before handlers exist, early messages are
    // dropped, and cached data is invisible until the socket connects.
    if (restore) {
        await sync.restore(credentials, encryption);
    } else {
        await sync.create(credentials, encryption);
    }

    // Wire socket status to storage
    apiSocket.onStatusChange((status) => {
        storage.getState().setSocketStatus(status);
    });

    // Start socket connection — handlers are already registered, cache is loaded.
    const API_ENDPOINT = getServerUrl();
    // Set before initialising: a server the setting has switched off must not be connected to even
    // for the instant it takes the first connect to come back.
    apiSocket.setServerEnabled(channelEnabled(storage.getState().localSettings.channelPriority, 'server'));
    apiSocket.initialize({ endpoint: API_ENDPOINT, token: credentials.token }, encryption);
}
