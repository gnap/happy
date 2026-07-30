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
import { log } from '@/log';
import * as SQLite from 'expo-sqlite';

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
    getSessionMessages(sessionId: string): Promise<Message[]>;
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

    async getSessionMessages(sessionId: string): Promise<Message[]> {
        return this.messages.get(sessionId) ?? [];
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

    async getSessionMessages(sessionId: string): Promise<Message[]> {
        await this.initialize();
        return new Promise((resolve, reject) => {
            const req = this.getStore().messages.get(sessionId);
            req.onsuccess = () => {
                const entry = req.result as { sessionId: string; messages: string[] } | undefined;
                if (!entry?.messages?.length) {
                    resolve([]);
                    return;
                }
                const messages: Message[] = [];
                for (const json of entry.messages) {
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

class ExpoSQLiteSessionCacheDB implements ISessionCacheDB {
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
        log.log(`📦 sessionCacheDB: openDatabaseAsync took ${Date.now() - t0}ms`);

        const t2 = Date.now();
        await this.db.execAsync(`
            PRAGMA journal_mode = WAL;

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

    async getSessionCache(sessionId: string): Promise<CachedSessionRow | null> {
        await this.ensureReady();
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
    }

    async getSessionMessages(sessionId: string): Promise<Message[]> {
        await this.ensureReady();
        const rows = await this.db.getAllAsync(
            'SELECT message_json FROM session_messages WHERE session_id = ? ORDER BY created_at ASC',
            [sessionId]
        ) as Record<string, unknown>[];

        const messages: Message[] = [];
        for (const row of rows) {
            try {
                messages.push(JSON.parse(row['message_json'] as string) as Message);
            } catch {
                // Skip malformed rows
            }
        }
        return messages;
    }

    async saveSessionCache(row: CachedSessionRow, messages: Message[]): Promise<void> {
        await this.ensureReady();

        await this.db.withTransactionAsync(async () => {
            await this.db.runAsync(
                `INSERT OR REPLACE INTO session_cache
                    (session_id, last_seq, oldest_seq, has_older_messages, schema_version, cached_at, reducer_state)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [row.sessionId, row.lastSeq, row.oldestSeq, row.hasOlderMessages ? 1 : 0, row.schemaVersion, row.cachedAt, row.reducerStateJson]
            );

            await this.db.runAsync(
                'DELETE FROM session_messages WHERE session_id = ?',
                [row.sessionId]
            );

            for (const message of messages) {
                await this.db.runAsync(
                    `INSERT OR REPLACE INTO session_messages
                        (session_id, message_id, created_at, message_json)
                     VALUES (?, ?, ?, ?)`,
                    [row.sessionId, message.id, message.createdAt, JSON.stringify(message)]
                );
            }
        });
    }

    async clearSessionCache(sessionId: string): Promise<void> {
        await this.ensureReady();
        await this.db.withTransactionAsync(async () => {
            await this.db.runAsync('DELETE FROM session_cache WHERE session_id = ?', [sessionId]);
            await this.db.runAsync('DELETE FROM session_messages WHERE session_id = ?', [sessionId]);
        });
    }

    async getSessionsListCache(): Promise<CachedSessionListRow | null> {
        await this.ensureReady();
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
    }

    async saveSessionsListCache(row: CachedSessionListRow): Promise<void> {
        await this.ensureReady();
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
    }

    async clearSessionsListCache(): Promise<void> {
        await this.ensureReady();
        await this.db.runAsync('DELETE FROM sessions_list_cache WHERE id = 1');
    }

    async clearAllCaches(): Promise<void> {
        await this.ensureReady();
        await this.db.withTransactionAsync(async () => {
            await this.db.runAsync('DELETE FROM session_cache');
            await this.db.runAsync('DELETE FROM session_messages');
            await this.db.runAsync('DELETE FROM sessions_list_cache');
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

    async getSessionMessages(sessionId: string): Promise<Message[]> {
        return (await this.ensureDelegate()).getSessionMessages(sessionId);
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
