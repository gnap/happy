/**
 * Session Cache Database Layer
 *
 * Provides an abstraction over SQLite for persisting session message caches.
 * The interface allows tests to inject an in-memory implementation without
 * requiring native expo-sqlite.
 *
 * Schema:
 *   session_cache   – one row per session: lastSeq, schemaVersion, reducerState JSON
 *   session_messages – one row per rendered Message: sessionId, messageId, createdAt, JSON
 */

import type { Message } from '../typesMessage';
import { collapseDuplicateMessages } from '../messageIdentity';
import { MAX_CACHED_MESSAGES, MAX_REDUCER_STATE_BYTES } from './limits';
import { StatementQueue } from './statementQueue';
import { log } from '@/log';
import * as SQLite from 'expo-sqlite';

/**
 * Whatever the engine says when another connection holds the lock.
 *
 * expo-sqlite reports it as `SQLiteErrorException: Error code 5: database is locked` wrapped in a
 * `FunctionCallException` from whichever statement could not finish, so the code and the text are
 * both matched rather than one assumed.
 */
/**
 * The database object a *previous* evaluation of this module created, if there was one.
 *
 * A reload re-evaluates this module but not the native side: the previous `LazySessionCacheDB`
 * and its one SQLite connection are still alive. Closing that connection from here did not work —
 * the handle belongs to a JS context that is gone, and the close either failed or never landed —
 * so every reload added a second connection to the same file. They then blocked each other: on a
 * device, statements were measured at 10–16 seconds after a few reloads, and a 387KB session-list
 * parse appeared to take 51 seconds because the JS thread was continuously busy behind them.
 *
 * So the instance itself is parked on `globalThis`, which every evaluation shares, and the next
 * evaluation takes it over instead of opening a connection of its own. There is only ever one
 * connection, and the queue and its bookkeeping survive the reload with it.
 *
 * In production this runs exactly never, because the module is evaluated once — which is also why
 * nothing else would have caught it.
 */
const sessionCacheSlot = globalThis as unknown as { __happySessionCacheDB?: ISessionCacheDB };
const inheritedDb = sessionCacheSlot.__happySessionCacheDB;

