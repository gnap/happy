import { describe, expect, it } from 'vitest';
import { machineChannelIcons, resolveMachinePresence, type MachineCapability, type MachineLink, type MachineReach } from './machinePresence';
import type { ChannelDriver } from './channels/types';

/** A channel that reports the machine alive, reachable-but-not-alive, or says nothing about it. */
const driver = (
    channel: ChannelDriver['channel'],
    report: { reachable: boolean; alive: boolean } | null,
): ChannelDriver => ({ channel, link: () => null, session: () => null, machine: () => report, capable: () => true, supports: () => true,
    // The endpoint members answer nothing here: these cases are about what a driver says, not about
    // where it would send anything.
    endpoints: () => [],
    socketTarget: () => null,
    accepts: () => true, });

describe('resolveMachinePresence', () => {
    it('answers with the first channel, in priority order, that reports it alive', () => {
        const alive = { reachable: true, alive: true };
        expect(resolveMachinePresence([driver('server', alive), driver('lan', alive)], 'machine-1')).toBe('server');
        expect(resolveMachinePresence([driver('lan', alive), driver('server', alive)], 'machine-1')).toBe('lan');
    });

    it('does not count a machine that is reachable but not up', () => {
        // The dot means the machine is there. The server can still serve a machine's sessions after
        // the machine itself has gone, so reachability would paint a stopped machine green.
        expect(resolveMachinePresence([
            driver('server', { reachable: true, alive: false }),
            driver('lan', { reachable: true, alive: true }),
        ], 'machine-1')).toBe('lan');
    });

    it('resolves a machine the server never reported from the channels that did', () => {
        expect(resolveMachinePresence([
            driver('lan', null),
            driver('relay', { reachable: true, alive: true }),
        ], 'machine-1')).toBe('relay');
    });

    it('is offline when no channel reports it, rather than when none has heard of it', () => {
        expect(resolveMachinePresence([driver('lan', null), driver('server', null)], 'machine-1')).toBe('offline');
        expect(resolveMachinePresence([], 'machine-1')).toBe('offline');
    });
});

const reachable: MachineReach = { server: false, lan: true, relay: true };
const capable: MachineCapability = { lan: true, relay: true };

describe('machineChannelIcons', () => {
    it('shows the relay up when the relay holds the machine, with no session stream open', () => {
        // The reboot case. Every session process is dead, so nothing has opened a stream, and the
        // socket layer's "idle" used to paint the glyph offline — which is what left no channel to
        // wake a session on.
        const link: MachineLink = { server: null, lan: null, relay: 'off' };
        const icons = machineChannelIcons(['lan', 'relay', 'server'], reachable, capable, link);
        expect(icons.find((icon) => icon.channel === 'relay')?.state).toBe('connected');
    });

    it('still lets a stream that is coming up say so', () => {
        const link: MachineLink = { server: null, lan: 'connecting', relay: 'connected' };
        const icons = machineChannelIcons(['lan', 'relay'], reachable, capable, link);
        expect(icons.map((icon) => icon.state)).toEqual(['connecting', 'connected']);
    });

    it('stays off when the machine is not reachable and nothing is connected', () => {
        const link: MachineLink = { server: null, lan: 'off', relay: 'off' };
        const icons = machineChannelIcons(
            ['lan', 'relay'],
            { server: false, lan: false, relay: false },
            capable,
            link,
        );
        expect(icons.map((icon) => icon.state)).toEqual(['off', 'off']);
    });
});
