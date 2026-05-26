/**
 * Resolve the message seq cursor when a CLI process (re)connects to a server session.
 *
 * CLI uses server `session.seq` from getOrCreateSession — no daemon coupling required.
 * Optional `initialLastSeq` (resumeAfterSeq) is only a wake/replay hint; stale values are clamped.
 */

/** Max messages to replay on connect when resumeAfterSeq lags far behind server seq. */
export const MAX_RESUME_REPLAY = 500;

export function resolveSessionLastSeq(
    sessionSeq: number | undefined,
    initialLastSeq?: number,
): number {
    const serverSeq = sessionSeq ?? 0;
    if (initialLastSeq === undefined) {
        return serverSeq;
    }
    // Daemon auto-respawn can pass resumeAfterSeq=0 (prevSeq=-1, seq=1) while
    // --resume-session-tag loads an existing session with a much higher seq.
    if (initialLastSeq === 0 && serverSeq > 0) {
        return serverSeq;
    }
    const replayGap = serverSeq - initialLastSeq;
    if (replayGap > MAX_RESUME_REPLAY) {
        return Math.max(0, serverSeq - MAX_RESUME_REPLAY);
    }
    return initialLastSeq;
}
