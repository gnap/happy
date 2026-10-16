/**
 * ReducerState Serializer
 *
 * Handles serialization and deserialization of ReducerState for SQLite persistence.
 * The ReducerState uses Map and Set objects which are not JSON-serializable, so we
 * convert them to arrays of [key, value] pairs or plain arrays.
 *
 * This is critical for incremental message merging: a deserialized ReducerState
 * preserves cross-request continuity for stateful messages (thinking streams,
 * running tool calls, task sidechains).
 */

import { ReducerState, createReducer } from '../reducer/reducer';
import { TracerState, createTracer } from '../reducer/reducerTracer';
import type { NormalizedMessage } from '../typesRaw';
import type { ToolCall } from '../typesMessage';
import type { MessageMeta } from '../typesMessageMeta';
import type { AgentEvent } from '../typesRaw';

// ---------------------------------------------------------------------------
// Serializable versions of internal types (Maps → [k,v][] arrays)
// ---------------------------------------------------------------------------

export interface PersistedReducerMessage {
    id: string;
    realID: string | null;
    localId?: string | null;
    createdAt: number;
    role: 'user' | 'agent';
    text: string | null;
    isThinking?: boolean;
    event: AgentEvent | null;
    tool: ToolCall | null;
    meta?: MessageMeta;
}

interface PersistedStoredPermission {
    tool: string;
    arguments: unknown;
    createdAt: number;
    completedAt?: number;
    status: 'pending' | 'approved' | 'denied' | 'canceled';
    reason?: string;
    mode?: string;
    allowedTools?: string[];
    decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort';
}

export interface PersistedTracerState {
    taskTools: [string, { messageId: string; prompt: string }][];
    promptToTaskId: [string, string][];
    uuidToSidechainId: [string, string][];
    toolCallToMessageId: [string, string][];
    orphanMessages: [string, NormalizedMessage[]][];
    processedIds: string[];
}

export interface PersistedReducerState {
    schemaVersion: number;
    toolIdToMessageId: [string, string][];
    sidechainToolIdToMessageId: [string, string][];
    permissions: [string, PersistedStoredPermission][];
    localIds: [string, string][];
    messageIds: [string, string][];
    lastThinkingMessageId: string | null;
    messages: [string, PersistedReducerMessage][];
    sidechains: [string, PersistedReducerMessage[]][];
    tracerState: PersistedTracerState;
    latestTodos?: {
        todos: Array<{
            content: string;
            status: 'pending' | 'in_progress' | 'completed';
            priority: 'high' | 'medium' | 'low';
            id: string;
        }>;
        timestamp: number;
    };
    latestTasks?: {
        tasks: Array<{
            id: string;
            content: string;
            status: 'pending' | 'in_progress' | 'completed';
        }>;
        timestamp: number;
    };
    latestUsage?: {
        inputTokens: number;
        outputTokens: number;
        cacheCreation: number;
        cacheRead: number;
        contextSize: number;
        contextWindowTokens?: number;
        timestamp: number;
    };
}

export const SERIALIZER_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

export function serializeTracerState(state: TracerState): PersistedTracerState {
    return {
        taskTools: Array.from(state.taskTools.entries()),
        promptToTaskId: Array.from(state.promptToTaskId.entries()),
        uuidToSidechainId: Array.from(state.uuidToSidechainId.entries()),
        toolCallToMessageId: Array.from(state.toolCallToMessageId.entries()),
        orphanMessages: Array.from(state.orphanMessages.entries()),
        processedIds: Array.from(state.processedIds),
    };
}

export function serializeReducerState(state: ReducerState): PersistedReducerState {
    return {
        schemaVersion: SERIALIZER_SCHEMA_VERSION,
        toolIdToMessageId: Array.from(state.toolIdToMessageId.entries()),
        sidechainToolIdToMessageId: Array.from(state.sidechainToolIdToMessageId.entries()),
        permissions: Array.from(state.permissions.entries()),
        localIds: Array.from(state.localIds.entries()),
        messageIds: Array.from(state.messageIds.entries()),
        lastThinkingMessageId: state.lastThinkingMessageId,
        messages: Array.from(state.messages.entries()),
        sidechains: Array.from(state.sidechains.entries()),
        tracerState: serializeTracerState(state.tracerState),
        latestTodos: state.latestTodos,
        latestTasks: state.latestTasks,
        latestUsage: state.latestUsage,
    };
}

