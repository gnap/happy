/**
 * How long a daemon keeps saying that a session is being restarted.
 *
 * A restart is invisible from outside: the session stops reporting, which is exactly what an ended
 * session looks like. The daemon is the only party that knows the difference, and what it says has
 * to survive being missed, read late, or contradicted by a daemon that dies mid-restart — so the
 * state it pushes carries a *timestamp*, and readers apply the same grace to it that this uses. A
 * push that never arrived, or a clear that never arrived, then goes stale on its own instead of
 * leaving a session reading as restarting for good.
 *
 * Longer than any restart takes, so a reader never stops believing it while the daemon still means
 * it.
 */
export const RESTARTING_TTL_MS = 90_000;

/**
 * The sessions whose grace has run out, removed from `entries` as they are handed back.
 *
 * What the caller does with them is call the restart off: the daemon has stopped believing it, and
 * so must every reader. Removing them here is also what keeps a daemon that restarts a session a
 * day from holding one id per day for as long as it runs.
 */
export function expiredRestarting(
    entries: Map<string, number>,
    now: number = Date.now(),
    ttlMs: number = RESTARTING_TTL_MS,
): string[] {
    const expired: string[] = [];
    for (const [sessionId, startedAt] of entries) {
        if (now - startedAt >= ttlMs) {
            entries.delete(sessionId);
            expired.push(sessionId);
        }
    }
    return expired;
}

/**
 * Whether this session is being restarted as far as this daemon is concerned, as of `now`.
 *
 * The same grace the readers apply, from the same timestamp, so what the daemon lists and what it
 * pushes cannot disagree about a session near the end of a restart.
 */
export function isRestarting(
    entries: Map<string, number>,
    sessionId: string,
    now: number = Date.now(),
    ttlMs: number = RESTARTING_TTL_MS,
): boolean {
    const startedAt = entries.get(sessionId);
    return startedAt !== undefined && now - startedAt < ttlMs;
}
