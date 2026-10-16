import { describe, expect, it } from 'vitest';
import { advanceLanEndpoint, advanceRelayEndpoint, parseLanEndpoint, parseRelayEndpoint } from './relay';

const TAG = 'a'.repeat(32);
const state = (endpoints: unknown[], at = 123) => ({ p2p: { v: 1, endpoints, at } });

describe('parseRelayEndpoint', () => {
    it('builds an https base URL, omitting the default port', () => {
        const ep = parseRelayEndpoint('m1', state([{ t: 'lan', addr: '10.0.0.2', port: 55673 }, { t: 'relay', addr: '47.80.241.214', port: 443, tag: TAG }]));
        // `published`: the machine said so itself, which is the only thing that says its daemon
        // runs a relay client — as opposed to a tag this device derived from the machine key.
        expect(ep).toEqual({ machineId: 'm1', baseUrl: `https://47.80.241.214/r/${TAG}`, source: 'published', at: 123 });
    });

    it('keeps a non-default port', () => {
        expect(parseRelayEndpoint('m1', state([{ t: 'relay', addr: 'relay.example.com', port: 8443, tag: TAG }]))?.baseUrl)
            .toBe(`https://relay.example.com:8443/r/${TAG}`);
    });

    it('returns null when nothing relay-shaped is published', () => {
        expect(parseRelayEndpoint('m1', null)).toBeNull();
        expect(parseRelayEndpoint('m1', {})).toBeNull();
        expect(parseRelayEndpoint('m1', state([{ t: 'lan', addr: '10.0.0.2', port: 1 }]))).toBeNull();
    });

    it('rejects values that could not be a safe URL', () => {
        for (const bad of [
            { t: 'relay', addr: 'evil.com/x?y', port: 443, tag: TAG },
            { t: 'relay', addr: 'a b', port: 443, tag: TAG },
            { t: 'relay', addr: 'host', port: 0, tag: TAG },
            { t: 'relay', addr: 'host', port: 443, tag: '../etc' },
            { t: 'relay', addr: 'host', port: 443 },
        ]) {
            expect(parseRelayEndpoint('m1', state([bad]))).toBeNull();
        }
    });
});

describe('advanceLanEndpoint', () => {
    // The rule the three carriers of an address share: the server's copy of a machine's metadata, the
    // machine's own log, and the relay's directory. They are the same claim, so they resolve the same
    // way — and a machine republishing the address it already has must not churn the store.
    const held = { baseUrl: 'http://192.168.1.5:55673', at: 1 };

    it('moves to a different address', () => {
        expect(advanceLanEndpoint(held, { baseUrl: 'http://192.168.1.99:55673', at: 2 }))
            .toEqual({ kind: 'set', endpoint: { baseUrl: 'http://192.168.1.99:55673', at: 2 } });
    });

    it('says nothing when the address is the one already held', () => {
        expect(advanceLanEndpoint(held, { baseUrl: held.baseUrl, at: 9 })).toEqual({ kind: 'none' });
    });

    it('forgets the address when the machine published none, but leaves an empty slot alone', () => {
        // A blob that parses to nothing is a machine whose metadata predates the field, so the cached
        // address goes — there is nothing left claiming it is right.
        expect(advanceLanEndpoint(held, null)).toEqual({ kind: 'clear' });
        expect(advanceLanEndpoint(undefined, null)).toEqual({ kind: 'none' });
    });

    it('sets the first address for a machine that had none', () => {
        expect(advanceLanEndpoint(undefined, { baseUrl: 'http://10.0.0.2:1234', at: 5 }).kind).toBe('set');
    });
});

describe('advanceRelayEndpoint', () => {
    const published = { machineId: 'm1', baseUrl: `https://47.80.241.214/r/${TAG}`, source: 'published' as const, at: 1 };

    it('never clears a route: a machine going quiet looks the same as a machine having none', () => {
        expect(advanceRelayEndpoint(published, null)).toEqual({ kind: 'none' });
    });

    it('replaces a route this device derived with the one the machine published', () => {
        const derived = { ...published, baseUrl: 'https://relay.example.com/r/' + TAG, source: 'derived' as const };
        expect(advanceRelayEndpoint(derived, published)).toEqual({ kind: 'set', endpoint: published });
    });

    it('says nothing when the route is unchanged, whichever way it was learned', () => {
        expect(advanceRelayEndpoint(published, { ...published, at: 99 })).toEqual({ kind: 'none' });
    });
});
