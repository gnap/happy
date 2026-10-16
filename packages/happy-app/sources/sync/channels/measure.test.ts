import { describe, expect, it } from 'vitest';
import { channelDrivers, type ChannelState } from './measure';
import type { ChannelOperation } from './types';
import { channelsFor, operationSupported } from './resolve';
import type { ChannelDriver } from './types';
import type { DaemonConnectionState } from '@/sync/lan/daemonConnections';
import { candidateKey } from './health';

/** A store slice with nothing in it, so each test states only what it is about. */
const state = (over: Partial<ChannelState> = {}): ChannelState => ({
    socketStatus: 'connected',
    sessions: {},
    machines: {},
    daemonSockets: {},
    daemonSessionList: {},
    lanSightings: {},
    lanEndpoints: {},
    candidateHealth: {},
    relayEndpoints: {},
    relayDirectory: {},
    relayHubConnected: false,
    ...over,
});

const socket = (route: 'lan' | 'relay', phase: DaemonConnectionState['phase']): DaemonConnectionState =>
    ({ route, phase } as DaemonConnectionState);

const byChannel = (drivers: ChannelDriver[]) => drivers.map((d) => d.channel);
const LAN = 'http://192.168.5.87:55673';
const RELAY = 'https://relay.example.com/r/' + 'a'.repeat(32);

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
    const capableOf = (over: Partial<ChannelState>, channel: ChannelDriver['channel'], machineId = 'machine-1') =>
        channelDrivers(state(over), ['lan', 'relay', 'server'])
            .find((driver) => driver.channel === channel)!
            .capable(machineId);
    const machineOf = (over: Partial<ChannelState>, channel: ChannelDriver['channel'], now = 0, machineId = 'machine-1') =>
        channelDrivers(state(over), ['lan', 'relay', 'server'])
            .find((driver) => driver.channel === channel)!
            .machine(machineId, now);

    it('reaches a machine the LAN has seen, or is holding a socket to', () => {
        // Reachable and alive are different questions now. An address nothing has tried yet is worth
        // trying, which is what makes the channel usable at all; only something that answered makes
        // the machine alive, which is what the badge claims.
        expect(machineOf({}, 'lan')).toBeNull();
        // A browse that resolved it here: mDNS reaches this segment only, so this is an observation.
        expect(machineOf({ lanSightings: { 'machine-1': { baseUrl: LAN } } }, 'lan'))
            .toEqual({ reachable: true, alive: true });
        expect(machineOf({ daemonSockets: { 'machine-1:lan': socket('lan', 'opening') } }, 'lan')).toBeNull();
        expect(machineOf({ daemonSockets: { 'machine-1:lan': socket('lan', 'live') } }, 'lan'))
            .toBeNull(); // a socket with no address is not an address

        const proven = {
            lanSightings: { 'machine-1': { baseUrl: LAN } },
            candidateHealth: { [candidateKey('machine-1', 'lan', LAN)]: { phase: 'live' as const, failures: 0, since: 0 } },
        };
        expect(machineOf(proven, 'lan')).toEqual({ reachable: true, alive: true });
    });

    it('does not earn the channel glyph from an address the machine published', () => {
        // The glyph is what the list draws beside a machine, so this is the wifi icon on a machine
        // that is not on this network: publishing an address is a claim, and a claim is not having
        // observed the channel.
        const claimed = { lanEndpoints: { 'machine-1': { baseUrls: [LAN], at: 0 } } };
        expect(capableOf(claimed, 'lan')).toBe(false);
        // Seen by a browse, or answered at: then it is this device's channel for that machine.
        expect(capableOf({ lanSightings: { 'machine-1': { baseUrl: LAN } } }, 'lan')).toBe(true);
        expect(capableOf({ ...claimed, daemonSockets: { 'machine-1:lan': { ...socket('lan', 'live'), baseUrl: LAN } } }, 'lan'))
            .toBe(true);
        // And a relay route derived from the key earns nothing either: every machine has one.
        expect(capableOf({ relayEndpoints: { 'machine-1': { baseUrl: RELAY, source: 'derived' } } }, 'relay')).toBe(false);
        expect(capableOf({ relayEndpoints: { 'machine-1': { baseUrl: RELAY, source: 'published' } } }, 'relay')).toBe(true);
    });

    it('does not call a machine reachable here on the strength of an address it published', () => {
        // The machine saying where it is, on a machine that is on *its own* network, is an address
        // this device cannot use at all. Treating that as reachability is what made the App label
        // sessions on other people's LANs as LAN — and it makes discovery and the address probes
        // pointless, since their whole job is to tell those cases apart.
        const claimed = { lanEndpoints: { 'machine-1': { baseUrls: [LAN], at: 0 } } };
        expect(machineOf(claimed, 'lan')).toEqual({ reachable: false, alive: false });
        // But it is still a thing worth *trying*: a socket is opened at it, and that socket coming
        // up is the observation that makes it reachability.
        expect(machineOf({ ...claimed, daemonSockets: { 'machine-1:lan': { ...socket('lan', 'live'), baseUrl: LAN } } }, 'lan'))
            .toEqual({ reachable: true, alive: true });
    });

    it('a demoted address stops making the channel reachable, and a proven one does not', () => {
        // The rule that ends the sawtooth: an address that has been failing is out until its backoff
        // expires, instead of becoming eligible again ninety seconds later with nothing new to say.
        const down = { phase: 'down' as const, failures: 3, since: 0, retryAt: 5_000 };
        const demoted = {
            lanEndpoints: { 'machine-1': { baseUrls: [LAN], at: 0 } },
            candidateHealth: { [candidateKey('machine-1', 'lan', LAN)]: down },
        };
        expect(machineOf(demoted, 'lan', 1_000)).toBeNull();
        // Past its backoff it is offered again — as something to try, since nothing has answered.
        expect(machineOf(demoted, 'lan', 5_000)).toEqual({ reachable: false, alive: false });
    });

    it('tells a relay that is carrying the machine apart from one that merely has an address for it', () => {
        // Every machine key on this device derives a relay address whether or not that machine's
        // daemon ever dialled the hub. That address is worth *trying* — it is a route — but it is
        // not evidence that anything is there, so it routes without making the machine alive.
        // Derived from the key: every machine has one, whether or not its daemon ever dialled in, so
        // it is a route to try and not evidence that anything is there.
        expect(machineOf({ relayEndpoints: { 'machine-1': { baseUrl: RELAY, source: 'derived' } } }, 'relay'))
            .toEqual({ reachable: false, alive: false });
        // A *published* relay route is the machine saying it runs a relay client, and the relay only
        // holds a machine that dialled in — so unlike a published LAN address, this one is evidence.
        // The asymmetry is deliberate: a machine knows which addresses it has, not which of them a
        // given client can route to.
        expect(machineOf({ relayEndpoints: { 'machine-1': { baseUrl: RELAY, source: 'published' } } }, 'relay'))
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

describe('what each channel can do', () => {
    const channels = (priority: ('lan' | 'relay' | 'server')[]) => channelDrivers(state(), priority);

    it('lets a machine serve its own sessions', () => {
        // The daemon's API reads a session, takes a message for one, restarts its process and says
        // what it is running. Those are the four things the LAN and the relay can do.
        const drivers = channels(['lan', 'relay']);
        for (const operation of ['read', 'send', 'restart', 'identity', 'listSessions'] as const) {
            expect(operationSupported(drivers, operation), operation).toBe(true);
        }
    });

    it('leaves starting a session to the server, and says so when the server is off', () => {
        // Not a defect to be smoothed over: starting a session is an RPC the server forwards to the
        // daemon, and the daemon's own API refuses it. The point of naming the operations is that
        // the App can say this *before* trying, instead of reporting whatever the failure looked
        // like — which is how "the server is switched off" read as an unknown error.
        const withoutServer = channels(['lan', 'relay']);
        expect(operationSupported(withoutServer, 'spawn')).toBe(false);
        expect(operationSupported(withoutServer, 'stop')).toBe(false);
        expect(operationSupported(withoutServer, 'exec')).toBe(false);
        expect(channelsFor(withoutServer, 'spawn')).toEqual([]);
        // And with the server on, it is the only channel that offers them.
        expect(channelsFor(channels(['lan', 'server']), 'spawn')).toEqual(['server']);
    });

    it('offers a restart over both kinds of channel, which is what makes it survivable', () => {
        // The action this whole layer was first built for: a session is restarted because its
        // machine has been rebuilt, and the machine's own channel is the one that is up then.
        expect(channelsFor(channels(['lan', 'relay', 'server']), 'restart')).toEqual(['lan', 'relay', 'server']);
    });
});

describe('what a driver offers to send to', () => {
    const endpointsOf = (over: Partial<ChannelState>, channel: ChannelDriver['channel'], now = 0) =>
        channelDrivers(state(over), ['lan', 'relay', 'server'])
            .find((driver) => driver.channel === channel)!
            .endpoints('machine-1', now);
    const socketOf = (over: Partial<ChannelState>, channel: ChannelDriver['channel'], now = 0) =>
        channelDrivers(state(over), ['lan', 'relay', 'server'])
            .find((driver) => driver.channel === channel)!
            .socketTarget('machine-1', now);
    const accepts = (over: Partial<ChannelState>, channel: ChannelDriver['channel'], operation: ChannelOperation) =>
        channelDrivers(state(over), ['lan', 'relay', 'server'])
            .find((driver) => driver.channel === channel)!
            .accepts(operation, 'machine-1', 0);

    it('offers the addresses the machine published, in the order it published them', () => {
        // The half the channel layer was missing: a driver says *whether* it can carry something and
        // now also *where*, so no call site has to build an address list of its own.
        const list = endpointsOf({ lanEndpoints: { 'machine-1': { baseUrls: [LAN, 'http://192.168.5.88:55673'], at: 0 } } }, 'lan');
        expect(list).toEqual([
            { kind: 'address', route: 'lan', baseUrl: LAN, source: 'published' },
            { kind: 'address', route: 'lan', baseUrl: 'http://192.168.5.88:55673', source: 'published' },
        ]);
    });

    it('leaves a demoted address out, and offers the sibling instead', () => {
        const other = 'http://10.99.0.1:55673';
        const down = { phase: 'down' as const, failures: 3, since: 0, retryAt: 5_000 };
        const list = endpointsOf({
            lanEndpoints: { 'machine-1': { baseUrls: [other, LAN], at: 0 } },
            candidateHealth: { [candidateKey('machine-1', 'lan', other)]: down },
        }, 'lan', 1_000);
        expect(list.map((endpoint) => (endpoint.kind === 'address' ? endpoint.baseUrl : 'server'))).toEqual([LAN]);
    });

    it('holds a socket at the best address even before anything has answered there', () => {
        // That is the point of opening it: a socket coming up is what turns a claimed address into a
        // proven one, which is the strongest evidence the channel has.
        expect(socketOf({ lanEndpoints: { 'machine-1': { baseUrls: [LAN], at: 0 } } }, 'lan'))
            .toEqual({ kind: 'address', route: 'lan', baseUrl: LAN, source: 'published' });
        expect(socketOf({}, 'lan')).toBeNull();
        // The server is one connection, not a set of addresses: there is nothing to hold.
        expect(socketOf({}, 'server')).toBeNull();
    });

    it('holds a relay socket only for a machine the relay is carrying', () => {
        // Every machine with a key has a derived relay address, and holding a stream open for each of
        // those would be a connection to a machine that never dialled in.
        const derived = { relayEndpoints: { 'machine-1': { baseUrl: RELAY, source: 'derived' } } };
        expect(socketOf(derived, 'relay')).toBeNull();
        expect(endpointsOf(derived, 'relay')).toHaveLength(1); // still worth trying, not worth holding

        const carried = { ...derived, relayDirectory: { 'machine-1': { at: 0, sessions: [] } } };
        expect(socketOf(carried, 'relay')).toMatchObject({ kind: 'address', route: 'relay', baseUrl: RELAY });
    });

    it('offers the server itself only while its connection is usable', () => {
        expect(endpointsOf({ socketStatus: 'connected' }, 'server')).toEqual([{ kind: 'server' }]);
        expect(endpointsOf({ socketStatus: 'disconnected' }, 'server')).toEqual([]);
        expect(endpointsOf({ socketStatus: 'error' }, 'server')).toEqual([]);
    });

    it('accepts an operation only when it can both carry it and send it somewhere', () => {
        const withAddress = { lanEndpoints: { 'machine-1': { baseUrls: [LAN], at: 0 } } };
        expect(accepts(withAddress, 'lan', 'read')).toBe(true);
        expect(accepts(withAddress, 'lan', 'relay' as ChannelOperation)).toBe(false);
        // Nowhere to send it: no address, so nothing is accepted however capable the channel is.
        expect(accepts({}, 'lan', 'read')).toBe(false);
        // And starting a session is the server's, whichever channel is asked.
        expect(accepts(withAddress, 'lan', 'spawn')).toBe(false);
        expect(accepts(withAddress, 'server', 'spawn')).toBe(true);
    });
});
