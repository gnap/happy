import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    isCacheEnabled,
    loadMessageCache,
    saveMessageCache,
    clearMessageCache,
    clearAllMessageCaches,
} from './messageCache';
import { MemorySessionCacheDB, overrideSessionCacheDB, resetSessionCacheDB } from './sessionCacheDB';
import { createReducer } from '../reducer/reducer';
import { serializeReducerStateToJson, SERIALIZER_SCHEMA_VERSION } from './reducerStateSerializer';
import type { Session } from '../storageTypes';
import type { Message } from '../typesMessage';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Silence log output during tests
vi.mock('@/log', () => ({ log: { log: vi.fn() } }));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(flavor: string | null | undefined): Session {
    return {
        id: 'sess-123',
        seq: 1,
        createdAt: 1000,
        updatedAt: 2000,
        active: false,
        activeAt: 900,
        thinking: false,
        thinkingAt: 0,
        presence: 900,
        metadataVersion: 1,
        agentStateVersion: 1,
        agentState: null,
        metadata: flavor !== undefined ? {
            path: '/work',
            host: 'localhost',
            flavor,
        } : null,
    };
}

function makeMessages(count: number): Message[] {
    return Array.from({ length: count }, (_, i) => ({
        id: `m${i}`,
        localId: null,
        createdAt: 1000 + i,
        kind: 'user-text' as const,
        text: `Message ${i}`,
    }));
}

// ---------------------------------------------------------------------------
// isCacheEnabled
// ---------------------------------------------------------------------------

