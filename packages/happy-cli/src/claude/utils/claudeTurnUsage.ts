import type { SDKResultMessage } from '@/claude/sdk/types';

const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;

/**
 * Cursor-style usage payload attached to the App's turn-end envelope so the App can render
 * context-usage progress bars and per-turn cost. Mirrors `buildTurnEndUsagePayload` in
 * runCursor.ts: snake_case keys (`input_tokens`, `context_size`, `context_window_tokens`).
 *
 * The token fields describe **the last main-thread API call of the turn**, because that call's
 * prompt is the context at the end of the turn. In particular:
 *
 *   context_size = input_tokens + cache_read_input_tokens + cache_creation_input_tokens
 *
 * (`output_tokens` is the one exception: the assistant stream reports zero output per call, so it
 * carries the turn total from the result and is display-only.)
 *
 * Do not use the SDK result's `usage` (sum over all API calls in the turn — billing volume, not
 * context) or `modelUsage` (cumulative for the whole Claude process, which happy keeps alive for
 * the entire session) for `context_size`. Both grow without bound and produced readings like
 * 20M / 200K.
 */
export interface ClaudeTurnUsagePayload {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    /** Breakdown of cache creation by TTL tier (from Claude API). */
    cache_creation?: {
        ephemeral_5m_input_tokens: number;
        ephemeral_1h_input_tokens: number;
    };
    /** Effective prompt size against the model's context window at the end of this turn. */
    context_size?: number;
    /** Max context window for the primary model that ran the turn. */
    context_window_tokens: number;
    /** Best-effort identifier of the model the values are reported for (for App display). */
    model?: string;
}

/** Usage of the last main-thread API call seen in the turn, collected while streaming assistant messages. */
export interface ClaudeLastInferenceUsage {
    /** `message.id` of that call — repeated content-block messages share it. */
    messageId?: string;
    model?: string;
    inputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    cacheCreation?: {
        ephemeral_5m_input_tokens: number;
        ephemeral_1h_input_tokens: number;
    };
}

function pickPrimaryModel(
    modelUsage: SDKResultMessage['modelUsage'],
    preferred?: string,
): { name: string; entry: NonNullable<SDKResultMessage['modelUsage']>[string] } | null {
    if (!modelUsage) return null;
    const entries = Object.entries(modelUsage);
    if (entries.length === 0) return null;
    // The model that actually produced the last inference is the one whose contextWindow applies.
    if (preferred) {
        const exact = entries.find(([name]) => name === preferred);
        if (exact) return { name: exact[0], entry: exact[1] };
    }
    // Otherwise (e.g. an operator-chosen proxy model code that doesn't match the provider's
    // model name) fall back to the model with the most prompt tokens — that's the one whose
    // contextWindow matters for the progress bar.
    entries.sort((a, b) => {
        const aTokens = (a[1].cacheReadInputTokens ?? 0) + (a[1].inputTokens ?? 0)
            + (a[1].cacheCreationInputTokens ?? 0);
        const bTokens = (b[1].cacheReadInputTokens ?? 0) + (b[1].inputTokens ?? 0)
            + (b[1].cacheCreationInputTokens ?? 0);
        return bTokens - aTokens;
    });
    const [name, entry] = entries[0];
    return { name, entry };
}

export function buildClaudeTurnUsagePayload(
    result: Pick<SDKResultMessage, 'usage' | 'modelUsage' | 'num_turns'>,
    lastInference?: ClaudeLastInferenceUsage,
): ClaudeTurnUsagePayload | null {
    const primary = pickPrimaryModel(result.modelUsage, lastInference?.model);
    const contextWindow = primary?.entry.contextWindow ?? DEFAULT_CONTEXT_WINDOW_TOKENS;

    // A turn that made exactly one API call has turn sum == that call, so the result usage is a
    // valid fallback when no assistant message was observed (e.g. an error before streaming).
    const singleCall = (result.num_turns ?? 1) <= 1 ? result.usage : undefined;
    const inputTokens = lastInference?.inputTokens ?? singleCall?.input_tokens;
    const cacheRead = lastInference?.cacheReadInputTokens ?? singleCall?.cache_read_input_tokens;
    const cacheCreate = lastInference?.cacheCreationInputTokens ?? singleCall?.cache_creation_input_tokens;
    const cacheCreation = lastInference?.cacheCreation ?? singleCall?.cache_creation;
    // The assistant stream reports output_tokens: 0 on every event, so the per-call output is not
    // observable here. Report the turn total from the result instead — display only, never used
    // for context_size.
    const outputTokens = result.usage?.output_tokens ?? primary?.entry.outputTokens;

    // When we have nothing usable at all, skip the envelope decoration.
    if (inputTokens === undefined && cacheRead === undefined && cacheCreate === undefined) {
        return null;
    }

    const total = (inputTokens ?? 0) + (cacheRead ?? 0) + (cacheCreate ?? 0);

    return {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheCreate,
        cache_creation: cacheCreation,
        context_size: total > 0 ? total : undefined,
        context_window_tokens: contextWindow,
        model: primary?.name,
    };
}
