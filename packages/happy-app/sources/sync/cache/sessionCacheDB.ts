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
 * The connection the *previous* evaluation of this module left open, if there was one.
 *
 * A reload re-evaluates this module but not the native side: the connection the last
 * evaluation opened stays open, and the object that could close it is about to be garbage. So the
 * handle is parked here — on `globalThis`, which every evaluation of the module shares — and the
 * next one closes it before opening its own. Without this the old connection holds the database
 * while the new one works: statements wait, saves fail locked, and the whole cache crawls until
 * the ten-second detector gives up on it. Measured: statements waiting 51-65 seconds.
 *
 * In production this runs exactly never, because the module is evaluated once — which is also why
 * nothing else would have caught it.
 */
const inheritedSlot = globalThis as unknown as { __happyRetiredCacheConnection?: unknown };
const inherited = inheritedSlot.__happyRetiredCacheConnection;
inheritedSlot.__happyRetiredCacheConnection = null;
if (inherited) {
    try {
        // Bounded, and never awaited: a connection wedged by a statement whose caller is gone is
        // the case where closing can hang, and the module still has to finish loading.
        void Promise.race([
            (inherited as { closeAsync: () => Promise<void> }).closeAsync(),
            new Promise((resolve) => setTimeout(resolve, 2_000)),
        ]).catch(() => undefined);
        log.log('📦 sessionCacheDB: closed the connection a previous load of this module left open');
    } catch {
        // Not closable from here; the new connection is opened regardless.
    }
}

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
                const row = req.result as { id: number; sessionsJson: string; cachedAt: number } | undefined;
                if (!row) { resolve(null); return; }
                resolve({ sessionsJson: row.sessionsJson, cachedAt: row.cachedAt });
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
        // Parked for whichever evaluation of this module comes after this one: see the slot above.
        inheritedSlot.__happyRetiredCacheConnection = this.db;
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
        log.log(`📦 sessionCacheDB: execAsync (schema) took ${Date.now() - t2}ms`);

        this.initialized = true;
        log.log(`📦 sessionCacheDB: full init took ${Date.now() - t0}ms total`);
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
     * 1.1 s, and a read of one row is milliseconds.
     */
    private static readonly STUCK_STATEMENT_MS = 10_000;

    private enqueue<T>(work: () => Promise<T>, urgent = false): Promise<T> {
        // A job that never finishes must not take the cache with it. The queue and the connection
        // are module state, and a reload hands them to a context whose promises will never settle —
        // so the head of the queue can be a statement nobody is waiting for any more, with every
        // new statement behind it. Past the ceiling, both are abandoned: the new statement gets a
        // queue and a connection of its own, and the old ones are left to whatever native state
        // they hold.
        if (this.statements.stuckFor > ExpoSQLiteSessionCacheDB.STUCK_STATEMENT_MS) {
            log.log(`📦 sessionCacheDB: a statement has been running ${this.statements.stuckFor}ms; abandoning the queue and its connection`);
            this.statements = new StatementQueue();
            this.watchStatements();
            void this.replaceConnection();
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
    private async replaceConnection(): Promise<void> {
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

        // Serialised before the transaction opens, not inside it: stringifying would otherwise hold
        // the write lock across the whole loop.
        const encoded = inserts.map((message) => JSON.stringify(message));
        const started = Date.now();

        await this.enqueue(async () => {
            await this.db.withTransactionAsync(async () => {
                await this.db.runAsync(
                    `INSERT OR REPLACE INTO session_cache
                        (session_id, last_seq, oldest_seq, has_older_messages, schema_version, cached_at, reducer_state)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [row.sessionId, row.lastSeq, row.oldestSeq, row.hasOlderMessages ? 1 : 0, row.schemaVersion, row.cachedAt, row.reducerStateJson]
                );

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
                        params.push(row.sessionId, chunk[j].id, chunk[j].createdAt, encoded[at + j]);
                    }
                    await this.db.runAsync(
                        `INSERT OR REPLACE INTO session_messages
                            (session_id, message_id, created_at, message_json)
                         VALUES ${chunk.map(() => '(?, ?, ?, ?)').join(', ')}`,
                        params
                    );
                }
            });

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
            await this.db.withTransactionAsync(async () => {
                await this.db.runAsync('DELETE FROM session_cache WHERE session_id = ?', [sessionId]);
                await this.db.runAsync('DELETE FROM session_messages WHERE session_id = ?', [sessionId]);
            });
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
            await this.db.withTransactionAsync(async () => {
                await this.db.runAsync('DELETE FROM session_cache');
                await this.db.runAsync('DELETE FROM session_messages');
                await this.db.runAsync('DELETE FROM sessions_list_cache');
            });
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
        _instance = new LazySessionCacheDB();
    }
    return _instance;
}

/**
 * Override the singleton – intended for unit tests only.
 */
export function overrideSessionCacheDB(db: ISessionCacheDB): void {
    _instance = db;
}

/**
 * Reset the singleton to null (useful in afterEach blocks in tests).
 */
export function resetSessionCacheDB(): void {
    _instance = null;
}
