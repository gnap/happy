/**
 * What an archive answer from the owning machine means for the person's request.
 *
 * A delete is a request to the machine that owns the session, and that machine may be asleep.
 * The App asks once, over whichever channel can carry it (LAN, relay, then the machine's server
 * socket), and reports what came back. There is deliberately no queue for another time: if
 * nothing answers, the deletion failed, the person is told, and no row is left pretending to be
 * on its way out.
 *
 * Kept free of storage and sync on purpose: it is the mapping from an answer to an outcome, and
 * the caller owns the effects.
 */

/** What the owning machine said about a delete or an archive. */
export type SessionActionOutcome =
    | { kind: 'applied' }
    | { kind: 'refused'; status?: number; body?: string }
    /** A machine answered and has no archive route: a build older than this feature. */
    | { kind: 'unsupported' }
    /** No machine channel could carry the request right now. */
    | { kind: 'unavailable' };

/** What the person's request became. */
export type SessionDeleteDecision =
    /** The machine recorded it. The deletion is a fact. */
    | { kind: 'applied' }
    /** A build from before the route: the server's delete is the road this request used to take. */
    | { kind: 'legacy-server' }
    /**
     * Nothing was recorded. The row stays and the caller says so.
     *
     * Carries only a reason the machine itself gave; an unreachable machine has none, and the
     * caller's localized "failed to delete" is the whole message.
     */
    | { kind: 'failed'; message?: string };

/**
 * Reads one machine answer as the outcome of a deletion.
 *
 * Silence is a failure, not an intention to retry later: reachability belongs to the channels,
 * and this App does not keep offline state. A refusal is the machine's answer about this account
 * or this session; a route this build does not have is a reason to use the old road once.
 */
export function decideSessionDelete(outcome: SessionActionOutcome): SessionDeleteDecision {
    if (outcome.kind === 'applied') {
        return { kind: 'applied' };
    }
    if (outcome.kind === 'unsupported') {
        return { kind: 'legacy-server' };
    }
    if (outcome.kind === 'refused') {
        return { kind: 'failed', ...(outcome.body ? { message: outcome.body } : {}) };
    }
    return { kind: 'failed' };
}
