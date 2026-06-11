/**
 * Web-specific implementation of the Session Cache Database Layer.
 * Metro automatically picks this file over sessionCacheDB.ts when bundling for web.
 *
 * expo-sqlite is a native-only module and cannot be bundled for web, so this
 * file exports the same interface using IndexedDB (or in-memory as fallback).
 */

import type { Message } from '../typesMessage';
import { log } from '@/log';

// ---------------------------------------------------------------------------
// Types (duplicated from sessionCacheDB.ts to keep the same public interface)
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
// In-memory implementation (used as fallback when IndexedDB is unavailable)
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
// IndexedDB implementation for web (browser + Tauri desktop)
// ---------------------------------------------------------------------------

const IDB_NAME = 'happy_message_cache';
const IDB_VERSION = 3;
const STORE_SESSION_CACHE = 'session_cache';
const STORE_SESSION_MESSAGES = 'session_messages';
const STORE_SESSIONS_LIST = 'sessions_list';

export class IndexedDBSessionCacheDB implements ISessionCacheDB {
    private db: IDBDatabase | null = null;
    private initPromise: Promise<void> | null = null;

    async initialize(): Promise<void> {
        // Re-open if the existing connection is on an older schema version.
        // Metro hot reload keeps the singleton alive with a stale DB reference;
        // the upgrade handler only fires on open(), so we must close+reopen.
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
                const row = req.result as {
                    sessionId: string;
                    lastSeq: number;
                    oldestSeq?: number;
                    hasOlderMessages?: boolean;
                    schemaVersion: number;
                    cachedAt: number;
                    reducerState: string;
                } | undefined;
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
// Singleton factory — on web, default to IndexedDB with memory fallback
// ---------------------------------------------------------------------------

let _instance: ISessionCacheDB | null = null;

export function getSessionCacheDB(): ISessionCacheDB {
    if (!_instance) {
        _instance = new IndexedDBSessionCacheDB();
        log.log('📦 sessionCacheDB: web singleton created (IndexedDB)');
    }
    return _instance;
}

export function overrideSessionCacheDB(db: ISessionCacheDB): void {
    _instance = db;
}

export function resetSessionCacheDB(): void {
    _instance = null;
}
