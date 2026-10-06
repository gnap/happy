/**
 * Offline Reconnection Setup
 *
 * Handles the common pattern of creating an offline session stub with
 * automatic background reconnection for all backends (Codex, Gemini).
 *
 * @module setupOfflineReconnection
 */

import type { ApiClient } from '@/api/api';
import type { ApiSessionClient } from '@/api/apiSession';
import type { AgentState, Metadata, Session } from '@/api/types';
import { configuration } from '@/configuration';
import { createOfflineSessionStub } from '@/utils/offlineSessionStub';
import { startOfflineReconnection } from '@/utils/serverConnectionErrors';

/**
 * Options for setting up offline reconnection.
 */
export interface SetupOfflineReconnectionOptions {
    /** API client instance */
    api: ApiClient;
    /** Unique session tag */
    sessionTag: string;
    /** Session metadata */
    metadata: Metadata;
    /** Agent state */
    state: AgentState;
    /** Initial API response (null if server unreachable) */
    response: Session | null;
    /** Existing encryption key for session reuse (avoids key mismatch on reconnection) */
    existingEncryptionKey?: Uint8Array;
    /** Writer identity, stamped onto envelopes queued while offline as `site`. */
    site?: string;
    /** Override initial lastSeq (e.g. daemon pre-wake seq) so HTTP sync fetches unread messages. */
    initialLastSeq?: number;
    /**
     * Callback invoked when session is swapped after reconnection.
     * Use this to update the session reference in the calling code.
     */
    onSessionSwap: (newSession: ApiSessionClient) => void;
}

/**
 * Result from setupOfflineReconnection.
 */
export interface SetupOfflineReconnectionResult {
    /** The session client (stub if offline, real if connected) */
    session: ApiSessionClient;
    /** Handle to the reconnection process, null if connected */
    reconnectionHandle: ReturnType<typeof startOfflineReconnection<ApiSessionClient>> | null;
    /** Whether we're in offline mode */
    isOffline: boolean;
}

/**
 * Sets up offline session handling with automatic background reconnection.
 *
 * If the server is unreachable (response is null), this creates an offline
 * session stub and starts background reconnection. When reconnection succeeds,
 * the `onSessionSwap` callback is invoked with the new real session.
 *
 * @param opts - Options including api, sessionTag, metadata, state, response, onSessionSwap
 * @returns Result with session, reconnectionHandle, and isOffline flag
 *
 * @example
 * ```typescript
 * let session: ApiSessionClient;
 *
 * const result = setupOfflineReconnection({
 *     api,
 *     sessionTag,
 *     metadata,
 *     state,
 *     response,
 *     onSessionSwap: (newSession) => { session = newSession; }
 * });
 *
 * session = result.session;
 * const reconnectionHandle = result.reconnectionHandle;
 * ```
 */
export function setupOfflineReconnection(opts: SetupOfflineReconnectionOptions): SetupOfflineReconnectionResult {
    const { api, sessionTag, metadata, state, response, existingEncryptionKey, onSessionSwap } = opts;
    const sessionClientOpts = opts.initialLastSeq !== undefined ? { initialLastSeq: opts.initialLastSeq } : undefined;

    let session: ApiSessionClient;
    let reconnectionHandle: ReturnType<typeof startOfflineReconnection<ApiSessionClient>> | null = null;

    // Note: connectionState.notifyOffline() was already called by api.ts with error details
    if (!response) {
        // The stub encrypts and queues outbound messages rather than dropping them. It needs
        // the same key the reconnected client will use, so resolve it through the API client
        // (which persisted it before the failed create attempt) instead of inventing one here.
        const { encryptionKey, encryptionVariant } = api.resolveSessionEncryption(sessionTag, existingEncryptionKey);
        session = createOfflineSessionStub({ tag: sessionTag, site: opts.site, encryptionKey, encryptionVariant });

        // Start background reconnection
        reconnectionHandle = startOfflineReconnection<ApiSessionClient>({
            serverUrl: configuration.serverUrl,
            onReconnected: async () => {
                const resp = await api.getOrCreateSession({ tag: sessionTag, site: opts.site, metadata, state, existingEncryptionKey });
                if (!resp) throw new Error('Server unavailable');
                const realSession = api.sessionSyncClient(resp, true, sessionClientOpts);
                // Notify caller to swap the session reference. The stub wrote its messages to
                // the tag-keyed outbox, so the new client's constructor seeds and drains them.
                onSessionSwap(realSession);
                return realSession;
            },
            onNotify: (msg) => {
                // Log to console - this matches Claude's behavior
                console.log(msg);
            }
        });

        return { session, reconnectionHandle, isOffline: true };
    } else {
        session = api.sessionSyncClient(response, true, sessionClientOpts);
        return { session, reconnectionHandle: null, isOffline: false };
    }
}
