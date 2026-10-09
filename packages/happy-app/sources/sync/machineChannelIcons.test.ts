import { describe, expect, it } from 'vitest';
import { machineChannelIcons } from './machinePresence';

const DEFAULT = ['lan', 'server', 'relay'] as const;

describe('machineChannelIcons', () => {
    it('draws every enabled channel, colouring each by whether it reaches the machine', () => {
        expect(machineChannelIcons([...DEFAULT], 'server', true, true)).toEqual([
            { channel: 'lan', up: true },
            { channel: 'server', up: true },
            { channel: 'relay', up: false },
        ]);
        expect(machineChannelIcons([...DEFAULT], 'lan', true, true)).toEqual([
            { channel: 'lan', up: true },
            { channel: 'server', up: false },
            { channel: 'relay', up: false },
        ]);
    });

    it('draws nothing for a channel the setting has switched off', () => {
        // The case that looks like a missing icon: with the server switched off there is no server
        // icon to draw, because the App is not using that channel on this device at all.
        expect(machineChannelIcons(['relay', 'lan'], 'relay', false, true)).toEqual([
            { channel: 'relay', up: true },
        ]);
    });

    it('hides the LAN icon until the machine has actually been seen', () => {
        expect(machineChannelIcons(['lan', 'server'], 'server', false, false)).toEqual([
            { channel: 'server', up: true },
        ]);
    });

    it('shows a published relay route in grey until the relay answers for it', () => {
        expect(machineChannelIcons(['server', 'relay'], 'server', false, true)).toEqual([
            { channel: 'server', up: true },
            { channel: 'relay', up: false },
        ]);
    });
});
