/**
 * Stands in for `expo-sqlite` under vitest.
 *
 * `sessionCacheDB` imports expo-sqlite, which imports react-native — a Flow-typed package Rollup
 * cannot parse, so merely importing anything that reaches the cache module failed to even load:
 * `messageCache.test.ts` reported a parse error on `react-native/index.js` and ran zero tests,
 * which left the cache with no coverage at all.
 *
 * The tests drive `MemorySessionCacheDB` through `overrideSessionCacheDB` and never open a real
 * database, so nothing here needs to work. It throws rather than returning a stub handle on
 * purpose: a test that silently exercised a fake SQLite would be worse than one that fails.
 */

export function openDatabaseAsync(): never {
    throw new Error(
        'expo-sqlite is stubbed in tests; use MemorySessionCacheDB via overrideSessionCacheDB'
    );
}
