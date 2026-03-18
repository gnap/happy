/**
 * Message Cache Service
 *
 * High-level orchestration for the session message cache. Only active for
 * Cursor agent sessions (flavor === 'cursor'). Other agents are intentionally
 * excluded because their message formats or session lifecycles differ.
 *
 * Responsibilities:
 *  - Determine whether caching is enabled for a session
 *  - Load cached messages + ReducerState on cold start
 *  - Save updated messages + ReducerState after each fetch cycle
 *  - Clear the cache for a single session (rebuild) or all sessions (logout)
 */

import { getSessionCacheDB } from './sessionCacheDB';
import {
    serializeReducerStateToJson,
    deserializeReducerStateOrCreate,
    SERIALIZER_SCHEMA_VERSION,
} from './reducerStateSerializer';
import type { ReducerState } from '../reducer/reducer';
import type { Message } from '../typesMessage';
import type { Session } from '../storageTypes';
import { log } from '@/log';

// ---------------------------------------------------------------------------
// Guard: only Cursor sessions use the cache
// ---------------------------------------------------------------------------

/**
 * Returns true if the message cache should be used for this session.
 * Currently restricted to sessions with flavor === 'cursor'.
 */
export function isCacheEnabled(session: Session | null | undefined): boolean {
    const flavor = session?.metadata?.flavor;
    return flavor === 'cursor' || flavor === 'acp-cursor';
}

// ---------------------------------------------------------------------------
// Loaded cache result
// ---------------------------------------------------------------------------

export interface LoadedCache {
    messages: Message[];
    reducerState: ReducerState;
    lastSeq: number;
    oldestSeq: number;
    hasOlderMessages: boolean;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Preload the session cache DB (and expo-sqlite) so the first open of a session
 * doesn't block on native module load. Call once at app startup (e.g. in sync init).
 */
export async function preloadSessionCacheDB(): Promise<void> {
    const start = Date.now();
    try {
        const db = getSessionCacheDB();
        await db.initialize();
        const ms = Date.now() - start;
        log.log(`📦 messageCache: session cache DB preloaded in ${ms}ms`);
    } catch (e) {
        const ms = Date.now() - start;
        log.log(`📦 messageCache: preloadSessionCacheDB failed after ${ms}ms (non-fatal): ${e}`);
    }
}

/**
 * Try to load the cached messages and reducer state for a session.
 * Returns null if the cache is empty, stale, or disabled for this session.
 */
export async function loadMessageCache(session: Session): Promise<LoadedCache | null> {
    if (!session) {
        log.log('📦 messageCache: skip load (no session)');
        return null;
    }
    if (!isCacheEnabled(session)) {
        log.log(`📦 messageCache: skip load for ${session.id} (flavor=${session.metadata?.flavor ?? 'none'}, not cursor)`);
        return null;
    }

    try {
        const db = getSessionCacheDB();
        // Don't block fetchMessages if DB is still initializing (e.g. preload not done). Skip cache after timeout.
        const CACHE_LOAD_TIMEOUT_MS = 3000;
        const cacheRow = await Promise.race([
            db.getSessionCache(session.id),
            new Promise<null>((_, reject) =>
                setTimeout(() => reject(new Error('cache load timeout')), CACHE_LOAD_TIMEOUT_MS)
            ),
        ]);
        if (!cacheRow) {
            log.log(`📦 messageCache: no cache row for ${session.id}`);
            return null;
        }

        if (cacheRow.schemaVersion !== SERIALIZER_SCHEMA_VERSION) {
            log.log(`📦 messageCache: schema mismatch for ${session.id}, clearing stale cache`);
            await db.clearSessionCache(session.id);
            return null;
        }

        const messages = await db.getSessionMessages(session.id);
        const reducerState = deserializeReducerStateOrCreate(cacheRow.reducerStateJson);

        log.log(`📦 messageCache: loaded ${messages.length} messages for ${session.id} (lastSeq=${cacheRow.lastSeq}, oldestSeq=${cacheRow.oldestSeq}, hasOlderMessages=${cacheRow.hasOlderMessages})`);
        return {
            messages,
            reducerState,
            lastSeq: cacheRow.lastSeq,
            oldestSeq: cacheRow.oldestSeq,
            hasOlderMessages: cacheRow.hasOlderMessages,
        };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === 'cache load timeout') {
            log.log(`📦 messageCache: skip load for ${session.id} (DB not ready in time, will fetch from server)`);
        } else {
            log.log(`📦 messageCache: load error for ${session.id}: ${msg}`);
        }
        return null;
    }
}

