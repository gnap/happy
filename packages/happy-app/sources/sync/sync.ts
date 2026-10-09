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
import { InvalidateSync } from '@/utils/sync';
import { ActivityUpdateAccumulator } from './reducer/activityUpdateAccumulator';
import { randomUUID } from 'expo-crypto';
import * as Notifications from 'expo-notifications';
import * as Network from 'expo-network';
import { registerPushToken } from './apiPush';
import { Platform, AppState, type AppStateStatus } from 'react-native';
import { isRunningOnMac, isRunningInTauri } from '@/utils/platform';
import { NormalizedMessage, normalizeRawMessage, RawRecord } from './typesRaw';
import type { MessageMeta } from './typesMessageMeta';
import { applySettings, Settings, settingsDefaults, settingsParse, SUPPORTED_SCHEMA_VERSION } from './settings';
import { Profile, profileParse } from './profile';
import { loadPendingSettings, savePendingSettings, loadWrappedMachineKeys, saveWrappedMachineKeys, loadLanCursors, saveLanCursors } from './persistence';
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
import { readSessionOverLan, listSessionsOverLan, toNormalizedMessages, type LanConnection, type LanSessionRead } from './lan/sessionChannel';
import { decryptLanEntries } from './lan/history';
import { openLanSocket, type LanSocketHandle } from './lan/socket';
import type { LanSessionLogEntry } from './lan/types';
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

type V3PostSessionMessagesResponse = {
    messages: Array<{
        id: string;
        seq: number;
        localId: string | null;
        createdAt: number;
        updatedAt: number;
    }>;
};

type OutboxMessage = {
    localId: string;
    content: string;
};

/** Why a session is on the channel it is on; the UI turns these into words. */
export type ChannelReason =
    | 'pinned'
    | 'reachable'
    | 'session-not-loaded'
    | 'not-declared'
    | 'no-machine-id'
    | 'no-machine-key'
    | 'not-on-network';

class Sync {
    private static readonly BACKGROUND_SEND_TIMEOUT_MS = 30_000;
    private static readonly DESKTOP_SESSION_REFRESH_COOLDOWN_MS = 15_000;
    /** Minimum interval between full session list fetches (rate-limit). */
    private static readonly SESSION_REFRESH_COOLDOWN_MS = 30_000;
    /** Periodic fallback refresh interval when no events arrive. */
    private static readonly SESSION_REFRESH_INTERVAL_MS = 300_000; // 5 min
    /** Interval between full (non-delta) session list refreshes to clean up stale cache. */
    private static readonly FULL_REFRESH_INTERVAL_MS = 600_000; // 10 min
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
    private sessionSendLocks = new Map<string, AsyncLock>();
    /** Limit concurrent message fetches to avoid network congestion (e.g. 150 sessions all requesting at once on reconnect). */
    private static readonly MAX_CONCURRENT_MESSAGE_FETCHES = 5;
    private messageFetchRunning = 0;
    private messageFetchQueue: (() => void)[] = [];
    private sessionDataKeys = new Map<string, Uint8Array>(); // Store session data encryption keys internally
    private machineDataKeys = new Map<string, Uint8Array>(); // Store machine data encryption keys internally
    private artifactDataKeys = new Map<string, Uint8Array>(); // Store artifact data encryption keys internally
    /**
     * Per-session LAN polling while the server is not answering, keyed by sessionId.
     *
     * The LAN channel has no push — the daemon serves a snapshot of its log — so a one-shot read
     * would freeze a session the moment it switched. Polling is what makes the switch an actual
     * channel rather than a single look. It runs only while the server is unreachable: the moment
     * a server fetch succeeds the poll is stopped (see `fetchMessages`), so this cannot quietly
     * become a permanent second source of traffic.
     */
    private lanPollTimers = new Map<string, ReturnType<typeof setInterval>>();
    /**
     * Per-session LAN state: where to resume reading, and the connection that position came from.
     * Both are kept with the machine that issued them — a cursor addresses a position in one
     * machine's log, and a token only authenticates against that machine.
     */
    private lanChannels = new Map<
        string,
        { machineId: string; cursor: string; connection: LanConnection }
    >();
    /**
     * The connection each machine was last reached over, keyed by machine rather than by session.
     *
     * A connection is a property of the machine — one address, one token, good for every session
     * it serves — but the cache above is keyed by session, so a session that had never been read
     * before had no connection of its own and paid a full mDNS browse to find one. A browse is
     * not returned early; it collects until its timeout elapses, so that was a flat 4s per
     * previously-unread session, on a channel polled every two seconds.
     */
    private lanMachineConnections = new Map<string, LanConnection>();
    /**
     * Where each session's log read got to, across restarts. `lanChannels` is runtime state and
     * dies with the process; this is the half that has to survive it, or a cold start reads the
     * whole log again — thousands of entries to fetch and decrypt before the session settles.
     */
    private lanCursors = loadLanCursors();
    /** Pending coalesced cache writes, one per session. */
    private cacheSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
    /**
     * The live LAN socket, when one is open. Keyed by baseUrl because the daemon's socket is
     * machine-wide: one connection carries every session on that machine, and the App
     * demultiplexes on `body.sid` exactly as it does for the server channel.
     */
    private lanSocket: { baseUrl: string; handle: LanSocketHandle } | null = null;
    /**
     * The session key each LAN read unwrapped, by session. The live socket is handed entries with
     * no read and no wrapped key around them, so this is the only place it can come from.
     */
    private lanSessionKeys = new Map<string, Uint8Array>();
    /** LAN sends awaiting the session's verdict, so a lost one cannot sit "sending" forever. */
    private lanSendTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

