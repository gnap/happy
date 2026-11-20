import { describe, expect, it } from 'vitest';
import {
    decideSessionDelete,
    DELETE_RETRY_DELAYS_MS,
    deleteRetryDelayMs,
    dueSessionDeletes,
    nextDeleteAttemptAt,
    nextDeleteDueAt,
} from './sessionDeleteQueue';
import type { PendingSessionDelete } from './persistence';

const intent = (sessionId: string, nextAttemptAt: number): PendingSessionDelete => ({
    sessionId,
    machineId: 'machine-1',
    at: 0,
    attempts: 0,
    nextAttemptAt,
});

describe('delete retry ladder', () => {
    it('waits longer after each failed attempt, then keeps a steady beat', () => {
        // The first retry is soon enough to catch a machine that just blinked; the last is slow
        // enough that a machine which is off for the evening is not a battery cost.
        expect(deleteRetryDelayMs(1)).toBe(5_000);
        expect(deleteRetryDelayMs(2)).toBe(15_000);
        expect(deleteRetryDelayMs(3)).toBe(60_000);
        expect(deleteRetryDelayMs(4)).toBe(5 * 60_000);
        expect(deleteRetryDelayMs(5)).toBe(15 * 60_000);
        expect(deleteRetryDelayMs(50)).toBe(DELETE_RETRY_DELAYS_MS[DELETE_RETRY_DELAYS_MS.length - 1]);
        expect(nextDeleteAttemptAt(2, 1_000)).toBe(16_000);
    });
});

describe('which intents are due', () => {
    it('returns only the ones whose wait is over, oldest due first', () => {
        const intents = {
            a: intent('a', 2_000),
            b: intent('b', 500),
            c: intent('c', 9_000),
        };
        expect(dueSessionDeletes(intents, 2_000).map((i) => i.sessionId)).toEqual(['b', 'a']);
    });

    it('names the next moment any of them is worth an attempt', () => {
        expect(nextDeleteDueAt({})).toBeNull();
        expect(nextDeleteDueAt({ a: intent('a', 2_000), b: intent('b', 500) })).toBe(500);
    });
});

describe('reading an archive answer into a decision about the intent', () => {
    it('stops asking once the machine has recorded the deletion', () => {
        expect(decideSessionDelete({ kind: 'archived' }, 0, 1_000)).toEqual({ kind: 'archived' });
    });

    it('keeps the old road for a build without the archive route', () => {
        // A machine that answered and has no route is not offline; it is an older build, and the
        // server's delete is what this request did before the route existed.
        expect(decideSessionDelete({ kind: 'unsupported' }, 0, 1_000)).toEqual({ kind: 'legacy-server' });
    });

    it('takes a refusal as the answer and does not retry it', () => {
        expect(decideSessionDelete({ kind: 'refused', body: 'not yours' }, 0, 1_000))
            .toEqual({ kind: 'refused', message: 'not yours' });
        expect(decideSessionDelete({ kind: 'refused' }, 0, 1_000))
            .toMatchObject({ kind: 'refused' });
    });

    it('treats silence as lateness: keep the intent and move its next attempt out', () => {
        expect(decideSessionDelete({ kind: 'unavailable' }, 0, 1_000)).toEqual({
            kind: 'retry',
            attempts: 1,
            nextAttemptAt: 6_000,
            lastError: 'The machine is not reachable',
        });
        expect(decideSessionDelete({ kind: 'unavailable' }, 1, 6_000)).toMatchObject({
            attempts: 2,
            nextAttemptAt: 21_000,
        });
    });
});
