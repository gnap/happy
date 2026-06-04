import * as z from 'zod';
import { isCuid } from '@paralleldrive/cuid2';
import { MessageMetaSchema, MessageMeta } from './typesMessageMeta';

//
// Raw types
//

// Usage data type from Claude API
const usageDataSchema = z.object({
    input_tokens: z.number(),
    cache_creation_input_tokens: z.number().optional(),
    cache_read_input_tokens: z.number().optional(),
    output_tokens: z.number(),
    service_tier: z.string().optional(),
    // Pre-computed context window size (may be provided by CLI for Cursor sessions
    // where input_tokens alone does not represent the full context window).
    contextSize: z.number().optional(),
    // Max context window from cursor-agent init model name (turn-end denominator).
    context_window_tokens: z.number().optional(),
});

export type UsageData = z.infer<typeof usageDataSchema>;

let _sessionProtocolSendEnabledLogged = false;

function isSessionProtocolSendEnabled(): boolean {
    const raw = (
        process.env.EXPO_PUBLIC_ENABLE_SESSION_PROTOCOL_SEND
        ?? process.env.ENABLE_SESSION_PROTOCOL_SEND
        ?? ''
    ).toLowerCase();
    const fromEnv = raw === '1' || raw === 'true' || raw === 'yes';
    if (fromEnv) {
        if (!_sessionProtocolSendEnabledLogged) {
            _sessionProtocolSendEnabledLogged = true;
            console.log('[session protocol] enableSessionProtocolSend=true (env)');
        }
        return true;
    }
    try {
        const Constants = require('expo-constants').default;
        const fromExtra = Constants.expoConfig?.extra?.enableSessionProtocolSend === true;
        if (!_sessionProtocolSendEnabledLogged) {
            _sessionProtocolSendEnabledLogged = true;
            console.log('[session protocol] enableSessionProtocolSend=', fromExtra, '(expoConfig.extra)');
        }
        return fromExtra;
    } catch (e) {
        if (!_sessionProtocolSendEnabledLogged) {
            _sessionProtocolSendEnabledLogged = true;
            console.warn('[session protocol] enableSessionProtocolSend=false (expo-constants failed)');
        }
        return false;
    }
}

const agentEventSchema = z.discriminatedUnion('type', [z.object({
    type: z.literal('switch'),
    mode: z.enum(['local', 'remote'])
}), z.object({
    type: z.literal('message'),
    message: z.string(),
}), z.object({
    type: z.literal('limit-reached'),
    endsAt: z.number(),
}), z.object({
    type: z.literal('ready'),
})]);
export type AgentEvent = z.infer<typeof agentEventSchema>;

const sessionTextEventSchema = z.object({
    t: z.literal('text'),
    text: z.string(),
    thinking: z.boolean().optional(),
});

const sessionServiceMessageEventSchema = z.object({
    t: z.literal('service'),
    text: z.string(),
});

const sessionToolCallStartEventSchema = z.object({
    t: z.literal('tool-call-start'),
    call: z.string(),
    name: z.string(),
    title: z.string(),
    description: z.string(),
    args: z.record(z.string(), z.unknown()),
});

const sessionToolCallEndEventSchema = z.object({
    t: z.literal('tool-call-end'),
    call: z.string(),
    result: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
});

const sessionFileEventSchema = z.object({
    t: z.literal('file'),
    ref: z.string(),
    name: z.string(),
    size: z.number(),
    image: z.object({
        width: z.number(),
        height: z.number(),
        thumbhash: z.string(),
    }).optional(),
});

const sessionTurnStartEventSchema = z.object({
    t: z.literal('turn-start'),
});

const sessionStartEventSchema = z.object({
    t: z.literal('start'),
    title: z.string().optional(),
});

const sessionTurnEndEventSchema = z.object({
    t: z.literal('turn-end'),
    status: z.enum(['completed', 'failed', 'cancelled']),
    // Usage fields from Cursor/Claude may use either snake_case or camelCase; all optional to be lenient
    usage: z.object({
        input_tokens: z.number().optional(),
        inputTokens: z.number().optional(),
        output_tokens: z.number().optional(),
        outputTokens: z.number().optional(),
        cache_creation_input_tokens: z.number().optional(),
        cacheCreationInputTokens: z.number().optional(),
        cache_read_input_tokens: z.number().optional(),
        cacheReadInputTokens: z.number().optional(),
        // Pre-computed by CLI; numerator (used context size)
        contextSize: z.number().optional(),
        context_size: z.number().optional(),
        // Max context window parsed from init model display name (denominator)
        context_window_tokens: z.number().optional(),
        contextWindowTokens: z.number().optional(),
    }).optional(),
});

const sessionStopEventSchema = z.object({
    t: z.literal('stop'),
});

const sessionEventSchema = z.discriminatedUnion('t', [
    sessionTextEventSchema,
    sessionServiceMessageEventSchema,
    sessionToolCallStartEventSchema,
    sessionToolCallEndEventSchema,
    sessionFileEventSchema,
    sessionTurnStartEventSchema,
    sessionStartEventSchema,
    sessionTurnEndEventSchema,
    sessionStopEventSchema,
]);

