import { describe, it, expect } from 'vitest';
import {
    serializeReducerState,
    deserializeReducerState,
    serializeReducerStateToJson,
    deserializeReducerStateFromJson,
    deserializeReducerStateOrCreate,
    serializeTracerState,
    deserializeTracerState,
    SERIALIZER_SCHEMA_VERSION,
    type PersistedReducerState,
} from './reducerStateSerializer';
import { createReducer, type ReducerState } from '../reducer/reducer';
import { createTracer, type TracerState } from '../reducer/reducerTracer';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFullReducerState(): ReducerState {
    const state = createReducer();

    state.toolIdToMessageId.set('tool1', 'msg1');
    state.toolIdToMessageId.set('tool2', 'msg2');
    state.sidechainToolIdToMessageId.set('stool1', 'smsg1');
    state.permissions.set('perm1', {
        tool: 'Bash',
        arguments: { command: 'ls' },
        createdAt: 1000,
        completedAt: 2000,
        status: 'approved',
        mode: 'auto',
    });
    state.localIds.set('local1', 'internal1');
    state.messageIds.set('real1', 'internal1');
    state.lastThinkingMessageId = 'think1';
    state.messages.set('internal1', {
        id: 'internal1',
        realID: 'real1',
        createdAt: 1500,
        role: 'agent',
        text: '*thinking...*',
        isThinking: true,
        event: null,
        tool: null,
    });
    state.sidechains.set('task1', [
        {
            id: 'sc_msg1',
            realID: 'real_sc1',
            createdAt: 1700,
            role: 'agent',
            text: 'sidechain text',
            event: null,
            tool: null,
        },
    ]);
    state.tracerState.taskTools.set('task_msg1', { messageId: 'task_msg1', prompt: 'do work' });
    state.tracerState.promptToTaskId.set('do work', 'task_msg1');
    state.tracerState.uuidToSidechainId.set('uuid-abc', 'task_msg1');
    state.tracerState.processedIds.add('real1');
    state.tracerState.processedIds.add('real_sc1');
    state.latestTodos = {
        todos: [{ id: 't1', content: 'Do thing', status: 'pending', priority: 'high' }],
        timestamp: 9999,
    };
    state.latestUsage = {
        inputTokens: 100,
        outputTokens: 200,
        cacheCreation: 10,
        cacheRead: 5,
        contextSize: 115,
        contextWindowTokens: 272000,
        timestamp: 9000,
    };

    return state;
}

// ---------------------------------------------------------------------------
// TracerState serialization
// ---------------------------------------------------------------------------

