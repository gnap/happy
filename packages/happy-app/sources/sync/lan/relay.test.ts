import { describe, expect, it } from 'vitest';
import { parseRelayEndpoint } from './relay';

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