    /** How long a LAN send waits for the session's verdict before it is treated as lost. */
    private static readonly LAN_DELIVERY_TIMEOUT_MS = 15_000;
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
    private appStateSubscription: ReturnType<typeof AppState.addEventListener> | null = null;
    private networkStateSubscription: ReturnType<typeof Network.addNetworkStateListener> | null = null;
    private currentVisibleSessionId: string | null = null;
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
        // On web (browser + Tauri/Linux), expo-sqlite is unavailable – use IndexedDB for persistent cache
        // so desktop/Linux doesn't refetch on every launch (same behaviour as iOS SQLite cache).
        if (Platform.OS === 'web') {
            overrideSessionCacheDB(new IndexedDBSessionCacheDB());
        }

        this.sessionsSync = new InvalidateSync(this.fetchSessions);
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
                // Probe the socket first — a live connection responds in < 200ms.
                // If probe fails (1.5s timeout) a fresh connect is triggered.
                // Only invalidate syncs after the probe settles so data fetches
                // don't race against a dead socket.
                void apiSocket.resumeReconnection().then(() => {
                    this.#invalidateAllSyncs();
                    // Refresh the currently visible session's messages immediately.
                    // After background/foreground the session screen is still mounted
                    // so onSessionVisible doesn't fire — we must trigger it explicitly.
                    if (this.currentVisibleSessionId) {
                        this.onSessionVisible(this.currentVisibleSessionId);
                    }
                });
            } else {
                log.log(`📱 App state changed to: ${nextAppState}`);
                // A coalesced cache write may be waiting on a timer that suspension will not run.
                // This is the last reliable moment before the App can be killed, so write now.
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
                } else if (!connected && prevConnected) {
                    log.log('🌐 Network lost, pausing reconnection');
                    apiSocket.pauseReconnection();
                } else if (connected && type !== prevType) {
                    // Network interface switched (e.g. WiFi → Cellular) while staying
                    // connected. The underlying TCP connection may have been silently
                    // dropped; probe immediately to confirm liveness.
                    log.log(`🌐 Network interface changed (${prevType} → ${type}), probing connection`);
                    apiSocket.resumeReconnection();
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
        this.sessionsRefreshInterval = setInterval(() => {
            // Check socket health first — a silent TCP drop (socket.connected === true
            // but no data flowing) won't self-recover without a nudge.
            apiSocket.checkHealthAndReconnect();

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
        }, Sync.SESSION_REFRESH_INTERVAL_MS);
    }

    /** Invalidate all data syncs (called on app resume / window becoming visible). */
    #invalidateAllSyncs() {
        this.purchasesSync.invalidate();
        this.profileSync.invalidate();
        this.machinesSync.invalidate();
        this.pushTokenSync.invalidate();
        this.sessionsSync.invalidate();
        this.nativeUpdateSync.invalidate();
        log.log('🖥️ Invalidating artifacts sync');
        this.artifactsSync.invalidate();
        this.friendsSync.invalidate();
        this.friendRequestsSync.invalidate();
        this.feedSync.invalidate();
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
                    // onSessionVisible doesn't fire — we must trigger it explicitly.
                    if (this.currentVisibleSessionId) {
                        this.onSessionVisible(this.currentVisibleSessionId);
                    }
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

        // A machine on this network gets its live channel as soon as it is seen. Waiting for a
        // session to ask for the LAN was circular: the declaration that makes a session prefer it
        // arrives over the very socket this would open, and until then only the slow server list
        // could say so.
        if (!this.lanSightingWatch) {
            this.lanSightingWatch = storage.subscribe((state, previous) => {
                if (state.lanSightings !== previous.lanSightings) {
                    this.openLanSocketForSightedMachine();
                }
            });
            this.openLanSocketForSightedMachine();
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
        log.log('🔄 #init: Invalidating all syncs');
        this.sessionsSync.invalidate();
        this.settingsSync.invalidate();
        this.profileSync.invalidate();
        this.purchasesSync.invalidate();
        this.machinesSync.invalidate();
        this.pushTokenSync.invalidate();
        this.nativeUpdateSync.invalidate();
        this.friendsSync.invalidate();
        this.friendRequestsSync.invalidate();
        this.artifactsSync.invalidate();
        this.feedSync.invalidate();
        log.log('🔄 #init: All syncs invalidated, including artifacts');

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
        this.currentVisibleSessionId = sessionId;
        this.getMessagesSync(sessionId).invalidate();

        // Also invalidate git status sync for this session
        gitStatusSync.getSync(sessionId).invalidate();

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
        if (this.currentVisibleSessionId === sessionId) {
            this.currentVisibleSessionId = null;
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
        await saveMessageCache(session, sessionMsgs.messages, sessionMsgs.reducerState, lastSeq, oldestSeq, hasOlderMessages);
    }

    /**
     * Clear the local message cache for a session and trigger a full refetch.
     * Only meaningful for Cursor sessions; safe to call on any session.
     */
    rebuildMessageCache = async (sessionId: string): Promise<void> => {
        log.log(`🔄 rebuildMessageCache: clearing cache for ${sessionId}`);

        // Clear the persisted cache
        await clearMessageCache(sessionId);

        // Reset in-memory seq so the next fetch starts from 0
        this.sessionLastSeq.delete(sessionId);

        // Clear the in-memory Zustand messages so the UI shows a loading state
        storage.getState().deleteSessionMessages(sessionId);

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
            const response = await this.instrumentedFetch(`${API_ENDPOINT}/v2/sessions?${qs}`, {
                headers: {
                    'Authorization': `Bearer ${this.credentials.token}`,
                    'Content-Type': 'application/json',
                    'Accept-Encoding': 'gzip, deflate',
                }
            });
            const networkMs = Math.round(performance.now() - fetchStart);

            if (!response.ok) {
                const body = await response.text();
                log.log(`📥 fetchSessions: failed status=${response.status} body=${body.slice(0, 200)}`);
                throw new Error(`Failed to fetch sessions: ${response.status}`);
            }

            const parseStart = performance.now();
            // response.json() uses the browser's native streaming parser (faster than
            // text()+JSON.parse, especially on JSC engines like WebKitGTK and iOS).
            const data = await response.json() as { sessions?: unknown };
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
            // The server answered, so the LAN's view of the list is no longer the fallback.
            storage.getState().applyLanSessionList(null);
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

            // Eagerly catch up messages for active sessions (agent is running) and
            // the currently visible session (user is looking at it). Inactive/
            // non-visible sessions are loaded lazily when the user opens them.
            void (async () => {
                const visibleId = this.currentVisibleSessionId;
                for (const session of decryptedSessions) {
                    if (session.metadata?.flavor !== 'cursor' && session.metadata?.flavor !== 'acp-cursor' && session.metadata?.flavor !== 'claude') continue;
                    if (!session.active && session.id !== visibleId) continue; // skip unless active or visible
                    try {
                        const cached = await getCachedLastSeq(session.id);
                        if (cached != null && cached < session.seq) {
                            // Skip the HTTP fetch only when the seq gap is small (< 100)
                            // AND WebSocket recently delivered messages — the WS path can
                            // fill a small gap on its own, avoiding a redundant HTTP round-trip.
                            // For large gaps (e.g. after Linux sleep/wake or long disconnect),
                            // the WS only delivers new messages going forward, so an HTTP
                            // gap-fill is required regardless of WS recency.
                            const gapSize = session.seq - cached;
                            const lastWsAt = this.sessionLastWsMessageAt.get(session.id) ?? 0;
                            const wsGap = Date.now() - lastWsAt;
                            if (gapSize < 100 && wsGap < 5000) {
                                log.log(`📥 fetchSessions: skipping redundant message fetch for ${session.id} (gap=${gapSize}, WS delivered ${wsGap}ms ago, cached=${cached} < seq=${session.seq})`);
                                continue;
                            }
                            // Skip if encryption keys are not available — can never fetch
                            // (e.g. session archived/deleted on another device).
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
            try {
                await this.fetchSessionListFromLan();
            } catch (lanError) {
                log.log(`📡 fetchSessions: LAN list failed: ${String(lanError)}`);
            }
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
        this.openLanSocketForSightedMachine();

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

        const batch = pending.slice();

        // A session on the LAN channel writes back over the LAN, the same way the server path
        // prefers its own socket. Both channels are chosen the same way and neither is written to
        // twice — keeping them in agreement is the CLI's job, since the message it receives is
        // synced onward by its ordinary outgoing path.
        //
        // Falling through when the socket is closed is deliberate: the outbox still holds the
        // message, so an unavailable channel costs a retry rather than the message.
        if (this.preferredChannel(sessionId) === 'lan' && this.lanSocket) {
            const socket = this.lanSocket.handle;
            const allSent = batch.every((msg) =>
                socket.send({ sessionId, localId: msg.localId, content: msg.content })
            );
            if (allSent) {
                pending.splice(0, batch.length);
                // Deliberately not marked acked here, unlike the server socket path. There the
                // server echoes the message back, so a fast-ack is a claim the server will honour;
                // here nothing confirms the write but the session itself, and treating the write as
                // the delivery is exactly what hides a dropped message. Each entry waits for that
                // verdict, and fails if it never arrives.
                for (const msg of batch) {
                    this.awaitLanDelivery(msg.localId);
                }
                return;
            }
        }

        // Prefer WebSocket send — same path as CLI. No HTTP round-trip, no
        // Tauri HTTP plugin issues. Server echoes back via new-message WS
        // event, which handleUpdate already fast-acks.
        if (apiSocket.isConnected) {
            try {
                for (const msg of batch) {
                    apiSocket.send('message', {
                        sid: sessionId,
                        message: msg.content,
                        localId: msg.localId,
                    });
                }
                pending.splice(0, batch.length);
                for (const msg of batch) {
                    storage.getState().markOutboxMessageAcked(msg.localId);
                }
                // WS send has no seq ack — pull receive cursor forward via HTTP.
                this.getMessagesSync(sessionId).invalidate();
                return;
            } catch (_err) {
                // WS send failed — fall through to HTTP POST below.
            }
        }

        const controller = new AbortController();
        this.sendAbortControllers.set(sessionId, controller);
        try {
            const response = await apiSocket.request(`/v3/sessions/${sessionId}/messages`, {
                method: 'POST',
                body: JSON.stringify({
                    messages: batch.map((message) => ({
                        localId: message.localId,
                        content: message.content
                    }))
                }),
                headers: {
                    'Content-Type': 'application/json'
                },
                signal: controller.signal
            });
            if (!response.ok) {
                throw new Error(`Failed to send messages for ${sessionId}: ${response.status}`);
            }

            const data = await response.json() as V3PostSessionMessagesResponse;
            pending.splice(0, batch.length);

            // Server confirmed – mark as acked (green check). The echo
            // (fast-ack or text-matched session-protocol echo) will remove it.
            for (const msg of batch) {
                storage.getState().markOutboxMessageAcked(msg.localId);
            }

            if (Array.isArray(data.messages) && data.messages.length > 0) {
                const currentLastSeq = this.sessionLastSeq.get(sessionId) ?? 0;
                let maxSeq = currentLastSeq;
                for (const message of data.messages) {
                    if (message.seq > maxSeq) {
                        maxSeq = message.seq;
                    }
                }
                this.sessionLastSeq.set(sessionId, maxSeq);
            }
        } catch (error) {
            this.maybeStartBackgroundSendWatchdog();
            throw error;
        } finally {
            this.sendAbortControllers.delete(sessionId);
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

    private acquireMessageFetchSlot = (): Promise<void> => {
        if (this.messageFetchRunning < Sync.MAX_CONCURRENT_MESSAGE_FETCHES) {
            this.messageFetchRunning++;
            return Promise.resolve();
        }
        return new Promise<void>((resolve) => {
            this.messageFetchQueue.push(resolve);
        });
    };

    private releaseMessageFetchSlot = (): void => {
        if (this.messageFetchQueue.length > 0) {
            const next = this.messageFetchQueue.shift();
            if (next) next();
        } else {
            this.messageFetchRunning--;
        }
    };

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
    private fetchMessages = async (sessionId: string) => {
        log.log(`💬 fetchMessages starting for session ${sessionId} - acquiring lock`);
        const lock = this.getSessionMessageLock(sessionId);
        await lock.inLock(async () => {
            await this.acquireMessageFetchSlot();
            log.log(`💬 fetchMessages: got lock for ${sessionId}`);
            try {
                // --- Cache: cold-start hydration ---
                // Before the channel is chosen, not after. The cache is channel-agnostic — it holds
                // whatever either channel last delivered — so it is the one thing here that must
                // not be skipped for any session. Hydrating below the LAN branch meant a LAN
                // session never hydrated at all: reopening the app showed an empty conversation
                // and then re-read and re-decrypted its whole log before anything appeared.
                //
                // Load first — even if encryption isn't ready yet, cached messages provide instant
                // display while the network fetch waits.
                const session = storage.getState().sessions[sessionId];
                const existingSessionMessages = storage.getState().sessionMessages[sessionId];
                if (!existingSessionMessages?.isLoaded) {
                    const cached = await loadMessageCache(session);
                    if (cached) {
                        storage.getState().applyHydratedCache(
                            sessionId,
                            cached.messages,
                            cached.reducerState,
                            cached.oldestSeq,
                            cached.hasOlderMessages,
                            cached.lastSeq,
                        );
                        this.sessionLastSeq.set(sessionId, cached.lastSeq);
                        log.log(`💬 fetchMessages: hydrated from cache for ${sessionId} (lastSeq=${cached.lastSeq}, oldestSeq=${cached.oldestSeq}, ${cached.messages.length} messages)`);
                    } else {
                        log.log(`💬 fetchMessages: no cache for ${sessionId} (will fetch from server)`);
                    }
                }

                // A channel is chosen per session, and everything after this point is the same
                // whichever one it was: the read's bytes go through `ingestChannelRead`.
                if (this.preferredChannel(sessionId) === 'lan') {
                    await this.fetchMessagesViaLan(sessionId);
                    return;
                }

                const encryption = this.encryption.getSessionEncryption(sessionId);
                if (!encryption) {
                    log.log(`💬 fetchMessages: Session encryption not ready for ${sessionId}, skipping`);
                    return;
                }

                const cachedLastSeq = this.sessionLastSeq.get(sessionId) ?? 0;
                const currentSession = storage.getState().sessions[sessionId];
                const sessionSeq = currentSession?.seq ?? 0;
                // Use the store's actual newestSeq (highest seq actually applied to the
                // message list) rather than sessionLastSeq (highest seq ever seen via WS).
                // WS fast-path updates sessionLastSeq but messages can be missed during a
                // disconnect, leaving gaps that sessionLastSeq would wrongly hide.
                const storedNewestSeq = storage.getState().sessionMessages[sessionId]?.newestSeq ?? 0;

                // Already up-to-date: skip the API call and loading indicator entirely.
                if (storedNewestSeq > 0 && storedNewestSeq >= sessionSeq) {
                    log.log(`💬 fetchMessages: already up-to-date for ${sessionId} (newestSeq=${storedNewestSeq} >= seq=${sessionSeq}), skipping fetch`);
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
                const response = await apiSocket.request(`/v3/sessions/${sessionId}/messages?after_seq=${afterSeq}&limit=100`);
                if (!response.ok) {
                    throw new Error(`Failed to fetch messages for ${sessionId}: ${response.status}`);
                }
                const data = await response.json() as V3GetSessionMessagesResponse;
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
                        const claimedLocalId = this.resolveLocalIdForIncoming(sessionId, normalized.id, normalized.content.text, decrypted.localId);
                        if (claimedLocalId) {
                            normalized = { ...normalized, localId: claimedLocalId };
                        }
                    }
                    normalizedMessages.push(normalized);

                    this.applySessionThinkingFromRawContent(sessionId, decrypted.content);
                }

                this.ingestChannelRead(sessionId, { messages: normalizedMessages });

                // The server answered, so this session is back on the primary channel — stop the
                // polling an outage started.
                this.stopLanPolling(sessionId);

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
                if (this.isRetryableMessageFetchError(err) && storage.getState().channelOverride[sessionId] !== 'server') {
                    // The server is unreachable. Before handing this over to the retry backoff,
                    // try the other channel: the daemon that owns this session keeps its own log
                    // of everything the session process saw, and it may be sitting on this very
                    // network. This is the channel switch, and it is driven by the failure itself
                    // rather than by a status flag — so it covers every reason the server can be
                    // unreachable, not just the ones a status enum happens to model.
                    try {
                        const read = await this.fetchSessionFromLan(sessionId);
                        if (read) {
                            log.log(`📡 fetchMessages: server unreachable — read ${read.messages.length} message(s) over the LAN for ${sessionId}`);
                            // The LAN only serves snapshots, so without this the session would
                            // freeze at the moment of the switch. Keep reading until the server
                            // answers again (stopped in the success path below).
                            this.startLanPolling(sessionId);
                        }
                    } catch (lanError) {
                        // The LAN is best-effort. A failure here must not mask the original error.
                        log.log(`📡 fetchMessages: LAN fallback failed for ${sessionId}: ${String(lanError)}`);
                    }
                    // Still re-throw: the LAN log only covers what that process has seen since it
                    // started, so it supplements the server rather than replacing it, and the
                    // backoff keeps trying for the fuller channel.
                    throw err;
                }
            } finally {
                storage.getState().applyMessagesLoaded(sessionId);
                this.releaseMessageFetchSlot();
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

        storage.getState().setLoadingOlder(sessionId, true);

        const lock = this.getSessionMessageLock(sessionId);
        await lock.inLock(async () => {
            await this.acquireMessageFetchSlot();
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
                for (const decrypted of decryptedMessages) {
                    if (!decrypted) continue;
                    const normalized = normalizeRawMessage(decrypted.id, decrypted.localId, decrypted.createdAt, decrypted.content);
                    if (normalized) normalizedMessages.push(normalized);
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
                storage.getState().setLoadingOlder(sessionId, false);
            } finally {
                this.releaseMessageFetchSlot();
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
        apiSocket.onReconnected(() => {
            log.log('🔌 Socket reconnected');
            this.lastDesktopSessionRefreshAt = Date.now();
            this.sessionsSync.invalidate();
            this.machinesSync.invalidate();
            log.log('🔌 Socket reconnected: Invalidating artifacts sync');
            this.artifactsSync.invalidate();
            this.friendsSync.invalidate();
            this.friendRequestsSync.invalidate();
            this.feedSync.invalidate();
            // Invalidate message sync for all sessions: active first so they get the concurrency slots
            try {
                const state = storage.getState();
                const activeIds = new Set(state.getActiveSessions().map(s => s.id));
                const sessionsData = state.sessionsData;
                let active: string[] = [];
                let inactive: string[] = [];
                if (Array.isArray(sessionsData)) {
                    for (const item of sessionsData) {
                        if (typeof item !== 'string' && item?.id) {
                            if (activeIds.has(item.id)) active.push(item.id);
                            else inactive.push(item.id);
                        }
                    }
                } else {
                    // Fallback when sessionsData not yet populated (e.g. before first fetchSessions)
                    const sessions = Object.values(state.sessions);
                    for (const s of sessions) {
                        if (activeIds.has(s.id)) active.push(s.id);
                        else inactive.push(s.id);
                    }
                }
                // On reconnect, only eagerly refresh active sessions.
                // Inactive/offline sessions load both messages and git status lazily on open.
                for (const sessionId of active) {
                    this.getMessagesSync(sessionId).invalidate();
                    gitStatusSync.invalidate(sessionId);
                }
                // The currently visible session must refresh regardless of active state —
                // the user is looking at it right now and expects new messages to appear.
                if (this.currentVisibleSessionId && !activeIds.has(this.currentVisibleSessionId)) {
                    this.getMessagesSync(this.currentVisibleSessionId).invalidate();
                    gitStatusSync.invalidate(this.currentVisibleSessionId);
                }
                // inactive: skip entirely — onSessionVisible handles both on open.
            } catch (e) {
                log.log(`🔄 reconnect: error invalidating message syncs: ${String(e)}`);
            }
            for (const sync of this.sendSync.values()) {
                sync.invalidate();
            }
            this.recoverPendingOutbox();
        });
    }

    private handleUpdate = async (update: unknown) => {
        // No JSON.stringify of the payload here. This runs on every socket update and the body
        // carries base64 message content, so serialising one only to truncate the log to 300
        // characters was real JS work on the hottest path in the app. The validated type is
        // logged just below, which is what the line was actually for.
        const validatedUpdate = ApiUpdateContainerSchema.safeParse(update);
        if (!validatedUpdate.success) {
            console.log('❌ Sync: Invalid update received:', validatedUpdate.error);
            console.error('❌ Sync: Invalid update data:', update);
            return;
        }
        const updateData = validatedUpdate.data;
        console.log(`🔄 Sync: Validated update type: ${updateData.body.t}`);

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
                            const claimedLocalId = this.resolveLocalIdForIncoming(sid, lastMessage.id, lastMessage.content.text, decrypted.localId);
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
                        console.log('🔄 Sync: Applying message (fast path):', JSON.stringify(lastMessage));
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
                        if (lastMessage) {
                            this.getMessagesSync(updateData.body.sid).invalidate();
                        }
                        // Enqueue immediately so the UI updates without waiting for fetchMessages.
                        // Neither sessionLastSeq nor newestSeq is advanced here — the gap must
                        // be filled by fetchMessages before the store is considered caught up.
                        if (lastMessage) {
                            console.log('🔄 Sync: Applying message (lenient path, seq gap):', JSON.stringify(lastMessage));
                            this.enqueueMessages(updateData.body.sid, [lastMessage]);
                        }
                    }
                    // Refresh git status only when turn is done (ready), not on every mutable tool result
                    if (shouldClearThinking) {
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
            // no need to trigger a redundant fetchMessages via onSessionVisible.
            if (!didFastPath) {
                this.onSessionVisible(updateData.body.sid);
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
            this.sentMessageLocalIds.delete(sessionId);
            // claimedServerMessageIds is keyed by serverId not sessionId, so we can't easily
            // bulk-delete by session. It's small and self-limiting (only live claims), so just
            // leave entries to expire naturally (they'll never match again after session deletion).
            this.sessionMessageLocks.delete(sessionId);
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

                // Do not set seq from updateData.seq (global); keep session.seq as session-internal so it matches GET /v1/sessions
                this.applySessions([{
                    ...session,
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
                        this.onSessionVisible(updateData.body.id);
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
    async fetchSessionFromLan(sessionId: string): Promise<LanSessionRead | null> {
        const accountPublicKey = this.encryption?.contentDataKey;
        if (!accountPublicKey) {
            return null;
        }

        const machineId = storage.getState().sessions[sessionId]?.metadata?.machineId;
        const machineKey = machineId ? this.getMachineKey(machineId) : null;
        // Resume where the last read stopped, and over the connection it used. Both matter: a
        // cursor keeps each poll from re-reading and re-decrypting the whole log, and the
        // connection keeps it from paying for an mDNS browse and a handshake on every tick.
        const remembered = this.lanChannels.get(sessionId);
        const resumable = remembered && remembered.machineId === machineId ? remembered : undefined;
        // The persisted cursor is the restart's fallback. The connection is gone with the process,
        // but the position is not — and resuming from it is the difference between reading the
        // delta and reading the entire log.
        const persisted = this.lanCursors[sessionId];
        const since = resumable?.cursor
            ?? (persisted && persisted.machineId === machineId ? persisted.cursor : undefined);
        const read = await readSessionOverLan({
            sessionId,
            machineId,
            accountPublicKey,
            machineKey,
            encryption: this.encryption,
            since,
            // The session's own connection when it has one, otherwise whatever this machine was
            // last reached over — same machine, so the same address and a token that covers it.
            connection: resumable?.connection ?? (machineId ? this.lanMachineConnections.get(machineId) : undefined),
        });
        if (!read) {
            return null;
        }
        this.lanChannels.set(sessionId, {
            machineId: read.machineId,
            cursor: read.cursor,
            connection: read.connection,
        });
        this.lanMachineConnections.set(read.machineId, read.connection);
        this.lanCursors[sessionId] = { machineId: read.machineId, cursor: read.cursor };
        saveLanCursors(this.lanCursors);
        // The machine answered, so bring the live channel up alongside the poll. Fire-and-forget:
        // polling is what keeps the session readable, and the socket only removes the delay
        // between a message being written and being seen.
        if (machineKey) {
            void this.ensureLanSocket(read.connection.baseUrl, machineKey);
        }

        // Dedup inside the shared pipeline is what makes `reset` safe to ignore: a full log resent
        // after a pruned cursor lands as "nothing new" rather than as duplicates.
        const fresh = this.ingestChannelRead(sessionId, {
            messages: read.messages,
            sessionKey: read.sessionKey,
        });
        // No explicit persist here: `ingestChannelRead` schedules one when the store changed, and
        // a tick with nothing new costs no write at 2s intervals.
        log.log(
            `📡 fetchSessionFromLan: ${read.messages.length} read, ${fresh} new ` +
            `(${read.decryptedCount}/${read.total} decrypted, tag ${read.tag}` +
            `${resumable ? `, since ${resumable.cursor}` : ''}${read.reset ? ', cursor reset' : ''})`
        );
        return read;
    }

    /**
     * Asks the LAN daemons what sessions they have and records it.
     *
     * Called when the server cannot answer. The LAN summary carries no metadata — that is
     * encrypted and only travels inside a message payload — so this cannot populate the session
     * list on its own. What it buys is knowing which sessions exist and are alive on a machine we
     * can still reach, including one this app has never seen.
     */
    async fetchSessionListFromLan(): Promise<number> {
        const accountPublicKey = this.encryption?.contentDataKey;
        if (!accountPublicKey) {
            return 0;
        }
        const read = await listSessionsOverLan({
            accountPublicKey,
            // Resolved per machine: a key only answers its own machine's challenge.
            machineKeyFor: (machineId) => this.getMachineKey(machineId),
        });
        if (!read) {
            log.log('📡 fetchSessions: server unreachable, and no LAN daemon answered for this account');
            return 0;
        }
        storage.getState().applyLanSessionList(read.sessions);
        log.log(`📡 fetchSessions: server unreachable — daemon ${read.machineId.slice(0, 8)} reports ${read.sessions.length} session(s)`);
        return read.sessions.length;
    }

    /**
     * Pin a session to one channel, or return it to automatic with null.
     *
     * Invalidates the message sync so the choice takes effect now rather than at the next
     * scheduled fetch — a control that appears to do nothing for several seconds is worse than
     * no control.
     */
    setSessionChannel(sessionId: string, channel: 'lan' | 'server' | null): void {
        storage.getState().setSessionChannelOverride(sessionId, channel);
        if (channel !== 'lan') {
            // Leaving the LAN: a poll started by an earlier fallback must not outlive the choice.
            this.stopLanPolling(sessionId);
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
    private preferredChannel(sessionId: string): 'lan' | 'server' {
        const [channel, reason] = this.resolveChannel(sessionId);
        if (this.channelReasons.get(sessionId) !== reason) {
            this.channelReasons.set(sessionId, reason);
            log.log(`📡 channel for ${sessionId}: ${channel} (${reason})`);
        }
        return channel;
    }

    private channelReasons = new Map<string, string>();

    /** Which channel a session is on right now, and why. The single source for logic and UI alike. */
    describeChannel(sessionId: string): { channel: 'lan' | 'server'; reason: ChannelReason } {
        const [channel, reason] = this.resolveChannel(sessionId);
        return { channel, reason };
    }

    private resolveChannel(sessionId: string): ['lan' | 'server', ChannelReason] {
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
        return storage.getState().lanSightings[machineId]
            ? ['lan', 'reachable']
            : ['server', 'not-on-network'];
    }

    private lanSightingWatch: (() => void) | null = null;

    /** Opens the live channel to a sighted machine this device holds a key for. One socket at a time. */
    private openLanSocketForSightedMachine(): void {
        if (this.lanSocket) {
            return;
        }
        for (const sighting of Object.values(storage.getState().lanSightings)) {
            const machineKey = this.getMachineKey(sighting.machineId);
            if (machineKey) {
                void this.ensureLanSocket(sighting.baseUrl, machineKey);
                return;
            }
        }
    }

    /**
     * Opens the live LAN channel for a machine, if it is not already up.
     *
     * Frames go straight to `handleUpdate` — the same handler the server socket feeds — because
     * the daemon emits the server's own envelope shape. That is the whole point: this channel adds
     * no second way to interpret an update, so nothing downstream has to know which one delivered
     * it.
     *
     * Failure is not an error path: polling keeps running, so a socket that cannot open or cannot
     * stay open degrades to exactly what the channel did before it existed.
     */
    private async ensureLanSocket(baseUrl: string, machineKey: Uint8Array): Promise<void> {
        if (this.lanSocket?.baseUrl === baseUrl) {
            return;
        }
        this.closeLanSocket();

        let opened: LanSocketHandle | null = null;
        const handle = await openLanSocket({
            baseUrl,
            machineKey,
            onUpdate: (payload) => {
                const body = (payload as {
                    body?: { t?: string; id?: string; entry?: LanSessionLogEntry };
                } | null)?.body;
                // The daemon's hint that a session's local log grew. It is not a server update, so
                // it never reaches handleUpdate: it only means "read now" instead of waiting for
                // the next poll tick. It stays even though entries are pushed as well — it is what
                // recovers a frame the socket missed while it was down.
                if (body?.t === 'log-grew' && body.id) {
                    if (this.preferredChannel(body.id) === 'lan') {
                        this.messagesSync.get(body.id)?.invalidate();
                    }
                    return;
                }
                // An entry the session wrote to its log, pushed as it was appended. Applying it
                // here is what makes the LAN channel deliver a message rather than announce one:
                // no round trip, and dedup on `localId` means the overlapping read cannot double
                // it. Only for sessions that resolve to the LAN — a session pinned to the server
                // reads the same bytes from there, and applying both would be the one path the
                // dedup is not set up to cover.
                if (body?.t === 'log-entry' && body.id && body.entry) {
                    if (this.preferredChannel(body.id) === 'lan') {
                        void this.applyPushedLanEntry(body.id, body.entry);
                    }
                    return;
                }
                void this.handleUpdate(payload);
            },
            onDelivered: (result) => {
                const timer = this.lanSendTimeouts.get(result.localId);
                if (timer) {
                    clearTimeout(timer);
                    this.lanSendTimeouts.delete(result.localId);
                }
                // A write is not a delivery, and the App cannot see whether the session could read
                // the message — so this verdict is the only thing separating a dropped message from
                // one that looks sent forever.
                if (result.delivered) {
                    storage.getState().markOutboxMessageAcked(result.localId);
                } else {
                    storage.getState().failOutboxEntries(
                        [result.localId],
                        'The session could not read this message.',
                    );
                }
            },
            onClosed: () => {
                // Only clear the entry this handle owns: a replacement may already be in place.
                // `opened` is null until the open completes, so a drop during the handshake is
                // ignored here — that case is reported as a null return instead.
                if (opened && this.lanSocket?.handle === opened) {
                    log.log(`📡 LAN socket dropped (${baseUrl}); falling back to polling until it reopens`);
                    this.lanSocket = null;
                    storage.getState().setLanSocketStatus(null);
                    // This socket was carrying every session on that machine, so they have just lost
                    // their push. Invalidating them is what puts polling back: it runs
                    // `fetchMessages`, which restarts the timer now that no socket backs the read.
                    for (const [sessionId, channel] of this.lanChannels) {
                        if (channel.connection.baseUrl === baseUrl) {
                            this.getMessagesSync(sessionId).invalidate();
                        }
                    }
                }
            },
        });
        opened = handle;
        if (handle) {
            this.lanSocket = { baseUrl, handle };
            storage.getState().setLanSocketStatus({ baseUrl, connectedAt: Date.now() });
            log.log(`📡 LAN socket live at ${baseUrl}`);
            // Stop the fallback for the sessions this socket now covers, rather than waiting for
            // each one's next tick to notice. Any session on another machine keeps its timer.
            for (const [sessionId, channel] of this.lanChannels) {
                if (channel.connection.baseUrl === baseUrl) {
                    this.stopLanPolling(sessionId);
                }
            }
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
    private async applyPushedLanEntry(sessionId: string, entry: LanSessionLogEntry): Promise<void> {
        const sessionKey = this.lanSessionKeys.get(sessionId);
        if (!sessionKey) {
            return;
        }
        try {
            const decrypted = await decryptLanEntries(this.encryption, sessionKey, [entry]);
            const messages = toNormalizedMessages(decrypted);
            if (messages.length > 0) {
                const fresh = this.ingestChannelRead(sessionId, { messages });
                log.log(`📡 LAN entry applied for ${sessionId}: ${fresh} new of ${messages.length} (over the socket)`);
            }
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
        const timer = setTimeout(() => {
            this.lanSendTimeouts.delete(localId);
            storage.getState().failOutboxEntries(
                [localId],
                'No confirmation that the session received this message.',
            );
            log.log(`📡 LAN send ${localId} was never confirmed`);
        }, Sync.LAN_DELIVERY_TIMEOUT_MS);
        (timer as unknown as { unref?: () => void }).unref?.();
        this.lanSendTimeouts.set(localId, timer);
    }

    private closeLanSocket(): void {
        if (!this.lanSocket) {
            return;
        }
        this.lanSocket.handle.close();
        this.lanSocket = null;
        storage.getState().setLanSocketStatus(null);
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
    private fetchMessagesViaLan = async (sessionId: string): Promise<void> => {
        const read = await this.fetchSessionFromLan(sessionId);
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
        if (read && this.lanSocket?.baseUrl === read.connection.baseUrl) {
            this.stopLanPolling(sessionId);
            return;
        }
        this.startLanPolling(sessionId);
    };

    /**
     * How often to re-read the LAN while the server is unavailable.
     *
     * This is short because a tick is now cheap: the cursor means only newly-written entries come
     * back, and the reused connection means no mDNS browse and no handshake. At the old interval
     * a tick re-read and re-decrypted the session's whole log and re-ran discovery, so the cost
     * per tick grew with the session and the channel got slower the longer it was used.
     */
    private static readonly LAN_POLL_INTERVAL_MS = 2_000;

    /**
     * Keeps re-reading a session over the LAN until the server answers again.
     *
     * Started by the fallback in `fetchMessages` and stopped by its success path, so the polling
     * exists exactly as long as the server does not — a session that switches back does not leave
     * a timer behind.
     */
    private startLanPolling(sessionId: string): void {
        if (this.lanPollTimers.has(sessionId)) {
            return;
        }
        const timer = setInterval(() => {
            // Through the same entry point the server path uses, so a tick takes the session lock
            // and a fetch slot rather than racing whatever else is reading this session. The
            // override is re-read there, so a channel switch also takes effect on the next tick.
            this.getMessagesSync(sessionId).invalidate();
        }, Sync.LAN_POLL_INTERVAL_MS);
        // Node/web only; keeps the timer from holding the process open in tests.
        (timer as unknown as { unref?: () => void }).unref?.();
        this.lanPollTimers.set(sessionId, timer);
        log.log(`📡 LAN mode: polling ${sessionId} every ${Sync.LAN_POLL_INTERVAL_MS / 1000}s until the server answers`);
    }

    private stopLanPolling(sessionId: string): void {
        const timer = this.lanPollTimers.get(sessionId);
        if (!timer) {
            return;
        }
        clearInterval(timer);
        this.lanPollTimers.delete(sessionId);
        log.log(`📡 LAN mode: stopped polling ${sessionId}`);
        // The socket is deliberately left alone. It used to be closed once no polling session
        // remained, back when polling was the mechanism and the socket only existed to shorten its
        // interval — under that reading an idle socket was waste. It is the mechanism now, so
        // tying it to the fallback's bookkeeping would close the channel the moment it started
        // carrying the session, and reopening it would look exactly like a flapping connection.
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
        this.applyMessages(sessionId, fresh);
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
        storage.getState().applySessions(sessions, fullRefresh);
        const newActive = storage.getState().getActiveSessions();
        this.applySessionDiff(active, newActive);

        // The channel is only chosen when a read starts, so a session already open on the server
        // would stay there after its CLI restarts and declares the LAN. Re-read it on the new one.
        for (const [sessionId, before] of channelBefore) {
            if (before !== 'lan' && this.preferredChannel(sessionId) === 'lan') {
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

// Global singleton instance
export const sync = new Sync();

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
    apiSocket.initialize({ endpoint: API_ENDPOINT, token: credentials.token }, encryption);
}
