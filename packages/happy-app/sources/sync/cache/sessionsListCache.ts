/**
 * Sessions List Cache Service
 *
 * High-level orchestration for the session list cache. Persists the decrypted
 * session list locally so the App can show cached sessions immediately on open.
 *
 * Mirrors the messageCache.ts pattern: load on cold start, save after each
 * successful fetch, clear on logout.
 */

import { getSessionCacheDB } from './sessionCacheDB';
import { getSyncStore } from './hotWindow';
import type { Session } from '../storageTypes';
import { log } from '@/log';

/** The synchronous copy the home screen draws before SQLite answers. */
const SESSIONS_LIST_HOT_KEY = 'sessions-list-hot-v1';

type SessionListEntry = Omit<Session, 'presence'> & { presence?: Session['presence'] };

/** Cached encryption keys: sessionId → dataEncryptionKey (base64). Keys are immutable per session. */
export type CachedEncryptionKeys = Record<string, string>;

// ---------------------------------------------------------------------------
// Preload
// ---------------------------------------------------------------------------

/**
 * Preload the session cache DB so the first read doesn't block on native module
 * load. Call once at app startup alongside preloadSessionCacheDB().
 */
export async function preloadSessionsListCache(): Promise<void> {
    const start = Date.now();
    try {
        const db = getSessionCacheDB();
        await db.initialize();
        const ms = Date.now() - start;
        log.log(`📦 sessionsListCache: DB preloaded in ${ms}ms`);
    } catch (e) {
        const ms = Date.now() - start;
        log.log(`📦 sessionsListCache: preload failed after ${ms}ms (non-fatal): ${e}`);
    }
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

/**
 * Try to load the cached session list. Returns null if empty or unavailable.
 */
export async function loadSessionsListCache(): Promise<{ sessions: SessionListEntry[]; cachedAt: number; encryptionKeys: CachedEncryptionKeys } | null> {
    // The synchronous copy first. The home screen is drawn from this list; asking SQLite for it —
    // and waiting behind whatever else the JS thread is doing — is the cold-start delay this
    // cache exists to remove.
    const store = getSyncStore();
    if (store) {
        const raw = store.getString(SESSIONS_LIST_HOT_KEY);
        if (raw) {
            try {
                const hot = JSON.parse(raw) as {
                    sessions?: SessionListEntry[];
                    cachedAt?: number;
                    encryptionKeys?: CachedEncryptionKeys;
                };
                if (Array.isArray(hot.sessions)) {
                    console.warn(`📦 sessionsListCache: hot copy — ${hot.sessions.length} sessions`);
                    return {
                        sessions: hot.sessions,
                        cachedAt: Number(hot.cachedAt) || 0,
                        encryptionKeys: hot.encryptionKeys ?? {},
                    };
                }
            } catch {
                // Fall through to the archive; a corrupt synchronous copy is not a reason to be
                // without a list.
            }
        }
    }
    try {
        const db = getSessionCacheDB();
        const row = await db.getSessionsListCache();
        if (!row || !row.sessionsJson) {
            console.warn('📦 sessionsListCache: load — no cache row');
            return null;
        }
        const sessions = JSON.parse(row.sessionsJson) as SessionListEntry[];
        let encryptionKeys: CachedEncryptionKeys = {};
        if (row.encryptionKeysJson) {
            try {
                encryptionKeys = JSON.parse(row.encryptionKeysJson);
            } catch { /* ignore corrupt keys */ }
        }
        console.warn(`📦 sessionsListCache: loaded ${sessions.length} sessions (cachedAt=${row.cachedAt}, keys=${Object.keys(encryptionKeys).length})`);
        return { sessions, cachedAt: row.cachedAt, encryptionKeys };
    } catch (err) {
        console.warn(`📦 sessionsListCache: load error: ${err}`);
        return null;
    }
}

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

/**
 * Persist the decrypted session list after a successful fetch.
 */
export async function saveSessionsListCache(sessions: SessionListEntry[], encryptionKeys?: CachedEncryptionKeys): Promise<void> {
    const cachedAt = Date.now();
    const keysJson = encryptionKeys && Object.keys(encryptionKeys).length > 0
        ? JSON.stringify(encryptionKeys) : undefined;
    // Synchronous copy first: the next cold start draws the list from it, and the database write
    // below is the archive rather than the source of the first frame.
    const store = getSyncStore();
    if (store) {
        try {
            store.set(SESSIONS_LIST_HOT_KEY, JSON.stringify({
                sessions,
                cachedAt,
                encryptionKeys: encryptionKeys ?? {},
            }));
        } catch {
            // The archive below still has it; the next start pays the asynchronous path.
        }
    }
    try {
        const db = getSessionCacheDB();
        await db.saveSessionsListCache({
            sessionsJson: JSON.stringify(sessions),
            cachedAt,
            encryptionKeysJson: keysJson,
        });
        console.warn(`📦 sessionsListCache: saved ${sessions.length} sessions (keys=${encryptionKeys ? Object.keys(encryptionKeys).length : 0})`);
    } catch (err) {
        console.warn(`📦 sessionsListCache: save error: ${err}`);
    }
}

// ---------------------------------------------------------------------------
// Clear
// ---------------------------------------------------------------------------

/**
 * Clear the session list cache. Called on logout.
 */
export async function clearSessionsListCache(): Promise<void> {
    const store = getSyncStore();
    if (store) {
        try {
            store.delete(SESSIONS_LIST_HOT_KEY);
        } catch {
            // ignore
        }
    }
    try {
        const db = getSessionCacheDB();
        await db.clearSessionsListCache();
        log.log('📦 sessionsListCache: cleared');
    } catch (err) {
        log.log(`📦 sessionsListCache: clear error: ${err}`);
    }
}
