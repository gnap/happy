/**
 * Session Cache Database Layer
 *
 * Provides an abstraction over SQLite for persisting session message caches.
 * The interface allows tests to inject an in-memory implementation without
 * requiring native expo-sqlite.
 *
 * Schema:
 *   session_cache   - one row per session: lastSeq, schemaVersion, reducerState JSON
 *   session_messages - one row per rendered Message: sessionId, messageId, createdAt, JSON
 */

import type { Message } from '../typesMessage';
import { log } from '@/log';

export interface CachedSessionRow {
    sessionId: string;
    lastSeq: number;
    oldestSeq: number;
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

export interface ISessionCacheDB {
    initialize(): Promise<void>;
    getSessionCache(sessionId: string): Promise<CachedSessionRow | null>;
    getSessionMessages(sessionId: string): Promise<Message[]>;
    saveSessionCache(row: CachedSessionRow, messages: Message[]): Promise<void>;
    clearSessionCache(sessionId: string): Promise<void>;
    clearAllCaches(): Promise<void>;
}

export class MemorySessionCacheDB implements ISessionCacheDB {
    private sessions = new Map<string, CachedSessionRow>();
    private messages = new Map<string, Message[]>();

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
    }
}

const DB_NAME = 'happy_message_cache.db';

class ExpoSQLiteSessionCacheDB implements ISessionCacheDB {
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
        const SQLite = require('expo-sqlite');
        this.db = await SQLite.openDatabaseAsync(DB_NAME);
        log.log(`📦 sessionCacheDB: openDatabaseAsync took ${Date.now() - t0}ms`);

        const t2 = Date.now();
        await this.db.execAsync(`
            PRAGMA journal_mode = WAL;

            CREATE TABLE IF NOT EXISTS session_cache (
                session_id      TEXT PRIMARY KEY,
                last_seq        INTEGER NOT NULL DEFAULT 0,
                oldest_seq      INTEGER NOT NULL DEFAULT 0,
                has_older_messages INTEGER NOT NULL DEFAULT 0,
                schema_version  INTEGER NOT NULL DEFAULT 1,
                cached_at       INTEGER NOT NULL DEFAULT 0,
                reducer_state   TEXT NOT NULL DEFAULT '{}'
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
        `);
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
            oldestSeq: row['oldest_seq'] as number,
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
                // Skip malformed rows.
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

    async clearAllCaches(): Promise<void> {
        await this.ensureReady();
        await this.db.withTransactionAsync(async () => {
            await this.db.runAsync('DELETE FROM session_cache');
            await this.db.runAsync('DELETE FROM session_messages');
        });
    }
}

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
}

let _instance: ISessionCacheDB | null = null;

export function getSessionCacheDB(): ISessionCacheDB {
    if (!_instance) {
        _instance = new LazySessionCacheDB();
    }
    return _instance;
}

export function overrideSessionCacheDB(db: ISessionCacheDB): void {
    _instance = db;
}

export function resetSessionCacheDB(): void {
    _instance = null;
}
