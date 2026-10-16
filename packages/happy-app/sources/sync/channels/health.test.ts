import { describe, expect, it } from 'vitest';
import {
    CANDIDATE,
    backoffFor,
    candidateEligible,
    candidateFailed,
    candidateKey,
    candidateRearmed,
    candidateSucceeded,
    channelHealthFor,
    rearmAll,
    unknownCandidate,
    type CandidateHealth,
} from './health';

const T0 = 1_700_000_000_000;
const ADDRESS = 'http://192.168.5.87:55673';

/** Apply a run of failures from a starting state, one per `now` value. */
const failures = (health: CandidateHealth | undefined, ...times: number[]) =>
    times.reduce<CandidateHealth | undefined>((held, at) => candidateFailed(held, at), health);

describe('candidate health', () => {
    it('a proven address is not demoted by one failure', () => {
        // The anti-flap rule. A machine that just served a page is not made unusable by one attempt
        // that did not land, and moving the channel for it is what the session list showed as
        // flipping between LAN and relay.
        const live = candidateSucceeded(undefined, T0);
        const after = candidateFailed(live, T0 + 5_000);

        expect(after).toEqual(live);
        expect(candidateEligible(after, T0 + 5_000)).toBe(true);
    });

    it('past the dwell, one failure is recorded and the address is still tried', () => {
        const live = candidateSucceeded(undefined, T0);
        const after = candidateFailed(live, T0 + CANDIDATE.MIN_LIVE_MS);

        expect(after.phase).toBe('failing');
        expect(after.failures).toBe(1);
        expect(candidateEligible(after, T0 + CANDIDATE.MIN_LIVE_MS)).toBe(true);
    });

    it('demotes on the third consecutive failure, with a backoff', () => {
        const down = failures(undefined, T0, T0 + 1, T0 + 2);

        expect(down?.phase).toBe('down');
        // The third failure is what demotes it, so the third step of the backoff is what it waits.
        expect(down?.retryAt).toBe(T0 + 2 + backoffFor(CANDIDATE.FAILURES_TO_DEMOTE));
    });

    it('does not try a demoted address until its backoff expires', () => {
        // This is what replaces "eligible again after ninety seconds with no new evidence": an
        // address that was demoted stays demoted, and is asked less and less often.
        const down = failures(undefined, T0, T0 + 1, T0 + 2)!;
        expect(candidateEligible(down, down.retryAt! - 1)).toBe(false);
        expect(candidateEligible(down, down.retryAt!)).toBe(true);
    });

    it('doubles the backoff and stops at the ceiling', () => {
        expect(backoffFor(1)).toBe(2_000);
        expect(backoffFor(3)).toBe(8_000);
        expect(backoffFor(20)).toBe(CANDIDATE.BACKOFF_MAX_MS);
    });

    it('any success clears the run', () => {
        const tired = failures(undefined, T0, T0 + 1, T0 + 2, T0 + 3, T0 + 4)!;
        const revived = candidateSucceeded(tired, T0 + 5);

        expect(revived.phase).toBe('live');
        expect(revived.failures).toBe(0);
        expect(revived.retryAt).toBeUndefined();
    });

    it('re-arms a demoted address when something changed, and keeps a proven one proven', () => {
        const down = failures(undefined, T0, T0 + 1, T0 + 2)!;
        const rearmed = candidateRearmed(down, T0 + 100);
        expect(rearmed.phase).toBe('unknown');
        expect(rearmed.retryAt).toBeUndefined();
        expect(candidateEligible(rearmed, T0 + 100)).toBe(true);

        const live = candidateSucceeded(undefined, T0);
        expect(candidateRearmed(live, T0 + 100)).toBe(live);
    });

    it('re-arms every address at once, which is the shape a network change has', () => {
        const all = rearmAll({ a: failures(undefined, T0, T0 + 1, T0 + 2)!, b: candidateSucceeded(undefined, T0) }, T0 + 9);
        expect(all.a.phase).toBe('unknown');
        expect(all.b.phase).toBe('live');
    });
});

describe('channelHealthFor', () => {
    const key = (baseUrl: string) => candidateKey('m1', 'lan', baseUrl);

    it('separates "could carry traffic" from "the machine is there"', () => {
        // A machine whose addresses have never been tried is reachable and not alive — where the old
        // rule called it both the moment a blob mentioned it.
        const unknown = { [key(ADDRESS)]: unknownCandidate(T0) };
        expect(channelHealthFor(unknown, 'm1', 'lan', T0)).toEqual({ reachable: true, alive: false });

        const live = { [key(ADDRESS)]: candidateSucceeded(undefined, T0) };
        expect(channelHealthFor(live, 'm1', 'lan', T0)).toEqual({ reachable: true, alive: true });
    });

    it('a demoted address is not reachable, but a live sibling still is', () => {
        // One address that does not answer says nothing about the machine's other addresses.
        const other = candidateKey('m1', 'lan', 'http://10.99.0.1:55673');
        const health = {
            [other]: failures(undefined, T0, T0 + 1, T0 + 2)!,
            [key(ADDRESS)]: candidateSucceeded(undefined, T0),
        };
        expect(channelHealthFor(health, 'm1', 'lan', T0 + 3)).toEqual({ reachable: true, alive: true });

        const onlyDead = { [other]: health[other] };
        expect(channelHealthFor(onlyDead, 'm1', 'lan', T0 + 3)).toEqual({ reachable: false, alive: false });
    });

    it('says nothing about a machine it holds no address for', () => {
        expect(channelHealthFor({}, 'm1', 'lan', T0)).toEqual({ reachable: false, alive: false });
        // And a route it holds addresses for is not confused with another route's.
        expect(channelHealthFor({ [key(ADDRESS)]: candidateSucceeded(undefined, T0) }, 'm1', 'relay', T0))
            .toEqual({ reachable: false, alive: false });
    });
});