describe('isCacheEnabled', () => {
    it('returns true for cursor sessions', () => {
        expect(isCacheEnabled(makeSession('cursor'))).toBe(true);
    });

    it('returns false for claude sessions', () => {
        expect(isCacheEnabled(makeSession('claude'))).toBe(false);
    });

    it('returns false for codex sessions', () => {
        expect(isCacheEnabled(makeSession('codex'))).toBe(false);
    });

    it('returns false for gemini sessions', () => {
        expect(isCacheEnabled(makeSession('gemini'))).toBe(false);
    });

    it('returns false for sessions with no metadata', () => {
        expect(isCacheEnabled(makeSession(undefined))).toBe(false);
    });

    it('returns false for sessions with null flavor', () => {
        expect(isCacheEnabled(makeSession(null))).toBe(false);
    });

    it('returns false for null session', () => {
        expect(isCacheEnabled(null)).toBe(false);
    });

    it('returns false for undefined session', () => {
        expect(isCacheEnabled(undefined)).toBe(false);
    });

    it('is case-sensitive – "Cursor" is not treated as cursor', () => {
        expect(isCacheEnabled(makeSession('Cursor'))).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// loadMessageCache / saveMessageCache / clearMessageCache
// ---------------------------------------------------------------------------

describe('loadMessageCache', () => {
    let db: MemorySessionCacheDB;

    beforeEach(() => {
        db = new MemorySessionCacheDB();
        overrideSessionCacheDB(db);
    });

    afterEach(() => {
        resetSessionCacheDB();
    });

    it('returns null for non-cursor sessions', async () => {
        const session = makeSession('claude');
        const result = await loadMessageCache(session);
        expect(result).toBeNull();
    });

    it('returns null when there is no cache entry', async () => {
        const session = makeSession('cursor');
        const result = await loadMessageCache(session);
        expect(result).toBeNull();
    });

    it('returns cached messages, reducerState, and lastSeq', async () => {
        const session = makeSession('cursor');
        const messages = makeMessages(3);
        const reducerState = createReducer();
        reducerState.lastThinkingMessageId = 'think1';
        await saveMessageCache(session, messages, reducerState, 77);

        const result = await loadMessageCache(session);
        expect(result).not.toBeNull();
        expect(result!.lastSeq).toBe(77);
        expect(result!.messages).toHaveLength(3);
        expect(result!.reducerState.lastThinkingMessageId).toBe('think1');
    });

    it('clears and returns null when schemaVersion is mismatched', async () => {
        const session = makeSession('cursor');
        // Manually plant a row with wrong schemaVersion
        await db.saveSessionCache(
            {
                sessionId: session.id,
                lastSeq: 10,
                schemaVersion: SERIALIZER_SCHEMA_VERSION + 999,
                cachedAt: Date.now(),
                reducerStateJson: JSON.stringify({ schemaVersion: SERIALIZER_SCHEMA_VERSION + 999 }),
            },
            makeMessages(2),
        );

        const result = await loadMessageCache(session);
        expect(result).toBeNull();

        // The stale row should have been cleaned up
        expect(await db.getSessionCache(session.id)).toBeNull();
    });

    it('falls back to empty reducerState when reducerStateJson is invalid', async () => {
        const session = makeSession('cursor');
        await db.saveSessionCache(
            {
                sessionId: session.id,
                lastSeq: 5,
                schemaVersion: SERIALIZER_SCHEMA_VERSION,
                cachedAt: Date.now(),
                reducerStateJson: 'invalid-json!!!',
            },
            makeMessages(1),
        );

        const result = await loadMessageCache(session);
        expect(result).not.toBeNull();
        expect(result!.reducerState.toolIdToMessageId.size).toBe(0);
        expect(result!.lastSeq).toBe(5);
    });
});

describe('saveMessageCache', () => {
    let db: MemorySessionCacheDB;

    beforeEach(() => {
        db = new MemorySessionCacheDB();
        overrideSessionCacheDB(db);
    });

    afterEach(() => {
        resetSessionCacheDB();
    });

    it('is a no-op for non-cursor sessions', async () => {
        const session = makeSession('claude');
        await saveMessageCache(session, makeMessages(5), createReducer(), 10);
        expect(await db.getSessionCache(session.id)).toBeNull();
    });

    it('saves messages and reducerState for cursor sessions', async () => {
        const session = makeSession('cursor');
        const messages = makeMessages(4);
        await saveMessageCache(session, messages, createReducer(), 50);

        const row = await db.getSessionCache(session.id);
        expect(row?.lastSeq).toBe(50);
        expect(row?.schemaVersion).toBe(SERIALIZER_SCHEMA_VERSION);

        const stored = await db.getSessionMessages(session.id);
        expect(stored).toHaveLength(4);
    });

    it('overwrites previous cache on second call', async () => {
        const session = makeSession('cursor');
        await saveMessageCache(session, makeMessages(3), createReducer(), 10);
        await saveMessageCache(session, makeMessages(7), createReducer(), 20);

        const row = await db.getSessionCache(session.id);
        expect(row?.lastSeq).toBe(20);
        expect(await db.getSessionMessages(session.id)).toHaveLength(7);
    });
});

describe('clearMessageCache', () => {
    let db: MemorySessionCacheDB;

    beforeEach(() => {
        db = new MemorySessionCacheDB();
        overrideSessionCacheDB(db);
    });

    afterEach(() => {
        resetSessionCacheDB();
    });

    it('clears an existing cursor session cache', async () => {
        const session = makeSession('cursor');
        await saveMessageCache(session, makeMessages(5), createReducer(), 30);
        await clearMessageCache(session.id);
        expect(await db.getSessionCache(session.id)).toBeNull();
        expect(await db.getSessionMessages(session.id)).toEqual([]);
    });

    it('is safe to call when there is nothing to clear', async () => {
        await expect(clearMessageCache('nonexistent-session')).resolves.toBeUndefined();
    });

    it('only clears the targeted session', async () => {
        const sess1 = makeSession('cursor');
        const sess2 = { ...makeSession('cursor'), id: 'sess-456' };

        await saveMessageCache(sess1, makeMessages(3), createReducer(), 5);
        await saveMessageCache(sess2, makeMessages(2), createReducer(), 6);

        await clearMessageCache(sess1.id);

        expect(await db.getSessionCache(sess1.id)).toBeNull();
        expect(await db.getSessionCache(sess2.id)).not.toBeNull();
    });
});

describe('clearAllMessageCaches', () => {
    let db: MemorySessionCacheDB;

    beforeEach(() => {
        db = new MemorySessionCacheDB();
        overrideSessionCacheDB(db);
    });

    afterEach(() => {
        resetSessionCacheDB();
    });

    it('clears all cached sessions', async () => {
        for (let i = 0; i < 4; i++) {
            const s = { ...makeSession('cursor'), id: `sess-${i}` };
            await saveMessageCache(s, makeMessages(i + 1), createReducer(), i);
        }

        await clearAllMessageCaches();

        for (let i = 0; i < 4; i++) {
            expect(await db.getSessionCache(`sess-${i}`)).toBeNull();
        }
    });
});

// ---------------------------------------------------------------------------
// Load → save → load round-trip with live ReducerState
// ---------------------------------------------------------------------------

describe('load → save → load round-trip', () => {
    let db: MemorySessionCacheDB;

    beforeEach(() => {
        db = new MemorySessionCacheDB();
        overrideSessionCacheDB(db);
    });

    afterEach(() => {
        resetSessionCacheDB();
    });

    it('preserves ReducerState Maps across save/load', async () => {
        const session = makeSession('cursor');
        const reducerState = createReducer();
        reducerState.toolIdToMessageId.set('toolA', 'msgA');
        reducerState.lastThinkingMessageId = 'thinkX';
        reducerState.tracerState.processedIds.add('processed1');

        await saveMessageCache(session, makeMessages(2), reducerState, 99);
        const loaded = await loadMessageCache(session);

        expect(loaded?.reducerState.toolIdToMessageId.get('toolA')).toBe('msgA');
        expect(loaded?.reducerState.lastThinkingMessageId).toBe('thinkX');
        expect(loaded?.reducerState.tracerState.processedIds.has('processed1')).toBe(true);
        expect(loaded?.lastSeq).toBe(99);
        expect(loaded?.messages).toHaveLength(2);
    });

    it('preserves running tool call state for cross-request continuity', async () => {
        const session = makeSession('cursor');
        const reducerState = createReducer();
        reducerState.messages.set('m1', {
            id: 'm1',
            realID: 'r1',
            createdAt: 500,
            role: 'agent',
            text: null,
            event: null,
            tool: {
                name: 'Bash',
                state: 'running',
                input: { command: 'sleep 5' },
                createdAt: 500,
                startedAt: 501,
                completedAt: null,
                description: null,
                result: undefined,
            },
        });
        reducerState.toolIdToMessageId.set('r1', 'm1');

        await saveMessageCache(session, [], reducerState, 10);
        const loaded = await loadMessageCache(session);

        const tool = loaded?.reducerState.messages.get('m1')?.tool;
        expect(tool?.state).toBe('running');
        expect(tool?.name).toBe('Bash');
        expect(loaded?.reducerState.toolIdToMessageId.get('r1')).toBe('m1');
    });
});
