/**
 * What this machine says a session *is*, derived in one place.
 *
 * The roster already says several partial things — `isAlive`, `restartingSince`, `origin`, the
 * stored `status` — and each was added when one reader needed one distinction. That works until a
 * second reader needs a different combination: then the same session reads differently on the LAN,
 * in the relay directory, and in a control result, because each spot recomputes the rules (or
 * forgets one). This module is the single projection: facts the daemon has, phase a reader sees.
 *
 * The phase is deliberately *above* the existing flags rather than replacing them. `isAlive` is
 * still the honest answer to "is a process running", `restartingSince` is still the timestamp
 * readers apply their own grace to, and both stay on the wire unchanged. A reader that does not
 * know about `phase` loses nothing.
 *
 * That ordering is also why restarting wins over liveness: during a restart the old process has
 * been signalled and the new one has not registered, so a phase derived from liveness alone would
 * read `Stopped` for as long as the restart takes — the exact reading the restart machinery was
 * added to stop. The facts below are ordered by how much this daemon knows about the session, not
 * by how recently each was written.
 */

export type SessionPhase =
    /** A spawn was requested and the spec is on disk; no process has reported yet. */
    | 'Scheduling'
    /** A process of ours is running but the server has not named the session yet. */
    | 'Starting'
    /** A process of ours is running and registered with the server. */
    | 'Running'
    /** This daemon is replacing the process; nothing is registered while it happens. */
    | 'Restarting'
    /** Known to this machine, with no process behind it. */
    | 'Stopped'
    /** Removed from this machine's catalog. */
    | 'Archived'
    /** Known only as another machine's record — this machine cannot say anything about it. */
    | 'Unknown';

export type SessionConditionType = 'Spawned' | 'Registered';

export type SessionCondition = {
    type: SessionConditionType;
    status: 'True' | 'False' | 'Unknown';
    /** Why the condition has that value, when the answer is not self-evident. */
    reason?: string;
    /** When this condition was observed, in epoch milliseconds. */
    updatedAt: number;
};

/** The lifecycle this machine's log can want a session to have. */
export type SessionDesiredLifecycle = 'running' | 'archived';

/**
 * A want the facts do not reflect yet, with the reason the reconciler last gave.
 *
 * `observedGeneration < generation` is the general statement; the reason makes the particular
 * one readable. `blocked` is the point at which retrying has stopped being useful — the reader
 * should show the want as stuck rather than as still in progress.
 */
export type SessionDivergence = {
    desired: SessionDesiredLifecycle;
    generation: number;
    reason: string;
    /** When the want was stated, in epoch milliseconds. */
    since: number;
    /** Attempts the reconciler has made to realize this generation, when it has tried. */
    attempts?: number;
    blocked?: boolean;
};

export type SessionStatus = {
    phase: SessionPhase;
    /**
     * The spec revision this phase is being reconciled against. `0` means this machine has no
     * spec for the session — a legacy row, or a record imported from the server.
     */
    generation: number;
    /**
     * The spec revision the phase actually reflects.
     *
     * Below `generation` means the machine has accepted a newer spec but has not converged on it
     * yet: a row is `Starting` while `generation` is the process it is starting. Equal means
     * nothing is outstanding. This is what lets a reader distinguish "settled" from "working"
     * without inventing another flag.
     */
    observedGeneration: number;
    /** When the phase was last justified by a fact, in epoch milliseconds. */
    observedAt: number;
    /** A short, human-readable explanation of the phase. */
    reason?: string;
    /** The lifecycle the log wants, when this machine has a spec for the session. */
    desiredLifecycle?: SessionDesiredLifecycle;
    /** Present while the desired lifecycle is not yet reflected by the facts. */
    divergence?: SessionDivergence;
    conditions: SessionCondition[];
};

/** The facts this machine can have about one session. All are as of `now`. */
export type SessionStatusFacts = {
    /** A process this daemon owns and can see running right now. */
    live?: {
        pid?: number;
        /** When the process was spawned, if known. */
        spawnTime?: number;
        /** The last time the session reported in, if ever. */
        lastHeartbeat?: number;
    };
    /** The server has named the session (the session webhook arrived). */
    registered?: boolean;
    /** This daemon has a spawn spec on disk and no process for it yet. */
    schedulingSince?: number;
    /** This daemon is replacing the process, since this timestamp. */
    restartingSince?: number;
    /** The durable record, when this machine has one. */
    stored?: {
        origin?: 'daemon' | 'server';
        status?: 'running' | 'stopped';
        exitReason?: string;
        exitTime?: number;
        lastHeartbeat?: number;
        updatedAt?: number;
        generation?: number;
    };
    /** The tombstone, when the session was removed from this machine's catalog. */
    archivedAt?: number;
    /** The spec revision, when known independently of the stored record. */
    generation?: number;
    /** The newest want in this machine's log, when the caller has folded one. */
    desired?: {
        lifecycle: SessionDesiredLifecycle;
        generation: number;
        /** When the want was written, in epoch milliseconds. */
        at: number;
    };
    /** What the reconciler has done about a mismatch, when it has tried. */
    reconciliation?: {
        reason: string;
        since: number;
        attempts: number;
        blocked?: boolean;
    };
    now?: number;
};

/**
 * The session's phase and the conditions behind it.
 *
 * Precedence is knowledge, not recency: a tombstone is the strongest statement, a restart in
 * flight is next (it explains why liveness reads false), a live process next, and only then the
 * durable record and the import.
 */