const sessionEnvelopeSchema = z.object({
    id: z.string(),
    time: z.number(),
    role: z.enum(['user', 'agent']),
    turn: z.string().optional(),
    subagent: z.string().refine((value) => isCuid(value), {
        message: 'subagent must be a cuid2 value',
    }).optional(),
    taskCall: z.string().optional(),
    ev: sessionEventSchema,
}).superRefine((envelope, ctx) => {
    if (envelope.ev.t === 'service' && envelope.role !== 'agent') {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'service events must use role "agent"',
            path: ['role'],
        });
    }
    if ((envelope.ev.t === 'start' || envelope.ev.t === 'stop') && envelope.role !== 'agent') {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${envelope.ev.t} events must use role "agent"`,
            path: ['role'],
        });
    }
});
type SessionEnvelope = z.infer<typeof sessionEnvelopeSchema>;

const rawTextContentSchema = z.object({
    type: z.literal('text'),
    text: z.string(),
}).passthrough();  // ROBUST: Accept unknown fields for future API compatibility
export type RawTextContent = z.infer<typeof rawTextContentSchema>;

const rawToolUseContentSchema = z.object({
    type: z.literal('tool_use'),
    id: z.string(),
    name: z.string(),
    input: z.any(),
}).passthrough();  // ROBUST: Accept unknown fields preserved by transform
export type RawToolUseContent = z.infer<typeof rawToolUseContentSchema>;

const rawToolResultContentSchema = z.object({
    type: z.literal('tool_result'),
    tool_use_id: z.string(),
    content: z.union([z.array(z.object({ type: z.literal('text'), text: z.string() })), z.string()]),
    is_error: z.boolean().optional(),
    permissions: z.object({
        date: z.number(),
        result: z.enum(['approved', 'denied']),
        mode: z.enum(['default', 'acceptEdits', 'bypassPermissions', 'plan', 'read-only', 'safe-yolo', 'yolo']).optional(),
        allowedTools: z.array(z.string()).optional(),
        decision: z.enum(['approved', 'approved_for_session', 'denied', 'abort']).optional(),
    }).optional(),
}).passthrough();  // ROBUST: Accept unknown fields for future API compatibility
export type RawToolResultContent = z.infer<typeof rawToolResultContentSchema>;

/**
 * Extended thinking content from Claude API
 * Contains model's reasoning process before generating the final response
 * Uses .passthrough() to preserve signature and other unknown fields
 */
const rawThinkingContentSchema = z.object({
    type: z.literal('thinking'),
    thinking: z.string(),
}).passthrough();  // ROBUST: Accept signature and future fields
export type RawThinkingContent = z.infer<typeof rawThinkingContentSchema>;

// ============================================================================
// WOLOG: Type-Safe Content Normalization via Zod Transform
// ============================================================================
// Accepts both hyphenated (Codex/Gemini) and underscore (Claude) formats
// Transforms all to canonical underscore format during validation
// Full type safety - no `unknown` types
// Source: Part D of the Expo Mobile Testing & Package Manager Agnostic System plan
// ============================================================================

/**
 * Hyphenated tool-call format from Codex/Gemini agents
 * Transforms to canonical tool_use format during validation
 * Uses .passthrough() to preserve unknown fields for future API compatibility
 */
const rawHyphenatedToolCallSchema = z.object({
    type: z.literal('tool-call'),
    callId: z.string(),
    id: z.string().optional(), // Some messages have both
    name: z.string(),
    input: z.any(),
}).passthrough();  // ROBUST: Accept and preserve unknown fields
type RawHyphenatedToolCall = z.infer<typeof rawHyphenatedToolCallSchema>;

/**
 * Hyphenated tool-call-result format from Codex/Gemini agents
 * Transforms to canonical tool_result format during validation
 * Uses .passthrough() to preserve unknown fields for future API compatibility
 */
const rawHyphenatedToolResultSchema = z.object({
    type: z.literal('tool-call-result'),
    callId: z.string(),
    tool_use_id: z.string().optional(), // Some messages have both
    output: z.any(),
    content: z.any().optional(), // Some messages have both
    is_error: z.boolean().optional(),
}).passthrough();  // ROBUST: Accept and preserve unknown fields
type RawHyphenatedToolResult = z.infer<typeof rawHyphenatedToolResultSchema>;

/**
 * Input schema accepting ALL formats (both hyphenated and canonical)
 * Including Claude's extended thinking content type
 */
const rawAgentContentInputSchema = z.discriminatedUnion('type', [
    rawTextContentSchema,           // type: 'text' (canonical)
    rawToolUseContentSchema,        // type: 'tool_use' (canonical)
    rawToolResultContentSchema,     // type: 'tool_result' (canonical)
    rawThinkingContentSchema,       // type: 'thinking' (canonical)
    rawHyphenatedToolCallSchema,    // type: 'tool-call' (hyphenated)
    rawHyphenatedToolResultSchema,  // type: 'tool-call-result' (hyphenated)
]);
type RawAgentContentInput = z.infer<typeof rawAgentContentInputSchema>;

/**
 * Type-safe transform: Hyphenated tool-call → Canonical tool_use
 * ROBUST: Unknown fields preserved via object spread and .passthrough()
 */
function normalizeToToolUse(input: RawHyphenatedToolCall) {
    // Spread preserves all fields from input (passthrough fields included)
    return {
        ...input,
        type: 'tool_use' as const,
        id: input.callId,  // Codex uses callId, canonical uses id
    };
}

/**
 * Type-safe transform: Hyphenated tool-call-result → Canonical tool_result
 * ROBUST: Unknown fields preserved via object spread and .passthrough()
 */
function normalizeToToolResult(input: RawHyphenatedToolResult) {
    // Spread preserves all fields from input (passthrough fields included)
    return {
        ...input,
        type: 'tool_result' as const,
        tool_use_id: input.callId,  // Codex uses callId, canonical uses tool_use_id
        content: input.output ?? input.content ?? '',  // Codex uses output, canonical uses content
        is_error: input.is_error ?? false,
    };
}

/**
 * Schema that accepts both hyphenated and canonical formats.
 * Normalization happens via .preprocess() at root level to avoid Zod v4 "unmergable intersection" issue.
 * See: https://github.com/colinhacks/zod/discussions/2100
 *
 * Accepts: 'text' | 'tool_use' | 'tool_result' | 'thinking' | 'tool-call' | 'tool-call-result'
 * All types validated by their respective schemas with .passthrough() for unknown fields
 */
const rawAgentContentSchema = z.union([
    rawTextContentSchema,
    rawToolUseContentSchema,
    rawToolResultContentSchema,
    rawThinkingContentSchema,
    rawHyphenatedToolCallSchema,
    rawHyphenatedToolResultSchema,
]);
export type RawAgentContent = z.infer<typeof rawAgentContentSchema>;

const codexCursorDataSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('reasoning'), message: z.string() }),
    z.object({ type: z.literal('message'), message: z.string() }),
    z.object({ type: z.literal('thinking'), text: z.string() }),
    z.object({ type: z.literal('task_started'), id: z.string() }),
    z.object({ type: z.literal('task_complete'), id: z.string() }),
    z.object({ type: z.literal('turn_aborted'), id: z.string() }),
    z.object({
        type: z.literal('tool-call'),
        callId: z.string(),
        input: z.any(),
        name: z.string(),
        id: z.string()
    }),
    z.object({
        type: z.literal('tool-call-result'),
        callId: z.string(),
        output: z.any(),
        id: z.string(),
        is_error: z.boolean().optional()
    })
]);

const rawAgentRecordSchema = z.discriminatedUnion('type', [z.object({
    type: z.literal('output'),
    data: z.intersection(z.discriminatedUnion('type', [
        z.object({ type: z.literal('system') }),
        z.object({ type: z.literal('result') }),
        z.object({ type: z.literal('summary'), summary: z.string() }),
        z.object({ type: z.literal('assistant'), message: z.object({ role: z.literal('assistant'), model: z.string(), content: z.array(rawAgentContentSchema), usage: usageDataSchema.optional() }), parent_tool_use_id: z.string().nullable().optional() }),
        z.object({ type: z.literal('user'), message: z.object({ role: z.literal('user'), content: z.union([z.string(), z.array(rawAgentContentSchema)]) }), parent_tool_use_id: z.string().nullable().optional(), toolUseResult: z.any().nullable().optional() }),
    ]), z.object({
        isSidechain: z.boolean().nullish(),
        isCompactSummary: z.boolean().nullish(),
        isMeta: z.boolean().nullish(),
        uuid: z.string().nullish(),
        parentUuid: z.string().nullish(),
    }).passthrough()),  // ROBUST: Accept CLI metadata fields (userType, cwd, sessionId, version, gitBranch, slug, requestId, timestamp)
}), z.object({
    type: z.literal('event'),
    id: z.string(),
    data: agentEventSchema
}), z.object({
    type: z.literal('codex'),
    data: codexCursorDataSchema,
}), z.object({
    type: z.literal('cursor'),
    data: codexCursorDataSchema,
}), z.object({
    type: z.literal('session'),
    data: sessionEnvelopeSchema
}), z.object({
    // ACP (Agent Communication Protocol) - unified format for all agent providers
    type: z.literal('acp'),
    provider: z.enum(['gemini', 'codex', 'claude', 'opencode']),
    data: z.discriminatedUnion('type', [
        // Core message types
        z.object({ type: z.literal('reasoning'), message: z.string() }),
        z.object({ type: z.literal('message'), message: z.string() }),
        z.object({ type: z.literal('thinking'), text: z.string() }),
        // Tool interactions
        z.object({
            type: z.literal('tool-call'),
            callId: z.string(),
            input: z.any(),
            name: z.string(),
            id: z.string()
        }),
        z.object({
            type: z.literal('tool-result'),
            callId: z.string(),
            output: z.any(),
            id: z.string(),
            isError: z.boolean().optional()
        }),
        // Hyphenated tool-call-result (for backwards compatibility with CLI)
        z.object({
            type: z.literal('tool-call-result'),
            callId: z.string(),
            output: z.any(),
            id: z.string(),
            is_error: z.boolean().optional()
        }),
        // File operations
        z.object({
            type: z.literal('file-edit'),
            description: z.string(),
            filePath: z.string(),
            diff: z.string().optional(),
            oldContent: z.string().optional(),
            newContent: z.string().optional(),
            id: z.string()
        }),
        // Terminal/command output
        z.object({
            type: z.literal('terminal-output'),
            data: z.string(),
            callId: z.string()
        }),
        // Task lifecycle events
        z.object({ type: z.literal('task_started'), id: z.string() }),
        z.object({ type: z.literal('task_complete'), id: z.string() }),
        z.object({ type: z.literal('turn_aborted'), id: z.string() }),
        // Permissions
        z.object({
            type: z.literal('permission-request'),
            permissionId: z.string(),
            toolName: z.string(),
            description: z.string(),
            options: z.any().optional()
        }),
        // Usage/metrics
        z.object({ type: z.literal('token_count') }).passthrough()
    ])
})]);

/**
 * Preprocessor: Normalizes hyphenated content types to canonical before validation
 * This avoids Zod v4's "unmergable intersection" issue with transforms inside complex schemas
 * See: https://github.com/colinhacks/zod/discussions/2100
 */
function preprocessMessageContent(data: any): any {
    if (!data || typeof data !== 'object') return data;

    // Helper: normalize a single content item
    const normalizeContent = (item: any): any => {
        if (!item || typeof item !== 'object') return item;

        if (item.type === 'tool-call') {
            return normalizeToToolUse(item);
        }
        if (item.type === 'tool-call-result') {
            return normalizeToToolResult(item);
        }
        return item;
    };

    // Normalize assistant message content
    if (data.role === 'agent' && data.content?.type === 'output' && data.content?.data?.message?.content) {
        if (Array.isArray(data.content.data.message.content)) {
            data.content.data.message.content = data.content.data.message.content.map(normalizeContent);
        }
    }

    // Normalize user message content
    if (data.role === 'agent' && data.content?.type === 'output' && data.content?.data?.type === 'user' && Array.isArray(data.content.data.message?.content)) {
        data.content.data.message.content = data.content.data.message.content.map(normalizeContent);
    }

    // Accept new session wrapper shape and normalize to canonical wrapped shape.
    // New shape:
    // { role: 'session', content: { id, role, turn?, subagent?, ev }, meta? }
    if (data.role === 'session' && data.content && typeof data.content === 'object') {
        const content = data.content as Record<string, unknown>;
        const looksLikeEnvelope = content.type !== 'session'
            && typeof content.id === 'string'
            && typeof content.role === 'string'
            && content.ev !== undefined;
        if (looksLikeEnvelope) {
            data.content = {
                type: 'session',
                data: content,
            };
        }
    }

    return data;
}

const rawRecordSchema = z.preprocess(
    preprocessMessageContent,
    z.discriminatedUnion('role', [
        z.object({
            role: z.literal('agent'),
            content: rawAgentRecordSchema,
            meta: MessageMetaSchema.optional()
        }),
        z.object({
            role: z.literal('user'),
            content: z.object({
                type: z.literal('text'),
                text: z.string()
            }),
            meta: MessageMetaSchema.optional()
        }),
        z.object({
            role: z.literal('session'),
            content: z.object({
                type: z.literal('session'),
                data: sessionEnvelopeSchema
            }),
            meta: MessageMetaSchema.optional()
        })
    ])
);

export type RawRecord = z.infer<typeof rawRecordSchema>;

// Export schemas for validation
export const RawRecordSchema = rawRecordSchema;


//
// Normalized types
//

type NormalizedAgentContent =
    {
        type: 'text';
        text: string;
        uuid: string;
        parentUUID: string | null;
    } | {
        type: 'thinking';
        thinking: string;
        uuid: string;
        parentUUID: string | null;
    } | {
        type: 'tool-call';
        id: string;
        name: string;
        input: any;
        /** Human-readable one-line display title (from envelope.ev.title). */
        title?: string | null;
        description: string | null;
        uuid: string;
        parentUUID: string | null;
        /** True when the CLI truncated large content fields and full content must be fetched via RPC. */
        lazyContent?: boolean;
    } | {
        type: 'tool-result'
        tool_use_id: string;
        content: any;
        is_error: boolean;
        uuid: string;
        parentUUID: string | null;
        permissions?: {
            date: number;
            result: 'approved' | 'denied';
            mode?: string;
            allowedTools?: string[];
            decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort';
        };
    } | {
        type: 'summary',
        summary: string;
    } | {
        type: 'sidechain'
        uuid: string;
        prompt: string
    };

export type NormalizedMessage = ({
    role: 'user'
    content: {
        type: 'text';
        text: string;
    }
} | {
    role: 'agent'
    content: NormalizedAgentContent[]
} | {
    role: 'event'
    content: AgentEvent
}) & {
    id: string,
    localId: string | null,
    createdAt: number,
    isSidechain: boolean,
    meta?: MessageMeta,
    usage?: UsageData,
};

function normalizeSessionEnvelope(
    envelope: SessionEnvelope,
    localId: string | null,
    createdAt: number,
    meta: MessageMeta | undefined,
): NormalizedMessage | null {
    // Session protocol requires turn id on all agent-originated envelopes.
    // Drop malformed agent events without turn to avoid attaching stray messages.
    if (envelope.role === 'agent' && !envelope.turn) {
        return null;
    }

    const messageId = envelope.id;
    const messageCreatedAt = envelope.time;
    const parentUUID = envelope.taskCall ?? envelope.subagent ?? null;
    const isSidechain = parentUUID !== null;
    const contentUUID = envelope.id;

    if (envelope.ev.t === 'turn-start') {
        return null;
    }

    if (envelope.ev.t === 'start' || envelope.ev.t === 'stop') {
        // Lifecycle marker for subagent boundaries; currently not rendered as chat content.
        return null;
    }

    if (envelope.ev.t === 'turn-end') {
        const rawUsage = envelope.ev.usage;
        const inputTokens = rawUsage?.input_tokens ?? rawUsage?.inputTokens;
        const outputTokens = rawUsage?.output_tokens ?? rawUsage?.outputTokens;
        const contextSize = rawUsage?.contextSize ?? rawUsage?.context_size;
        const contextWindowTokens = rawUsage?.context_window_tokens ?? rawUsage?.contextWindowTokens;
        const hasUsage = rawUsage && (
            inputTokens !== undefined
            || contextSize !== undefined
            || contextWindowTokens !== undefined
        );
        const normalizedUsage: UsageData | undefined = hasUsage
            ? {
                input_tokens: inputTokens ?? 0,
                output_tokens: outputTokens ?? 0,
                cache_creation_input_tokens: rawUsage.cache_creation_input_tokens ?? rawUsage.cacheCreationInputTokens,
                cache_read_input_tokens: rawUsage.cache_read_input_tokens ?? rawUsage.cacheReadInputTokens,
                // Pass through pre-computed contextSize from CLI if present so processUsageData
                // can use it directly rather than recomputing from token fields that may be
                // incomplete (e.g. cursor-agent only reports per-turn incremental tokens).
                contextSize,
                context_window_tokens: contextWindowTokens,
            }
            : undefined;
        return {
            id: messageId,
            localId,
            createdAt: messageCreatedAt,
            role: 'event',
            isSidechain: false,
            content: { type: 'ready' },
            meta,
            ...(normalizedUsage ? { usage: normalizedUsage } : {}),
        } satisfies NormalizedMessage;
    }

    if (envelope.ev.t === 'service') {
        if (envelope.role !== 'agent') {
            return null;
        }

        // Cursor CLI surfaces errors as service envelopes; render like Claude/Codex session events.
        if (envelope.ev.text.startsWith('Error:')) {
            return {
                id: messageId,
                localId,
                createdAt: messageCreatedAt,
                role: 'event',
                isSidechain: false,
                content: { type: 'message', message: envelope.ev.text },
                meta
            } satisfies NormalizedMessage;
        }

        return {
            id: messageId,
            localId,
            createdAt: messageCreatedAt,
            role: 'agent',
            isSidechain,
            content: [{
                type: 'text',
                text: envelope.ev.text,
                uuid: contentUUID,
                parentUUID
            }],
            meta
        } satisfies NormalizedMessage;
    }

    if (envelope.ev.t === 'text') {
        if (envelope.role === 'user') {
            if (!isSessionProtocolSendEnabled()) {
                return null;
            }
            return {
                id: messageId,
                localId,
                createdAt: messageCreatedAt,
                role: 'user',
                isSidechain: false,
                content: {
                    type: 'text',
                    text: envelope.ev.text
                },
                meta
            } satisfies NormalizedMessage;
        }

        return {
            id: messageId,
            localId,
            createdAt: messageCreatedAt,
            role: 'agent',
            isSidechain,
            content: [
                envelope.ev.thinking ? {
                    type: 'thinking',
                    thinking: envelope.ev.text,
                    uuid: contentUUID,
                    parentUUID
                } : {
                    type: 'text',
                    text: envelope.ev.text,
                    uuid: contentUUID,
                    parentUUID
                }
            ],
            meta
        } satisfies NormalizedMessage;
    }

    if (envelope.ev.t === 'tool-call-start') {
        // If the CLI truncated large content fields (_lazy marker), lift the flag out of
        // the args object so it lives as proper metadata on the content block.
        const rawArgs = envelope.ev.args as Record<string, unknown>;
        const isLazy = rawArgs._lazy === true;
        const cleanArgs: Record<string, unknown> = isLazy
            ? Object.fromEntries(Object.entries(rawArgs).filter(([k]) => k !== '_lazy'))
            : rawArgs;
        const envelopeTitle = typeof envelope.ev.title === 'string' && envelope.ev.title ? envelope.ev.title : null;
        return {
            id: messageId,
            localId,
            createdAt: messageCreatedAt,
            role: 'agent',
            isSidechain,
            content: [{
                type: 'tool-call',
                id: envelope.ev.call,
                name: envelope.ev.name || 'unknown',
                input: cleanArgs,
                title: envelopeTitle,
                description: envelope.ev.description,
                uuid: contentUUID,
                parentUUID,
                ...(isLazy ? { lazyContent: true } : {}),
            }],
            meta
        } satisfies NormalizedMessage;
    }

    if (envelope.ev.t === 'tool-call-end') {
        return {
            id: messageId,
            localId,
            createdAt: messageCreatedAt,
            role: 'agent',
            isSidechain,
            content: [{
                type: 'tool-result',
                tool_use_id: envelope.ev.call,
                content: envelope.ev.result ?? null,
                is_error: false,
                uuid: contentUUID,
                parentUUID
            }],
            meta
        } satisfies NormalizedMessage;
    }

    if (envelope.ev.t === 'file') {
        const maybeImageMetadata = envelope.ev.image
            ? {
                image: {
                    width: envelope.ev.image.width,
                    height: envelope.ev.image.height,
                    thumbhash: envelope.ev.image.thumbhash
                }
            }
            : {};

        return {
            id: messageId,
            localId,
            createdAt: messageCreatedAt,
            role: 'agent',
            isSidechain,
            content: [{
                type: 'tool-call',
                id: messageId,
                name: 'file',
                input: {
                    ref: envelope.ev.ref,
                    name: envelope.ev.name,
                    size: envelope.ev.size,
                    ...maybeImageMetadata
                },
                description: envelope.ev.image
                    ? `Attached image: ${envelope.ev.name} (${envelope.ev.image.width}x${envelope.ev.image.height})`
                    : `Attached file: ${envelope.ev.name}`,
                uuid: contentUUID,
                parentUUID
            }],
            meta
        } satisfies NormalizedMessage;
    }

    return null;
}

export function normalizeRawMessage(
    id: string,
    localId: string | null,
    createdAt: number,
    raw: RawRecord
): NormalizedMessage | null {
    // Zod transform handles normalization during validation
    let parsed = rawRecordSchema.safeParse(raw);
    if (!parsed.success) {
        // 静默：服务端会缓存消息，仅修 CLI 无法保证历史/缓存消息格式一致；此类 tool_result content 为
        // { stdout, exitCode } 的校验失败未影响日常使用，暂不刷屏日志，日后与后端/协议对齐后再考虑恢复详细日志。
        const isLegacyToolResultContent = (issues: z.ZodIssue[]): boolean => {
            const check = (v: unknown): boolean => {
                if (Array.isArray(v)) return v.some(check);
                if (v && typeof v === 'object' && 'path' in v && 'expected' in v && 'received' in v) {
                    const p = (v as { path: unknown }).path;
                    const exp = (v as { expected: string }).expected;
                    const rec = (v as { received: string }).received;
                    if (Array.isArray(p) && exp === 'string' && (rec === 'object' || rec === 'array')) {
                        const pathStr = String(p.join('.'));
                        if (pathStr.includes('content') && pathStr.includes('message')) return true;
                    }
                }
                return false;
            };
            const walk = (ii: z.ZodIssue[]): boolean =>
                ii.some((i) => {
                    if (check(i)) return true;
                    const ue = (i as { unionErrors?: Array<{ issues: z.ZodIssue[] }> }).unionErrors;
                    return ue?.some((e) => walk(e.issues)) ?? false;
                });
            return walk(issues);
        };
        if (!isLegacyToolResultContent(parsed.error.issues)) {
            console.error('=== VALIDATION ERROR ===');
            console.error('Zod issues:', JSON.stringify(parsed.error.issues, null, 2));
            console.error('Raw message:', JSON.stringify(raw, null, 2));
            console.error('=== END ERROR ===');
        }
        return null;
    }
    raw = parsed.data;
    if (raw.role === 'user') {
        // A2A trigger messages are daemon infrastructure — never user-visible.
        if (raw.meta?.origin === 'a2a') {
            return null;
        }
        return {
            id,
            localId,
            createdAt,
            role: 'user',
            content: raw.content,
            isSidechain: false,
            meta: raw.meta,
        };
    }
    if (raw.role === 'session') {
        const out = normalizeSessionEnvelope(
            raw.content.data,
            localId,
            createdAt,
            raw.meta,
        );
        if (__DEV__ && out && out.role === 'agent' && out.content[0]?.type === 'text') console.log('[session protocol] rendered session text id=', out.id, 'len=', (out.content[0] as { text?: string }).text?.length);
        return out;
    }
    if (raw.role === 'agent') {
        if (raw.content.type === 'output') {
            // When session protocol is enabled we already show content from session envelopes; skip output to avoid duplicate bubbles
            if (isSessionProtocolSendEnabled()) {
                if (__DEV__) console.log('[session protocol] filtered output id=', id);
                return null;
            }

            // Skip Meta messages
            if (raw.content.data.isMeta) {
                return null;
            }

            // Skip compact summary messages
            if (raw.content.data.isCompactSummary) {
                return null;
            }

            // Handle Assistant messages (including sidechains)
            if (raw.content.data.type === 'assistant') {
                if (!raw.content.data.uuid) {
                    return null;
                }
                let content: NormalizedAgentContent[] = [];
                for (let c of raw.content.data.message.content) {
                    if (c.type === 'text') {
                        content.push({
                            ...c,  // WOLOG: Preserve all fields including unknown ones
                            uuid: raw.content.data.uuid,
                            parentUUID: raw.content.data.parentUuid ?? null
                        } as NormalizedAgentContent);
                    } else if (c.type === 'thinking') {
                        content.push({
                            ...c,  // WOLOG: Preserve all fields including unknown ones (signature, etc.)
                            uuid: raw.content.data.uuid,
                            parentUUID: raw.content.data.parentUuid ?? null
                        } as NormalizedAgentContent);
                    } else if (c.type === 'tool_use') {
                        let description: string | null = null;
                        if (typeof c.input === 'object' && c.input !== null && 'description' in c.input && typeof c.input.description === 'string') {
                            description = c.input.description;
                        }
                        content.push({
                            ...c,  // WOLOG: Preserve all fields including unknown ones
                            type: 'tool-call',
                            description,
                            uuid: raw.content.data.uuid,
                            parentUUID: raw.content.data.parentUuid ?? null
                        } as NormalizedAgentContent);
                    }
                }
                return {
                    id,
                    localId,
                    createdAt,
                    role: 'agent',
                    isSidechain: raw.content.data.isSidechain ?? false,
                    content,
                    meta: raw.meta,
                    usage: raw.content.data.message.usage
                };
            } else if (raw.content.data.type === 'user') {
                if (!raw.content.data.uuid) {
                    return null;
                }

                // Handle sidechain user messages
                if (raw.content.data.isSidechain && raw.content.data.message && typeof raw.content.data.message.content === 'string') {
                    // Return as a special agent message with sidechain content
                    return {
                        id,
                        localId,
                        createdAt,
                        role: 'agent',
                        isSidechain: true,
                        content: [{
                            type: 'sidechain',
                            uuid: raw.content.data.uuid,
                            prompt: raw.content.data.message.content
                        }]
                    };
                }

                // Handle regular user messages
                if (raw.content.data.message && typeof raw.content.data.message.content === 'string') {
                    return {
                        id,
                        localId,
                        createdAt,
                        role: 'user',
                        isSidechain: false,
                        content: {
                            type: 'text',
                            text: raw.content.data.message.content
                        }
                    };
                }

                // Handle tool results
                let content: NormalizedAgentContent[] = [];
                if (typeof raw.content.data.message.content === 'string') {
                    content.push({
                        type: 'text',
                        text: raw.content.data.message.content,
                        uuid: raw.content.data.uuid,
                        parentUUID: raw.content.data.parentUuid ?? null
                    });
                } else {
                    for (let c of raw.content.data.message.content) {
                        if (c.type === 'tool_result') {
                            content.push({
                                ...c,  // WOLOG: Preserve all fields including unknown ones
                                type: 'tool-result',
                                content: raw.content.data.toolUseResult ? raw.content.data.toolUseResult : (typeof c.content === 'string' ? c.content : c.content[0].text),
                                is_error: c.is_error || false,
                                uuid: raw.content.data.uuid,
                                parentUUID: raw.content.data.parentUuid ?? null,
                                permissions: c.permissions ? {
                                    date: c.permissions.date,
                                    result: c.permissions.result,
                                    mode: c.permissions.mode,
                                    allowedTools: c.permissions.allowedTools,
                                    decision: c.permissions.decision
                                } : undefined
                            } as NormalizedAgentContent);
                        }
                    }
                }
                return {
                    id,
                    localId,
                    createdAt,
                    role: 'agent',
                    isSidechain: raw.content.data.isSidechain ?? false,
                    content,
                    meta: raw.meta
                };
            }
        }
        if (raw.content.type === 'event') {
            return {
                id,
                localId,
                createdAt,
                role: 'event',
                content: raw.content.data,
                isSidechain: false,
            };
        }
        if (raw.content.type === 'codex' || raw.content.type === 'cursor') {
            const isCursorWire = (raw.content.type === 'cursor');
            // New App: when session protocol is enabled, skip codex/cursor text only (avoid duplicate bubbles); still accept tool-call/tool-call-result so tool cards get output
            if (isSessionProtocolSendEnabled()) {
                const t = raw.content.data.type;
                if (t === 'message' || t === 'reasoning' || t === 'thinking') {
                    if (__DEV__) console.log('[session protocol] filtered codex/cursor id=', id, 'dataType=', t);
                    return null;
                }
            }
            if (raw.content.data.type === 'message') {
                // Cast codex messages to agent text messages
                return {
                    id,
                    localId,
                    createdAt,
                    role: 'agent',
                    isSidechain: false,
                    content: [{
                        type: 'text',
                        text: raw.content.data.message,
                        uuid: id,
                        parentUUID: null
                    }],
                    meta: raw.meta
                };
            }
            if (raw.content.data.type === 'reasoning') {
                // Cast codex messages to agent text messages
                return {
                    id,
                    localId,
                    createdAt,
                    role: 'agent',
                    isSidechain: false,
                    content: [{
                        type: 'text',
                        text: raw.content.data.message,
                        uuid: id,
                        parentUUID: null
                    }],
                    meta: raw.meta
                } satisfies NormalizedMessage;
            }
            if (raw.content.data.type === 'tool-call') {
                // Cast tool calls to agent tool-call messages
                return {
                    id,
                    localId,
                    createdAt,
                    role: 'agent',
                    isSidechain: false,
                    content: [{
                        type: 'tool-call',
                        id: raw.content.data.callId,
                        name: raw.content.data.name || 'unknown',
                        input: raw.content.data.input,
                        description: null,
                        uuid: raw.content.data.id,
                        parentUUID: null
                    }],
                    meta: raw.meta
                } satisfies NormalizedMessage;
            }
            if (raw.content.data.type === 'tool-call-result') {
                // Cast tool call results to agent tool-result messages
                return {
                    id,
                    localId,
                    createdAt,
                    role: 'agent',
                    isSidechain: false,
                    content: [{
                        type: 'tool-result',
                        tool_use_id: raw.content.data.callId,
                        content: raw.content.data.output,
                        is_error: raw.content.data.is_error ?? false,
                        uuid: raw.content.data.id,
                        parentUUID: null
                    }],
                    meta: raw.meta
                } satisfies NormalizedMessage;
            }
            if (raw.content.data.type === 'thinking') {
                // Codex (main): always text so message list matches upstream. Cursor: wire type 'cursor' → thinking.
                const asThinking = isCursorWire;
                return {
                    id,
                    localId,
                    createdAt,
                    role: 'agent',
                    isSidechain: false,
                    content: [asThinking
                        ? { type: 'thinking' as const, thinking: raw.content.data.text, uuid: id, parentUUID: null }
                        : { type: 'text' as const, text: raw.content.data.text, uuid: id, parentUUID: null }
                    ],
                    meta: raw.meta
                } satisfies NormalizedMessage;
            }
            if (raw.content.data.type === 'task_started' || raw.content.data.type === 'task_complete' || raw.content.data.type === 'turn_aborted') {
                // Codex/Cursor lifecycle events; skip for UI (no message to show)
                return null;
            }
        }
        if (raw.content.type === 'session') {
            // When session protocol is enabled, only render from role === 'session' to avoid duplicate
            // (same envelope can be stored as both role session and role agent+type session)
            if (isSessionProtocolSendEnabled()) {
                if (__DEV__) console.log('[session protocol] filtered agent+session id=', id);
                return null;
            }
            const out = normalizeSessionEnvelope(raw.content.data, localId, createdAt, raw.meta);
            if (__DEV__ && out && out.role === 'agent' && out.content[0]?.type === 'text') console.log('[session protocol] rendered agent+session text id=', out.id);
            return out;
        }
        // ACP (Agent Communication Protocol) - unified format for all agent providers
        if (raw.content.type === 'acp') {
            // When session protocol is enabled, skip ACP text (message/reasoning) to avoid duplicate bubbles; keep tool-call/tool-result
            if (isSessionProtocolSendEnabled()) {
                const t = raw.content.data.type;
                if (t === 'message' || t === 'reasoning') return null;
            }
            if (raw.content.data.type === 'message') {
                return {
                    id,
                    localId,
                    createdAt,
                    role: 'agent',
                    isSidechain: false,
                    content: [{
                        type: 'text',
                        text: raw.content.data.message,
                        uuid: id,
                        parentUUID: null
                    }],
                    meta: raw.meta
                } satisfies NormalizedMessage;
            }
            if (raw.content.data.type === 'reasoning') {
                return {
                    id,
                    localId,
                    createdAt,
                    role: 'agent',
                    isSidechain: false,
                    content: [{
                        type: 'text',
                        text: raw.content.data.message,
                        uuid: id,
                        parentUUID: null
                    }],
                    meta: raw.meta
                } satisfies NormalizedMessage;
            }
            if (raw.content.data.type === 'tool-call') {
                return {
                    id,
                    localId,
                    createdAt,
                    role: 'agent',
                    isSidechain: false,
                    content: [{
                        type: 'tool-call',
                        id: raw.content.data.callId,
                        name: raw.content.data.name || 'unknown',
                        input: raw.content.data.input,
                        description: null,
                        uuid: raw.content.data.id,
                        parentUUID: null
                    }],
                    meta: raw.meta
                } satisfies NormalizedMessage;
            }
            if (raw.content.data.type === 'tool-result') {
                return {
                    id,
                    localId,
                    createdAt,
                    role: 'agent',
                    isSidechain: false,
                    content: [{
                        type: 'tool-result',
                        tool_use_id: raw.content.data.callId,
                        content: raw.content.data.output,
                        is_error: raw.content.data.isError ?? false,
                        uuid: raw.content.data.id,
                        parentUUID: null
                    }],
                    meta: raw.meta
                } satisfies NormalizedMessage;
            }
            // Handle hyphenated tool-call-result (backwards compatibility)
            if (raw.content.data.type === 'tool-call-result') {
                return {
                    id,
                    localId,
                    createdAt,
                    role: 'agent',
                    isSidechain: false,
                    content: [{
                        type: 'tool-result',
                        tool_use_id: raw.content.data.callId,
                        content: raw.content.data.output,
                        is_error: false,
                        uuid: raw.content.data.id,
                        parentUUID: null
                    }],
                    meta: raw.meta
                } satisfies NormalizedMessage;
            }
            if (raw.content.data.type === 'thinking') {
                return {
                    id,
                    localId,
                    createdAt,
                    role: 'agent',
                    isSidechain: false,
                    content: [{
                        type: 'thinking',
                        thinking: raw.content.data.text,
                        uuid: id,
                        parentUUID: null
                    }],
                    meta: raw.meta
                } satisfies NormalizedMessage;
            }
            if (raw.content.data.type === 'file-edit') {
                // Map file-edit to tool-call for UI rendering
                return {
                    id,
                    localId,
                    createdAt,
                    role: 'agent',
                    isSidechain: false,
                    content: [{
                        type: 'tool-call',
                        id: raw.content.data.id,
                        name: 'file-edit',
                        input: {
                            filePath: raw.content.data.filePath,
                            description: raw.content.data.description,
                            diff: raw.content.data.diff,
                            oldContent: raw.content.data.oldContent,
                            newContent: raw.content.data.newContent
                        },
                        description: raw.content.data.description,
                        uuid: raw.content.data.id,
                        parentUUID: null
                    }],
                    meta: raw.meta
                } satisfies NormalizedMessage;
            }
            if (raw.content.data.type === 'terminal-output') {
                // Map terminal-output to tool-result
                return {
                    id,
                    localId,
                    createdAt,
                    role: 'agent',
                    isSidechain: false,
                    content: [{
                        type: 'tool-result',
                        tool_use_id: raw.content.data.callId,
                        content: raw.content.data.data,
                        is_error: false,
                        uuid: id,
                        parentUUID: null
                    }],
                    meta: raw.meta
                } satisfies NormalizedMessage;
            }
            if (raw.content.data.type === 'permission-request') {
                // Map permission-request to tool-call for UI to show permission dialog
                return {
                    id,
                    localId,
                    createdAt,
                    role: 'agent',
                    isSidechain: false,
                    content: [{
                        type: 'tool-call',
                        id: raw.content.data.permissionId,
                        name: raw.content.data.toolName,
                        input: raw.content.data.options ?? {},
                        description: raw.content.data.description,
                        uuid: id,
                        parentUUID: null
                    }],
                    meta: raw.meta
                } satisfies NormalizedMessage;
            }
            // Task lifecycle events (task_started, task_complete, turn_aborted) and token_count
            // are status/metrics - skip normalization, they don't need UI rendering
        }
    }
    return null;
}
