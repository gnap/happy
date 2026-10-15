import { describe, expect, it } from 'vitest';
import { channelDrivers, type ChannelState } from './measure';
import type { ChannelDriver } from './types';
import type { DaemonConnectionState } from '@/sync/lan/daemonConnections';

/** A store slice with nothing in it, so each test states only what it is about. */
const state = (over: Partial<ChannelState> = {}): ChannelState => ({
    socketStatus: 'connected',
    sessions: {},
    machines: {},
    daemonSockets: {},
    daemonSessionList: {},
    lanSightings: {},
    relayEndpoints: {},
    relayDirectory: {},
    relayHubConnected: false,
    ...over,
});

const socket = (route: 'lan' | 'relay', phase: DaemonConnectionState['phase']): DaemonConnectionState =>
    ({ route, phase } as DaemonConnectionState);

const byChannel = (drivers: ChannelDriver[]) => drivers.map((d) => d.channel);

describe('channelDrivers', () => {
    it('builds the channels that are on, in the order the priority gives', () => {
        const drivers = channelDrivers(state(), ['relay', 'lan', 'server']);
        expect(byChannel(drivers)).toEqual(['relay', 'lan', 'server']);
    });

    it('leaves out a channel that is switched off', () => {
        // Omitting a channel from the list is how it is turned off, so the answer is one list —
        // and this is the one place that list is read.
        expect(byChannel(channelDrivers(state(), ['server', 'lan']))).toEqual(['server', 'lan']);
        expect(byChannel(channelDrivers(state(), ['lan']))).toEqual(['lan']);
    });

    it('falls back to the default set rather than building no channels at all', () => {
        // A device whose setting was blanked or unreadable must not end up with no channels: the
        // header would say nothing, which reads as "this App has no channels".
        expect(byChannel(channelDrivers(state(), []))).toEqual(['lan', 'server', 'relay']);
        expect(byChannel(channelDrivers(state(), ['nonsense'] as never))).toEqual(['lan', 'server', 'relay']);
    });

    it('treats the pre-relay list as never having decided about the relay', () => {
        // `['lan','server']` is the old default, not a decision about a channel that did not exist
        // when it was saved — same migration the resolver applies.
        expect(byChannel(channelDrivers(state(), ['lan', 'server']))).toEqual(['lan', 'server', 'relay']);
    });
});

describe('the channel links the header draws', () => {
    const linkOf = (over: Partial<ChannelState>, channel: ChannelDriver['channel']) =>
        channelDrivers(state(over), ['lan', 'relay', 'server'])
            .find((driver) => driver.channel === channel)!
            .link();

    it('draws the server by whether the App is connected to it', () => {
        expect(linkOf({ socketStatus: 'connected' }, 'server')).toBe('connected');
        expect(linkOf({ socketStatus: 'connecting' }, 'server')).toBe('connecting');
        // Never absent: unlike the LAN there is nothing conditional about the server existing.
        expect(linkOf({ socketStatus: 'error' }, 'server')).toBe('off');
    });

    it('draws the LAN only once something has been seen on this network', () => {
        expect(linkOf({}, 'lan')).toBeNull();
        expect(linkOf({ lanSightings: { 'machine-1': {} } }, 'lan')).toBe('connecting');
        expect(linkOf({ daemonSockets: { 'machine-1:lan': socket('lan', 'live') } }, 'lan')).toBe('connected');
    });

    it('draws the relay by the hub, not by the machines it carries', () => {
        // While it is switched on and not yet reached, the App is trying, which is the blue.
        expect(linkOf({ relayHubConnected: false }, 'relay')).toBe('connecting');
        expect(linkOf({ relayHubConnected: true }, 'relay')).toBe('connected');
    });
});

describe('what the drivers say about a machine', () => {
    const machineOf = (over: Partial<ChannelState>, channel: ChannelDriver['channel'], machineId = 'machine-1') =>
        channelDrivers(state(over), ['lan', 'relay', 'server'])
            .find((driver) => driver.channel === channel)!
            .machine(machineId, 0);

    it('reaches a machine the LAN has seen, or is holding a socket to', () => {
        expect(machineOf({}, 'lan')).toBeNull();
        expect(machineOf({ lanSightings: { 'machine-1': {} } }, 'lan')).toEqual({ reachable: true, alive: true });
        expect(machineOf({ daemonSockets: { 'machine-1:lan': socket('lan', 'opening') } }, 'lan')).toBeNull();
        expect(machineOf({ daemonSockets: { 'machine-1:lan': socket('lan', 'live') } }, 'lan')).toEqual({ reachable: true, alive: true });
    });

    it('tells a relay that is carrying the machine apart from one that merely has an address for it', () => {
        // Every machine key on this device derives a relay address whether or not that machine's
        // daemon ever dialled the hub. That address is worth *trying* — it is a route — but it is
        // not evidence that anything is there, so it routes without making the machine alive.
        expect(machineOf({ relayEndpoints: { 'machine-1': { source: 'derived' } } }, 'relay'))
            .toEqual({ reachable: true, alive: false });
        expect(machineOf({ relayEndpoints: { 'machine-1': { source: 'published' } } }, 'relay'))
            .toEqual({ reachable: true, alive: true });
        expect(machineOf({ relayDirectory: { 'machine-1': { at: 0, sessions: [] } } }, 'relay'))
            .toEqual({ reachable: true, alive: true });
        expect(machineOf({}, 'relay')).toBeNull();
    });

    it('separates what the server can route from what it knows about the machine', () => {
        // Reachable is the App's own connection being usable: the server holds every session it has
        // been told about, so a machine it has never heard of is still routable through it. Alive
        // is the server's record of the machine, which is what a spawn needs and a dot means.
        expect(machineOf({ machines: { 'machine-1': { active: true } } }, 'server'))
            .toEqual({ reachable: true, alive: true });
        expect(machineOf({ machines: { 'machine-1': { active: false } } }, 'server'))
            .toEqual({ reachable: true, alive: false });
        expect(machineOf({}, 'server')).toEqual({ reachable: true, alive: false });
        // "Connecting" is on its way and an auth failure is a credential the App still holds, so
        // neither is the server being down.
        expect(machineOf({ socketStatus: 'connecting' }, 'server')?.reachable).toBe(true);
        expect(machineOf({ socketStatus: 'auth_error' }, 'server')?.reachable).toBe(true);
        expect(machineOf({ socketStatus: 'disconnected' }, 'server')?.reachable).toBe(false);
        expect(machineOf({ socketStatus: 'error' }, 'server')?.reachable).toBe(false);
    });
});
