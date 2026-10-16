/**
 * Every address this App could try for a machine, in the order worth trying them.
 *
 * A machine is not one address. It publishes the addresses it is willing to be reached at, a browse
 * finds it on others, and this App may already hold a socket somewhere — and until now the only one
 * the read path could use was whatever a browse happened to return, which is why a machine found
 * without mDNS was selected as "on the LAN" and then could not be read there.
 *
 * Ordering is by what is known rather than by what exists: an address that has been proven comes
 * first, then one nothing is known against, then one that has failed but not enough to be demoted,
 * and a demoted address is not offered at all until its backoff expires. Within a step, an address
 * this App holds a connection to is worth more than one a browse just mentioned, which is worth
 * more than one the machine claims, which is worth more than one derived from a key.
 */

import type { DaemonRoute } from '../lan/types';
import { CANDIDATE, candidateEligible, candidateKey, type CandidateHealth } from './health';

export type CandidateSource =
    /** A connection this App holds, or last held, at this address. */
    | 'socket'
    /** A browse resolved the machine here, just now. */
    | 'mDNS'
    /** The machine's own blob named this address. */
    | 'published'
    /** Computed locally from the machine key — the relay tag, never a LAN address. */
    | 'derived';

export type Candidate = {
    machineId: string;
    route: DaemonRoute;
    baseUrl: string;
    source: CandidateSource;
};

/** What a read may try: an address that answered is worth reusing, one that just failed is not. */
const READABLE: ReadonlySet<CandidateHealth['phase']> = new Set(['live', 'unknown']);

const SOURCE_RANK: Record<CandidateSource, number> = { socket: 0, mDNS: 1, published: 2, derived: 3 };
const PHASE_RANK: Record<CandidateHealth['phase'], number> = {
    live: 0, unknown: 1, probing: 1, failing: 2, down: 3,
};

export type CandidateInputs = {
    /** Where the machine says it can be reached, best first, as it published them. */
    published: readonly string[];
    /** Where a browse just found it. */
    discovered: readonly string[];
    /** Where this App holds or held a connection. */
    sockets: readonly string[];
    /**
     * The relay's route to it, with how this App came by it: a route the relay is carrying the
     * machine on, or one the machine published, is worth more than one derived from its key.
     */
    relay: readonly { baseUrl: string; source: CandidateSource }[];
    health: Record<string, CandidateHealth>;
    /** Only these routes are offered. */
    routes: readonly DaemonRoute[];
    /** A read pays a page timeout per address, so it tries fewer and skips wobbling ones. */
    forRead?: boolean;
    max?: number;
    now: number;
};

/**
 * The addresses to try, best first.
 *
 * The same list answers "what should a socket sit on" and "what should a read try": they differ in
 * how much they can afford, not in what they believe — a read skips an address that has been
 * failing because a page can cost a full timeout, while opening a socket to it is cheap and is how
 * it gets a chance to stop failing.
 */
export function orderedCandidates(machineId: string, inputs: CandidateInputs): Candidate[] {
    const offered: Candidate[] = [];
    const add = (route: DaemonRoute, baseUrls: readonly string[], source: CandidateSource) => {
        if (!inputs.routes.includes(route)) {
            return;
        }
        for (const baseUrl of baseUrls) {
            if (baseUrl) {
                offered.push({ machineId, route, baseUrl, source });
            }
        }
    };

    add('lan', inputs.sockets, 'socket');
    add('lan', inputs.discovered, 'mDNS');
    add('lan', inputs.published, 'published');
    for (const route of inputs.relay) {
        add('relay', [route.baseUrl], route.source);
    }

    // One entry per address, keeping the best claim about it: the same address reached twice is one
    // address, and which source named it does not change where it is.
    const best = new Map<string, Candidate>();
    for (const candidate of offered) {
        const key = candidateKey(candidate.machineId, candidate.route, candidate.baseUrl);
        const held = best.get(key);
        if (!held || SOURCE_RANK[candidate.source] < SOURCE_RANK[held.source]) {
            best.set(key, candidate);
        }
    }

    const ranked = [...best.entries()]
        .map(([key, candidate]) => {
            const health = inputs.health[key];
            return { key, candidate, health };
        })
        .filter(({ health }) => candidateEligible(health, inputs.now))
        .filter(({ health }) => !inputs.forRead || health === undefined || READABLE.has(health.phase))
        .sort((a, b) => {
            const phase = PHASE_RANK[a.health?.phase ?? 'unknown'] - PHASE_RANK[b.health?.phase ?? 'unknown'];
            if (phase !== 0) {
                return phase;
            }
            // Nothing after this: `sort` is stable and the map kept insertion order, so the
            // machine's own ranking survives among addresses it claimed equally.
            return SOURCE_RANK[a.candidate.source] - SOURCE_RANK[b.candidate.source];
        })
        .map(({ candidate }) => candidate);

    const limit = inputs.max ?? (inputs.forRead ? CANDIDATE.MAX_ATTEMPTS_PER_READ : ranked.length);
    return ranked.slice(0, limit);
}
