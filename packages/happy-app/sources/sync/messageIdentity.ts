/**
 * One message, however many times the wire carried it.
 *
 * A session log is a record of the *wire*, not of the conversation: a message the CLI sends is
 * appended as `out` under its local id the moment it is queued, and the server's echo is appended
 * again as `in` under the server id when it comes back — the same ciphertext, the same `localId`,
 * two entries. That is correct for a log of traffic and wrong for a page of messages: a reader
 * that maps both entries produces two bubbles for one message, with two ids.
 *
 * `localId` is the identity every delivery of one message agrees on — the optimistic bubble, the
 * queued entry, and the server's echo. Collapsing on it is the projection from wire entries to
 * messages, which is why it belongs at the boundary and not at the point where two copies have
 * already been stored, cached and rendered.
 *
 * The copy kept is the one that carries the server id (`id !== localId`): that is the entry the
 * server has acknowledged, and the id a later read of the server channel will hand back for the
 * same message. Keeping the queued copy would mean the conversation permanently identified a
 * message by an id that exists nowhere but in this log.
 */

type Identified = {
    id: string;
    localId?: string | null;
    createdAt?: number;
};

/** Whether this copy of a message is the one the server assigned an id to. */
function carriesServerId(message: Identified, localId: string): boolean {
    return message.id !== localId;
}

/**
 * The copy to keep when the same `localId` appears more than once.
 *
 * A server id wins over the queued copy regardless of order. Between two copies of the same kind
 * — the same message re-logged after a reconnect, say — the later one wins, because it is the one
 * written after the delivery completed.
 */
function preferred(candidate: Identified, current: Identified, localId: string): boolean {
    const candidateServer = carriesServerId(candidate, localId);
    const currentServer = carriesServerId(current, localId);
    if (candidateServer !== currentServer) {
        return candidateServer;
    }
    return (candidate.createdAt ?? 0) >= (current.createdAt ?? 0);
}

/**
 * Collapses the copies of one message into one, preserving order.
 *
 * Messages without a `localId` are left alone: they have no identity that survives a redelivery,
 * and guessing one from content would merge messages that only look alike.
 */
export function collapseDuplicateMessages<T extends Identified>(messages: T[]): T[] {
    const result: T[] = [];
    const at = new Map<string, number>();
    for (const message of messages) {
        const localId = message.localId ?? null;
        if (!localId) {
            result.push(message);
            continue;
        }
        const index = at.get(localId);
        if (index === undefined) {
            at.set(localId, result.length);
            result.push(message);
        } else if (preferred(message, result[index], localId)) {
            // Replaced in place: the surviving copy takes the position of the first delivery, so
            // the page keeps the order the log had.
            result[index] = message;
        }
    }
    return result;
}
