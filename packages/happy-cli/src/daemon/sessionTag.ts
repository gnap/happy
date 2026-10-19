/**
 * Which tag a server-issued session id names on this machine.
 *
 * The two names are not interchangeable and only this machine can relate them: the tag is the
 * CLI's own, made at spawn, and the id is the server's, made whenever the server answers. The log
 * on disk is keyed by `(tag, site)`, so every read addressed by id has to come through here first.
 *
 * It is a function of both stores because the live one is not the durable one. The process index
 * holds a session only while its process is up, and the log outlives it — so resolving through the
 * index alone made a read fail for exactly the sessions the LAN channel exists to serve: the ones
 * on a machine whose daemon has restarted and whose server is unreachable. The persisted store is
 * the same record the lifecycle log publishes, so a reader is never told an id that the history
 * route would then refuse.
 */

/** The fields of a live `TrackedSession` this resolution reads. */
export type LiveSessionName = {
    happySessionId?: string;
    sessionTag?: string;
};

/** The fields of a `PersistedSession` this resolution reads. */
export type PersistedSessionName = {
    sessionTag?: string;
};

/**
 * The tag for `sessionId`, or null when this machine cannot name it.
 *
 * An empty tag counts as absent throughout: the persisted store writes `''` for a session whose
 * tag was never reported, and an empty tag addresses no log at all. A live entry that matches the
 * id without carrying a tag therefore falls through to the persisted store rather than ending the
 * search — it is the same session, and the earlier run may well have written the name down.
 */
export function sessionTagOf(
    sessionId: string,
    live: Iterable<LiveSessionName>,
    persisted: Readonly<Record<string, PersistedSessionName>>,
): string | null {
    if (!sessionId) {
        return null;
    }
    for (const session of live) {
        if (session.happySessionId === sessionId && session.sessionTag) {
            return session.sessionTag;
        }
    }
    return persisted[sessionId]?.sessionTag || null;
}
