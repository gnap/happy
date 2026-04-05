import { createReducer, type ReducerState } from '../reducer/reducer';
import type { TracerState } from '../reducer/reducerTracer';

export const SERIALIZER_SCHEMA_VERSION = 1;

type SerializedMapEntry = [string, unknown];

type SerializedTracerState = {
    taskTools: SerializedMapEntry[];
    promptToTaskId: SerializedMapEntry[];
    uuidToSidechainId: SerializedMapEntry[];
    toolCallToMessageId: SerializedMapEntry[];
    orphanMessages: SerializedMapEntry[];
    processedIds: string[];
};

type SerializedReducerState = {
    toolIdToMessageId: SerializedMapEntry[];
    sidechainToolIdToMessageId: SerializedMapEntry[];
    permissions: SerializedMapEntry[];
    localIds: SerializedMapEntry[];
    messageIds: SerializedMapEntry[];
    messages: SerializedMapEntry[];
    sidechains: SerializedMapEntry[];
    tracerState: SerializedTracerState;
    latestTodos?: ReducerState['latestTodos'];
    latestUsage?: ReducerState['latestUsage'];
};

function serializeTracerState(tracerState: TracerState): SerializedTracerState {
    return {
        taskTools: Array.from(tracerState.taskTools.entries()),
        promptToTaskId: Array.from(tracerState.promptToTaskId.entries()),
        uuidToSidechainId: Array.from(tracerState.uuidToSidechainId.entries()),
        toolCallToMessageId: Array.from(tracerState.toolCallToMessageId.entries()),
        orphanMessages: Array.from(tracerState.orphanMessages.entries()),
        processedIds: Array.from(tracerState.processedIds.values()),
    };
}

function deserializeTracerState(serialized: SerializedTracerState | undefined): TracerState {
    const tracerState = createReducer().tracerState;
    if (!serialized) {
        return tracerState;
    }

    tracerState.taskTools = new Map(serialized.taskTools as [string, { messageId: string; prompt: string }][]);
    tracerState.promptToTaskId = new Map(serialized.promptToTaskId as [string, string][]);
    tracerState.uuidToSidechainId = new Map(serialized.uuidToSidechainId as [string, string][]);
    tracerState.toolCallToMessageId = new Map(serialized.toolCallToMessageId as [string, string][]);
    tracerState.orphanMessages = new Map(serialized.orphanMessages as [string, any[]][]);
    tracerState.processedIds = new Set(serialized.processedIds);
    return tracerState;
}

export function serializeReducerStateToJson(state: ReducerState): string {
    const payload: SerializedReducerState = {
        toolIdToMessageId: Array.from(state.toolIdToMessageId.entries()),
        sidechainToolIdToMessageId: Array.from(state.sidechainToolIdToMessageId.entries()),
        permissions: Array.from(state.permissions.entries()),
        localIds: Array.from(state.localIds.entries()),
        messageIds: Array.from(state.messageIds.entries()),
        messages: Array.from(state.messages.entries()),
        sidechains: Array.from(state.sidechains.entries()),
        tracerState: serializeTracerState(state.tracerState),
        latestTodos: state.latestTodos,
        latestUsage: state.latestUsage,
    };
    return JSON.stringify(payload);
}

export function deserializeReducerStateOrCreate(json: string | null | undefined): ReducerState {
    if (!json) {
        return createReducer();
    }

    try {
        const parsed = JSON.parse(json) as Partial<SerializedReducerState>;
        const state = createReducer();
        if (Array.isArray(parsed.toolIdToMessageId)) {
            state.toolIdToMessageId = new Map(parsed.toolIdToMessageId as [string, string][]);
        }
        if (Array.isArray(parsed.sidechainToolIdToMessageId)) {
            state.sidechainToolIdToMessageId = new Map(parsed.sidechainToolIdToMessageId as [string, string][]);
        }
        if (Array.isArray(parsed.permissions)) {
            state.permissions = new Map(parsed.permissions as [string, any][] ) as ReducerState['permissions'];
        }
        if (Array.isArray(parsed.localIds)) {
            state.localIds = new Map(parsed.localIds as [string, string][]);
        }
        if (Array.isArray(parsed.messageIds)) {
            state.messageIds = new Map(parsed.messageIds as [string, string][]);
        }
        if (Array.isArray(parsed.messages)) {
            state.messages = new Map(parsed.messages as [string, any][]);
        }
        if (Array.isArray(parsed.sidechains)) {
            state.sidechains = new Map(parsed.sidechains as [string, any[]][]);
        }
        state.tracerState = deserializeTracerState(parsed.tracerState as SerializedTracerState | undefined);
        if (parsed.latestTodos) {
            state.latestTodos = parsed.latestTodos;
        }
        if (parsed.latestUsage) {
            state.latestUsage = parsed.latestUsage;
        }
        return state;
    } catch {
        return createReducer();
    }
}
