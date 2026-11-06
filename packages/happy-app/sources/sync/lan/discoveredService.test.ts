import { describe, expect, it } from 'vitest';
import { toDiscoveredMachine } from './discoveredService';
import type { ZeroconfService } from 'expo-zeroconf';

const service = (over: Partial<ZeroconfService> = {}): ZeroconfService => ({
    name: 'Happy (dev)',
    type: '_happy._tcp',
    domain: 'local.',
    host: 'spark.local.',
    port: 55673,
    addresses: [],
    txt: { v: '1', machineId: 'm1', accountFingerprint: 'abc' },
    ...over,
});

describe('toDiscoveredMachine', () => {
    it('uses the address the browse resolved rather than a name that would be resolved again', () => {
        // A `.local` name is a second mDNS lookup at the moment a socket opens, which is exactly
        // the lookup that fails after a suspension — while the address the browse already resolved
        // still answers.
        const machine = toDiscoveredMachine(service({ addresses: ['fe80::1', '192.168.31.74'] }));
        expect(machine?.baseUrl).toBe('http://192.168.31.74:55673');
        expect(machine?.host).toBe('192.168.31.74');
    });

    it('falls back to the hostname when the browse resolved no IPv4 address', () => {
        const machine = toDiscoveredMachine(service({ addresses: ['fe80::1'] }));
        expect(machine?.baseUrl).toBe('http://spark.local:55673');
    });

    it('keeps the trailing dot off a hostname it does use', () => {
        expect(toDiscoveredMachine(service())?.baseUrl).toBe('http://spark.local:55673');
    });
});
