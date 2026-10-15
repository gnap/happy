/**
 * Whether a session is being restarted — asked of every source that can know.
 *
 * A restart is not instant: the old process is signalled and waited for, a new one starts,
 * authenticates, resumes. For that stretch nothing reports the session at all — and "nothing is
 * reporting it" is exactly what a session that has *stopped* looks like. So the answer has to come
 * from somewhere other than the session, and there are three such places, none of which is
 * sufficient on its own:
 *
 * - **The machine doing it.** It publishes what it is restarting in its own state, which the server
 *   hands to every device it has, and in the session summaries it answers with on its own channels.
 *   This is what makes the state the same on every device: the party that knows is the party that
 *   says so, and nobody has to guess.
 * - **This device, if it is the one that asked.** Its own mark, so the tap has an effect on screen
 *   without waiting for a round trip — and so a device that cannot currently read the machine's
 *   state at all still knows what it just asked for.
 *
 * Every source is a *timestamp*, never a flag, and every one is read through the same grace. That
 * is what makes each of them safe to lose: a write that never landed, or a clear that never landed,
 * simply goes stale instead of leaving a session reading as restarting forever.
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

/**
 * What each source says about restarts, as this App currently holds it.
 *
 * Each is optional because each is knowable at a different time: the machine's state arrives with
 * the machine, and a daemon's own answer only exists when the App has had to ask one directly.
 */
export type RestartReports = {
    /** This device's own asks, by session id. */
    asked?: Record<string, number> | null;
    /**
     * The machine that owns the session, as the server has it. Its daemon state is where the
     * machine says which sessions it is restarting — the same place it says which build it runs.
     */
    machine?: { daemonState?: { restartingSessions?: unknown } | null } | null;
    /** What a daemon answered directly, when the server could not answer. */
    daemon?: { restartingSince?: number } | null;
};

/** Whether a restart written at this time is still within its grace. */
export function restartWithinGrace(startedAt: number | undefined, now: number = Date.now()): boolean {
    return startedAt !== undefined && now - startedAt < RESTART_GRACE_MS;
}

/**
 * Whether the machine says it is restarting this session, as of `now`.
 *
 * Read defensively: the state this comes out of is written by another process and crosses a wire,
 * so a field that is missing, empty, or not the shape this build expects means "nothing is being
 * restarted" rather than an error. An older daemon simply never says it.
 */
export function machineIsRestartingSession(machine: RestartReports['machine'], sessionId: string): number | undefined {
    const reported = machine?.daemonState?.restartingSessions;
    if (typeof reported !== 'object' || reported === null) {
        return undefined;
    }
    const startedAt = (reported as Record<string, unknown>)[sessionId];
    return typeof startedAt === 'number' ? startedAt : undefined;
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
    reports: RestartReports,
    now: number = Date.now()
): boolean {
    return restartWithinGrace(reports.asked?.[sessionId], now)
        || restartWithinGrace(machineIsRestartingSession(reports.machine, sessionId), now)
        || restartWithinGrace(reports.daemon?.restartingSince, now);
}
