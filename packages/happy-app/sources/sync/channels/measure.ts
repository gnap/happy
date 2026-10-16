/**
 * The three channels this App has, each answering the questions in `./types` out of its own state —
 * and nothing above this file knowing what that state looks like.
 *
 * This is where channel-shaped knowledge is allowed to live: which socket is open, which sightings
 * exist, whose directory says what. Each driver is a thin reader of the store slice it is handed;
 * the merge happens in `./resolve`, so a row, a count and a status line all get the same answer by
 * asking the same question.
 */

import { normalizeChannelPriority } from '@/sync/lan/channelOrder';
import { candidateInputsFor, orderedCandidates } from './candidates';
import { candidateKey, channelHealthFor, type CandidateHealth } from './health';
import type { DaemonConnectionState } from '@/sync/lan/daemonConnections';
import type { SessionChannel } from '@/sync/lan/types';
import type { ChannelDriver, ChannelOperation } from './types';

/**
 * The slice of the store the drivers read.
 *
 * Declared as its own type rather than taken as the store's, so a driver can be built in a test out
 * of a handful of fields — which is the whole reason these are separable from the store at all.
 */
export type ChannelState = {
    socketStatus: string;
    sessions: Record<string, { active: boolean; activeAt: number }>;
    machines: Record<string, { active?: boolean } | undefined>;
    daemonSockets: Record<string, DaemonConnectionState>;
    daemonSessionList: Record<string, { isAlive: boolean; via: string; at: number }>;
    lanSightings: Record<string, { baseUrl?: string; machineId?: string } | undefined>;
    /** Where machines published themselves on this network, for when discovery cannot find them. */
    lanEndpoints: Record<string, { baseUrls?: string[] } | undefined>;
    /**
     * What is known about each address: whether anything has answered there, and how recently it
     * stopped. This is what makes "the machine is on the LAN" a claim with evidence behind it,
     * instead of a claim a published blob makes by existing.
     */
    candidateHealth: Record<string, CandidateHealth>;
    relayEndpoints: Record<string, { baseUrl?: string; source?: string } | undefined>;
    relayDirectory: Record<string, { at: number; sessions: { happySessionId: string; isAlive: boolean }[] }>;
    relayHubConnected: boolean;
};

/**
 * What a machine's own API can do.
 *
 * The daemon serves reads, takes a message for a session it already has, restarts that session's
 * process, and says what it is running — and refuses to start sessions or run things inside them.
 * `packages/happy-cli/src/daemon/lanServer.test.ts` asserts the refusals, so this list and that
 * test are the two halves of one boundary.
 */
const DAEMON_OPERATIONS: ReadonlySet<ChannelOperation> = new Set([
    'read',
    'send',
    'restart',
    'identity',
    'listSessions',
]);

/** A connection this App is holding to a machine, on any route. */
const heldSocket = (state: ChannelState, machineId: string, route: SessionChannel): boolean =>
    Object.entries(state.daemonSockets).some(
        ([key, socket]) => key.startsWith(`${machineId}:`) && socket.route === route && socket.phase === 'live'
    );

/**
 * The server's copy of the session.
 *
 * It answers for every session it has ever been told about, which is both its value and its
 * limitation: it is the only channel that still knows a session exists when nothing can reach the
 * machine, and the only one whose answer can be minutes out of date. It says `active` — the
 * session's own last report to it — and never guesses on the machine's behalf.
 *
 * Its link is the App's one connection to the server, so it is drawn whenever it is switched on:
 * "connected", "trying", or plainly not there. It is never absent, because unlike the LAN there is
 * nothing conditional about it existing.
 */
function serverDriver(state: ChannelState): ChannelDriver {
    return {
        channel: 'server',
        link: () => (state.socketStatus === 'connected' ? 'connected'
            : state.socketStatus === 'connecting' ? 'connecting'
                : 'off'),
        machine: (machineId) => {
            // Reachable asks only whether the App's connection to the server is usable — the server
            // holds every session it has been told about, so a machine it has never heard of is
            // still routable through it. "Connecting" and an auth failure are not "down": the first
            // is on its way, and the second is a credential the App is still holding.
            const reachable = state.socketStatus !== 'disconnected' && state.socketStatus !== 'error';
            // Alive is the server's own record of the machine, and it says nothing about
            // reachability: the server can serve a machine's sessions long after the machine went.
            const machine = state.machines[machineId] as { active?: boolean } | undefined;
            return { reachable, alive: reachable && machine?.active === true };
        },
        // The server is always a channel this machine has while it is switched on: a server that
        // does not report the machine is still a channel the App could use.
        capable: () => true,
        // Everything. A machine's own channels cannot start a session — the daemon's API refuses it
        // on purpose, because starting one is the server's record to keep — and that is the whole
        // reason this axis exists.
        supports: () => true,
        session: (sessionId) => {
            const session = state.sessions[sessionId];
            if (!session) {
                return null;
            }
            return { reaching: session.active, seenAt: session.activeAt };
        },
    };
}

/**
 * The machine on this network.
 *
 * Two ways it reaches a session, and the difference matters when reading the counts: the daemon may
 * have answered with the session itself and said it is alive, or this App may be holding a session
 * open over the LAN — which is enough, because the LAN's reader is the machine, so a session being
 * read there is one the machine is serving whatever the server last heard from it.
 */
