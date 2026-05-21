/**
 * Resolve the message seq cursor when a CLI process (re)connects to a server session.
 */

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
    return initialLastSeq;
}
