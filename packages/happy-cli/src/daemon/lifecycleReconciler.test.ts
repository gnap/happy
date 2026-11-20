import { describe, expect, it } from 'vitest';
import {
    decideReconcile,
    MAX_RECONCILE_ATTEMPTS,
    nextReconcileProgress,
    RECONCILE_BACKOFF_MS,
    RECONCILE_IN_FLIGHT_RECHECK_MS,
    type ReconcileProgress,
    type ReconcileSpec,
} from './lifecycleReconciler';

const spec = (overrides: Partial<ReconcileSpec> = {}): ReconcileSpec => ({
    key: 'tag-1',
    lifecycle: 'running',
    generation: 2,
    at: 1_000,
    tag: 'tag-1',
    sessionId: 'sess-1',
    ...overrides,
});

describe('decideReconcile', () => {
    it('does nothing once the want has been realized', () => {
        const decision = decideReconcile({
            spec: spec(),
            observation: { phase: 'Running', observedGeneration: 2 },
            now: 10_000,
        });

        expect(decision).toEqual({ kind: 'settled' });
    });

    it('does not wake a session that was realized and later stopped', () => {
        // There is no "stopped" spec: a session that ran and exited is settled, not a missing
        // want. Otherwise every idle session would be respawned on the next sweep.
        const decision = decideReconcile({
            spec: spec(),
            observation: { phase: 'Stopped', observedGeneration: 2 },
            now: 10_000,
        });

        expect(decision).toEqual({ kind: 'settled' });
    });

    it('resumes a newer want that no process has realized', () => {
        const decision = decideReconcile({
            spec: spec(),
            observation: { phase: 'Stopped', observedGeneration: 1 },
            now: 10_000,
        });

        expect(decision).toEqual({ kind: 'resume', reason: 'want-not-observed', attempt: 1 });
    });

    it('waits while a spawn or restart is already on its way', () => {
        for (const phase of ['Scheduling', 'Starting', 'Restarting'] as const) {
            expect(decideReconcile({
                spec: spec(),
                observation: { phase, observedGeneration: 1 },
                now: 10_000,
            })).toEqual({ kind: 'in-flight', reason: 'in-flight' });
        }
    });

    it('replaces an old process that outlived the restart that was meant to replace it', () => {
        // `Running` below the want with nothing in flight is a restart accepted before a daemon
        // death and never performed. Leaving it alone would keep the old process serving and the
        // want outstanding forever; spawning beside it would produce two processes for one
        // session. The resume stops it first, which is why the decision is still `resume`.
        const decision = decideReconcile({
            spec: spec(),
            observation: { phase: 'Running', observedGeneration: 1 },
            now: 10_000,
        });

        expect(decision).toEqual({ kind: 'resume', reason: 'newer-want-while-running', attempt: 1 });
    });

    it('archives a session whose tombstone has not been applied', () => {
        const decision = decideReconcile({
            spec: spec({ lifecycle: 'archived', generation: 3 }),
            observation: { phase: 'Stopped', observedGeneration: 2 },
            now: 10_000,
        });

        expect(decision).toEqual({ kind: 'archive', reason: 'spec-archived', attempt: 1 });
    });

    it('does not re-archive a session that is already gone', () => {
        const decision = decideReconcile({
            spec: spec({ lifecycle: 'archived', generation: 3 }),
            observation: { phase: 'Archived', observedGeneration: 3 },
            now: 10_000,
        });

        expect(decision).toEqual({ kind: 'settled' });
    });

    it('refuses to resurrect an archived session', () => {
        const decision = decideReconcile({
            spec: spec({ lifecycle: 'running', generation: 4 }),
            observation: { phase: 'Archived', observedGeneration: 3 },
            now: 10_000,
        });

        expect(decision).toEqual({ kind: 'blocked', reason: 'archived-but-want-running', attempts: 0 });
    });

    it('backs off before retrying and then gives up', () => {
        let progress: ReconcileProgress | undefined = {
            generation: 2,
            attempts: 1,
            nextAttemptAt: 20_000,
        };

        expect(decideReconcile({
            spec: spec(),
            observation: { phase: 'Stopped', observedGeneration: 1 },
            progress,
            now: 10_000,
        })).toEqual({ kind: 'backoff', reason: 'want-not-observed', nextAttemptAt: 20_000 });

        progress = {
            generation: 2,
            attempts: MAX_RECONCILE_ATTEMPTS,
            nextAttemptAt: 20_000,
        };
        expect(decideReconcile({
            spec: spec(),
            observation: { phase: 'Stopped', observedGeneration: 1 },
            progress,
            now: 30_000,
        })).toEqual({ kind: 'blocked', reason: 'want-not-observed', attempts: MAX_RECONCILE_ATTEMPTS });
    });

    it('keeps a blocked verdict until a newer generation arrives', () => {
        const blocked: ReconcileProgress = {
            generation: 2,
            attempts: MAX_RECONCILE_ATTEMPTS,
            nextAttemptAt: Number.POSITIVE_INFINITY,
            blocked: { reason: 'want-not-observed', at: 5_000 },
        };

        expect(decideReconcile({
            spec: spec(),
            observation: { phase: 'Stopped', observedGeneration: 1 },
            progress: blocked,
            now: 60_000,
        })).toEqual({ kind: 'blocked', reason: 'want-not-observed', attempts: MAX_RECONCILE_ATTEMPTS });

        expect(decideReconcile({
            spec: spec({ generation: 3 }),
            observation: { phase: 'Stopped', observedGeneration: 1 },
            progress: blocked,
            now: 60_000,
        })).toEqual({ kind: 'resume', reason: 'want-not-observed', attempt: 1 });
    });
});

describe('nextReconcileProgress', () => {
    it('counts an attempt and schedules the next one on the ladder', () => {
        const next = nextReconcileProgress(
            { kind: 'resume', reason: 'want-not-observed', attempt: 1 },
            spec(),
            undefined,
            10_000,
        );

        expect(next).toEqual({
            generation: 2,
            attempts: 1,
            nextAttemptAt: 10_000 + RECONCILE_BACKOFF_MS[0],
        });
    });

    it('keeps attempts while a spawn is in flight', () => {
        const next = nextReconcileProgress(
            { kind: 'in-flight', reason: 'in-flight' },
            spec(),
            { generation: 2, attempts: 2, nextAttemptAt: 11_000 },
            10_000,
        );

        expect(next).toEqual({
            generation: 2,
            attempts: 2,
            nextAttemptAt: 10_000 + RECONCILE_IN_FLIGHT_RECHECK_MS,
        });
    });

    it('clears progress once settled', () => {
        expect(nextReconcileProgress(
            { kind: 'settled' },
            spec(),
            { generation: 2, attempts: 2, nextAttemptAt: 11_000 },
            10_000,
        )).toBeUndefined();
    });

    it('turns the last attempt into a decision the next pass can block', () => {
        const next = nextReconcileProgress(
            { kind: 'resume', reason: 'want-not-observed', attempt: MAX_RECONCILE_ATTEMPTS },
            spec(),
            undefined,
            10_000,
        );

        expect(next?.nextAttemptAt).toBe(10_000);
        expect(decideReconcile({
            spec: spec(),
            observation: { phase: 'Stopped', observedGeneration: 1 },
            progress: next,
            now: 10_000,
        })).toEqual({ kind: 'blocked', reason: 'want-not-observed', attempts: MAX_RECONCILE_ATTEMPTS });
    });
});
