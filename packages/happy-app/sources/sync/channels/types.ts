/**
 * What a channel is, as far as anything above it is concerned.
 *
 * There is more than one way to reach a session, and each knows different things: the server holds
 * a copy that survives the machine being unreachable and goes stale; the LAN is the machine on this
 * network answering for itself; the relay is the same machine through the hub. The details are per
 * channel and they are not the business of anything that draws a session — a badge, a count, a sort
 * order and a status line all want the same two facts (is anything reaching this session, and over
 * which channel), and each working it out for itself out of raw channel state is how the same
 * session came to be "online" on one line of a row and one of three on the line above it.
 *
 * So each channel is a *driver*: a small thing that answers the same questions about itself out of
 * whatever its own state happens to look like. Above them nothing knows the shape of any channel's
 * state, and a new channel is a new driver rather than an edit to every view.
 *
 * Pure: a driver is handed the slice it reads and a clock, and returns answers. No store, no wall
 * clock of its own — which is what makes what the App believes testable instead of inferable.
 */

import type { SessionChannel } from '@/sync/lan/types';

/** How a channel's own link is doing, for the header's row of icons. */
export type ChannelLinkState = 'connected' | 'connecting' | 'off';

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

/** What a driver is allowed to say it knows about one machine. */
export type ChannelMachineReport = {
    /** Whether this channel could carry a session on that machine right now. */
    reachable: boolean;
};

/**
 * One channel, as far as anything above it is concerned.
 *
 * Everything channel-shaped stops here: which socket is open, which sightings exist, whose
 * directory says what.
 */
export type ChannelDriver = {
    channel: SessionChannel;
    /**
     * How this channel's own link is doing on this device, or null when it has no business being
     * drawn at all — the LAN has a link only once a machine has been seen on this network, and an
     * icon for a network nothing has been seen on claims a channel that has never had anything to
     * talk to. Whether to draw a channel is the channel's own answer, because it is the one that
     * knows whether it has ever heard anything.
     */
    link(): ChannelLinkState | null;
    /**
     * What this channel can say about a session, or null when it has nothing to say about that one
     * — a machine it has never seen, a session it does not know.
     *
     * Null is not "offline": it is "not my business", and it is what keeps one channel's silence
     * from being read as a statement about a session another channel is happily serving.
     */
    session(sessionId: string, machineId: string | undefined, now: number): ChannelSessionReport | null;
    /** Whether this channel could carry a session on that machine at all right now. */
    machine(machineId: string, now: number): ChannelMachineReport | null;
};

/** The one answer anything above the drivers needs about a session. */
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
