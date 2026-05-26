import { describe, expect, it } from 'vitest';
import { MAX_RESUME_REPLAY, resolveSessionLastSeq } from './sessionLastSeq';

describe('resolveSessionLastSeq', () => {
    it('uses server seq when no initial cursor is provided', () => {
        expect(resolveSessionLastSeq(2613, undefined)).toBe(2613);
    });

    it('honors wake catch-up below server seq', () => {
        expect(resolveSessionLastSeq(12, 10)).toBe(10);
    });

    it('replaces stale resumeAfterSeq=0 on established sessions', () => {
        expect(resolveSessionLastSeq(2613, 0)).toBe(2613);
    });

    it('keeps zero baseline for brand-new sessions', () => {
        expect(resolveSessionLastSeq(0, 0)).toBe(0);
        expect(resolveSessionLastSeq(undefined, 0)).toBe(0);
    });

    it('clamps stale resumeAfterSeq that lags far behind server seq', () => {
        const serverSeq = 8000;
        const staleResume = 100;
        expect(resolveSessionLastSeq(serverSeq, staleResume)).toBe(serverSeq - MAX_RESUME_REPLAY);
    });
});
