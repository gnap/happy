import { describe, expect, it } from 'vitest';
import { advanceLanEndpoint, advanceRelayEndpoint, parseLanEndpoints, parseRelayEndpoint } from './relay';

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
    // way — and a machine republishing the set it already has must not churn the store.
    const held = { baseUrls: ['http://192.168.5.87:55673', 'http://10.0.0.2:55673'], at: 1 };

    it('moves to a different set of addresses', () => {
        const moved = { baseUrls: ['http://192.168.5.99:55673'], at: 2 };
        expect(advanceLanEndpoint(held, moved)).toEqual({ kind: 'set', endpoint: moved });
    });

    it('treats a reordering as a change, because the order is the machine ranking its own addresses', () => {
        const reordered = { baseUrls: [...held.baseUrls].reverse(), at: 2 };
        expect(advanceLanEndpoint(held, reordered)).toEqual({ kind: 'set', endpoint: reordered });
    });

    it('says nothing when the set is the one already held, even with a later timestamp', () => {
        expect(advanceLanEndpoint(held, { baseUrls: [...held.baseUrls], at: 9 })).toEqual({ kind: 'none' });
    });

    it('forgets the addresses when the machine published none, but leaves an empty slot alone', () => {
        // A machine that stops claiming an address is not the same as one this App never heard from:
        // the cached list goes, because nothing is claiming it any more.
        expect(advanceLanEndpoint(held, null)).toEqual({ kind: 'clear' });
        expect(advanceLanEndpoint(undefined, null)).toEqual({ kind: 'none' });
    });

    it('sets the addresses for a machine that had none', () => {
        expect(advanceLanEndpoint(undefined, { baseUrls: ['http://10.0.0.2:1234'], at: 5 }).kind).toBe('set');
    });
});

describe('parseLanEndpoints', () => {
    it('keeps every address the machine offered, in the order it offered them', () => {
        // The machine ranks its own interfaces, and the first is not always the one that answers —
        // a direct-attach port can precede the real network — so the whole list is kept rather than
        // the first entry standing for the machine.
        const parsed = parseLanEndpoints('m1', state([
            { t: 'lan', addr: '10.99.0.1', port: 55673 },
            { t: 'lan', addr: '192.168.5.87', port: 55673 },
            { t: 'ipv6', addr: '2001:db8::1', port: 55673 },
        ]));
        expect(parsed).toEqual({
            machineId: 'm1',
            baseUrls: ['http://10.99.0.1:55673', 'http://192.168.5.87:55673', 'http://[2001:db8::1]:55673'],
            at: 123,
        });
    });

    it('ignores the relay entry, which is a different kind of address', () => {
        const parsed = parseLanEndpoints('m1', state([
            { t: 'relay', addr: '47.80.241.214', port: 443, tag: TAG },
            { t: 'lan', addr: '192.168.5.87', port: 55673 },
        ]));
        expect(parsed?.baseUrls).toEqual(['http://192.168.5.87:55673']);
    });

    it('collapses a repeated address rather than trying it twice', () => {
        const parsed = parseLanEndpoints('m1', state([
            { t: 'lan', addr: '192.168.5.87', port: 55673 },
            { t: 'lan', addr: '192.168.5.87', port: 55673 },
        ]));
        expect(parsed?.baseUrls).toEqual(['http://192.168.5.87:55673']);
    });

    it('answers nothing when the blob names no address at all', () => {
        expect(parseLanEndpoints('m1', null)).toBeNull();
        expect(parseLanEndpoints('m1', {})).toBeNull();
        expect(parseLanEndpoints('m1', state([{ t: 'relay', addr: '47.80.241.214', port: 443, tag: TAG }]))).toBeNull();
        expect(parseLanEndpoints('m1', state([{ t: 'lan', addr: '', port: 1 }]))).toBeNull();
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
