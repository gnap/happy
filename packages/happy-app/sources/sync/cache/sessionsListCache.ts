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
import type { Session } from '../storageTypes';
import { log } from '@/log';

type SessionListEntry = Omit<Session, 'presence'> & { presence?: Session['presence'] };

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
export async function loadSessionsListCache(): Promise<{ sessions: SessionListEntry[]; cachedAt: number } | null> {
    try {
        const db = getSessionCacheDB();
        const row = await db.getSessionsListCache();
        if (!row || !row.sessionsJson) {
            console.warn('📦 sessionsListCache: load — no cache row');
            return null;
        }
        const sessions = JSON.parse(row.sessionsJson) as SessionListEntry[];
        console.warn(`📦 sessionsListCache: loaded ${sessions.length} sessions (cachedAt=${row.cachedAt})`);
        return { sessions, cachedAt: row.cachedAt };
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
export async function saveSessionsListCache(sessions: SessionListEntry[]): Promise<void> {
    try {
        const db = getSessionCacheDB();
        await db.saveSessionsListCache({
            sessionsJson: JSON.stringify(sessions),
            cachedAt: Date.now(),
        });
        console.warn(`📦 sessionsListCache: saved ${sessions.length} sessions`);
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
    try {
        const db = getSessionCacheDB();
        await db.clearSessionsListCache();
        log.log('📦 sessionsListCache: cleared');
    } catch (err) {
        log.log(`📦 sessionsListCache: clear error: ${err}`);
    }
}