describe('serializeTracerState / deserializeTracerState', () => {
    it('round-trips an empty TracerState', () => {
        const state = createTracer();
        const persisted = serializeTracerState(state);
        const restored = deserializeTracerState(persisted);

        expect(restored.taskTools.size).toBe(0);
        expect(restored.promptToTaskId.size).toBe(0);
        expect(restored.uuidToSidechainId.size).toBe(0);
        expect(restored.toolCallToMessageId.size).toBe(0);
        expect(restored.orphanMessages.size).toBe(0);
        expect(restored.processedIds.size).toBe(0);
    });

    it('round-trips Maps and Sets', () => {
        const state: TracerState = {
            taskTools: new Map([['msg1', { messageId: 'msg1', prompt: 'p' }]]),
            promptToTaskId: new Map([['p', 'msg1']]),
            uuidToSidechainId: new Map([['u1', 'msg1']]),
            toolCallToMessageId: new Map([['tc1', 'msg2']]),
            orphanMessages: new Map([['parent', [
                { id: 'orp1', localId: null, createdAt: 1, role: 'user', isSidechain: false, content: { type: 'text', text: 'hi' } } as any
            ]]]),
            processedIds: new Set(['id1', 'id2']),
        };

        const persisted = serializeTracerState(state);
        const restored = deserializeTracerState(persisted);

        expect(restored.taskTools.get('msg1')).toEqual({ messageId: 'msg1', prompt: 'p' });
        expect(restored.promptToTaskId.get('p')).toBe('msg1');
        expect(restored.uuidToSidechainId.get('u1')).toBe('msg1');
        expect(restored.toolCallToMessageId.get('tc1')).toBe('msg2');
        expect(restored.orphanMessages.has('parent')).toBe(true);
        expect(restored.processedIds.has('id1')).toBe(true);
        expect(restored.processedIds.has('id2')).toBe(true);
        expect(restored.processedIds.has('id3')).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// ReducerState serialization
// ---------------------------------------------------------------------------

describe('serializeReducerState / deserializeReducerState', () => {
    it('round-trips an empty ReducerState', () => {
        const state = createReducer();
        const persisted = serializeReducerState(state);
        const restored = deserializeReducerState(persisted);

        expect(restored.toolIdToMessageId.size).toBe(0);
        expect(restored.sidechainToolIdToMessageId.size).toBe(0);
        expect(restored.permissions.size).toBe(0);
        expect(restored.localIds.size).toBe(0);
        expect(restored.messageIds.size).toBe(0);
        expect(restored.lastThinkingMessageId).toBeNull();
        expect(restored.messages.size).toBe(0);
        expect(restored.sidechains.size).toBe(0);
        expect(restored.latestTodos).toBeUndefined();
        expect(restored.latestUsage).toBeUndefined();
    });

    it('round-trips a fully populated ReducerState', () => {
        const state = makeFullReducerState();
        const persisted = serializeReducerState(state);
        const restored = deserializeReducerState(persisted);

        // Maps are restored as Maps
        expect(restored.toolIdToMessageId).toBeInstanceOf(Map);
        expect(restored.toolIdToMessageId.get('tool1')).toBe('msg1');
        expect(restored.toolIdToMessageId.get('tool2')).toBe('msg2');

        expect(restored.sidechainToolIdToMessageId.get('stool1')).toBe('smsg1');

        const perm = restored.permissions.get('perm1');
        expect(perm?.tool).toBe('Bash');
        expect(perm?.status).toBe('approved');
        expect(perm?.arguments).toEqual({ command: 'ls' });

        expect(restored.localIds.get('local1')).toBe('internal1');
        expect(restored.messageIds.get('real1')).toBe('internal1');
        expect(restored.lastThinkingMessageId).toBe('think1');

        const msg = restored.messages.get('internal1');
        expect(msg?.isThinking).toBe(true);
        expect(msg?.text).toBe('*thinking...*');

        const sidechain = restored.sidechains.get('task1');
        expect(sidechain).toHaveLength(1);
        expect(sidechain?.[0].text).toBe('sidechain text');

        expect(restored.tracerState.taskTools.get('task_msg1')).toEqual({ messageId: 'task_msg1', prompt: 'do work' });
        expect(restored.tracerState.processedIds.has('real1')).toBe(true);

        expect(restored.latestTodos?.todos[0].id).toBe('t1');
        expect(restored.latestUsage?.inputTokens).toBe(100);
        expect(restored.latestUsage?.contextWindowTokens).toBe(272000);
    });

    it('preserves tool call state in messages', () => {
        const state = createReducer();
        state.messages.set('m1', {
            id: 'm1',
            realID: 'r1',
            createdAt: 100,
            role: 'agent',
            text: null,
            event: null,
            tool: {
                name: 'Bash',
                state: 'running',
                input: { command: 'echo hi' },
                createdAt: 100,
                startedAt: 101,
                completedAt: null,
                description: null,
                result: undefined,
                permission: { id: 'p1', status: 'approved' },
            },
        });
        state.toolIdToMessageId.set('r1', 'm1');

        const restored = deserializeReducerState(serializeReducerState(state));
        const tool = restored.messages.get('m1')?.tool;
        expect(tool?.name).toBe('Bash');
        expect(tool?.state).toBe('running');
        expect(tool?.permission?.status).toBe('approved');
        expect(restored.toolIdToMessageId.get('r1')).toBe('m1');
    });
});

// ---------------------------------------------------------------------------
// JSON round-trip helpers
// ---------------------------------------------------------------------------

describe('serializeReducerStateToJson / deserializeReducerStateFromJson', () => {
    it('produces valid JSON and round-trips correctly', () => {
        const state = makeFullReducerState();
        const json = serializeReducerStateToJson(state);

        expect(typeof json).toBe('string');
        // Must be valid JSON
        expect(() => JSON.parse(json)).not.toThrow();

        const restored = deserializeReducerStateFromJson(json);
        expect(restored).not.toBeNull();
        expect(restored?.toolIdToMessageId.get('tool1')).toBe('msg1');
    });

    it('returns null for invalid JSON', () => {
        expect(deserializeReducerStateFromJson('not-json')).toBeNull();
        expect(deserializeReducerStateFromJson('{}')).toBeNull(); // missing schemaVersion
        expect(deserializeReducerStateFromJson('')).toBeNull();
    });

    it('returns null when schemaVersion does not match', () => {
        const state = makeFullReducerState();
        const persisted: PersistedReducerState = {
            ...serializeReducerState(state),
            schemaVersion: SERIALIZER_SCHEMA_VERSION + 99,
        };
        expect(deserializeReducerStateFromJson(JSON.stringify(persisted))).toBeNull();
    });

    it('returns correct schemaVersion in serialized output', () => {
        const json = serializeReducerStateToJson(createReducer());
        const parsed = JSON.parse(json) as PersistedReducerState;
        expect(parsed.schemaVersion).toBe(SERIALIZER_SCHEMA_VERSION);
    });
});

// ---------------------------------------------------------------------------
// deserializeReducerStateOrCreate
// ---------------------------------------------------------------------------

describe('deserializeReducerStateOrCreate', () => {
    it('returns a fresh state for null input', () => {
        const state = deserializeReducerStateOrCreate(null);
        expect(state.toolIdToMessageId.size).toBe(0);
    });

    it('returns a fresh state for undefined input', () => {
        const state = deserializeReducerStateOrCreate(undefined);
        expect(state.toolIdToMessageId.size).toBe(0);
    });

    it('returns a fresh state for malformed JSON', () => {
        const state = deserializeReducerStateOrCreate('{bad-json}');
        expect(state.toolIdToMessageId.size).toBe(0);
    });

    it('returns deserialized state for valid JSON', () => {
        const original = createReducer();
        original.lastThinkingMessageId = 'think99';
        const json = serializeReducerStateToJson(original);
        const restored = deserializeReducerStateOrCreate(json);
        expect(restored.lastThinkingMessageId).toBe('think99');
    });
});

// ---------------------------------------------------------------------------
// Idempotency: serialize → deserialize → serialize produces the same JSON
// ---------------------------------------------------------------------------

describe('idempotency', () => {
    it('double serialization produces identical output', () => {
        const state = makeFullReducerState();
        const json1 = serializeReducerStateToJson(state);
        const restored = deserializeReducerStateOrCreate(json1);
        const json2 = serializeReducerStateToJson(restored);

        // Parse both to normalize key ordering before comparing
        expect(JSON.parse(json2)).toEqual(JSON.parse(json1));
    });
});
