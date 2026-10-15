import { describe, expect, it } from 'vitest';
import { RESTARTING_TTL_MS, expiredRestarting, isRestarting } from './restartTracker';

const T0 = 1_000_000;

describe('isRestarting', () => {
    it('holds for a restart that was started within the grace', () => {
        const entries = new Map([['sess-1', T0]]);
        expect(isRestarting(entries, 'sess-1', T0)).toBe(true);
        expect(isRestarting(entries, 'sess-1', T0 + RESTARTING_TTL_MS - 1)).toBe(true);
    });

    it('stops holding once the grace has run out', () => {
        // The point of the window ending: a restart that never brought the session back must stop
        // being reported as in progress, or a session that is simply gone reads as one still coming.
        const entries = new Map([['sess-1', T0]]);
        expect(isRestarting(entries, 'sess-1', T0 + RESTARTING_TTL_MS)).toBe(false);
    });

    it('says nothing about a session nobody restarted', () => {
        expect(isRestarting(new Map(), 'sess-1', T0)).toBe(false);
        expect(isRestarting(new Map([['sess-1', T0]]), 'other', T0)).toBe(false);
    });

    it('agrees with what the sweep keeps, which is the same timestamp and the same grace', () => {
        // These two answer the same question at the two moments they are asked — while listing, and
        // while clearing — and a disagreement would show a session as restarting in one and not in
        // the other, for the length of the gap between them.
        const entries = new Map([['sess-1', T0]]);
        const at = T0 + RESTARTING_TTL_MS - 1;
        expect(isRestarting(entries, 'sess-1', at)).toBe(true);
        expect(expiredRestarting(entries, at)).toEqual([]);
    });
});

describe('expiredRestarting', () => {
    it('hands back the entries that have run out, and forgets them', () => {
        const entries = new Map([['sess-1', T0]]);
        expect(expiredRestarting(entries, T0 + RESTARTING_TTL_MS)).toEqual(['sess-1']);
        expect(entries.size).toBe(0);
    });

    it('keeps every entry still within its own grace', () => {
        const entries = new Map([['old', T0], ['new', T0 + RESTARTING_TTL_MS]]);
        expect(expiredRestarting(entries, T0 + RESTARTING_TTL_MS + 1)).toEqual(['old']);
        expect([...entries.keys()]).toEqual(['new']);
    });

    it('finds nothing when nothing has run out', () => {
        expect(expiredRestarting(new Map(), T0)).toEqual([]);
        expect(expiredRestarting(new Map([['sess-1', T0]]), T0 + 1)).toEqual([]);
    });
});
