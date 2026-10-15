import { describe, expect, it } from 'vitest';
import { resolveMachinePresence } from './machinePresence';
import type { ChannelDriver } from './channels/types';

/** A channel that reports the machine alive, reachable-but-not-alive, or says nothing about it. */
const driver = (
    channel: ChannelDriver['channel'],
    report: { reachable: boolean; alive: boolean } | null,
): ChannelDriver => ({ channel, link: () => null, session: () => null, machine: () => report, capable: () => true, supports: () => true });

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
