import { describe, expect, it } from 'vitest';
import { channelAvailability, resolveSessionReach, routeFailedRecently } from './resolve';
import type { ChannelDriver } from './types';

/** A driver that says the same thing about everything it is asked. */
const driver = (
    channel: ChannelDriver['channel'],
    session: ChannelDriver['session'],
    machine: ChannelDriver['machine'] = () => null,
): ChannelDriver => ({ channel, session, machine, link: () => null, capable: () => false });

const says = (channel: ChannelDriver['channel'], reaching: boolean, seenAt?: number): ChannelDriver =>
    driver(channel, () => ({ reaching, seenAt }));

const silent = (channel: ChannelDriver['channel']): ChannelDriver => driver(channel, () => null);

describe('resolveSessionReach', () => {
    it('answers with the channel the device prefers, not the first that answers at all', () => {
        // The policy is the order: a session the server still holds *and* the LAN is serving is on
        // the LAN, because that is the channel this device would use to talk to it.
        const reach = resolveSessionReach('sess-1', 'machine-1', [
            says('lan', true, 20),
            says('server', true, 10),
        ]);
        expect(reach).toEqual({ online: true, channel: 'lan', seenAt: 20 });
    });

    it('falls through a channel that is not reaching it and takes the next', () => {
        // The bug this replaces: the server believing a session is away is not evidence about a
        // session the LAN is serving, and it is what made a row read "offline" while being used.
        const reach = resolveSessionReach('sess-1', 'machine-1', [
            says('lan', true, 20),
            says('server', false, 10),
        ]);
        expect(reach).toEqual({ online: true, channel: 'lan', seenAt: 20 });
    });

    it('is offline only when every channel that knows the session says so', () => {
        const reach = resolveSessionReach('sess-1', 'machine-1', [
            says('lan', false, 30),
            says('server', false, 10),
        ]);
        expect(reach.online).toBe(false);
        expect(reach.channel).toBeNull();
        // The most recent word still dates the session, whoever it came from.
        expect(reach.seenAt).toBe(30);
    });

    it('treats a channel with nothing to say as having nothing to say', () => {
        // Not the same as "offline": a channel that does not know the session must not be able to
        // end the search, or a session on the relay would go offline whenever the LAN is quiet.
        const reach = resolveSessionReach('sess-1', 'machine-1', [
            silent('lan'),
            says('relay', true, 5),
        ]);
        expect(reach).toEqual({ online: true, channel: 'relay', seenAt: 5 });
    });

    it('knows nothing at all when no channel does', () => {
        expect(resolveSessionReach('sess-1', undefined, [silent('lan'), silent('server')]))
            .toEqual({ online: false, channel: null, seenAt: undefined });
    });

    it('carries no timestamp when the channel reaching it does not date it', () => {
        // A session being read over the LAN is reached by holding the machine open, which says
        // nothing about when the session itself was last heard from.
        const reach = resolveSessionReach('sess-1', 'machine-1', [
            driver('lan', () => ({ reaching: true })),
            says('server', false, 10),
        ]);
        expect(reach).toEqual({ online: true, channel: 'lan', seenAt: 10 });
    });
});

describe('channelAvailability', () => {
    const machineReachable = (channel: ChannelDriver['channel'], yes: boolean): ChannelDriver =>
        driver(channel, () => null, () => (yes ? { reachable: true, alive: true } : null));

    it('is what the device has measured, per channel', () => {
        expect(channelAvailability({
            drivers: [machineReachable('lan', true), machineReachable('relay', false), machineReachable('server', true)],
            sessionId: 'sess-1',
            machineId: 'machine-1',
        })).toEqual({ lan: true, relay: false, server: true });
    });

    it('counts a channel this session was read over even when the measurement has gone quiet', () => {
        // The strongest evidence there is: a read of this very session came back over that route.
        // It is why a working route is not dropped the moment a browse is missed.
        expect(channelAvailability({
            drivers: [machineReachable('lan', false), machineReachable('relay', true)],
            sessionId: 'sess-1',
            machineId: 'machine-1',
            lastReadRoute: 'lan',
        })).toEqual({ lan: true, relay: true });
    });

    it('leaves out a route that has just failed, so it is not chosen again on every tick', () => {
        const now = 1_000_000;
        expect(channelAvailability({
            drivers: [machineReachable('lan', true), machineReachable('relay', true)],
            sessionId: 'sess-1',
            machineId: 'machine-1',
            failedAt: { lan: now - 1_000 },
            now,
        })).toEqual({ lan: false, relay: true });
        // A failure also beats the read that came over it: the read was before the failure.
        expect(channelAvailability({
            drivers: [machineReachable('lan', true)],
            sessionId: 'sess-1',
            machineId: 'machine-1',
            failedAt: { lan: now - 1_000 },
            lastReadRoute: 'lan',
            now,
        })).toEqual({ lan: false });
    });

    it('brings the route back once the failure has aged out', () => {
        const failedAt = { lan: 1_000_000 };
        expect(routeFailedRecently(failedAt.lan, 1_000_000 + 89_999)).toBe(true);
        expect(routeFailedRecently(failedAt.lan, 1_000_000 + 90_000)).toBe(false);
        expect(channelAvailability({
            drivers: [machineReachable('lan', true)],
            sessionId: 'sess-1',
            machineId: 'machine-1',
            failedAt,
            now: 1_000_000 + 90_000,
        })).toEqual({ lan: true });
    });
});
