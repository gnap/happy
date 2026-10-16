/**
 * Replaying a machine's record of deleted sessions to the server.
 *
 * The daemon's log is where a deletion is written first, whichever channel asked for it — an App on
 * the LAN or through the relay is asking a machine, and the machine is the party that knows the
 * session is gone. The server is another channel that has to hear about it, and it is the one that
 * is *slow*: on a machine whose server connection takes a minute to come up, doing this inline would
 * mean a delete that only lands when the network happens to cooperate.
 *
 * So the server has a cursor of its own — where *that* channel has been replayed to — and this
 * walks what is past it. The cursor is why the two are decoupled: the LAN reader may be at the end
 * of the log while the server is still at the beginning, and neither waits for the other.
 *
 * The walk stops at the first refusal rather than skipping past it. Entries are ordered, and
 * advancing past one that did not land is how a deletion is lost for good.
 */

import type { LifecycleEntry } from './lifecycleLog';

/** What this needs from the server channel, injected so the walk can be tested without one. */
export type ServerReplay = {
    /** Removes one session, or reports that it could not. */
    remove: (sessionId: string) => Promise<boolean>;
    /**
     * Where this channel stands — called once per entry that landed, so a crash between two of them
     * resumes from the right one rather than from the start.
     */
    advance: (revision: number) => void;
};

/**
 * Walks the deletions the server has not been told about.
 *
 * Returns the revision the server channel now stands at. A `created` entry is passed over without
 * being sent anywhere: a session registers itself with the server, which is the path that has
 * always existed, so this channel only ever has to carry the endings.
 */
export async function replayDeletions(
    entries: readonly LifecycleEntry[],
    cursor: number,
    server: ServerReplay,
): Promise<number> {
    let at = cursor;
    for (const entry of entries) {
        if (entry.rev <= at) {
            continue;
        }
        if (entry.op === 'deleted' && entry.sessionId) {
            if (!(await server.remove(entry.sessionId))) {
                // Left at the entry before it, so the next attempt starts here.
                return at;
            }
        }
        // A deletion for a session the server never named has nothing to remove, and a creation is
        // not this channel's business: both are simply behind us now.
        at = entry.rev;
        server.advance(at);
    }
    return at;
}
