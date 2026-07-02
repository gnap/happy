import { createId, isCuid } from '@paralleldrive/cuid2';
import * as z from 'zod';

export const sessionRoleSchema = z.enum(['user', 'agent']);
export type SessionRole = z.infer<typeof sessionRoleSchema>;

export const sessionTextEventSchema = z.object({
  t: z.literal('text'),
  text: z.string(),
  thinking: z.boolean().optional(),
});

export const sessionServiceMessageEventSchema = z.object({
  t: z.literal('service'),
  text: z.string(),
});

export const sessionToolCallStartEventSchema = z.object({
  t: z.literal('tool-call-start'),
  call: z.string(),
  name: z.string(),
  title: z.string(),
  description: z.string(),
  args: z.record(z.string(), z.unknown()),
});

export const sessionToolCallEndEventSchema = z.object({
  t: z.literal('tool-call-end'),
  call: z.string(),
  /** Optional tool execution result; passed through as-is from the provider. */
  result: z.unknown().optional(),
});

export const sessionFileEventSchema = z.object({
  t: z.literal('file'),
  ref: z.string(),
  name: z.string(),
  size: z.number(),
  image: z
    .object({
      width: z.number(),
      height: z.number(),
      thumbhash: z.string(),
    })
    .optional(),
});

export const sessionTurnStartEventSchema = z.object({
  t: z.literal('turn-start'),
});

export const sessionStartEventSchema = z.object({
  t: z.literal('start'),
  title: z.string().optional(),
});

export const sessionTurnEndStatusSchema = z.enum(['completed', 'failed', 'cancelled']);
export type SessionTurnEndStatus = z.infer<typeof sessionTurnEndStatusSchema>;

/** Per-turn usage payload attached to turn-end envelopes (Claude + Cursor). */
export const sessionTurnEndUsageSchema = z.object({
    input_tokens: z.number().int().nonnegative().optional(),
    output_tokens: z.number().int().nonnegative().optional(),
    cache_read_input_tokens: z.number().int().nonnegative().optional(),
    cache_creation_input_tokens: z.number().int().nonnegative().optional(),
    context_size: z.number().int().nonnegative().optional(),
    context_window_tokens: z.number().int().nonnegative().optional(),
    model: z.string().optional(),
}).passthrough();
export type SessionTurnEndUsage = z.infer<typeof sessionTurnEndUsageSchema>;

/** /context snapshot (from backgroundContextFetcher) carried in turn-end. */
export const sessionTurnEndContextUsageSchema = z.object({
    currentTokens: z.number().int().nonnegative(),
    maxTokens: z.number().int().nonnegative(),
    pct: z.number().int().nonnegative(),
    model: z.string().optional(),
    breakdown: z.object({
        systemPrompt: z.number().int().nonnegative(),
        systemTools: z.number().int().nonnegative(),
        customAgents: z.number().int().nonnegative(),
        skills: z.number().int().nonnegative(),
        messages: z.number().int().nonnegative(),
        freeSpace: z.number().int().nonnegative(),
    }).optional(),
    fetchedAt: z.number().optional(),
}).optional();

export const sessionTurnEndEventSchema = z.object({
  t: z.literal('turn-end'),
  status: sessionTurnEndStatusSchema,
  usage: sessionTurnEndUsageSchema.optional(),
  contextUsage: sessionTurnEndContextUsageSchema,
  costUsd: z.number().optional(),
  durationMs: z.number().int().nonnegative().optional(),
});

export const sessionStopEventSchema = z.object({
  t: z.literal('stop'),
});

/** Permission result event — embeds permission decisions into the replayable message stream. */
export const sessionPermissionResultEventSchema = z.object({
  t: z.literal('permission-result'),
  call: z.string(),
  status: z.enum(['approved', 'denied', 'canceled']),
  decision: z.enum(['approved', 'approved_for_session', 'denied', 'abort']).optional(),
  mode: z.string().optional(),
  allowedTools: z.array(z.string()).optional(),
  reason: z.string().optional(),
});

export const sessionEventSchema = z.discriminatedUnion('t', [
  sessionTextEventSchema,
  sessionServiceMessageEventSchema,
  sessionToolCallStartEventSchema,
  sessionToolCallEndEventSchema,
  sessionFileEventSchema,
  sessionTurnStartEventSchema,
  sessionStartEventSchema,
  sessionTurnEndEventSchema,
  sessionStopEventSchema,
  sessionPermissionResultEventSchema,
]);

export type SessionEvent = z.infer<typeof sessionEventSchema>;

export const sessionEnvelopeSchema = z
  .object({
    id: z.string(),
    time: z.number(),
    role: sessionRoleSchema,
    turn: z.string().optional(),
    subagent: z
      .string()
      .refine((value) => isCuid(value), {
        message: 'subagent must be a cuid2 value',
      })
      .optional(),
    taskCall: z.string().optional(),
    ev: sessionEventSchema,
  })
  .superRefine((envelope, ctx) => {
    if (envelope.ev.t === 'service' && envelope.role !== 'agent') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'service events must use role "agent"',
        path: ['role'],
      });
    }
    if (envelope.ev.t === 'permission-result' && envelope.role !== 'agent') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'permission-result events must use role "agent"',
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

export type SessionEnvelope = z.infer<typeof sessionEnvelopeSchema>;

export type CreateEnvelopeOptions = {
  id?: string;
  time?: number;
  turn?: string;
  subagent?: string;
  taskCall?: string;
  /** Passthrough metadata for the envelope (origin, cronId, etc.). */
  meta?: Record<string, unknown>;
};

export function createEnvelope(role: SessionRole, ev: SessionEvent, opts: CreateEnvelopeOptions = {}): SessionEnvelope {
  return sessionEnvelopeSchema.parse({
    id: opts.id ?? createId(),
    time: opts.time ?? Date.now(),
    role,
    ...(opts.turn ? { turn: opts.turn } : {}),
    ...(opts.subagent ? { subagent: opts.subagent } : {}),
    ...(opts.taskCall ? { taskCall: opts.taskCall } : {}),
    ev,
    ...(opts.meta ?? {}),
  });
}
