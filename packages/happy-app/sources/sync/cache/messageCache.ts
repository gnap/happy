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
    trimReducerState,
    deserializeReducerStateFromJson,
    deserializeReducerStateOrCreate,
    SERIALIZER_SCHEMA_VERSION,
} from './reducerStateSerializer';
import { clearAllHotWindows, clearHotWindow, loadHotWindow, saveHotWindow } from './hotWindow';
import { MAX_CACHED_MESSAGES, MAX_REDUCER_STATE_BYTES } from './limits';
import { createReducer, materializeReducerMessages, type ReducerState } from '../reducer/reducer';
import type { Message } from '../typesMessage';
import type { Session } from '../storageTypes';
import { collapseDuplicateMessages } from '../messageIdentity';
import { log } from '@/log';
import { bump } from '../metrics';

// ---------------------------------------------------------------------------
// Guard: only Cursor sessions use the cache
// ---------------------------------------------------------------------------

/**
 * Whether the message cache should be used for this session.
 *
 * The flavor is what says the CLI keeps a local log worth caching, but it is a *server*-decrypted
 * field: with the server channel switched off, a session learned from the daemon's own list has no
 * metadata at all, and a gate that insists on the flavor then refuses to cache — or to read — a
 * session the daemon is serving right now. Being served by a daemon is a reason in itself, and the
 * only one the App can establish without the server.
 */
export function isCacheEnabled(session: Session | null | undefined, servedByDaemon = false): boolean {
    if (servedByDaemon) {
        return true;
    }
    const flavor = session?.metadata?.flavor;
    return flavor === 'cursor' || flavor === 'acp-cursor' || flavor === 'claude';
}

// ---------------------------------------------------------------------------
// Loaded cache result
// ---------------------------------------------------------------------------

/**
 * How many messages one open reads back from the cache.
 *
 * What a screen needs, not a window to keep: the rest of the rows stay where they are, and scrolling
 * back walks them over the channel that owns the log — the daemon's log or the server's seqs — which
 * is where paging belongs. It is parsing JSON on the JS thread that costs here, not the query, so
 * this number is what an open costs; sixty messages is several screens and tens of milliseconds.
 */
const HYDRATE_MESSAGE_LIMIT = 60;

/**
 * Sessions whose rows have already been straightened in this evaluation of the module.
 *
 * The cache older than the projection fix may hold the same message twice — the queued copy and
 * the server's echo — because a page of wire entries was stored before the boundary collapsed
 * them. Left on disk, those rows come back on every open forever, and the user's only escape is
 * "rebuild cache", which is a manual wipe standing in for a correctness property. The repair is
 * a delete, not a wipe: one row survives per message.
 */
