import { describe, it, expect, beforeEach } from 'vitest';
import { MemorySessionCacheDB } from './sessionCacheDB';
import type { CachedSessionRow } from './sessionCacheDB';
import type { Message } from '../typesMessage';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeCacheRow(sessionId: string, lastSeq = 42): CachedSessionRow {
    return {
        sessionId,
        lastSeq,
        oldestSeq: 0,
        hasOlderMessages: false,
        schemaVersion: 1,
        cachedAt: Date.now(),
        reducerStateJson: JSON.stringify({ schemaVersion: 1 }),
    };
}

function makeMessages(count: number, sessionId: string): Message[] {
    return Array.from({ length: count }, (_, i) => ({
        id: `msg_${sessionId}_${i}`,
        localId: null,
        createdAt: 1000 + i,
        kind: 'user-text' as const,
        text: `Message ${i}`,
    }));
}

// ---------------------------------------------------------------------------
// MemorySessionCacheDB
// ---------------------------------------------------------------------------

describe('MemorySessionCacheDB', () => {
    let db: MemorySessionCacheDB;

    beforeEach(() => {
        db = new MemorySessionCacheDB();
    });

    describe('initialize', () => {
        it('completes without error', async () => {
            await expect(db.initialize()).resolves.toBeUndefined();
        });

        it('can be called multiple times safely', async () => {
            await db.initialize();
            await expect(db.initialize()).resolves.toBeUndefined();
        });
    });

    describe('getSessionCache', () => {
        it('returns null for unknown sessionId', async () => {
            const result = await db.getSessionCache('unknown');
            expect(result).toBeNull();
        });

        it('returns the stored row', async () => {
            const row = makeCacheRow('sess1', 100);
            await db.saveSessionCache(row, []);
            const result = await db.getSessionCache('sess1');
            expect(result).toEqual(row);
        });

        it('does not return data for a different sessionId', async () => {
            await db.saveSessionCache(makeCacheRow('sess1'), []);
            expect(await db.getSessionCache('sess2')).toBeNull();
        });
    });

    describe('getSessionMessages', () => {
        it('returns empty array for unknown sessionId', async () => {
            const messages = await db.getSessionMessages('unknown');
            expect(messages).toEqual([]);
        });

        it('returns the stored messages', async () => {
            const msgs = makeMessages(3, 'sess1');
            await db.saveSessionCache(makeCacheRow('sess1'), msgs);
            const result = await db.getSessionMessages('sess1');
            expect(result).toHaveLength(3);
            expect(result[0].id).toBe('msg_sess1_0');
        });

        it('does not leak messages between sessions', async () => {
            const msgs1 = makeMessages(2, 'sess1');
            const msgs2 = makeMessages(5, 'sess2');
            await db.saveSessionCache(makeCacheRow('sess1'), msgs1);
            await db.saveSessionCache(makeCacheRow('sess2'), msgs2);

            expect(await db.getSessionMessages('sess1')).toHaveLength(2);
            expect(await db.getSessionMessages('sess2')).toHaveLength(5);
        });
    });

    describe('saveSessionCache', () => {
        it('overwrites previous data for the same session', async () => {
            const msgs1 = makeMessages(2, 'sess1');
            const msgs2 = makeMessages(5, 'sess1');
            await db.saveSessionCache(makeCacheRow('sess1', 10), msgs1);
            await db.saveSessionCache(makeCacheRow('sess1', 20), msgs2);

            const row = await db.getSessionCache('sess1');
            expect(row?.lastSeq).toBe(20);
            const messages = await db.getSessionMessages('sess1');
            expect(messages).toHaveLength(5);
        });

        it('stores a snapshot – subsequent mutations do not affect the store', async () => {
            const msgs = makeMessages(2, 'sess1');
            await db.saveSessionCache(makeCacheRow('sess1'), msgs);

            // Mutate the original array
            msgs.push({ id: 'extra', localId: null, createdAt: 9999, kind: 'user-text', text: 'x' });

            const stored = await db.getSessionMessages('sess1');
            expect(stored).toHaveLength(2);
        });

        it('handles empty message array', async () => {
            await db.saveSessionCache(makeCacheRow('sess1'), []);
            expect(await db.getSessionMessages('sess1')).toEqual([]);
            expect(await db.getSessionCache('sess1')).not.toBeNull();
        });

        it('preserves reducerStateJson exactly', async () => {
            const json = JSON.stringify({ schemaVersion: 1, foo: 'bar' });
            const row = { ...makeCacheRow('sess1'), reducerStateJson: json };
            await db.saveSessionCache(row, []);
            const stored = await db.getSessionCache('sess1');
            expect(stored?.reducerStateJson).toBe(json);
        });
    });

    describe('clearSessionCache', () => {
        it('removes session row and messages', async () => {
            await db.saveSessionCache(makeCacheRow('sess1'), makeMessages(3, 'sess1'));
            await db.clearSessionCache('sess1');
            expect(await db.getSessionCache('sess1')).toBeNull();
            expect(await db.getSessionMessages('sess1')).toEqual([]);
        });

        it('does not affect other sessions', async () => {
            await db.saveSessionCache(makeCacheRow('sess1'), makeMessages(3, 'sess1'));
            await db.saveSessionCache(makeCacheRow('sess2'), makeMessages(2, 'sess2'));
            await db.clearSessionCache('sess1');

            expect(await db.getSessionCache('sess2')).not.toBeNull();
            expect(await db.getSessionMessages('sess2')).toHaveLength(2);
        });

        it('is safe to call on a non-existent session', async () => {
            await expect(db.clearSessionCache('doesNotExist')).resolves.toBeUndefined();
        });
    });

    describe('clearAllCaches', () => {
        it('removes all sessions and messages', async () => {
            await db.saveSessionCache(makeCacheRow('sess1'), makeMessages(3, 'sess1'));
            await db.saveSessionCache(makeCacheRow('sess2'), makeMessages(2, 'sess2'));
            await db.clearAllCaches();

            expect(await db.getSessionCache('sess1')).toBeNull();
            expect(await db.getSessionCache('sess2')).toBeNull();
            expect(await db.getSessionMessages('sess1')).toEqual([]);
            expect(await db.getSessionMessages('sess2')).toEqual([]);
        });

        it('is safe to call when already empty', async () => {
            await expect(db.clearAllCaches()).resolves.toBeUndefined();
        });
    });

    describe('concurrent usage', () => {
        it('handles parallel save and get correctly', async () => {
            const rows = Array.from({ length: 5 }, (_, i) => ({
                row: makeCacheRow(`sess${i}`, i * 10),
                messages: makeMessages(i + 1, `sess${i}`),
            }));

            // Save all in parallel
            await Promise.all(rows.map(({ row, messages }) => db.saveSessionCache(row, messages)));

            // Read all in parallel
            const results = await Promise.all(
                rows.map(({ row }) => db.getSessionCache(row.sessionId))
            );

            results.forEach((result, i) => {
                expect(result?.lastSeq).toBe(i * 10);
            });
        });
    });
});
