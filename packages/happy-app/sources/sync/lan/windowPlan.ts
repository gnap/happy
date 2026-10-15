/**
 * How a daemon read is steered, given the window this App already holds.
 *
 * A daemon log is addressed by position, and a read may land anywhere in it. Two windows that are
 * not adjacent must never be joined: the messages between them would never arrive, and nothing
 * downstream can tell, because the store's window fields still describe one contiguous span and
 * its bitmap still calls the whole range cached. So every read is either
 *
 * - an *extension*, when it starts exactly at an edge of what is held (the daemon returns a page
 *   beginning at the anchor it was given, and dedup absorbs the overlap), or
 * - a *replacement*, when it does not: the page becomes the whole window, and everything before it
 *   is left as older history to be read on demand.
 *
 * Replacement is how a reader that was away catches up without carrying the backlog: it lands on
 * the newest page, which is the only part of a long backlog it could show anyway. This mirrors the
 * server channel, which anchors its window near the session's newest seq.
 */

/** Which page to ask for. */
export type ReadIntent = { kind: 'tail' } | { kind: 'follow'; cursor: string } | { kind: 'older'; before: string };

export type WindowAnchor = { cursor: string };

/**
 * The first request for a session: continue from the window's own edge when there is one, and read
 * the newest page when there is not — a reader with no window has nothing to extend.
 */
export function planDaemonRead(anchor: WindowAnchor | null): { page: ReadIntent; replace: boolean } {
    return anchor
        ? { page: { kind: 'follow', cursor: anchor.cursor }, replace: false }
        : { page: { kind: 'tail' }, replace: true };
}

/**
 * Whether a page that came back means the window must be replaced after all.
 *
 * `hasNewer` says the page was cut short at its budget, so the log is further away than one page
 * and walking to it one page per tick is not catching up — it is falling behind at a fixed rate.
 * `reset` says the anchor was pruned out from under the reader, so what is held describes a log
 * that no longer starts where it thinks. Both end at the newest page.
 */
export function pageMovedTheLog(page: { hasNewer: boolean; reset: boolean }): boolean {
    return page.hasNewer || page.reset;
}

/** What to do with the page that came back, once it has. */
export type PageVerdict =
    /** The page becomes the whole window. */
    | { kind: 'replace' }
    /** Read the newest page first, then replace with it — the log moved past what is held. */
    | { kind: 'replace-from-tail' }
    /** Add it to what is held. */
    | { kind: 'extend' }
    /** The read did not serve this session at all: what is held stays as it is. */
    | { kind: 'keep' };

/**
 * What to do with the page a daemon read returned.
 *
 * Two invariants, both of which cost a conversation when they are got wrong, and both of which were
 * decided inline at the call site where neither could be tested:
 *
 * 1. **A replacement throws a window away**, so it is reserved for having nothing to throw away —
 *    no window held, or an anchor the log has pruned past, where what is held is older than
 *    anything the daemon can still serve and no read can connect to it. A window that is merely
 *    behind is *extended*: the caller comes back for more while `hasNewer` holds, which is what the
 *    server path does with its own paging rather than jumping and leaving a gap.
 * 2. **Two windows that are not adjacent are never joined**, so a page that turns out to have moved
 *    the log is re-read from the newest end rather than appended.
 *
 * What is deliberately *not* decided here is an empty page. Whether an empty replacement is a
 * failed read or an empty session depends on whether a window is held and is answered where the
 * failure is recorded — and a rule decided here would have applied to a reader holding nothing,
 * where an empty page is simply what the tail is.
 */
export function judgeDaemonPage(args: {
    /** What `planDaemonRead` recommended before the read went out. */
    planned: { replace: boolean };
    /** Whether a window is held at all — the thing a replacement would throw away. */
    hasWindow: boolean;
    /** What came back, or null when the read did not serve this session at all. */
    read: { reset: boolean } | null;
}): PageVerdict {
    if (!args.read) {
        return { kind: 'keep' };
    }
    if (args.planned.replace && !args.hasWindow) {
        return { kind: 'replace' };
    }
    if (args.read.reset) {
        // Not replaced *yet*: the page that came back is not adjacent to what is held, and the page
        // to replace it with is the newest one rather than this one.
        return { kind: 'replace-from-tail' };
    }
    return { kind: 'extend' };
}
