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
import type { DaemonConnectionState } from '@/sync/lan/daemonConnections';
import type { SessionChannel } from '@/sync/lan/types';
import type { ChannelDriver } from './types';

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
    lanSightings: Record<string, unknown>;
    relayEndpoints: Record<string, { source?: string }>;
    relayDirectory: Record<string, { at: number; sessions: { happySessionId: string; isAlive: boolean }[] }>;
    relayHubConnected: boolean;
};

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
            if (state.socketStatus !== 'connected' || !(machineId in state.machines)) {
                return null;
            }
            // The server can serve a machine's sessions after the machine has gone, so reachable
            // says nothing about the machine being up: that is what the server's own record is for.
            const machine = state.machines[machineId] as { active?: boolean } | undefined;
            return { reachable: true, alive: machine?.active === true };
        },
        // The server is always a channel this machine has while it is switched on: a server that
        // does not report the machine is still a channel the App could use.
        capable: () => true,
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
        machine: (machineId) => {
            // A daemon advertising itself, or a socket this App is holding to it, are both the
            // machine being up on this network — and the socket term is the one that survives a
            // browse being missed, which is why the two callers that only read sightings disagreed
            // with the resolver about the same machine.
            const seen = machineId in state.lanSightings || heldSocket(state, machineId, 'lan');
            return seen ? { reachable: true, alive: true } : null;
        },
        // Seen once on this network is what earns the glyph, whether or not it is up now.
        capable: (machineId) => machineId in state.lanSightings,
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
        // The relay vouches for what it is holding, and the machine vouches for a route it
        // published itself. A route derived from the machine key is not evidence its daemon runs a
        // relay client — every machine has one — which is why hosts that never published grew a
        // relay glyph they had not earned.
        capable: (machineId) => carrying(machineId),
        machine: (machineId) => {
            const carried = carrying(machineId) || heldSocket(state, machineId, 'relay');
            return carried ? { reachable: true, alive: true } : null;
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
