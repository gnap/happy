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
    const page = (over: { hasNewer?: boolean; reset?: boolean } = {}) => ({ hasNewer: false, reset: false, ...over });

    it('extends what is held when the page reached the end of the log', () => {
        expect(judgeDaemonPage({ planned: { replace: false }, hasWindow: true, read: page() }))
            .toEqual({ kind: 'extend' });
    });

    it('replaces only when there is nothing to throw away', () => {
        // The invariant that costs a conversation: a replacement *is* the window, so a reader with
        // one keeps it — unless one of the two cases below says the page cannot join to it.
        expect(judgeDaemonPage({ planned: { replace: true }, hasWindow: false, read: page() }))
            .toEqual({ kind: 'replace' });
        expect(judgeDaemonPage({ planned: { replace: true }, hasWindow: true, read: page() }))
            .toEqual({ kind: 'extend' });
    });

    it('reads the newest page when the reader is further behind than one page', () => {
        // The page was cut short at its budget, which says the log is more than a page further on
        // than the anchor. Walking it is falling behind at a fixed rate, on a reader that is not
        // reading — so the window goes to the newest page instead, and the rest is paged back.
        expect(judgeDaemonPage({ planned: { replace: false }, hasWindow: true, read: page({ hasNewer: true }) }))
            .toEqual({ kind: 'replace-from-tail' });
    });

    it('joins a page from a log that no longer holds the anchor', () => {
        // A reset page starts at the *beginning* of the log the daemon serves, so nothing between
        // it and what is held is missing. Replacing here emptied the conversation the user was
        // reading, which is the one thing a read must never do.
        expect(judgeDaemonPage({ planned: { replace: false }, hasWindow: true, read: page({ reset: true }) }))
            .toEqual({ kind: 'extend' });
    });

    it('keeps the window when the read did not serve this session at all', () => {
        expect(judgeDaemonPage({ planned: { replace: true }, hasWindow: true, read: null }))
            .toEqual({ kind: 'keep' });
        expect(judgeDaemonPage({ planned: { replace: false }, hasWindow: false, read: null }))
            .toEqual({ kind: 'keep' });
    });
});