// ---------------------------------------------------------------------------
// Cache progress subscription (for UI to show real-time "已缓存最新 seq")
// ---------------------------------------------------------------------------

export type CachedLastSeqListener = (sessionId: string, lastSeq: number | null) => void;
const cachedLastSeqListeners: CachedLastSeqListener[] = [];

export function subscribeToCachedLastSeq(listener: CachedLastSeqListener): () => void {
    cachedLastSeqListeners.push(listener);
    return () => {
        const i = cachedLastSeqListeners.indexOf(listener);
        if (i !== -1) cachedLastSeqListeners.splice(i, 1);
    };
}

function notifyCachedLastSeq(sessionId: string, lastSeq: number | null): void {
    for (const fn of cachedLastSeqListeners) {
        try {
            fn(sessionId, lastSeq);
        } catch (e) {
            log.log(`📦 messageCache: listener error: ${e}`);
        }
    }
}

/**
 * Return the cached lastSeq for a session (from DB), or null if no cache row.
 * Used by UI to show "已缓存最新 seq" in rebuild-cache quick action.
 */
export async function getCachedLastSeq(sessionId: string): Promise<number | null> {
    try {
        const db = getSessionCacheDB();
        const row = await Promise.race([
            db.getSessionCache(sessionId),
            new Promise<null>((_, reject) =>
                setTimeout(() => reject(new Error('timeout')), 3000)
            ),
        ]);
        return row?.lastSeq ?? null;
    } catch {
        return null;
    }
}

/**
 * Persist the current messages and reducer state for a session after a fetch cycle.
 * No-op if caching is disabled for this session.
 */
export async function saveMessageCache(
    session: Session,
    messages: Message[],
    reducerState: ReducerState,
    lastSeq: number,
    oldestSeq: number = 0,
    hasOlderMessages: boolean = false,
): Promise<void> {
    if (!isCacheEnabled(session)) {
        log.log(`📦 messageCache: skip save for ${session.id} (flavor=${session.metadata?.flavor ?? 'none'}, not cursor)`);
        return;
    }

    try {
        const db = getSessionCacheDB();
        await db.saveSessionCache(
            {
                sessionId: session.id,
                lastSeq,
                oldestSeq,
                hasOlderMessages,
                schemaVersion: SERIALIZER_SCHEMA_VERSION,
                cachedAt: Date.now(),
                reducerStateJson: serializeReducerStateToJson(reducerState),
            },
            messages,
        );
        log.log(`📦 messageCache: saved ${messages.length} messages for ${session.id} (lastSeq=${lastSeq}, oldestSeq=${oldestSeq}, hasOlderMessages=${hasOlderMessages})`);
        notifyCachedLastSeq(session.id, lastSeq);
    } catch (err) {
        log.log(`📦 messageCache: save error for ${session.id}: ${err}`);
    }
}

/**
 * Clear the cache for a single session. Used by "Rebuild Message Cache" and
 * when a session is deleted.
 */
export async function clearMessageCache(sessionId: string): Promise<void> {
    try {
        const db = getSessionCacheDB();
        await db.clearSessionCache(sessionId);
        log.log(`📦 messageCache: cleared cache for ${sessionId}`);
        notifyCachedLastSeq(sessionId, null);
    } catch (err) {
        log.log(`📦 messageCache: clear error for ${sessionId}: ${err}`);
    }
}

/**
 * Clear all session caches. Used on logout.
 */
export async function clearAllMessageCaches(): Promise<void> {
    try {
        const db = getSessionCacheDB();
        await db.clearAllCaches();
        log.log('📦 messageCache: cleared all caches');
    } catch (err) {
        log.log(`📦 messageCache: clearAll error: ${err}`);
    }
}