const repairedSessions = new Set<string>();

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
export async function loadMessageCache(session: Session, servedByDaemon = false): Promise<LoadedCache | null> {
    if (!session) {
        console.warn(`📦 messageCache: skip load (no session)`);
        return null;
    }
    if (!isCacheEnabled(session, servedByDaemon)) {
        console.warn(`📦 messageCache: skip load for ${session.id.slice(-8)} (flavor=${session.metadata?.flavor ?? 'none'})`);
        return null;
    }

    // The synchronous window first. It is what makes opening a conversation independent of both
    // the database's queue and the JS thread's queue: the messages a screen needs are already in
    // memory-mapped storage, and the return happens before the first await. SQLite below is the
    // fallback for sessions with no hot copy and the archive for everything older.
    const hotStartedAt = Date.now();
    const hot = loadHotWindow(session.id);
    if (!hot) {
        // Says why an open is about to pay the asynchronous path: no window for this session yet
        // (never saved by this build), evicted, or the store is unavailable.
        log.log(`📦 messageCache: hot miss for ${session.id}; falling back to SQLite`);
    }
    if (hot) {
        // The window keeps one copy: the reducer state when it was small enough, and the messages
        // themselves when it was not. A state that no longer produces the window it was saved with
        // (a partial write, a changed shape) is a miss, not a shorter window.
        if (hot.reducerStateJson) {
            const storedState = deserializeReducerStateFromJson(hot.reducerStateJson);
            const materialized = storedState ? materializeReducerMessages(storedState) : [];
            // The state's projection is the window: a few reducer entries can legitimately have no
            // display form (a streamed chunk folded into another message), so the count can come out
            // slightly lower than the messages that were saved. Only an empty projection means the
            // state is not this window at all — a changed shape, or a write that did not land.
            if (storedState && materialized.length > 0) {
                const messages = collapseDuplicateMessages(materialized);
                const reducerState = trimReducerState(
                    storedState,
                    new Set(messages.map((message) => message.id)),
                );
                log.log(
                    `📦 messageCache: hot window ${messages.length} messages for ${session.id}` +
                    ` in ${Date.now() - hotStartedAt}ms (${hot.bytes}b)`
                );
                return {
                    messages,
                    reducerState,
                    lastSeq: hot.lastSeq,
                    oldestSeq: hot.oldestSeq,
                    hasOlderMessages: hot.hasOlderMessages,
                };
            }
            log.log(
                `📦 messageCache: hot state for ${session.id} holds ${materialized.length} of ${hot.messageCount}` +
                ' messages; falling back to the copy in the window'
            );
        }
        if (hot.messages) {
            const messages = collapseDuplicateMessages(hot.messages);
            if (messages.length === hot.messageCount) {
                // The state was dropped as oversized, so there is no state to hand the next ingest:
                // a fresh one is correct, just not free to rebuild from the archive.
                const reducerState = trimReducerState(
                    deserializeReducerStateOrCreate(undefined),
                    new Set(messages.map((message) => message.id)),
                );
                log.log(
                    `📦 messageCache: hot messages ${messages.length} for ${session.id}` +
                    ` in ${Date.now() - hotStartedAt}ms (${hot.bytes}b, state dropped)`
                );
                return {
                    messages,
                    reducerState,
                    lastSeq: hot.lastSeq,
                    oldestSeq: hot.oldestSeq,
                    hasOlderMessages: hot.hasOlderMessages,
                };
            }
        }
        log.log(`📦 messageCache: hot window for ${session.id} did not cover its ${hot.messageCount} messages; reading the rows`);
    }

    try {
        const db = getSessionCacheDB();
        // Straighten rows written before the projection collapsed the two wire directions of one
        // message. Idempotent and local: it deletes the redundant row, never the cache. Scheduled
        // *after* the read below, because an open must not wait on housekeeping — on a reload the
        // connection is shared with a context that is gone, and every extra statement costs the
        // busy timeout. The read is clean either way: the projection collapses the window.
        const repair = !repairedSessions.has(session.id);
        if (repair) {
            repairedSessions.add(session.id);
        }
        const tStart = Date.now();
        // Awaited, not raced against a timer. The timer used to return `null` at three seconds,
        // which — on a busy JS thread — fired after the query had already done its work and threw
        // the result away, turning a slow open into an empty one that waited for the network. A
        // local read has no useful deadline; the caller has the hot window for the fast path.
        const cacheRow = await db.getSessionCache(session.id);
        const tRow = Date.now();
        if (!cacheRow) {
            log.log(`📦 messageCache: no cache row for ${session.id}`);
            return null;
        }

        // The version belongs to the *reducer state* serializer, not to the message rows, which are
        // stored separately and are already-reduced plain data this build still knows how to read.
        // `deserializeReducerStateOrCreate` below already falls back to a fresh state on a mismatch,
        // so the messages are still worth hydrating. Discarding the row instead — as this used to,
        // deleting it for good measure — blanks the screen and refetches everything, for *every*
        // session at once and on every serializer change: precisely the cold-start jank the cache
        // exists to prevent, inflicted wholesale by a version bump.
        if (cacheRow.schemaVersion !== SERIALIZER_SCHEMA_VERSION) {
            log.log(
                `📦 messageCache: reducer schema v${cacheRow.schemaVersion} != v${SERIALIZER_SCHEMA_VERSION} for ${session.id};` +
                ' keeping the messages, restarting the reducer'
            );
        }

        // The newest slice, not everything on disk. Every row is a full message JSON parsed on the
        // JS thread, so reading all of them made opening a session cost whatever its whole history
        // cost — 660 messages measured at ten seconds on a device. The window the user opens to is
        // the newest messages; the rest stay on disk and are reached by scrolling back, which goes
        // through the channel's paging rather than through this read.
        const messages = await db.getSessionMessages(session.id, HYDRATE_MESSAGE_LIMIT + 1);
        const tMessages = Date.now();
        // The rows were written from a page of wire entries, where one message can be two (the
        // queued copy and the server's echo). Collapse before taking the window, so the window is
        // sixty *messages* rather than sixty rows — and so a duplicate that survived on disk is
        // never what the store is handed.
        const collapsed = collapseDuplicateMessages(messages);
        // The read is cut when it returns more rows than the window; the collapse can bring the
        // count back down without changing that fact.
        const truncated = messages.length > HYDRATE_MESSAGE_LIMIT || collapsed.length > HYDRATE_MESSAGE_LIMIT;
        const hydrating = collapsed.length > HYDRATE_MESSAGE_LIMIT ? collapsed.slice(-HYDRATE_MESSAGE_LIMIT) : collapsed;
        const tDeserialize = Date.now();
        // Trimmed to the window this load hands back: the persisted state was written by a window
        // that may have contained a row the collapse just removed, and a state entry naming a
        // message the store does not hold is a reference nothing can resolve.
        const reducerState = trimReducerState(
            deserializeReducerStateOrCreate(cacheRow.reducerStateJson),
            new Set(hydrating.map((message) => message.id)),
        );
        // Where the milliseconds of an open actually go. The row read, the message rows and the
        // reducer state are three different sizes — one row, sixty rows, one blob whose size is the
        // session's history — and the totals so far say the messages are not the expensive part.
        log.log(
            `📦 messageCache: kind=${truncated ? 'truncated' : 'whole'} session=${session.id} ` +
            `row=${tRow - tStart}ms messages=${tMessages - tRow}ms(${hydrating.length}) ` +
            `reducerState=${Date.now() - tDeserialize}ms(${cacheRow.reducerStateJson.length}b)`
        );

        // Where the window this read hands back actually starts. The row's own `oldestSeq` describes
        // the window that *wrote* it, which reaches further back than this one does — reporting that
        // would tell the store it holds messages it does not, and the paging that follows would skip
        // everything between.
        const floors = hydrating.map((message) => message.seq).filter((seq): seq is number => typeof seq === 'number');
        const oldestSeq = truncated && floors.length === hydrating.length
            ? Math.min(...floors)
            : cacheRow.oldestSeq;

        log.log(`📦 messageCache: loaded ${hydrating.length} messages for ${session.id} (lastSeq=${cacheRow.lastSeq}, oldestSeq=${oldestSeq}, hasOlderMessages=${cacheRow.hasOlderMessages}, truncated=${truncated})`);
        // Seed the synchronous copy from the archive. A window used to become hot only when a
        // save wrote it, and a session whose history does not change never saves — so every open
        // of it paid SQLite. Seeding after a successful hydration is what makes the *next* open
        // the one the hot window exists for. Deferred so this open's bytes are not delayed by
        // serialising the window.
        const hotSeed = {
            reducerStateJson: null,
            messages: hydrating,
            messageCount: hydrating.length,
            lastSeq: cacheRow.lastSeq,
            oldestSeq,
            hasOlderMessages: cacheRow.hasOlderMessages || truncated,
        };
        setTimeout(() => {
            try {
                // A save may have written a newer window while this read was in flight; that one
                // is closer to the present than the archive this read came from.
                if (!loadHotWindow(session.id)) {
                    saveHotWindow(session.id, hotSeed);
                }
            } catch {
                // The archive is still there; the next open simply pays it again.
            }
        }, 0);
        if (repair) {
            void db.dedupeSessionMessages(session.id)
                .then((dropped) => {
                    if (dropped > 0) {
                        log.log(`📦 messageCache: repaired ${dropped} duplicate rows for ${session.id}`);
                    }
                })
                .catch((e) => {
                    // Not fatal: the window above is already clean.
                    log.log(`📦 messageCache: duplicate repair failed for ${session.id}: ${e}`);
                });
        }
        return {
            messages: hydrating,
            reducerState,
            lastSeq: cacheRow.lastSeq,
            oldestSeq,
            // A window that does not reach the bottom of what is held has older messages by
            // definition, whatever the row says — the row was written by a window that did reach it.
            hasOlderMessages: cacheRow.hasOlderMessages || truncated,
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
/** False when the rows did not land, so a caller that stores something *about* them can hold off. */
/** What the last save of each session wrote, so an unchanged one costs nothing. */
const lastSaveFingerprints = new Map<string, string>();

export async function saveMessageCache(
    session: Session,
    messages: Message[],
    reducerState: ReducerState,
    lastSeq: number,
    oldestSeq: number = 0,
    hasOlderMessages: boolean = false,
    servedByDaemon = false,
): Promise<boolean> {
    if (!isCacheEnabled(session, servedByDaemon)) {
        log.log(`📦 messageCache: skip save for ${session.id} (flavor=${session.metadata?.flavor ?? 'none'}, not cursor)`);
        return false;
    }

    // A save of exactly what the last one wrote is not worth its serialisation. The reducer state
    // is a projection of the messages (it is only ever mutated by reducing them), so the message
    // set plus the window edges describe everything the row would say — and the expensive part of
    // a save was measured as exactly this no-op: re-serialising a ~500KB state on every tick for
    // a session whose store had not changed, only to drop it for size again.
    const fingerprint = `${messages.length}|${messages[messages.length - 1]?.id ?? ''}|${lastSeq}|${oldestSeq}|${hasOlderMessages}`;
    if (lastSaveFingerprints.get(session.id) === fingerprint) {
        return true;
    }

    try {
        const started = Date.now();
        const db = getSessionCacheDB();
        // The cache is a window, not the store. Enforced here as well as at the caller: one path
        // that forgot the bound is how sessions reached 968-1033 rows on a device even after the
        // window was introduced, and those rows were then read and migrated forever.
        const bounded = messages.length > MAX_CACHED_MESSAGES
            ? [...messages].sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_CACHED_MESSAGES)
            : messages;
        // Trimmed to the window a load hands back, so what is written is what will be read: see
        // `trimReducerState`. The window's own state is untouched — this is the copy that goes to
        // disk.
        const newest = [...bounded].sort((a, b) => b.createdAt - a.createdAt).slice(0, HYDRATE_MESSAGE_LIMIT);
        let reducerStateJson = serializeReducerStateToJson(trimReducerState(reducerState, new Set(newest.map((message) => message.id))));
        let stateDropped = false;
        if (reducerStateJson.length > MAX_REDUCER_STATE_BYTES) {
            // The state is a projection of the window; past this size it is carrying something the
            // trim does not take, and deserialising it costs more than rebuilding it from the
            // messages. A fresh state is correct, just not free.
            log.log(
                `📦 messageCache: dropping oversized reducer state for ${session.id}` +
                ` (${reducerStateJson.length}b > ${MAX_REDUCER_STATE_BYTES}b)`
            );
            reducerStateJson = serializeReducerStateToJson(createReducer());
            stateDropped = true;
        }
        const stateMs = Date.now() - started;
        // The window's own floor, not the store's: the hot copy holds sixty messages, and reporting
        // the oldest seq the *store* reached would make the next paging read skip everything
        // between the two. Same rule the database load applies to a truncated window.
        const floors = newest.map((message) => message.seq).filter((seq): seq is number => typeof seq === 'number');
        const truncated = messages.length > newest.length;
        const hotOldestSeq = truncated && floors.length === newest.length ? Math.min(...floors) : oldestSeq;
        // The synchronous copy a tap reads, written before the database on purpose: the next open
        // must not depend on this connection being free, or on the JS thread getting to the SQLite
        // callback in time. It is the same window and the same state the row below describes.
        // One copy, never two: the state when it survived, and the messages themselves when it was
        // dropped for size. A session full of tool output takes the second path most of the time.
        saveHotWindow(session.id, {
            reducerStateJson: stateDropped ? null : reducerStateJson,
            messages: stateDropped ? newest : null,
            messageCount: newest.length,
            lastSeq,
            oldestSeq: hotOldestSeq,
            hasOlderMessages,
        });
        const row = {
            sessionId: session.id,
            lastSeq,
            oldestSeq,
            hasOlderMessages,
            schemaVersion: SERIALIZER_SCHEMA_VERSION,
            cachedAt: Date.now(),
            reducerStateJson,
        };
        await db.saveSessionCache(row, messages);
        bump('cacheSaves');
        // The state is serialised per save because it is a field of the same row; this is what makes
        // its size visible, since it is the part of a save that scales with the window.
        bump('cacheBytes', reducerStateJson.length);
        const totalMs = Date.now() - started;
        const slow = totalMs > 200 ? ` in ${totalMs}ms (reducer state ${stateMs}ms)` : '';
        log.log(`📦 messageCache: saved ${messages.length} messages for ${session.id} (lastSeq=${lastSeq}, oldestSeq=${oldestSeq}, hasOlderMessages=${hasOlderMessages})${slow}`);
        notifyCachedLastSeq(session.id, lastSeq);
        lastSaveFingerprints.set(session.id, fingerprint);
        return true;
    } catch (err) {
        log.log(`📦 messageCache: save error for ${session.id}: ${err}`);
        return false;
    }
}

/**
 * Clear the cache for a single session. Used by "Rebuild Message Cache" and
 * when a session is deleted.
 */
export async function clearMessageCache(sessionId: string): Promise<void> {
    // The synchronous copy goes first: a rebuild that cleared SQLite but left the hot window would
    // reopen to the very conversation it was rebuilding away from.
    clearHotWindow(sessionId);
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
    clearAllHotWindows();
    try {
        const db = getSessionCacheDB();
        await db.clearAllCaches();
        log.log('📦 messageCache: cleared all caches');
    } catch (err) {
        log.log(`📦 messageCache: clearAll error: ${err}`);
    }
}
