/**
 * How this App is reaching a machine or a session right now — asked once, and answered the same
 * way everywhere.
 *
 * There is more than one way to reach a session, and each of them knows different things:
 *
 * - **server** — the copy the server holds. Last known state, kept even when nobody can reach the
 *   machine; wrong for as long as it takes a session to report in again.
 * - **lan** — the machine on this network, answering for itself. Only exists while a machine is
 *   advertising here.
 * - **relay** — the same machine through the hub, for when it is not on this network.
 *
 * The details are per channel and they are not the business of anything that draws a session: a
 * badge, a count, a sort order and a status line all want the same two facts — is anything reaching
 * this session, and over which channel — and each of them working it out for itself out of the raw
 * channel state is how the same session came to be "online" on one line of a row and one of three
 * on the line above it.
 *
 * So each channel is a *driver*: a small thing that answers the same three questions about itself,
 * built from whatever that channel's state happens to look like. What sits above them asks once,
 * in priority order, and hands back one answer. A new channel is a new driver and nothing else:
 * no view, count or sort order is supposed to know the shape of any channel's state.
 *
 * Pure, and driven by drivers handed in rather than read from a store, so what the App believes can
 * be pinned down in a test instead of inferred from a device.
 */

import type { SessionChannel } from './lan/types';
import { normalizeChannelPriority } from './lan/channelOrder';
import type { DaemonConnectionState } from './lan/daemonConnections';

/** What a driver is allowed to say it knows about one session. */
export type ChannelSessionReport = {
    /**
     * Whether this channel is reaching the session.
     *
     * Two ways to be reaching it, and both are the channel's own business: it may have heard the
     * session itself (the server holds its last report; a daemon holds its live processes), or it
     * may be holding a connection to the machine that owns it, which is enough to reach the session
     * and is what the LAN actually offers — a session there is answered by the machine, not
     * announced by the session.
     */
    reaching: boolean;
    /** When this channel last heard from the session, if it says. */
    seenAt?: number;
};

/**
 * One channel, as far as anything above it is concerned.
 *
 * Everything channel-shaped stops here: which socket is open, which sightings exist, whose
 * directory says what. Above this line a channel has exactly these three answers.
 */
export type ChannelDriver = {
    channel: SessionChannel;
    /**
     * What this channel can say about a session, or null when it has nothing to say about that one
     * — a machine it has never seen, a session it does not know.
     *
     * Null is not "offline": it is "not my business", and it is what keeps one channel's silence
     * from being read as a statement about a session another channel is happily serving.
     */
    session(sessionId: string, machineId: string | undefined): ChannelSessionReport | null;
    /** Whether this channel could carry a session on that machine at all right now. */
    machine(machineId: string): boolean;
};

/** The one answer anything above the drivers needs. */
export type SessionReach = {
    /** Whether anything is reaching this session. */
    online: boolean;
    /**
     * The channel that is, in the order this device prefers them; null when nothing is — which is
     * a session that has stopped, not a session whose channel is merely quiet.
     */
    channel: SessionChannel | null;
    /** When the session was last heard from, from whichever channel knew, for a "last seen" line. */
    seenAt?: number;
};

/**
 * How this session is being reached, from the channel that is reaching it.
 *
 * The drivers are consulted in the order this device prefers its channels, and the first one that
 * is reaching the session is the answer: a session being served over the LAN is on the LAN even
 * while the server still believes it is away, and one the server is holding is on the server when
 * nothing closer can reach it.
 *
 * A channel that reports it is *not* reaching a session does not end the search — what it means is
 * "this one is not how you are reaching it", and whether some other channel is depends on that
 * other channel. Only reports of reaching are trusted to be about the session at all.
 */
export function resolveSessionReach(
    sessionId: string,
    machineId: string | undefined,
    drivers: readonly ChannelDriver[],
): SessionReach {
    // Every channel is asked, even after one says it is reaching the session: only the first
    // reaching one decides the answer, but the most recent word about *when* may come from another
    // — the LAN reaches a session by holding the machine open, which dates nothing.
    let reaching: SessionChannel | null = null;
    let seenAt: number | undefined;
    for (const driver of drivers) {
        const report = driver.session(sessionId, machineId);
        if (!report) {
            continue;
        }
        if (report.seenAt !== undefined && (seenAt === undefined || report.seenAt > seenAt)) {
            seenAt = report.seenAt;
        }
        if (report.reaching && reaching === null) {
            reaching = driver.channel;
        }
    }
    return reaching === null
        ? { online: false, channel: null, seenAt }
        : { online: true, channel: reaching, seenAt };
}

/**
 * Whether any channel could carry this machine right now, in priority order.
 *
 * For the machine-level question — is this machine reachable for a new session, a restart, a read —
 * where "which channel" is the sync engine's business rather than the reader's, but "is it
 * reachable at all" is still one answer.
 */
export function resolveMachineReach(machineId: string, drivers: readonly ChannelDriver[]): SessionChannel | null {
    for (const driver of drivers) {
        if (driver.machine(machineId)) {
            return driver.channel;
        }
    }
    return null;
}

//
// The drivers, over the store's own state.
//

/**
 * The slice of the store the drivers read.
 *
 * Declared as its own type rather than taken as the store's, so a driver can be built in a test out
 * of a handful of fields — which is the whole reason these are separable from the store at all.
 */
export type ChannelState = {
    socketStatus: string;
    sessions: Record<string, { active: boolean; activeAt: number }>;
    machines: Record<string, unknown>;
    daemonSockets: Record<string, DaemonConnectionState>;
    daemonSessionList: Record<string, { isAlive: boolean; via: string; at: number }>;
    lanSightings: Record<string, unknown>;
    relayEndpoints: Record<string, unknown>;
    relayDirectory: Record<string, { at: number; sessions: { happySessionId: string; isAlive: boolean }[] }>;
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
 */
function serverDriver(state: ChannelState): ChannelDriver {
    return {
        channel: 'server',
        machine: (machineId) => state.socketStatus === 'connected' && machineId in state.machines,
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
    return {
        channel: 'lan',
        machine: (machineId) => machineId in state.lanSightings || heldSocket(state, machineId, 'lan'),
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
 */
function relayDriver(state: ChannelState): ChannelDriver {
    return {
        channel: 'relay',
        machine: (machineId) => machineId in state.relayDirectory || machineId in state.relayEndpoints,
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
 */
export function channelDrivers(state: ChannelState, priority: readonly SessionChannel[]): ChannelDriver[] {
    const drivers: Record<SessionChannel, ChannelDriver> = {
        server: serverDriver(state),
        lan: lanDriver(state),
        relay: relayDriver(state),
    };
    return normalizeChannelPriority([...priority]).map((channel) => drivers[channel]);
}
