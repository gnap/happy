/**
 * Re-exports @anthropic-ai/claude-agent-sdk's query() + our own type definitions.
 * Previously this directory contained a spawn-based query() wrapper (~1,100 lines),
 * now replaced by the official Agent SDK.
 */
export { query, AbortError } from '@anthropic-ai/claude-agent-sdk';

// Keep our own type definitions for backward compatibility.
export type {
    QueryOptions,
    QueryPrompt,
    SDKMessage,
    SDKUserMessage,
    SDKAssistantMessage,
    SDKSystemMessage,
    SDKResultMessage,
    SDKControlResponse,
    ControlRequest,
    InterruptRequest,
    SDKControlRequest,
    CanCallToolCallback,
    PermissionResult,
} from './types';
