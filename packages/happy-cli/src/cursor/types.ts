/**
 * Type definitions for Cursor Agent CLI integration
 *
 * Cursor Agent outputs stream-json messages via --output-format stream-json.
 * These types represent the raw message shapes emitted by cursor-agent.
 */

/** Thinking delta message (reasoning/thinking content) */
export interface CursorThinkingMessage {
    type: 'thinking';
    subtype: 'delta' | 'complete';
    text: string;
}

/** Assistant message with content blocks */
export interface CursorAssistantMessage {
    type: 'assistant';
    model_call_id?: string;
    message: {
        role: 'assistant';
        content: Array<{
            type: string;
            text?: string;
            id?: string;
            name?: string;
            input?: unknown;
        }>;
    };
}

/** Tool call message (started, completed, or other e.g. cancelled/failed so we send tool_call_end) */
export interface CursorToolCallMessage {
    type: 'tool_call';
    subtype: 'completed' | 'started' | string;
    description?: string;
    tool_call: {
        shellToolCall?: {
            args?: { command?: string };
            result?: {
                success?: {
                    stdout?: string;
                    stderr?: string;
                    exitCode?: number;
                };
                failure?: {
                    stderr?: string;
                    exitCode?: number;
                };
            };
        };
        readToolCall?: {
            args?: { path?: string };
            result?: unknown;
        };
        writeToolCall?: {
            args?: { path?: string; content?: string };
            result?: unknown;
        };
        editToolCall?: {
            args?: Record<string, unknown>;
            result?: unknown;
        };
    };
}

/** Result message (final output of a turn) */
export interface CursorResultMessage {
    type: 'result';
    subtype?: 'success' | 'error_max_turns' | 'error_during_execution';
    result?: string;
    session_id?: string;
    is_error?: boolean;
    usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
    };
    total_cost_usd?: number;
    duration_ms?: number;
}

/** System/init message */
export interface CursorSystemMessage {
    type: 'system';
    subtype: string;
    session_id?: string;
    model?: string;
}

/** Some cursor-agent streams emit a startup user placeholder event. */
export interface CursorUserMessage {
    type: 'user';
}

/** Union of all cursor-agent stream-json message types */
export type CursorStreamMessage =
    | CursorThinkingMessage
    | CursorAssistantMessage
    | CursorToolCallMessage
    | CursorResultMessage
    | CursorSystemMessage
    | CursorUserMessage;

/** Mode configuration for cursor sessions */
export interface CursorMode {
    permissionMode: import('@/api/types').PermissionMode;
    model?: string;
}
