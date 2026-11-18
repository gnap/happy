import { describe, expect, it } from 'vitest';
import { buildClaudeTurnUsagePayload, type ClaudeLastInferenceUsage } from './claudeTurnUsage';

const lastInference: ClaudeLastInferenceUsage = {
    messageId: 'msg_2',
    model: 'claude-sonnet-5-5',
    inputTokens: 192,
    cacheReadInputTokens: 11_776,
    cacheCreationInputTokens: 0,
};

describe('buildClaudeTurnUsagePayload', () => {
    it('reports the last API call prompt as context_size, not the turn sum', () => {
        // Two calls in the turn: 11,798 then 11,968 tokens of prompt. The old formula summed
        // both (23,766) and divided by num_turns, which drifts as soon as tool round-trips differ.
        const usage = buildClaudeTurnUsagePayload({
            num_turns: 2,
            usage: { input_tokens: 11_990, output_tokens: 500, cache_read_input_tokens: 11_776, cache_creation_input_tokens: 0 },
            modelUsage: {
                'claude-sonnet-5-5': {
                    inputTokens: 11_990,
                    outputTokens: 500,
                    cacheReadInputTokens: 11_776,
                    cacheCreationInputTokens: 0,
                    contextWindow: 1_000_000,
                },
            },
        }, lastInference);

        expect(usage?.context_size).toBe(11_968);
        expect(usage?.context_window_tokens).toBe(1_000_000);
        expect(usage?.input_tokens).toBe(192);
        expect(usage?.cache_read_input_tokens).toBe(11_776);
    });

    it('does not let the process-cumulative modelUsage become context_size', () => {
        // happy keeps one Claude process per session, so modelUsage grows across turns —
        // real sessions have read 215M prompt tokens against a 200K window.
        const usage = buildClaudeTurnUsagePayload({
            num_turns: 11,
            usage: { input_tokens: 2_186, output_tokens: 300, cache_read_input_tokens: 84_096, cache_creation_input_tokens: 0 },
            modelUsage: {
                'glm-5.3': {
                    inputTokens: 215_799_808,
                    outputTokens: 1_000_000,
                    cacheReadInputTokens: 215_000_000,
                    cacheCreationInputTokens: 0,
                    contextWindow: 200_000,
                },
            },
        }, { ...lastInference, model: 'glm-5.3', inputTokens: 2_186, cacheReadInputTokens: 84_096 });

        expect(usage?.context_size).toBe(86_282);
        expect(usage?.context_window_tokens).toBe(200_000);
    });

    it('falls back to the result usage when the turn made a single call', () => {
        const usage = buildClaudeTurnUsagePayload({
            num_turns: 1,
            usage: { input_tokens: 4, output_tokens: 23, cache_read_input_tokens: 13_681, cache_creation_input_tokens: 2_525 },
        });

        expect(usage?.context_size).toBe(16_210);
        expect(usage?.context_window_tokens).toBe(200_000);
    });

    it('omits the estimate when a multi-call turn reported no assistant usage', () => {
        const usage = buildClaudeTurnUsagePayload({
            num_turns: 5,
            usage: { input_tokens: 4, output_tokens: 23, cache_read_input_tokens: 13_681, cache_creation_input_tokens: 2_525 },
        });

        expect(usage).toBeNull();
    });

    it('picks the context window of the model that answered, even when another model ran more tokens', () => {
        const usage = buildClaudeTurnUsagePayload({
            num_turns: 3,
            usage: { input_tokens: 1_000, output_tokens: 100 },
            modelUsage: {
                'claude-opus-5-5': { inputTokens: 900_000, contextWindow: 200_000 },
                'claude-sonnet-5-5': { inputTokens: 1_000, contextWindow: 1_000_000 },
            },
        }, lastInference);

        expect(usage?.context_window_tokens).toBe(1_000_000);
        expect(usage?.model).toBe('claude-sonnet-5-5');
    });

    it('passes the per-TTL cache creation breakdown through', () => {
        const usage = buildClaudeTurnUsagePayload({
            num_turns: 2,
            usage: { input_tokens: 1, output_tokens: 10 },
        }, {
            ...lastInference,
            cacheCreationInputTokens: 22_644,
            cacheCreation: { ephemeral_5m_input_tokens: 22_644, ephemeral_1h_input_tokens: 0 },
        });

        expect(usage?.cache_creation).toEqual({ ephemeral_5m_input_tokens: 22_644, ephemeral_1h_input_tokens: 0 });
        expect(usage?.context_size).toBe(34_612);
    });
});
