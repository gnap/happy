/**
 * Whether a session is being restarted, read off the session itself.
 *
 * A restart is not instant: the old process is signalled and waited for, a new one starts,
 * authenticates, resumes. For that stretch nothing reports the session at all — and "nothing is
 * reporting it" is exactly what a session that has *stopped* looks like. So the answer comes from
 * the one party that knows: the machine doing the restarting, which pushes it as a change to that
 * session's state. It lands on the session, and this reads it there.
 *
 * One field, one place. The machine is heard over more than one carrier — a pushed frame, the
 * listing it answers with, the snapshot a reader is handed when it connects — but they all say the
 * same thing about the same session, so there is nothing here to reconcile.
 *
 * What is left here is the one thing that does need deciding: how long a restart is believed to be
 * in flight. The value is a timestamp rather than a flag precisely so that can be decided here,
 * where the reader is, instead of being trusted forever because a clear never arrived.
 */

/**
 * How long a restart is given before the last thing the machine said is believed again.
 *
 * Long enough to cover the slow end of a restart: signal the old process, wait for it to go, boot
 * a new one, authenticate, resume. Short enough that a restart which never worked stops claiming
 * to be in progress. The daemon publishing it uses the same figure, so a reader never stops
 * believing a restart the machine still means.
 *
 * Nothing hinges on it being exact. Once the session reports itself again the online path takes
 * over and this stops being consulted, so what it really decides is how long a *silent* session is
 * given the benefit of the doubt — and being wrong on the long side costs a status line, while
 * being wrong on the short side puts the reader back to "last seen 3 minutes ago" during a restart.
 */
export const RESTART_GRACE_MS = 90_000;

/** Whether a restart written down at this time is still within its grace. */
export function restartWithinGrace(startedAt: number | null | undefined, now: number = Date.now()): boolean {
    return typeof startedAt === 'number' && now - startedAt < RESTART_GRACE_MS;
}

/**
 * Whether this session should be drawn as restarting rather than as one that has stopped.
 *
 * Deliberately says nothing about a session that *is* reporting itself. Both can be true at once —
 * the push is still going out, or the old process has not been signalled yet — and when they are,
 * the session's own report is the one to believe: a session answering happily is not one whose
 * status line should change.
 */
export function sessionIsRestarting(
    session: { restartingAt?: number | null },
    now: number = Date.now()
): boolean {
    return restartWithinGrace(session.restartingAt, now);
}
