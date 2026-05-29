import type { SDKResultMessage } from '@/claude/sdk/types';

const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;

/**
 * Cursor-style usage payload attached to the App's turn-end envelope so the App can render
 * context-usage progress bars and per-turn cost. Mirrors `buildTurnEndUsagePayload` in
 * runCursor.ts: snake_case keys (`input_tokens`, `context_size`, `context_window_tokens`).
 *
 * For Claude we read the authoritative `contextWindow` from the SDK result's `modelUsage`
 * rollup. `context_size` (the value the App's progress gauge reads as "prompt size at
 * end of turn") is back-calculated from the cumulative SDK usage via the cursor-style
 * formula: cacheRead / N, where N = num_turns (number of API round-trips this turn).
 */
export interface ClaudeTurnUsagePayload {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    /** Effective prompt size against the model's context window at the end of this turn. */
    context_size?: number;
    /** Max context window for the primary model that ran the turn. */
    context_window_tokens: number;
    /** Best-effort identifier of the model the values are reported for (for App display). */
    model?: string;
}

function pickPrimaryModel(
    modelUsage: SDKResultMessage['modelUsage'],
): { name: string; entry: NonNullable<SDKResultMessage['modelUsage']>[string] } | null {
    if (!modelUsage) return null;
    const entries = Object.entries(modelUsage);
    if (entries.length === 0) return null;
    // When Claude routes a turn through multiple models, prefer the one with the most prompt
    // tokens — that's the one whose contextWindow matters for the progress bar.
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
): ClaudeTurnUsagePayload | null {
    const primary = pickPrimaryModel(result.modelUsage);
    const fromModel = primary?.entry;

    // Prefer modelUsage (richer + contextWindow); fall back to flat result.usage.
    const inputTokens = fromModel?.inputTokens ?? result.usage?.input_tokens;
    const outputTokens = fromModel?.outputTokens ?? result.usage?.output_tokens;
    const cacheRead = fromModel?.cacheReadInputTokens ?? result.usage?.cache_read_input_tokens;
    const cacheCreate = fromModel?.cacheCreationInputTokens ?? result.usage?.cache_creation_input_tokens;
    const contextWindow = fromModel?.contextWindow ?? DEFAULT_CONTEXT_WINDOW_TOKENS;

    // When we have nothing usable at all, skip the envelope decoration.
    if (
        inputTokens === undefined
        && outputTokens === undefined
        && cacheRead === undefined
        && cacheCreate === undefined
    ) {
        return null;
    }

    // SDK reports modelUsage as **cumulative across all API calls in the turn**
    // (each tool round-trip is one API call, plus the final assistant). Naively summing
    // cacheRead + cacheCreate + input across the turn balloons way past the model's
    // contextWindow and makes the App's progress gauge read > 100%.
    //
    // Cursor solves this by treating per-call cacheRead as ≈ accumulated / N (N = round
    // trips). Claude's `result.num_turns` is exactly that round-trip count. When num_turns
    // is unavailable (e.g. the synthetic "Not logged in" result is num_turns=1 but with
    // zero tokens), the formula degenerates safely.
    const n = Math.max(result.num_turns ?? 1, 1);
    const perCallCacheRead = cacheRead !== undefined ? Math.round(cacheRead / n) : undefined;
    // cacheCreation is written only by the final API call this turn (cache is written
    // once and read N times), so it's NOT divided. inputTokens is the freshly-billed
    // user-side delta and likewise stays as-is.
    const rawContextSize = (perCallCacheRead ?? 0) + (cacheCreate ?? 0) + (inputTokens ?? 0);
    const contextSize = rawContextSize > 0 ? rawContextSize : undefined;

    return {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheCreate,
        context_size: contextSize,
        context_window_tokens: contextWindow,
        model: primary?.name,
    };
}