function isLocked(error: unknown): boolean {
    const message = String(error);
    return message.includes('database is locked') || message.includes('Error code 5');
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CachedSessionRow {
    sessionId: string;
    lastSeq: number;
    /** Lowest seq currently stored (1 = all messages loaded, >1 = older messages exist) */
    oldestSeq: number;
    /** True when the server has messages with seq < oldestSeq */
    hasOlderMessages: boolean;
    schemaVersion: number;
    cachedAt: number;
    reducerStateJson: string;
}

export interface CachedMessageRow {
    sessionId: string;
    messageId: string;
    createdAt: number;
    messageJson: string;
}

export interface CachedSessionListRow {
    sessionsJson: string;
    cachedAt: number;
    encryptionKeysJson?: string;
}

export interface ISessionCacheDB {
    initialize(): Promise<void>;
    getSessionCache(sessionId: string): Promise<CachedSessionRow | null>;
    getSessionMessages(sessionId: string, limit?: number): Promise<Message[]>;
    /**
     * Drops the rows that are the same message under a second delivery id.
     *
     * The wire log records a message once per direction — the queued copy under its local id, the
     * server's echo under the server id — and a build that stored pages of wire entries persisted
     * both. One row survives per `localId`: the copy carrying the server id when there is one.
     * Local and idempotent; returns how many rows it removed.
     */
    dedupeSessionMessages(sessionId: string): Promise<number>;
    saveSessionCache(row: CachedSessionRow, messages: Message[]): Promise<void>;
    clearSessionCache(sessionId: string): Promise<void>;
    clearAllCaches(): Promise<void>;
    getSessionsListCache(): Promise<CachedSessionListRow | null>;
    saveSessionsListCache(row: CachedSessionListRow): Promise<void>;
    clearSessionsListCache(): Promise<void>;
}

// ---------------------------------------------------------------------------
// In-memory implementation for testing and non-native platforms (web)
// ---------------------------------------------------------------------------

export class MemorySessionCacheDB implements ISessionCacheDB {
    private sessions = new Map<string, CachedSessionRow>();
    private messages = new Map<string, Message[]>();
    private sessionsList: CachedSessionListRow | null = null;

    async initialize(): Promise<void> {}

    async getSessionCache(sessionId: string): Promise<CachedSessionRow | null> {
        return this.sessions.get(sessionId) ?? null;
    }

    async getSessionMessages(sessionId: string, limit?: number): Promise<Message[]> {
        const held = this.messages.get(sessionId) ?? [];
        return limit === undefined ? held : held.slice(-limit);
    }

    async dedupeSessionMessages(sessionId: string): Promise<number> {
        const held = this.messages.get(sessionId) ?? [];
        const kept = collapseDuplicateMessages(held);
        this.messages.set(sessionId, kept);
        return held.length - kept.length;
    }

    async saveSessionCache(row: CachedSessionRow, messages: Message[]): Promise<void> {
        this.sessions.set(row.sessionId, row);
        this.messages.set(row.sessionId, [...messages]);
    }

    async clearSessionCache(sessionId: string): Promise<void> {
        this.sessions.delete(sessionId);
        this.messages.delete(sessionId);
    }

    async clearAllCaches(): Promise<void> {
        this.sessions.clear();
        this.messages.clear();
        this.sessionsList = null;
    }

    async getSessionsListCache(): Promise<CachedSessionListRow | null> {
        return this.sessionsList;
    }

    async saveSessionsListCache(row: CachedSessionListRow): Promise<void> {
        this.sessionsList = row;
    }

    async clearSessionsListCache(): Promise<void> {
        this.sessionsList = null;
    }
}

// ---------------------------------------------------------------------------
// IndexedDB implementation for web (browser + Tauri/Linux desktop)
// Persists session cache so Linux/desktop doesn't refetch on every launch.
// ---------------------------------------------------------------------------

const IDB_NAME = 'happy_message_cache';
const IDB_VERSION = 4;
const STORE_SESSION_CACHE = 'session_cache';
const STORE_SESSION_MESSAGES = 'session_messages';
const STORE_SESSIONS_LIST = 'sessions_list';

export class IndexedDBSessionCacheDB implements ISessionCacheDB {
    private db: IDBDatabase | null = null;
    private initPromise: Promise<void> | null = null;

    async initialize(): Promise<void> {
        // Re-open if the existing connection is on an older schema version.
        // Metro hot reload keeps the singleton alive with a stale DB reference.
        if (this.db && (this.db.version as number) < IDB_VERSION) {
            this.db.close();
            this.db = null;
            this.initPromise = null;
        }
        if (this.db) return;
        if (this.initPromise) return this.initPromise;
        this.initPromise = this._doInitialize();
        await this.initPromise;
    }

    private async _doInitialize(): Promise<void> {
        return new Promise((resolve, reject) => {
            if (typeof window === 'undefined' || !window.indexedDB) {
                reject(new Error('IndexedDB not available'));
                return;
            }
            const req = window.indexedDB.open(IDB_NAME, IDB_VERSION);
            req.onerror = () => reject(req.error);
            req.onsuccess = () => {
                this.db = req.result;
                log.log(`📦 sessionCacheDB: using IndexedDB v${this.db.version} (persistent, web/Tauri)`);
                resolve();
            };
            req.onupgradeneeded = (event) => {
                const db = (event.target as IDBOpenDBRequest).result;
                if (!db.objectStoreNames.contains(STORE_SESSION_CACHE)) {
                    db.createObjectStore(STORE_SESSION_CACHE, { keyPath: 'sessionId' });
                }
                if (!db.objectStoreNames.contains(STORE_SESSION_MESSAGES)) {
                    db.createObjectStore(STORE_SESSION_MESSAGES, { keyPath: 'sessionId' });
                }
                if (!db.objectStoreNames.contains(STORE_SESSIONS_LIST)) {
                    db.createObjectStore(STORE_SESSIONS_LIST, { keyPath: 'id' });
                }
            };
        });
    }

    private getStore(mode: IDBTransactionMode = 'readonly'): { cache: IDBObjectStore; messages: IDBObjectStore } {
        if (!this.db) throw new Error('IndexedDBSessionCacheDB not initialized');
        const tx = this.db.transaction([STORE_SESSION_CACHE, STORE_SESSION_MESSAGES], mode);
        return {
            cache: tx.objectStore(STORE_SESSION_CACHE),
            messages: tx.objectStore(STORE_SESSION_MESSAGES),
        };
    }

    async getSessionCache(sessionId: string): Promise<CachedSessionRow | null> {
        await this.initialize();
        return new Promise((resolve, reject) => {
            const req = this.getStore().cache.get(sessionId);
            req.onsuccess = () => {
                const row = req.result as { sessionId: string; lastSeq: number; oldestSeq?: number; hasOlderMessages?: boolean; schemaVersion: number; cachedAt: number; reducerState: string } | undefined;
                if (!row) {
                    resolve(null);
                    return;
                }
                resolve({
                    sessionId: row.sessionId,
                    lastSeq: row.lastSeq,
                    oldestSeq: row.oldestSeq ?? 0,
                    hasOlderMessages: row.hasOlderMessages ?? false,
                    schemaVersion: row.schemaVersion,
                    cachedAt: row.cachedAt,
                    reducerStateJson: row.reducerState,
                });
            };
            req.onerror = () => reject(req.error);
        });
    }

    async getSessionMessages(sessionId: string, limit?: number): Promise<Message[]> {
        await this.initialize();
        return new Promise((resolve, reject) => {
            const req = this.getStore().messages.get(sessionId);
            req.onsuccess = () => {
                const entry = req.result as { sessionId: string; messages: string[] } | undefined;
                if (!entry?.messages?.length) {
                    resolve([]);
                    return;
                }
                const held = limit === undefined ? entry.messages : entry.messages.slice(-limit);
                const messages: Message[] = [];
                for (const json of held) {
                    try {
                        messages.push(JSON.parse(json) as Message);
                    } catch {
                        // skip malformed
                    }
                }
                resolve(messages);
            };
            req.onerror = () => reject(req.error);
        });
    }

    async dedupeSessionMessages(sessionId: string): Promise<number> {
        await this.initialize();
        return new Promise((resolve, reject) => {
            const { messages } = this.getStore('readwrite');
            const read = messages.get(sessionId);
            read.onsuccess = () => {
                const entry = read.result as { sessionId: string; messages: string[] } | undefined;
                if (!entry?.messages?.length) {
                    resolve(0);
                    return;
                }
                const parsed: Message[] = [];
                for (const json of entry.messages) {
                    try {
                        parsed.push(JSON.parse(json) as Message);
                    } catch {
                        // Skip malformed, as the read does.
                    }
                }
                const kept = collapseDuplicateMessages(parsed);
                const dropped = parsed.length - kept.length;
                if (dropped === 0) {
                    resolve(0);
                    return;
                }
                messages.put({ sessionId, messages: kept.map((message) => JSON.stringify(message)) });
                const tx = messages.transaction;
                tx.oncomplete = () => resolve(dropped);
                tx.onerror = () => reject(tx.error);
            };
            read.onerror = () => reject(read.error);
        });
    }

    async saveSessionCache(row: CachedSessionRow, messages: Message[]): Promise<void> {
        await this.initialize();
        return new Promise((resolve, reject) => {
            const { cache, messages: messagesStore } = this.getStore('readwrite');
            cache.put({
                sessionId: row.sessionId,
                lastSeq: row.lastSeq,
                oldestSeq: row.oldestSeq,
                hasOlderMessages: row.hasOlderMessages,
                schemaVersion: row.schemaVersion,
                cachedAt: row.cachedAt,
                reducerState: row.reducerStateJson,
            });
            const messageBlobs = messages.map((m) => JSON.stringify(m));
            messagesStore.put({ sessionId: row.sessionId, messages: messageBlobs });
            const tx = cache.transaction;
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    async clearSessionCache(sessionId: string): Promise<void> {
        await this.initialize();
        return new Promise((resolve, reject) => {
            const { cache, messages } = this.getStore('readwrite');
            cache.delete(sessionId);
            messages.delete(sessionId);
            const tx = cache.transaction;
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    async getSessionsListCache(): Promise<CachedSessionListRow | null> {
        await this.initialize();
        return new Promise((resolve, reject) => {
            const tx = this.db!.transaction([STORE_SESSIONS_LIST], 'readonly');
            const req = tx.objectStore(STORE_SESSIONS_LIST).get(1);
            req.onsuccess = () => {
                // The wrapped session keys are read back as well as written. Without them a cold
                // start restores every session's text and none of its key, so the only way left to
                // a key is the server -- and a device whose server is unreachable sits on sessions
                // it can display but not decrypt, offering no send.
                const row = req.result as CachedSessionListRow | undefined;
                if (!row) { resolve(null); return; }
                resolve({
                    sessionsJson: row.sessionsJson,
                    cachedAt: row.cachedAt,
                    encryptionKeysJson: row.encryptionKeysJson,
                });
            };
            req.onerror = () => reject(req.error);
        });
    }

    async saveSessionsListCache(row: CachedSessionListRow): Promise<void> {
        await this.initialize();
        return new Promise((resolve, reject) => {
            const tx = this.db!.transaction([STORE_SESSIONS_LIST], 'readwrite');
            tx.objectStore(STORE_SESSIONS_LIST).put({ id: 1, ...row });
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    async clearSessionsListCache(): Promise<void> {
        await this.initialize();
        return new Promise((resolve, reject) => {
            const tx = this.db!.transaction([STORE_SESSIONS_LIST], 'readwrite');
            tx.objectStore(STORE_SESSIONS_LIST).delete(1);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    async clearAllCaches(): Promise<void> {
        await this.initialize();
        return new Promise((resolve, reject) => {
            const { cache, messages } = this.getStore('readwrite');
            cache.clear();
            messages.clear();
            const txSessionList = this.db!.transaction([STORE_SESSIONS_LIST], 'readwrite');
            txSessionList.objectStore(STORE_SESSIONS_LIST).clear();
            const tx = cache.transaction;
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }
}

// ---------------------------------------------------------------------------
// SQLite implementation (expo-sqlite) for iOS / Android
// ---------------------------------------------------------------------------

const DB_NAME = 'happy_message_cache_v2.db';
const SCHEMA_VERSION = 2;

/**
 * What a save has to write, given what the database already holds.
 *
 * Object identity is the change signal: the store rebuilds a message object when it changes and
 * keeps the same one otherwise, so a re-render that touched nothing costs nothing here. An absent
 * `previous` means the rows on disk are unknown (a fresh install, or a session never read), which
 * is the one case that needs the session rewritten outright.
 */
export function diffMessages<T extends { id: string }>(
    previous: Map<string, T> | undefined,
    messages: T[],
): { next: Map<string, T>; inserts: T[]; removed: string[]; rewrite: boolean } {
    const next = new Map<string, T>();
    const inserts: T[] = [];
    for (const message of messages) {
        next.set(message.id, message);
        if (previous?.get(message.id) !== message) {
            inserts.push(message);
        }
    }
    return {
        next,
        inserts,
        removed: previous ? [...previous.keys()].filter((id) => !next.has(id)) : [],
        rewrite: !previous,
    };
}

class ExpoSQLiteSessionCacheDB implements ISessionCacheDB {
    /**
     * What this database believes it holds, per session: message id → the object that was written.
     *
     * The write path used to delete every row for a session and insert them all again, on a
     * 1.5-second timer, for whatever had changed — which for a long session is megabytes of
     * serialisation and thousands of statements per save, growing with the window rather than with
     * the change. Comparing against what was written turns the steady state into a handful of
     * inserts, and the rows still end up describing exactly the messages the store holds.
     *
     * Object identity is the change signal: the store rebuilds a message object when it changes and
     * keeps the same one otherwise, so a re-render that touched nothing costs nothing here.
     */
    private written = new Map<string, Map<string, Message>>();
    /** The watermark of those same rows, so a save that would change nothing is not made. */
    private writtenWatermark = new Map<string, { lastSeq: number; oldestSeq: number; hasOlderMessages: boolean }>();

    // We use dynamic require to avoid crashing on platforms without native support
    // (the web platform uses MemorySessionCacheDB instead)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private db: any = null;
    private initialized = false;
    private initPromise: Promise<void> | null = null;

    async initialize(): Promise<void> {
        if (this.initialized) return;
        if (this.initPromise) return this.initPromise;

        this.initPromise = this._doInitialize();
        await this.initPromise;
    }

    private async _doInitialize(): Promise<void> {
        log.log('📦 sessionCacheDB: _doInitialize started');
        const t0 = Date.now();
        // Static import so expo-sqlite loads with app bundle (avoids cold-start hang on first session open)
        this.db = await SQLite.openDatabaseAsync(DB_NAME);
        this.watchStatements();
        log.log(`📦 sessionCacheDB: openDatabaseAsync took ${Date.now() - t0}ms`);

        const t2 = Date.now();
        await this.db.execAsync(`
            PRAGMA journal_mode = WAL;
            -- Wait for a lock rather than failing on it. The failure this replaces is
            -- "finalizeAsync has failed: database is locked", which lost saves outright; five
            -- seconds is longer than any statement here takes and shorter than a user's patience.
            PRAGMA busy_timeout = 5000;

            CREATE TABLE IF NOT EXISTS session_cache (
                session_id          TEXT PRIMARY KEY,
                last_seq            INTEGER NOT NULL DEFAULT 0,
                oldest_seq          INTEGER NOT NULL DEFAULT 0,
                has_older_messages  INTEGER NOT NULL DEFAULT 0,
                schema_version      INTEGER NOT NULL DEFAULT 2,
                cached_at           INTEGER NOT NULL DEFAULT 0,
                reducer_state       TEXT NOT NULL DEFAULT '{}'
            );

            CREATE TABLE IF NOT EXISTS session_messages (
                session_id      TEXT NOT NULL,
                message_id      TEXT NOT NULL,
                created_at      INTEGER NOT NULL DEFAULT 0,
                message_json    TEXT NOT NULL,
                -- The identity every delivery of one message agrees on. The primary key is the
                -- delivery id, which is not stable across the wire's two directions; this column
                -- is what the unique index below holds the cache to one row per *message*.
                local_id        TEXT,
                PRIMARY KEY (session_id, message_id)
            );

            CREATE INDEX IF NOT EXISTS idx_session_messages_session
                ON session_messages(session_id, created_at);

            CREATE TABLE IF NOT EXISTS sessions_list_cache (
                id                    INTEGER PRIMARY KEY DEFAULT 1,
                sessions_json         TEXT NOT NULL DEFAULT '[]',
                cached_at             INTEGER NOT NULL DEFAULT 0,
                encryption_keys_json  TEXT
            );
        `);
        // Migration: add encryption_keys_json to tables created before this column
        // existed (CREATE TABLE IF NOT EXISTS won't alter existing tables).
        try {
            await this.db.execAsync('ALTER TABLE sessions_list_cache ADD COLUMN encryption_keys_json TEXT');
        } catch {
            // Column already exists or table doesn't exist yet — either is fine.
        }
        await this.migrateMessageIdentity();
        log.log(`📦 sessionCacheDB: execAsync (schema) took ${Date.now() - t2}ms`);

        this.initialized = true;
        log.log(`📦 sessionCacheDB: full init took ${Date.now() - t0}ms total`);
    }

    /**
     * Brings on-disk state up to what this build reads, once.
     *
     * Two conversions, both table scans too expensive to repeat on every launch:
     *
     * - v1: one row per message. The table used to be keyed only by the id a delivery carried, and
     *   one message has two of those (the local id on the wire's queued direction and the server id
     *   on the echo), so a page of wire entries stored the same message twice. The column and the
     *   unique index make that unrepresentable from now on.
     * - v2: a bounded window. The table used to keep every message ever seen and reducer states
     *   that could reach tens of megabytes; the write path is bounded now, and this converts what
     *   is already there. A state past the cap is dropped, not trimmed: rebuilding it from the
     *   window is the reducer's job and costs less than deserialising it forever.
     *
     * `user_version` gates both, so a database converted here never pays for it again.
     */
    private async migrateMessageIdentity(): Promise<void> {
        const version = await this.db.getFirstAsync('PRAGMA user_version') as { user_version: number } | null;
        const from = version?.user_version ?? 0;
        // v3 re-runs the bounding pass for databases that reached 2 before it existed. On a device
        // that left 14,258 rows older than two days and sessions at 968-1033 rows: the save path
        // was bounded by then, so the rows were pure legacy, and no gate would ever have removed
        // them because the version alone said the work was done.
        if (from >= 3) {
            return;
        }
        const started = Date.now();
        if (from < 1) {
            try {
                await this.db.execAsync('ALTER TABLE session_messages ADD COLUMN local_id TEXT');
            } catch {
                // The column already exists: a fresh install that created it above, or a migration
                // that got this far before failing later.
            }
            await this.db.execAsync(`
                UPDATE session_messages
                   SET local_id = json_extract(message_json, '$.localId')
                 WHERE local_id IS NULL
                   AND json_valid(message_json)
                   AND json_extract(message_json, '$.localId') IS NOT NULL;

                DELETE FROM session_messages
                 WHERE local_id IS NOT NULL
                   AND message_id NOT IN (
                       SELECT message_id FROM (
                           SELECT message_id,
                                  ROW_NUMBER() OVER (
                                      PARTITION BY session_id, local_id
                                      ORDER BY (message_id != local_id) DESC, created_at DESC
                                  ) AS rn
                             FROM session_messages
                            WHERE local_id IS NOT NULL
                       )
                        WHERE rn = 1
                   );

                CREATE UNIQUE INDEX IF NOT EXISTS idx_session_messages_local
                    ON session_messages(session_id, local_id)
                    WHERE local_id IS NOT NULL;
            `);
        }
        await this.db.execAsync(`
            DELETE FROM session_messages
             WHERE message_id IN (
                 SELECT message_id FROM (
                     SELECT message_id,
                            ROW_NUMBER() OVER (
                                PARTITION BY session_id
                                ORDER BY created_at DESC
                            ) AS rn
                       FROM session_messages
                 )
                  WHERE rn > ${MAX_CACHED_MESSAGES}
             );

            UPDATE session_cache
               SET reducer_state = '{}'
             WHERE length(reducer_state) > ${MAX_REDUCER_STATE_BYTES};

            PRAGMA wal_checkpoint(TRUNCATE);
            PRAGMA user_version = 3;
        `);
        log.log(`📦 sessionCacheDB: cache migration v3 took ${Date.now() - started}ms`);
    }

    private async ensureReady(): Promise<void> {
        if (!this.initialized) await this.initialize();
    }

    /**
     * expo-sqlite hands out a single connection, and one connection cannot have two statements in
     * flight. Overlapping them fails however the engine notices first, and both ways were seen
     * here: two saves nested their BEGINs ("cannot start a transaction within a transaction"), and
     * a read running alongside a write came back "database is locked" and then failed to finalise
     * its statement — which left the cache saving *nothing at all*, the state a session reverts to
     * its older messages from after the app has been in the background.
     *
     * So every statement goes through one queue, reads included. The reads were left out of this
     * the first time because the symptom then was a write failing; the connection does not care
     * which half of a pair is the read.
     */
    /** Every statement on the one connection, with the ones a person is waiting for first. */
    private statements = new StatementQueue();
    /** A replacement in flight, so several locked statements open one connection, not several. */
    private replacing: Promise<void> | null = null;
    private lastReplacedAt = 0;

    /**
     * Statement timings, but only the ones worth seeing.
     *
     * A slow read is either waiting for the connection or slow *on* it, and those are different
     * bugs: the first is who is ahead in this queue, the second is the connection itself — a
     * statement an earlier failure left un-finalised holds it, and every statement behind that one
     * pays seconds. Nothing under a fifth of a second is reported, so a healthy cache says nothing.
     */
    private watchStatements = () => {
        this.statements.onStatement = ({ waited, ran, depth }) => {
            if (waited > 200 || ran > 200) {
                log.log(`📦 sessionCacheDB: statement waited=${waited}ms ran=${ran}ms queued behind ${depth - 1}`);
            }
        };
    };

    /**
     * Past every statement this file issues with room to spare: a save of a whole window measured
     * 1.1 s, and a read of one row is milliseconds. Raised from ten seconds after a device log
     * showed the detector firing during ordinary use — the timer includes the JS thread's delay in
     * getting to the callback, not just the statement — and every firing made things worse.
     */
    private static readonly STUCK_STATEMENT_MS = 90_000;

    private enqueue<T>(work: () => Promise<T>, urgent = false): Promise<T> {
        // A job that never finishes must not take the cache with it. But the previous answer —
        // dropping the queue and opening another connection — was a second fault: the old
        // connection kept the file, the new one waited on it, and every statement behind the new
        // one paid. On a device this ran repeatedly (16:01–16:02), with opens taking 6–8s and
        // statements waiting 20–47s; the "recovery" was the outage. New work is refused instead, so
        // callers fall back to the hot window or the network, and the stuck job is left alone.
        if (this.statements.stuckFor > ExpoSQLiteSessionCacheDB.STUCK_STATEMENT_MS) {
            log.log(
                `📦 sessionCacheDB: a statement has been running ${Math.round(this.statements.stuckFor / 1000)}s;` +
                ' refusing new cache work until it finishes'
            );
            return Promise.reject(new Error('cache busy: a statement has been running too long'));
        }
        return this.statements.run(async () => {
            try {
                return await work();
            } catch (error) {
                if (!isLocked(error)) {
                    throw error;
                }
                // A locked connection is not a failed statement, it is a connection somebody else
                // still holds: a previous JS context that a reload left running, or a transaction of
                // ours an earlier failure never finalised. Everything behind it pays — measured on a
                // device, one read waited 0ms and then took thirty seconds — and no amount of
                // retrying on the same connection helps. So the connection is replaced, and the
                // statement is tried once on the new one: every statement here is idempotent
                // (`INSERT OR REPLACE`, deletes by key), so a second run cannot double-apply it.
                log.log(`📦 sessionCacheDB: the connection is locked (${String(error).slice(0, 80)}); replacing it and retrying`);
                await this.replaceConnection();
                await this.ensureReady();
                return await work();
            }
        }, urgent);
    }

    /**
     * Throws the connection away, and the state that says it is ready.
     *
     * `closeAsync` is bounded: a connection wedged by an un-finalised statement is exactly the case
     * where closing it can hang, and a reset that never returns would be a worse failure than the
     * lock it is fixing.
     */
    private replaceConnection(): Promise<void> {
        if (this.replacing) {
            // Several statements can meet the lock at once. One new connection is the whole
            // answer; a second is one more contender for the same file.
            return this.replacing;
        }
        if (Date.now() - this.lastReplacedAt < 5_000) {
            // A replacement just happened and the file is still locked. Opening another will not
            // change that; let this caller fail and fall back instead of adding to the pile.
            return Promise.resolve();
        }
        this.replacing = this.doReplaceConnection().finally(() => {
            this.replacing = null;
            this.lastReplacedAt = Date.now();
        });
        return this.replacing;
    }

    private async doReplaceConnection(): Promise<void> {
        const previous = this.db;
        // `this.db` is never left null: a statement already in flight reads it again after every
        // await, and the reset must not turn "the connection is being replaced" into
        // `Cannot read property 'withTransactionAsync' of null` for the work it is replacing. The
        // new connection is opened first, and the old one is closed behind it.
        this.initialized = false;
        this.initPromise = null;
        if (!previous) {
            return;
        }
        try {
            await this.ensureReady();
            if (this.db === previous) {
                return;
            }
        } catch {
            // Opening a replacement failed outright; the caller's retry will report why.
            return;
        }
        try {
            await Promise.race([
                previous.closeAsync(),
                new Promise((resolve) => setTimeout(resolve, 2_000)),
            ]);
        } catch {
            // Already gone, or never closable: the reference is dropped either way, which is what
            // matters — the next statement opens a connection of its own.
        }
    }

    async getSessionCache(sessionId: string): Promise<CachedSessionRow | null> {
        await this.ensureReady();
        return this.enqueue(async () => {
            const row = await this.db.getFirstAsync(
                'SELECT session_id, last_seq, oldest_seq, has_older_messages, schema_version, cached_at, reducer_state FROM session_cache WHERE session_id = ?',
                [sessionId]
            ) as Record<string, unknown> | null;

            if (!row) return null;
            return {
                sessionId: row['session_id'] as string,
                lastSeq: row['last_seq'] as number,
                oldestSeq: (row['oldest_seq'] as number) ?? 0,
                hasOlderMessages: !!row['has_older_messages'],
                schemaVersion: row['schema_version'] as number,
                cachedAt: row['cached_at'] as number,
                reducerStateJson: row['reducer_state'] as string,
            };
        }, true);
    }

    /**
     * The newest `limit` messages, or every one the database holds when no limit is given.
     *
     * Opening a session used to read *all* of them: 660 messages measured at ten seconds, because
     * every row is a full message JSON and each is parsed on the JS thread. The limit is what makes
     * that cost a property of the window rather than of the session's history — the older rows stay
     * on disk, where scrolling back reaches them through the channel's own paging rather than
     * through this read.
     */
    async getSessionMessages(sessionId: string, limit?: number): Promise<Message[]> {
        await this.ensureReady();
        // Urgent for the same reason the row above is: this is the read a tap is waiting on.
        return this.enqueue(async () => {
            const rows = limit === undefined
                ? await this.db.getAllAsync(
                    'SELECT message_json FROM session_messages WHERE session_id = ? ORDER BY created_at ASC',
                    [sessionId]
                ) as Record<string, unknown>[]
                // Newest first for the LIMIT, then reversed: the same index serves both, and the
                // rows that fall off the end are the oldest ones.
                : (await this.db.getAllAsync(
                    'SELECT message_json FROM session_messages WHERE session_id = ? ORDER BY created_at DESC LIMIT ?',
                    [sessionId, limit]
                ) as Record<string, unknown>[]).reverse();

            const messages: Message[] = [];
            for (const row of rows) {
                try {
                    messages.push(JSON.parse(row['message_json'] as string) as Message);
                } catch {
                    // Skip malformed rows
                }
            }
            // Reading is how the database learns what it holds: it has just seen every row, so the
            // next save can be a delta rather than a rewrite.
            this.written.set(sessionId, new Map(messages.map((message) => [message.id, message])));
            return messages;
        }, true);
    }

    async dedupeSessionMessages(sessionId: string): Promise<number> {
        await this.ensureReady();
        return this.enqueue(async () => {
            // Only the identity fields: reading the whole message JSON is the cost this cache
            // exists to avoid, and the decision needs three columns.
            const rows = await this.db.getAllAsync(
                `SELECT message_id AS id, local_id AS localId, created_at AS createdAt
                   FROM session_messages
                  WHERE session_id = ? AND local_id IS NOT NULL`,
                [sessionId]
            ) as { id: string; localId: string | null; createdAt: number }[];
            const identified = rows
                .filter((row) => typeof row.localId === 'string' && row.localId !== '')
                .map((row) => ({ id: row.id, localId: row.localId as string, createdAt: Number(row.createdAt) }));
            if (identified.length === 0) {
                return 0;
            }
            const survivors = new Set(collapseDuplicateMessages(identified).map((row) => row.id));
            const doomed = identified.filter((row) => !survivors.has(row.id)).map((row) => row.id);
            if (doomed.length === 0) {
                return 0;
            }
            const CHUNK = 100;
            for (let at = 0; at < doomed.length; at += CHUNK) {
                const chunk = doomed.slice(at, at + CHUNK);
                await this.db.runAsync(
                    `DELETE FROM session_messages
                     WHERE session_id = ? AND message_id IN (${chunk.map(() => '?').join(', ')})`,
                    [sessionId, ...chunk]
                );
            }
            // What the database holds just changed, and the next save's delta is computed
            // against what it is believed to hold: forgetting the row set is what makes the
            // first save after this one rewrite rather than assume a row that is gone.
            this.written.delete(sessionId);
            log.log(`📦 sessionCacheDB: dropped ${doomed.length} duplicate message rows for ${sessionId}`);
            return doomed.length;
        }, true);
    }

    async saveSessionCache(row: CachedSessionRow, messages: Message[]): Promise<void> {
        await this.ensureReady();
        const { next, inserts, rewrite } = diffMessages(this.written.get(row.sessionId), messages);
        // Nothing to add, and the window is where it was: the row on disk already says all of this.
        // The reducer state needs no comparison of its own — it is only ever mutated by reducing
        // messages, and any message that changed is one of the inserts.
        const watermark = this.writtenWatermark.get(row.sessionId);
        if (
            !rewrite &&
            inserts.length === 0 &&
            watermark !== undefined &&
            watermark.lastSeq === row.lastSeq &&
            watermark.oldestSeq === row.oldestSeq &&
            watermark.hasOlderMessages === row.hasOlderMessages
        ) {
            return;
        }

        // Serialised before any statement runs: stringifying would otherwise happen between two
        // statements of the save.
        const encoded = inserts.map((message) => JSON.stringify(message));
        const started = Date.now();

        await this.enqueue(async () => {
            // No transaction, deliberately.
            //
            // `withTransactionAsync` opens a BEGIN on the native connection and closes it when the
            // callback finishes. A JS context torn down mid-save — every reload in development,
            // which is how this App is used — leaves that transaction open on a connection nothing
            // can reach any more, and the file stays write-locked for the life of the process: every
            // statement after it waited ~2s on `busy_timeout` until the app was killed. Measured:
            // 7ms per statement on a cold start, 2000ms after a reload.
            //
            // The price is that a save is no longer atomic, and it is paid in the safe direction:
            // the message rows go first and the `session_cache` row last, so a save that dies
            // halfway leaves the *previous* row in place — the last statement is what makes the new
            // window visible. Every row is idempotent (`INSERT OR REPLACE` by key).

            // Nothing is ever deleted here, and that is the point.
            //
            // This used to drop the rows for messages that had left the window — and a rewrite
            // dropped every row for the session outright. But a window shrinks as a matter of
            // course on this channel: a read that is more than a page behind replaces it with
            // the newest page, and the whole point of the cache is to be the copy the App can
            // still show when that page is a small one. Deleting the rows made the shrink
            // permanent and irreversible, which is what "today's messages are gone" was: the
            // window was replaced by a page of a few dozen messages, and the save that followed
            // deleted the hundreds of rows behind it. Rows now accumulate; a window is a view of
            // what is held, not a licence to discard it.
            //
            // One statement per chunk rather than one per message: each round trip crosses into
            // native, and a burst of messages is the normal case, not the exception. 100 rows x
            // 4 columns stays well under SQLite's bound-parameter limit.
            const CHUNK = 100;
            for (let at = 0; at < inserts.length; at += CHUNK) {
                const chunk = inserts.slice(at, at + CHUNK);
                const params: unknown[] = [];
                for (let j = 0; j < chunk.length; j += 1) {
                    const message = chunk[j];
                    // The identity column, not the delivery id: the unique index turns a second
                    // delivery of the same message into a replacement of its row rather than a
                    // second row. `INSERT OR REPLACE` is what performs that merge.
                    const localId = 'localId' in message ? message.localId ?? null : null;
                    params.push(row.sessionId, message.id, message.createdAt, encoded[at + j], localId);
                }
                await this.db.runAsync(
                    `INSERT OR REPLACE INTO session_messages
                        (session_id, message_id, created_at, message_json, local_id)
                     VALUES ${chunk.map(() => '(?, ?, ?, ?, ?)').join(', ')}`,
                    params
                );
            }

                await this.db.runAsync(
                    `INSERT OR REPLACE INTO session_cache
                        (session_id, last_seq, oldest_seq, has_older_messages, schema_version, cached_at, reducer_state)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [row.sessionId, row.lastSeq, row.oldestSeq, row.hasOlderMessages ? 1 : 0, row.schemaVersion, row.cachedAt, row.reducerStateJson]
                );

            this.written.set(row.sessionId, next);
            const ms = Date.now() - started;
            if (ms > 50) {
                log.log(`📦 sessionCacheDB: wrote ${inserts.length}/${messages.length} messages for ${row.sessionId} in ${ms}ms${rewrite ? ' (rewrite)' : ''}`);
            }
        }, true);

        this.writtenWatermark.set(row.sessionId, {
            lastSeq: row.lastSeq,
            oldestSeq: row.oldestSeq,
            hasOlderMessages: row.hasOlderMessages,
        });
    }

    async clearSessionCache(sessionId: string): Promise<void> {
        await this.ensureReady();
        await this.enqueue(async () => {
            // Autocommit, for the same reason the save is: a transaction abandoned by a reloaded
            // JS context holds the file until the process dies.
            await this.db.runAsync('DELETE FROM session_messages WHERE session_id = ?', [sessionId]);
            await this.db.runAsync('DELETE FROM session_cache WHERE session_id = ?', [sessionId]);
            this.written.delete(sessionId);
            this.writtenWatermark.delete(sessionId);
        });
    }

    async getSessionsListCache(): Promise<CachedSessionListRow | null> {
        await this.ensureReady();
        return this.enqueue(async () => {
            // Try with encryption_keys_json first. If the column doesn't exist yet
            // (pre-migration), fall back to the old schema.
            try {
                const row = await this.db.getFirstAsync(
                    'SELECT sessions_json, cached_at, encryption_keys_json FROM sessions_list_cache WHERE id = 1'
                ) as Record<string, unknown> | null;
                if (!row) return null;
                return {
                    sessionsJson: row['sessions_json'] as string,
                    cachedAt: row['cached_at'] as number,
                    encryptionKeysJson: row['encryption_keys_json'] as string | undefined,
                };
            } catch {
                // Column encryption_keys_json doesn't exist yet — fall back.
                const row = await this.db.getFirstAsync(
                    'SELECT sessions_json, cached_at FROM sessions_list_cache WHERE id = 1'
                ) as Record<string, unknown> | null;
                if (!row) return null;
                return {
                    sessionsJson: row['sessions_json'] as string,
                    cachedAt: row['cached_at'] as number,
                };
            }
        });
    }

    async saveSessionsListCache(row: CachedSessionListRow): Promise<void> {
        await this.ensureReady();
        await this.enqueue(async () => {
            try {
                await this.db.runAsync(
                    'INSERT OR REPLACE INTO sessions_list_cache (id, sessions_json, cached_at, encryption_keys_json) VALUES (1, ?, ?, ?)',
                    [row.sessionsJson, row.cachedAt, row.encryptionKeysJson ?? null]
                );
            } catch {
                // Column encryption_keys_json may not exist yet — fall back.
                await this.db.runAsync(
                    'INSERT OR REPLACE INTO sessions_list_cache (id, sessions_json, cached_at) VALUES (1, ?, ?)',
                    [row.sessionsJson, row.cachedAt]
                );
            }
        });
    }

    async clearSessionsListCache(): Promise<void> {
        await this.ensureReady();
        await this.enqueue(async () => {
            await this.db.runAsync('DELETE FROM sessions_list_cache WHERE id = 1');
        });
    }

    async clearAllCaches(): Promise<void> {
        await this.ensureReady();
        await this.enqueue(async () => {
            // Autocommit, like every other write here: a transaction left open by a context that
            // was torn down holds the file until the process dies.
            await this.db.runAsync('DELETE FROM session_messages');
            await this.db.runAsync('DELETE FROM session_cache');
            await this.db.runAsync('DELETE FROM sessions_list_cache');
            this.written.clear();
            this.writtenWatermark.clear();
        });
    }
}

// ---------------------------------------------------------------------------
// Lazy wrapper: try ExpoSQLite first, fall back to Memory on any init error
// (avoids native-module crashes in Release when SQLite is unavailable)
// ---------------------------------------------------------------------------

class LazySessionCacheDB implements ISessionCacheDB {
    private delegate: ISessionCacheDB | null = null;
    private initPromise: Promise<void> | null = null;

    private async ensureDelegate(): Promise<ISessionCacheDB> {
        if (this.delegate) return this.delegate;
        if (this.initPromise) {
            await this.initPromise;
            return this.delegate!;
        }
        this.initPromise = (async () => {
            try {
                const sqlite = new ExpoSQLiteSessionCacheDB();
                await sqlite.initialize();
                this.delegate = sqlite;
                log.log('📦 sessionCacheDB: using SQLite (persistent)');
            } catch (e) {
                log.log(`📦 sessionCacheDB: expo-sqlite init failed, using in-memory cache (no persistence): ${e}`);
                this.delegate = new MemorySessionCacheDB();
            }
        })();
        await this.initPromise;
        return this.delegate!;
    }

    async initialize(): Promise<void> {
        await this.ensureDelegate();
    }

    async getSessionCache(sessionId: string): Promise<CachedSessionRow | null> {
        return (await this.ensureDelegate()).getSessionCache(sessionId);
    }

    async getSessionMessages(sessionId: string, limit?: number): Promise<Message[]> {
        return (await this.ensureDelegate()).getSessionMessages(sessionId, limit);
    }

    async dedupeSessionMessages(sessionId: string): Promise<number> {
        return (await this.ensureDelegate()).dedupeSessionMessages(sessionId);
    }

    async saveSessionCache(row: CachedSessionRow, messages: Message[]): Promise<void> {
        return (await this.ensureDelegate()).saveSessionCache(row, messages);
    }

    async clearSessionCache(sessionId: string): Promise<void> {
        return (await this.ensureDelegate()).clearSessionCache(sessionId);
    }

    async clearAllCaches(): Promise<void> {
        return (await this.ensureDelegate()).clearAllCaches();
    }

    async getSessionsListCache(): Promise<CachedSessionListRow | null> {
        return (await this.ensureDelegate()).getSessionsListCache();
    }

    async saveSessionsListCache(row: CachedSessionListRow): Promise<void> {
        return (await this.ensureDelegate()).saveSessionsListCache(row);
    }

    async clearSessionsListCache(): Promise<void> {
        return (await this.ensureDelegate()).clearSessionsListCache();
    }
}

// ---------------------------------------------------------------------------
// Singleton factory
// ---------------------------------------------------------------------------

let _instance: ISessionCacheDB | null = null;

/**
 * Returns the singleton database instance.
 * On native: tries expo-sqlite first, falls back to in-memory on init failure.
 * On web, sync.ts constructor calls overrideSessionCacheDB(MemorySessionCacheDB).
 * In tests, call overrideSessionCacheDB / resetSessionCacheDB to inject a mock.
 */
export function getSessionCacheDB(): ISessionCacheDB {
    if (!_instance) {
        // The previous evaluation's instance, when there is one: same connection, same queue.
        _instance = inheritedDb ?? new LazySessionCacheDB();
        sessionCacheSlot.__happySessionCacheDB = _instance;
    }
    return _instance;
}

/**
 * Override the singleton – intended for unit tests only.
 */
export function overrideSessionCacheDB(db: ISessionCacheDB): void {
    _instance = db;
    sessionCacheSlot.__happySessionCacheDB = db;
}

/**
 * Reset the singleton to null (useful in afterEach blocks in tests).
 */
export function resetSessionCacheDB(): void {
    _instance = null;
    delete sessionCacheSlot.__happySessionCacheDB;
}
