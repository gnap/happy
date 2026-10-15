import { describe, expect, it } from 'vitest';
import { judgeDaemonPage, pageMovedTheLog, planDaemonRead } from './windowPlan';

describe('planDaemonRead', () => {
    it('continues from the window it already holds', () => {
        expect(planDaemonRead({ cursor: '2:40' })).toEqual({
            page: { kind: 'follow', cursor: '2:40' },
            replace: false,
        });
    });

    it('reads the newest page when it holds nothing, and replaces what the store has', () => {
        // Nothing held means nothing to extend: the messages a store may still carry came from a
        // window this App cannot place, so the page replaces them rather than joining them.
        expect(planDaemonRead(null)).toEqual({ page: { kind: 'tail' }, replace: true });
    });
});

describe('pageMovedTheLog', () => {
    it('is false for a page that reached the end of the log', () => {
        expect(pageMovedTheLog({ hasNewer: false, reset: false })).toBe(false);
    });

    it('is true when the page was cut short, so the log is further than one page', () => {
        expect(pageMovedTheLog({ hasNewer: true, reset: false })).toBe(true);
    });

    it('is true when the anchor was pruned, so what is held describes a different log', () => {
        expect(pageMovedTheLog({ hasNewer: false, reset: true })).toBe(true);
    });
});

describe('judgeDaemonPage', () => {
    it('extends what is held when the page sits next to it', () => {
        expect(judgeDaemonPage({ planned: { replace: false }, hasWindow: true, read: { reset: false } }))
            .toEqual({ kind: 'extend' });
    });

    it('replaces only when there is nothing to throw away', () => {
        // The invariant that costs a conversation: a replacement *is* the window, so a reader with
        // one keeps it and comes back for more pages instead.
        expect(judgeDaemonPage({ planned: { replace: true }, hasWindow: false, read: { reset: false } }))
            .toEqual({ kind: 'replace' });
        expect(judgeDaemonPage({ planned: { replace: true }, hasWindow: true, read: { reset: false } }))
            .toEqual({ kind: 'extend' });
    });

    it('re-reads from the newest end when the log moved past what is held', () => {
        expect(judgeDaemonPage({ planned: { replace: false }, hasWindow: true, read: { reset: true } }))
            .toEqual({ kind: 'replace-from-tail' });
    });

    it('keeps the window when the read did not serve this session at all', () => {
        expect(judgeDaemonPage({ planned: { replace: true }, hasWindow: true, read: null }))
            .toEqual({ kind: 'keep' });
        expect(judgeDaemonPage({ planned: { replace: false }, hasWindow: false, read: null }))
            .toEqual({ kind: 'keep' });
    });
});