/**
 * The state that belongs to the messages a load would actually hand back.
 *
 * What is persisted is read on every open, as one string across the bridge — and it grew with the
 * session rather than with the window: three megabytes for a session whose window is sixty messages,
 * measured at 1.8s of the 1.9s an open cost. The entries for messages outside that window cannot be
 * used by anything that reads this back, because they describe messages that will not be there.
 *
 * So it is trimmed by message id, which is what these maps are keyed or valued on. The maps whose
 * keys mean something else (`permissions`, `sidechains`, `taskTools`) are small and are kept whole.
 */
export function trimReducerState(state: ReducerState, keepIds: Set<string>): ReducerState {
    const byValue = <K>(entries: Iterable<[K, string]>) => new Map([...entries].filter(([, messageId]) => keepIds.has(messageId)));
    const byKey = <V>(entries: Iterable<[string, V]>) => new Map([...entries].filter(([id]) => keepIds.has(id)));
    return {
        ...state,
        messages: byKey(state.messages),
        messageIds: byKey(state.messageIds),
        localIds: byKey(state.localIds),
        toolIdToMessageId: byValue(state.toolIdToMessageId),
        sidechainToolIdToMessageId: byValue(state.sidechainToolIdToMessageId),
        tracerState: {
            ...state.tracerState,
            toolCallToMessageId: byValue(state.tracerState.toolCallToMessageId),
            orphanMessages: byKey(state.tracerState.orphanMessages),
            processedIds: new Set([...state.tracerState.processedIds].filter((id) => keepIds.has(id))),
        },
    };
}

export function serializeReducerStateToJson(state: ReducerState): string {
    return JSON.stringify(serializeReducerState(state));
}

// ---------------------------------------------------------------------------
// Deserialization
// ---------------------------------------------------------------------------

export function deserializeTracerState(persisted: PersistedTracerState): TracerState {
    return {
        taskTools: new Map(persisted.taskTools),
        promptToTaskId: new Map(persisted.promptToTaskId),
        uuidToSidechainId: new Map(persisted.uuidToSidechainId),
        toolCallToMessageId: new Map(persisted.toolCallToMessageId),
        orphanMessages: new Map(persisted.orphanMessages),
        processedIds: new Set(persisted.processedIds),
    };
}

export function deserializeReducerState(persisted: PersistedReducerState): ReducerState {
    return {
        toolIdToMessageId: new Map(persisted.toolIdToMessageId),
        sidechainToolIdToMessageId: new Map(persisted.sidechainToolIdToMessageId),
        sidechainBufferedResults: new Map(), // transient — never persisted
        bufferedResults: new Map(), // transient — never persisted
        permissions: new Map(persisted.permissions),
        localIds: new Map(persisted.localIds),
        messageIds: new Map(persisted.messageIds),
        lastThinkingMessageId: persisted.lastThinkingMessageId,
        lastAgentTextMessageId: null, // always reset on restore — streaming state is transient
        messages: new Map(persisted.messages),
        sidechains: new Map(persisted.sidechains),
        tracerState: deserializeTracerState(persisted.tracerState),
        latestTodos: persisted.latestTodos,
        latestTasks: persisted.latestTasks,
        latestUsage: persisted.latestUsage,
    };
}

/**
 * Attempt to deserialize from JSON string. Returns null on any parse/schema error
 * so callers can fall back to a fresh reducer state.
 */
export function deserializeReducerStateFromJson(json: string): ReducerState | null {
    try {
        const raw = JSON.parse(json) as PersistedReducerState;
        if (raw.schemaVersion !== SERIALIZER_SCHEMA_VERSION) {
            return null;
        }
        return deserializeReducerState(raw);
    } catch {
        return null;
    }
}

/**
 * Convenience: deserialize or return a fresh reducer state (never throws).
 */
export function deserializeReducerStateOrCreate(json: string | null | undefined): ReducerState {
    if (!json) return createReducer();
    return deserializeReducerStateFromJson(json) ?? createReducer();
}
