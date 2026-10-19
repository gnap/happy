import { describe, expect, it } from 'vitest';
import { machineChannelIcons } from './machinePresence';

const DEFAULT = ['lan', 'server', 'relay'] as const;

describe('machineChannelIcons', () => {
    const reach = (over: Partial<{ server: boolean; lan: boolean; relay: boolean }> = {}) =>
        ({ server: false, lan: false, relay: false, ...over });
    const capability = (over: Partial<{ lan: boolean; relay: boolean }> = {}) =>
        ({ lan: false, relay: false, ...over });

    it('colours each channel by whether that channel reaches the machine', () => {
        // The bug this replaces: colour came from `MachinePresence`, which names only *one* way a
        // machine is reachable — so a machine that was online through the server could never show a
        // relay that was working, and every relay icon on the machine list was grey.
        expect(machineChannelIcons([...DEFAULT], reach({ server: true, relay: true }), capability({ lan: true, relay: true }))).toEqual([
            { channel: 'lan', state: 'off' },
            { channel: 'server', state: 'connected' },
            { channel: 'relay', state: 'connected' },
        ]);
        expect(machineChannelIcons([...DEFAULT], reach({ server: true, lan: true }), capability({ lan: true, relay: true }))).toEqual([
            { channel: 'lan', state: 'connected' },
            { channel: 'server', state: 'connected' },
            { channel: 'relay', state: 'off' },
        ]);
    });

    it('draws a channel by its own link when it has one, not by reach', () => {
        // Reachable and reconnecting at the same time is the state the badge used to hide: reads
        // keep working over the LAN while the socket that carries pushes and sends is being rebuilt.
        expect(machineChannelIcons(
            [...DEFAULT],
            reach({ lan: true, relay: true }),
            capability({ lan: true, relay: true }),
            { server: null, lan: 'connecting', relay: 'connected' },
        )).toEqual([
            { channel: 'lan', state: 'connecting' },
            { channel: 'server', state: 'off' },
            { channel: 'relay', state: 'connected' },
        ]);
    });

    it('falls back to reach where a channel holds no per-machine link', () => {
        expect(machineChannelIcons(
            ['lan'],
            reach({ lan: true }),
            capability({ lan: true }),
            { server: null, lan: null, relay: null },
        )).toEqual([{ channel: 'lan', state: 'connected' }]);
    });

    it('draws nothing for a channel the setting has switched off', () => {
        // The case that looks like a missing icon: with the server switched off there is no server
        // icon to draw, because the App is not using that channel on this device at all.
        expect(machineChannelIcons(['relay', 'lan'], reach({ relay: true }), capability({ relay: true }))).toEqual([
            { channel: 'relay', state: 'connected' },
        ]);
    });

    it('hides the LAN icon until the machine has actually been seen', () => {
        expect(machineChannelIcons(['lan', 'server'], reach({ server: true }), capability())).toEqual([
            { channel: 'server', state: 'connected' },
        ]);
    });

    it('hides the relay icon for a machine nothing vouches for', () => {
        // A tag derived from the machine key is not evidence its daemon runs a relay client, so a
        // machine that has never published a route must not grow a relay icon.
        expect(machineChannelIcons(['server', 'relay'], reach({ server: true }), capability())).toEqual([
            { channel: 'server', state: 'connected' },
        ]);
    });
});
