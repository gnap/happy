import { describe, expect, it } from 'vitest';
import { CANDIDATE, candidateFailed, candidateKey, candidateSucceeded, type CandidateHealth } from './health';
import { orderedCandidates, type CandidateInputs } from './candidates';

const T0 = 1_700_000_000_000;
const LAN_A = 'http://192.168.5.87:55673';
const LAN_B = 'http://10.99.0.1:55673';
const RELAY = 'https://47.80.241.214/r/' + 'a'.repeat(32);

const inputs = (over: Partial<CandidateInputs> = {}): CandidateInputs => ({
    published: [],
    discovered: [],
    sockets: [],
    relay: [],
    health: {},
    routes: ['lan', 'relay'],
    now: T0,
    ...over,
});

const urls = (list: { baseUrl: string }[]) => list.map((c) => c.baseUrl);

describe('orderedCandidates', () => {
    it('offers the machine its own published addresses, best first', () => {
        // The list the read path never had: the machine says where it is, and both addresses are
        // worth trying when the first one turns out to be a link nothing else can route to.
        const list = orderedCandidates('m1', inputs({ published: [LAN_B, LAN_A] }));
        expect(urls(list)).toEqual([LAN_B, LAN_A]);
        expect(list[0]).toMatchObject({ machineId: 'm1', route: 'lan', source: 'published' });
    });

    it('puts a proven address above one nothing is known about', () => {
        const health: Record<string, CandidateHealth> = {
            [candidateKey('m1', 'lan', LAN_A)]: candidateSucceeded(undefined, T0),
        };
        const list = orderedCandidates('m1', inputs({ published: [LAN_B, LAN_A], health }));
        expect(urls(list)).toEqual([LAN_A, LAN_B]);
    });

    it('does not offer a demoted address, but does offer its sibling', () => {
        // One address that does not answer says nothing about the machine's other addresses — the
        // rule that a per-route failure got wrong.
        const health: Record<string, CandidateHealth> = {
            [candidateKey('m1', 'lan', LAN_B)]: candidateFailed(candidateFailed(candidateFailed(undefined, T0), T0 + 1), T0 + 2),
        };
        expect(urls(orderedCandidates('m1', inputs({ published: [LAN_B, LAN_A], health })))).toEqual([LAN_A]);
    });

    it('offers a demoted address again once its backoff has passed', () => {
        const down = candidateFailed(candidateFailed(candidateFailed(undefined, T0), T0 + 1), T0 + 2);
        const later = down.retryAt! + 1;
        expect(urls(orderedCandidates('m1', inputs({ published: [LAN_A], health: { [candidateKey('m1', 'lan', LAN_A)]: down }, now: later }))))
            .toEqual([LAN_A]);
    });

    it('ranks a connection we hold above a browse, and a claim above a derived key', () => {
        const relayDerived = { baseUrl: RELAY, source: 'derived' as const };
        const list = orderedCandidates('m1', inputs({
            published: [LAN_A],
            discovered: ['http://happy.local:55673'],
            sockets: [LAN_B],
            relay: [relayDerived],
        }));
        expect(urls(list)).toEqual([LAN_B, 'http://happy.local:55673', LAN_A, RELAY]);
    });

    it('keeps one entry per address, however many sources named it', () => {
        const list = orderedCandidates('m1', inputs({
            published: [LAN_A],
            discovered: [LAN_A],
            sockets: [LAN_A],
        }));
        expect(urls(list)).toEqual([LAN_A]);
        // And keeps the strongest claim about it.
        expect(list[0].source).toBe('socket');
    });

    it('only offers the routes that are switched on', () => {
        expect(urls(orderedCandidates('m1', inputs({ published: [LAN_A], routes: ['relay'], relay: [{ baseUrl: RELAY, source: 'derived' }] }))))
            .toEqual([RELAY]);
        expect(orderedCandidates('m1', inputs({ published: [LAN_A], routes: [] }))).toEqual([]);
    });

    it('gives a read fewer addresses and skips the wobbling ones', () => {
        // A page can cost a full history timeout, so a read cannot walk the whole list the way
        // opening a socket can.
        const many = Array.from({ length: 5 }, (_v, i) => `http://192.168.5.${i + 1}:55673`);
        expect(orderedCandidates('m1', inputs({ published: many, forRead: true }))).toHaveLength(CANDIDATE.MAX_ATTEMPTS_PER_READ);

        const wobbling = candidateFailed(candidateSucceeded(undefined, T0), T0 + CANDIDATE.MIN_LIVE_MS);
        const list = orderedCandidates('m1', inputs({
            published: [LAN_A, LAN_B],
            health: { [candidateKey('m1', 'lan', LAN_A)]: wobbling },
            forRead: true,
        }));
        // Still tried for a socket — that is how it gets the chance to stop failing.
        expect(urls(list)).toEqual([LAN_B]);
        expect(urls(orderedCandidates('m1', inputs({ published: [LAN_A, LAN_B], health: { [candidateKey('m1', 'lan', LAN_A)]: wobbling } }))))
            .toEqual([LAN_B, LAN_A]);
    });
});
