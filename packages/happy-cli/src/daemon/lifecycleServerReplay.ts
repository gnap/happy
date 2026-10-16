/**
 * Replaying a machine's own log to the server.
 *
 * The daemon's log is where a fact is written first, whichever channel asked for it — an App on the
 * LAN or through the relay is asking a machine, and the machine is the party that knows. The server
 * is another channel that has to hear about it, and it is the one that is *slow*: on a machine whose
 * server connection takes a minute to come up, doing this inline would mean a change that only lands
 * when the network happens to cooperate.
 *
 * So the server has a cursor of its own — where *that* channel has been replayed to — and this walks
 * what is past it. The cursor is why the two are decoupled: the LAN reader may be at the end of the
 * log while the server is still at the beginning, and neither waits for the other.
 *
 * The walk stops at the first refusal rather than skipping past it. Entries are ordered, and
 * advancing past one that did not land is how a fact is lost for good — a deletion that never
 * reached the server, or an address the server would keep serving as the current one.
 */

import type { LifecycleEntry } from './lifecycleLog';
import type { LanEndpoint } from './lanEndpoints';

/** What this needs from the server channel, injected so the walk can be tested without one. */
export type ServerReplay = {
    /** Removes one session, or reports that it could not. */
    remove: (sessionId: string) => Promise<boolean>;
    /** Writes where the machine says it can be reached. Untyped on the wire: the server stores it. */
    publishReachable: (endpoints: LanEndpoint[], at: number) => Promise<boolean>;
    /**
     * Where this channel stands — called once per entry that landed, so a crash between two of them
     * resumes from the right one rather than from the start.
     */
    advance: (revision: number) => void;
};

/**
 * Walks what the server has not been told about.
 *
 * Returns the revision the server channel now stands at. A `created` entry is passed over without
 * being sent anywhere: a session registers itself with the server, which is the path that has always
 * existed, so this channel only has to carry what the server cannot learn on its own.
 */
export async function replayToServer(
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
        } else if (entry.op === 'reachable') {
            // The server's copy of this is a projection, not the record: it is what a client can
            // read while it is here, and the log is what says it is still true.
            if (!(await server.publishReachable(entry.endpoints, entry.at))) {
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
