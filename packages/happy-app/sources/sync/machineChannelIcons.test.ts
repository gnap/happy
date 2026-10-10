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
            { channel: 'lan', up: false },
            { channel: 'server', up: true },
            { channel: 'relay', up: true },
        ]);
        expect(machineChannelIcons([...DEFAULT], reach({ server: true, lan: true }), capability({ lan: true, relay: true }))).toEqual([
            { channel: 'lan', up: true },
            { channel: 'server', up: true },
            { channel: 'relay', up: false },
        ]);
    });

    it('draws nothing for a channel the setting has switched off', () => {
        // The case that looks like a missing icon: with the server switched off there is no server
        // icon to draw, because the App is not using that channel on this device at all.
        expect(machineChannelIcons(['relay', 'lan'], reach({ relay: true }), capability({ relay: true }))).toEqual([
            { channel: 'relay', up: true },
        ]);
    });

    it('hides the LAN icon until the machine has actually been seen', () => {
        expect(machineChannelIcons(['lan', 'server'], reach({ server: true }), capability())).toEqual([
            { channel: 'server', up: true },
        ]);
    });

    it('hides the relay icon for a machine nothing vouches for', () => {
        // A tag derived from the machine key is not evidence its daemon runs a relay client, so a
        // machine that has never published a route must not grow a relay icon.
        expect(machineChannelIcons(['server', 'relay'], reach({ server: true }), capability())).toEqual([
            { channel: 'server', up: true },
        ]);
    });
});
