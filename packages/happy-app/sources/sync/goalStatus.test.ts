import { describe, expect, it } from 'vitest';
import { AgentStateSchema } from './storageTypes';
import { RawRecordSchema, normalizeRawMessage } from './typesRaw';

// React Native injects this global at runtime; vitest's node environment does not.
(globalThis as unknown as { __DEV__: boolean }).__DEV__ = false;

function sessionRecord(role: 'agent' | 'user', ev: Record<string, unknown>) {
    return {
        role: 'session',
        content: {
            type: 'session',
            data: { id: 'env1', time: 1788256626515, role, ev },
        },
    };
}

describe('/goal status — agentState', () => {
    it('keeps activeGoal through parsing', () => {
        // zod strips unknown keys, so a missing schema field would silently kill the
        // feature rather than fail loudly — this is the regression that matters.
        const parsed = AgentStateSchema.safeParse({
            activeGoal: {
                condition: 'all tests pass',
                status: 'pending',
                updatedAt: 1788256626515,
            },
        });

        expect(parsed.success).toBe(true);
        expect(parsed.success && parsed.data.activeGoal).toEqual({
            condition: 'all tests pass',
            status: 'pending',
            updatedAt: 1788256626515,
        });
    });

    it('preserves a cleared goal as null', () => {
        const parsed = AgentStateSchema.safeParse({ activeGoal: null });

        expect(parsed.success).toBe(true);
        expect(parsed.success && parsed.data.activeGoal).toBeNull();
    });

    it('keeps reason and iterations on a resolved goal', () => {
        const parsed = AgentStateSchema.safeParse({
            activeGoal: { condition: 'x', status: 'failed', reason: 'gave up', iterations: 4, updatedAt: 1 },
        });

        expect(parsed.success && parsed.data.activeGoal?.status).toBe('failed');
        expect(parsed.success && parsed.data.activeGoal?.reason).toBe('gave up');
        expect(parsed.success && parsed.data.activeGoal?.iterations).toBe(4);
    });
});

describe('/goal status — session protocol event', () => {
    it('validates the armed (sentinel) event', () => {
        const parsed = RawRecordSchema.safeParse(
            sessionRecord('agent', { t: 'goal-status', condition: 'all tests pass', met: false, sentinel: true }),
        );

        expect(parsed.success).toBe(true);
    });

    it('validates the resolve event with every optional field', () => {
        const parsed = RawRecordSchema.safeParse(
            sessionRecord('agent', {
                t: 'goal-status',
                condition: 'all tests pass',
                met: true,
                failed: false,
                reason: 'suite green',
                iterations: 7,
                durationMs: 1234,
                tokens: 5678,
            }),
        );

        expect(parsed.success).toBe(true);
    });

    it('rejects a goal-status event that is not role "agent"', () => {
        const parsed = RawRecordSchema.safeParse(
            sessionRecord('user', { t: 'goal-status', condition: 'x', met: false }),
        );

        expect(parsed.success).toBe(false);
    });

    it('is ignored by the normalizer instead of throwing or spamming validation errors', () => {
        const record = sessionRecord('agent', {
            t: 'goal-status',
            condition: 'all tests pass',
            met: false,
            sentinel: true,
        });

        expect(normalizeRawMessage('m1', null, 1788256626515, record as never)).toBeNull();
    });
});