function projectSessionStatus(facts: SessionStatusFacts): SessionStatus {
    const now = facts.now ?? Date.now();
    const generation = facts.generation ?? facts.stored?.generation ?? 0;

    const spawned: SessionCondition = facts.live
        ? { type: 'Spawned', status: 'True', updatedAt: facts.live.spawnTime ?? now }
        : {
            type: 'Spawned',
            status: facts.schedulingSince !== undefined || facts.stored ? 'False' : 'Unknown',
            ...(facts.stored?.exitReason ? { reason: facts.stored.exitReason } : {}),
            updatedAt: facts.stored?.exitTime ?? facts.schedulingSince ?? now,
        };
    const registered: SessionCondition = facts.registered
        ? { type: 'Registered', status: 'True', updatedAt: facts.live?.lastHeartbeat ?? now }
        : {
            type: 'Registered',
            status: facts.live ? 'False' : 'Unknown',
            ...(facts.live ? { reason: 'waiting for the server to name the session' } : {}),
            updatedAt: facts.live?.spawnTime ?? now,
        };
    const conditions = [spawned, registered];

    if (facts.archivedAt !== undefined) {
        return {
            phase: 'Archived',
            generation,
            observedGeneration: generation,
            observedAt: facts.archivedAt,
            reason: 'removed from this machine',
            conditions,
        };
    }

    if (facts.restartingSince !== undefined) {
        return {
            phase: 'Restarting',
            generation,
            // The replacement is the new spec; nothing has observed it yet.
            observedGeneration: Math.max(0, generation - 1),
            observedAt: facts.restartingSince,
            reason: 'replacing the process',
            conditions,
        };
    }

    if (facts.live) {
        const observedAt = facts.live.lastHeartbeat ?? facts.live.spawnTime ?? now;
        if (facts.registered) {
            // The process that is running is the one that registered, and its generation is the
            // record's. A newer want can be accepted while that old process is still alive; saying
            // it had already observed the new generation would hide exactly that gap.
            return {
                phase: 'Running',
                generation,
                observedGeneration: facts.stored?.generation ?? generation,
                observedAt,
                conditions,
            };
        }
        return {
            phase: 'Starting',
            generation,
            observedGeneration: Math.max(0, generation - 1),
            observedAt,
            reason: 'waiting for the server to name the session',
            conditions,
        };
    }

    if (facts.schedulingSince !== undefined) {
        return {
            phase: 'Scheduling',
            generation,
            observedGeneration: Math.max(0, generation - 1),
            observedAt: facts.schedulingSince,
            reason: 'spawn requested; no process has reported yet',
            conditions,
        };
    }

    if (!facts.stored) {
        return {
            phase: 'Unknown',
            generation,
            observedGeneration: 0,
            observedAt: now,
            reason: 'this machine has no record of the session',
            conditions,
        };
    }

    if (facts.stored.origin === 'server') {
        return {
            phase: 'Unknown',
            generation,
            observedGeneration: facts.stored.generation ?? 0,
            observedAt: facts.stored.updatedAt ?? facts.stored.lastHeartbeat ?? now,
            reason: 'imported from the server; this machine does not run it',
            conditions,
        };
    }

    return {
        phase: 'Stopped',
        generation,
        // The record says which generation its process realized. A restart that never brought a
        // new process up leaves this below the spec, which is the gap the reconciler acts on.
        observedGeneration: facts.stored.generation ?? 0,
        observedAt: facts.stored.exitTime ?? facts.stored.updatedAt ?? facts.stored.lastHeartbeat ?? now,
        reason: facts.stored.exitReason ?? 'no process is running',
        conditions,
    };
}

/**
 * The session's phase, plus what the machine wants it to be when a spec says so.
 *
 * Divergence is derived from the same comparison a reader would make — the desired generation
 * against the one the facts reflect — so a reader never has to re-implement the rule. The
 * reconciler's own progress (`reconciliation`) only makes the reason more precise; its absence
 * still leaves a truthful `want-not-observed`.
 */
export function sessionStatusOf(facts: SessionStatusFacts): SessionStatus {
    const status = projectSessionStatus(facts);
    if (!facts.desired) {
        return status;
    }
    const divergence = divergenceOf(facts, status, facts.desired);
    return {
        ...status,
        desiredLifecycle: facts.desired.lifecycle,
        ...(divergence ? { divergence } : {}),
    };
}

function divergenceOf(
    facts: SessionStatusFacts,
    status: SessionStatus,
    desired: NonNullable<SessionStatusFacts['desired']>,
): SessionDivergence | undefined {
    const runningButArchived = desired.lifecycle === 'running' && status.phase === 'Archived';
    const archivedButPresent = desired.lifecycle === 'archived' && status.phase !== 'Archived';
    const wantNotObserved = desired.lifecycle === 'running'
        && status.phase !== 'Archived'
        && status.observedGeneration < desired.generation;
    if (!runningButArchived && !archivedButPresent && !wantNotObserved) {
        return undefined;
    }

    const inFlight = status.phase === 'Scheduling'
        || status.phase === 'Starting'
        || status.phase === 'Restarting';
    const reason = facts.reconciliation?.reason
        ?? (runningButArchived
            ? 'archived-but-want-running'
            : archivedButPresent
                ? 'spec-archived'
                : inFlight
                    ? 'in-flight'
                    : 'want-not-observed');
    return {
        desired: desired.lifecycle,
        generation: desired.generation,
        reason,
        since: facts.reconciliation?.since ?? desired.at,
        ...(facts.reconciliation
            ? { attempts: facts.reconciliation.attempts, blocked: facts.reconciliation.blocked === true }
            : {}),
    };
}
