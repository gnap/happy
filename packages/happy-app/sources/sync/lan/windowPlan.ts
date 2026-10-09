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
