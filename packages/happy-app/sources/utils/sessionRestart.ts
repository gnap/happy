/**
 * A restart this App asked for, and whether it is still in flight.
 *
 * A restart is not instant: the old process is signalled and waited for, a new one starts,
 * authenticates, resumes the session. For that stretch nothing reports the session at all — and
 * "nothing is reporting it" is exactly what a session that has *stopped* looks like. The party
 * that can tell the two apart is the one that asked, so it remembers asking, for as long as a
 * restart could plausibly take and no longer.
 *
 * The awkward part — how long "in flight" lasts — is here, apart from the store, so it can be
 * pinned down without one.
 */

/**
 * How long a restart is given before what the server says about the session is believed again.
 *
 * Long enough to cover the slow end of a restart: signal the old process, wait for it to go, boot
 * a new one, authenticate, resume. Short enough that a restart which never worked stops claiming
 * to be in progress.
 *
 * Nothing hinges on it being exact. Once the session reports itself again the online path takes
 * over and this stops being consulted, so what it really decides is how long a *silent* session is
 * given the benefit of the doubt — and being wrong on the long side costs a status line, while
 * being wrong on the short side puts the reader back to "last seen 3 minutes ago" during a restart
 * they just asked for.
 */
export const RESTART_GRACE_MS = 90_000;

/** Whether a restart asked for at this time is still within its grace. */
export function restartWithinGrace(askedAt: number | undefined, now: number = Date.now()): boolean {
    return askedAt !== undefined && now - askedAt < RESTART_GRACE_MS;
}

/**
 * Whether a session that is not reporting itself should be drawn as restarting.
 *
 * Deliberately says nothing about a session that *is* reporting itself. Both can be true at once —
 * the request is still going out, or the old process has not been signalled yet — and when they
 * are, the session's own report is the one to believe: a session answering happily is not one
 * whose status line should change.
 */
export function sessionIsRestarting(
    sessionId: string,
    restarting: Record<string, number>,
    now: number = Date.now()
): boolean {
    return restartWithinGrace(restarting[sessionId], now);
}