function lanDriver(state: ChannelState): ChannelDriver {
    const anySocket = (): boolean =>
        Object.values(state.daemonSockets).some((socket) => socket.route === 'lan' && socket.phase === 'live');
    return {
        channel: 'lan',
        link: () => (anySocket() ? 'connected'
            : Object.keys(state.lanSightings).length > 0 ? 'connecting'
                : null),
        machine: (machineId, now) => {
            // Every address this machine could be reached at, minus the ones that have been tried and
            // demoted. A machine with an address nothing has tried yet is reachable — that is what
            // makes it worth trying — and it is not *alive*, which is the badge's question and
            // requires something to have answered.
            //
            // What this replaced: `machineId in lanEndpoints` as both answers. A published address
            // said the machine was up whether or not it could be reached there, so the channel was
            // selected, failed, and was selected again the moment the failure was forgotten.
            const candidates = orderedCandidates(machineId, candidateInputsFor(state, machineId, { now, routes: ['lan'] }));
            if (candidates.length === 0) {
                return null;
            }
            const alive = candidates.some((candidate) =>
                state.candidateHealth[candidateKey(candidate.machineId, candidate.route, candidate.baseUrl)]?.phase === 'live');
            return { reachable: true, alive };
        },
        // Seen once on this network is what earns the glyph, whether or not it is up now.
        // Seen by a browse, or published by the machine itself — the second is what makes the LAN
        // usable on a network where multicast never reaches anyone.
        capable: (machineId) => machineId in state.lanSightings || machineId in state.lanEndpoints,
        // Capability stays "has this channel ever been had by the machine", which is what the grey
        // glyph means; whether it is reaching it *now* is `machine().alive` above.
        // A machine can serve its own sessions: read them, take a message, restart a process, say
        // what it is running. What it cannot do is start one, or act inside one — those are the
        // server's, and the daemon's API is built that way.
        supports: (operation) => DAEMON_OPERATIONS.has(operation),
        session: (sessionId, machineId) => {
            const answered = state.daemonSessionList[sessionId];
            if (answered?.via === 'lan') {
                return { reaching: answered.isAlive, seenAt: answered.at };
            }
            if (machineId && heldSocket(state, machineId, 'lan')) {
                return { reaching: true };
            }
            return null;
        },
    };
}

/**
 * The same machine through the hub, for when it is not on this network.
 *
 * The relay publishes each daemon's own session summary, so this knows what is on a machine without
 * asking it and without holding a connection to it — and says nothing at all about a machine the
 * relay is not carrying, which is what keeps its silence from reading as an answer.
 *
 * Reaching a machine over the relay needs the relay to be *carrying* it, not merely to have an
 * address for it: every machine key on this device derives a relay address, whether or not that
 * machine's daemon ever dialled the hub (`source: 'derived'`). A derived address is how the App
 * would try, not evidence that anything is there.
 */
function relayDriver(state: ChannelState): ChannelDriver {
    const carrying = (machineId: string): boolean =>
        machineId in state.relayDirectory || state.relayEndpoints[machineId]?.source === 'published';
    return {
        channel: 'relay',
        // The relay is its one connection to the hub, not the per-machine streams it carries: while
        // it is switched on and not yet reached, the App is trying, which is the blue.
        link: () => (state.relayHubConnected ? 'connected' : 'connecting'),
        // Same operations as the LAN: it is the same daemon and the same API, reached the other way.
        supports: (operation) => DAEMON_OPERATIONS.has(operation),
        // The relay vouches for what it is holding, and the machine vouches for a route it
        // published itself. A route derived from the machine key is not evidence its daemon runs a
        // relay client — every machine has one — which is why hosts that never published grew a
        // relay glyph they had not earned.
        capable: (machineId) => carrying(machineId),
        machine: (machineId, now) => {
            // Same asymmetry as the LAN, with one extra rule: the relay holding the machine is
            // itself evidence it is up, because the relay only holds a machine that dialled in.
            // Every route worth trying makes it reachable — an address derived from the machine key
            // is one the App can *try* — while being alive requires something to have answered.
            // The relay holding the machine is reachable with no address at all: it is the relay's
            // own answer about what it is carrying, and it is the one fact that does not need a
            // route this App can name.
            const carried = carrying(machineId);
            const candidates = orderedCandidates(machineId, candidateInputsFor(state, machineId, { now, routes: ['relay'] }));
            if (!carried && candidates.length === 0) {
                return null;
            }
            const answered = candidates.some((candidate) =>
                state.candidateHealth[candidateKey(candidate.machineId, candidate.route, candidate.baseUrl)]?.phase === 'live');
            return { reachable: true, alive: carried || answered };
        },
        session: (sessionId, machineId) => {
            const answered = state.daemonSessionList[sessionId];
            if (answered?.via === 'relay') {
                return { reaching: answered.isAlive, seenAt: answered.at };
            }
            const entry = machineId ? state.relayDirectory[machineId] : undefined;
            const published = entry?.sessions.find((session) => session.happySessionId === sessionId);
            if (entry && published) {
                return { reaching: published.isAlive, seenAt: entry.at };
            }
            if (machineId && heldSocket(state, machineId, 'relay')) {
                return { reaching: true };
            }
            return null;
        },
    };
}

/**
 * Every channel this device has switched on, in the order it prefers them.
 *
 * Order is the whole of the priority: the resolver takes the first channel that is reaching the
 * session, so this list *is* the policy, and the setting that holds it is the one this device has
 * always used to choose where its traffic goes.
 *
 * Built per call from the state handed in, which is cheap but not free — the drivers close over
 * nothing, so callers on a hot path are expected to hold the result for as long as their state and
 * priority are unchanged.
 */
export function channelDrivers(state: ChannelState, priority: readonly SessionChannel[]): ChannelDriver[] {
    const drivers: Record<SessionChannel, ChannelDriver> = {
        server: serverDriver(state),
        lan: lanDriver(state),
        relay: relayDriver(state),
    };
    return normalizeChannelPriority([...priority]).map((channel) => drivers[channel]);
}
