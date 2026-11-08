/**
 * How each address a machine can be reached at is doing, in one place.
 *
 * The App used to remember failure *per route per session*, for ninety seconds: a read that came
 * back empty marked `lan` unavailable, the channel fell to another one, and when the ninety seconds
 * lapsed the route was eligible again **with no new evidence at all**. Measured on a machine whose
 * published LAN address could never serve a read, that is a sawtooth: select lan, fail, fall to
 * relay, wait ninety seconds, select lan again — and the session list visibly flips between the two.
 *
 * A failure is a fact about an *address*, not about a session and not about a route: one address
 * that does not answer says nothing about the machine's other addresses, and another session
 * reading the same machine learns nothing from either. So the state lives per address here, and it
 * only ever changes for a reason:
 *
 * - a **success** makes an address live and clears its run of failures;
 * - a **failure** is only ever "nothing answered at this address" — a refusal, a 404, or a heartbeat
 *   this daemon is too old to answer are all statements about the daemon or the session, and
 *   demoting an address for them would throw away one that works;
 * - an address that has just been proven live is **not** demoted by a single failure, which is the
 *   whole point: a momentary blip must not move the channel;
 * - an address that is demoted stays demoted until its backoff expires, and the backoff doubles.
 *
 * Pure: no store, no clock, no network. `now` is passed in, so every rule above is a test.
 */

export type CandidatePhase =
    /** Never tried, or re-armed. Tryable, and proves nothing. */
    | 'unknown'
    /** An attempt is in flight. */
    | 'probing'
    /** Something answered here, and nothing has failed since. */
    | 'live'
    /** Failures below the threshold: still tried, no longer claimed as working. */
    | 'failing'
    /** Demoted. Not tried again until `retryAt`. */
    | 'down';

export type CandidateHealth = {
    phase: CandidatePhase;
    /** Consecutive failures since the last success or re-arm. */
    failures: number;
    /** When the phase last changed — what the minimum dwell is measured from. */
    since: number;
    /** For `down`: when this address may be tried again. */
    retryAt?: number;
    /** For `live`: when it was last proven. */
    lastLiveAt?: number;
};

export const CANDIDATE = {
    /** Consecutive failures at one address before it stops being tried. */
    FAILURES_TO_DEMOTE: 3,
    /**
     * How long a proven address is protected from a single failure.
     *
     * The anti-flap rule, and the reason it is at the address rather than at the channel: a second
     * clock on the channel is how a system ends up with several that disagree.
     */
    MIN_LIVE_MS: 30_000,
    BACKOFF_BASE_MS: 2_000,
    BACKOFF_MAX_MS: 60_000,
    /** How many addresses one read may try: a page can cost a full history timeout each. */
    MAX_ATTEMPTS_PER_READ: 2,
} as const;

/** The stable name of one address, for the health map and for socket targets. */
export const candidateKey = (machineId: string, route: string, baseUrl: string): string =>
    `${machineId}|${route}|${baseUrl}`;

export function backoffFor(failures: number): number {
    return Math.min(CANDIDATE.BACKOFF_MAX_MS, CANDIDATE.BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1));
}

/** A fresh state for an address nothing is known about. */
export function unknownCandidate(now: number): CandidateHealth {
    return { phase: 'unknown', failures: 0, since: now };
}

/**
 * The address answered.
 *
 * Anything that proves the address is usable counts, whatever it was for: a page read, a handshake,
 * an identity query, a socket that came up and answered a heartbeat. They are all the same fact.
 */
export function candidateSucceeded(health: CandidateHealth | undefined, now: number): CandidateHealth {
    return { phase: 'live', failures: 0, since: now, lastLiveAt: now };
}

/**
 * Nothing answered at this address.
 *
 * A live address is protected for `MIN_LIVE_MS`: inside that window the failure is recorded as
 * nothing at all, because an address that just served a page is not made unusable by one attempt
 * that did not land. Past it, failures accumulate, and the third one demotes the address — with a
 * backoff, so a machine that is gone is asked less and less often rather than every ninety seconds.
 */
export function candidateFailed(health: CandidateHealth | undefined, now: number): CandidateHealth {
    const held = health ?? unknownCandidate(now);
    if (held.phase === 'live' && now - held.since < CANDIDATE.MIN_LIVE_MS) {
        return held;
    }
    const failures = held.failures + 1;
    if (failures >= CANDIDATE.FAILURES_TO_DEMOTE) {
        return { phase: 'down', failures, since: now, retryAt: now + backoffFor(failures), lastLiveAt: held.lastLiveAt };
    }
    return { phase: 'failing', failures, since: now, lastLiveAt: held.lastLiveAt };
}

/**
 * Whether this address may be tried now.
 *
 * `down` is the only phase that says no, and only until its backoff expires. There is no timer: the
 * question is asked when someone is about to try, which is the only moment the answer matters.
 */
export function candidateEligible(health: CandidateHealth | undefined, now: number): boolean {
    if (!health) {
        return true;
    }
    if (health.phase !== 'down') {
        return true;
    }
    return health.retryAt !== undefined && now >= health.retryAt;
}

/**
 * Forgets what went wrong, because something changed that the old answer cannot speak for: the
 * machine published a different set of addresses, the device joined another network, or the App came
 * back from a suspension. A proven address keeps its proof; a demoted one gets to try again.
 */
export function candidateRearmed(health: CandidateHealth | undefined, now: number): CandidateHealth {
    if (!health || health.phase === 'unknown') {
        return health ?? unknownCandidate(now);
    }
    if (health.phase === 'live') {
        return health;
    }
    return { phase: 'unknown', failures: 0, since: now, lastLiveAt: health.lastLiveAt };
}

/** Rearms everything — the shape a network change or a return from suspension has. */
export function rearmAll(
    health: Record<string, CandidateHealth>,
    now: number,
): Record<string, CandidateHealth> {
    const next: Record<string, CandidateHealth> = {};
    for (const [key, value] of Object.entries(health)) {
        next[key] = candidateRearmed(value, now);
    }
    return next;
}

/**
 * Whether a channel can carry traffic for a machine, and whether the machine is there.
 *
 * `reachable` means "at least one address is not demoted", which is the routing question;
 * `alive` means "at least one address has been proven", which is the badge question. The difference
 * matters: a machine whose addresses have never been tried is reachable and not alive, where the old
 * rule called it both the moment a blob mentioned it.
 */
export function channelHealthFor(
    health: Record<string, CandidateHealth>,
    machineId: string,
    route: string,
    now: number,
): { reachable: boolean; alive: boolean } {
    const prefix = `${machineId}|${route}|`;
    let reachable = false;
    let alive = false;
    for (const [key, value] of Object.entries(health)) {
        if (!key.startsWith(prefix)) {
            continue;
        }
        if (candidateEligible(value, now)) {
            reachable = true;
        }
        if (value.phase === 'live') {
            alive = true;
        }
    }
    return { reachable, alive };
}
