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
 * Three rules, each of which costs a conversation when it is got wrong, and each of which was
 * decided inline at the call site where it could not be tested:
 *
 * 1. **A page that is not adjacent to what is held is never joined to it** — unless it is a `reset`
 *    page, which is the one page that starts at the *beginning* of the log the daemon now serves,
 *    and therefore leaves nothing between it and what is held. A page cut short at its budget
 *    (`hasNewer`) is the other kind: it says the reader is further behind than one page, and
 *    appending it would leave the entries between the two unreachable while the store's fields
 *    still called the whole span cached.
 * 2. **A reader that is more than a page behind belongs at the newest page.** So a cut-short page
 *    ends by reading the tail and replacing the window with it. The alternative — walking forward a
 *    page per tick — is not catching up: it is falling behind at a fixed rate, and it is done by a
 *    reader that is by definition not reading, so the backlog it carries is a backlog nobody asked
 *    to see. What was missed stays reachable by paging back, and a long backlog was never going to
 *    be shown in full anyway. The server channel anchors its window the same way, at the newest
 *    hundred sequences rather than wherever the reader left off, so the two agree on what opening a
 *    session that has been away is meant to show.
 * 3. **A replacement throws a window away**, so it is reserved for having nothing to throw away — no
 *    window held, or a page that was cut short. Everything else *extends*.
 *
 * What is deliberately *not* decided here is an empty page. Whether an empty replacement is a failed
 * read or an empty session depends on whether a window is held and is answered where the failure is
 * recorded — and a rule decided here would have applied to a reader holding nothing, where an empty
 * page is simply what the tail is.
 */
export function judgeDaemonPage(args: {
    /** What `planDaemonRead` recommended before the read went out. */
    planned: { replace: boolean };
    /** Whether a window is held at all — the thing a replacement would throw away. */
    hasWindow: boolean;
    /** What came back, or null when the read did not serve this session at all. */
    read: { hasNewer: boolean; reset: boolean } | null;
}): PageVerdict {
    if (!args.read) {
        return { kind: 'keep' };
    }
    if (args.read.reset) {
        // The anchor is not in the log this daemon is serving: it was pruned, or the session is
        // being served from a log that has been restarted (the same id, a machine that started it
        // fresh). Either way the daemon answers from the *beginning* of what it has, so the entries
        // between that page and what is held are not missing — there are none. That makes this the
        // one page that may be joined to a window it does not abut, and replacing instead is what
        // empties a conversation the user was in the middle of reading.
        return { kind: 'extend' };
    }
    if (args.read.hasNewer) {
        // Cut short at its budget: the reader is more than one page behind, and where it belongs is
        // the newest page — not at the end of a chain of pages it has to walk.
        return { kind: 'replace-from-tail' };
    }
    if (args.planned.replace && !args.hasWindow) {
        return { kind: 'replace' };
    }
    return { kind: 'extend' };
}
