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

import type { DaemonRoute, SessionChannel } from '@/sync/lan/types';
import type { CandidateSource } from './candidates';

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
    /**
     * Whether this is the owning machine's own answer about the session, rather than an inference.
     *
     * It is what lets a *negative* mean something. Ordinarily a channel saying it is not reaching a
     * session says nothing about whether another one is, so the search goes on — but the machine
     * running the session is the only party that can see its process, and when it lists the session
     * and reports it not alive, that is the fact itself. Treating it as silence sends the question
     * on to the server, whose record says active until something tells it otherwise, and a process
     * killed by a reboot tells nobody. The session then reads as online with nothing behind it,
     * and the send that follows fails on a delivery timeout.
     */
    fromOwner?: boolean;
    /** When this channel last heard from the session, if it says. */
    seenAt?: number;
};

/**
 * What a driver is allowed to say it knows about one machine.
 *
 * Two facts, because they are two questions and the App asks both. *Reachable* is whether this
 * channel could carry traffic for the machine — what choosing a channel needs, and true of the
 * server for a machine that has gone, because the server still holds its sessions. *Alive* is
 * whether the machine itself is up over this channel — what a status dot means, and narrower: a
 * machine that stopped is still reachable over the server; it is not alive.
 */
export type ChannelMachineReport = {
    /**
     * Whether this channel could carry traffic for that machine right now — the routing question.
     *
     * Deliberately weaker evidence than `alive`: a relay address this device *derived* from the
     * machine key counts here, because the App can try it, while it says nothing about any daemon
     * having dialled the hub. Choosing a channel wants "could this work"; a status dot wants "is it
     * there".
     */
    reachable: boolean;
    /** Whether the machine itself is up, as far as this channel knows. */
    alive: boolean;
};

/**
 * Something the App asks a channel to do.
 *
 * Declared per channel rather than assumed, because the channels genuinely differ and the
 * difference is not a defect to be smoothed over: a machine's own channels can read its sessions,
 * carry a message and restart a process, while *starting* a session is an RPC the server forwards
 * to the daemon — the daemon's own API refuses it, by design and with a test that says so.
 *
 * Naming the operations is what turns "this only works over the server" from something each call
 * site discovers by failing into something the App can say before it tries.
 */
export type ChannelOperation =
    /** Read a session's messages. */
    | 'read'
    /** Hand a user message to a session. */
    | 'send'
    /** Replace a session's process with a newer build. */
    | 'restart'
    /** Ask a machine what it is running. */
    | 'identity'
    /** Ask a machine which sessions it has. */
    | 'listSessions'
    /** Replay a machine's own log of what it has started and archived. */
    | 'lifecycle'
    /** Start a new session on a machine. */
    | 'spawn'
    /** Stop a session, or the daemon. */
    | 'stop'
    /** Run something inside a session — a shell command, a file operation. */
    | 'exec';

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
     * How this channel's link to *one machine* is doing, or null when it holds nothing for it.
     *
     * The global `link()` answers "is this transport up at all", which is the header's question.
     * A machine list asks a narrower one — is this machine's own connection up — and the two can
     * disagree: one machine's socket can be reconnecting while another's is live. A driver that
     * holds per-machine connections answers here; the server, which has one connection, does not.
     */
    machineLink?(machineId: string): ChannelLinkState | null;
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
    /**
     * Whether this machine has this channel at all, whether or not it is up at the moment.
     *
     * A different question from `machine()`, and the one the per-channel glyphs ask: a channel this
     * machine has never had is *absent* from its badge, while one it has and is not currently
     * reaching is grey. The two callers of that badge used to answer this inline, and disagreed
     * about which machines had earned a relay glyph.
     */
    capable(machineId: string): boolean;
    /**
     * Whether this channel can carry an operation at all.
     *
     * A capability, not a measurement: it does not depend on whether the machine is up, only on
     * what this kind of channel is able to do. Whether it can be done *now* is a separate question,
     * asked of the same drivers' measurements.
     */
    supports(operation: ChannelOperation): boolean;
    /**
     * The endpoints this channel would use for a machine, best first.
     *
     * This is the half the channel layer was missing: a driver used to answer *whether* it could
     * carry something and nothing about *where*, so every call site above it built its own address
     * list — and they disagreed, because only one of them consulted what the addresses had actually
     * done lately. Empty means this channel has nothing to offer this machine.
     *
     * Ordered and filtered here, by the channel that knows what its own addresses mean: for the LAN
     * that is the machine's published ones, a browse's sightings and any address this App holds a
     * connection to, with the proven ones first and the demoted ones left out.
     */
    endpoints(machineId: string, now: number, options?: { forRead?: boolean }): ChannelEndpoint[];
    /**
     * The endpoint a socket should be held at for this machine, or null when this channel has
     * nothing to hold one to.
     *
     * A socket is the strongest evidence a channel has — it comes up, answers a heartbeat, and the
     * address is then *proven* rather than claimed — so which address to hold one at is the
     * channel's own decision, made from the same ordering as everything else.
     */
    socketTarget(machineId: string, now: number): ChannelEndpoint | null;
    /**
     * Whether this channel can be asked to do this for this machine, now.
     *
     * `supports` is what the *kind* of channel can do; this is that, minus the channels that have
     * nowhere to send it. A call site asks this and stops choosing: a channel that says yes will
     * carry it over its own endpoints, and one that says no is not asked twice.
     */
    accepts(operation: ChannelOperation, machineId: string, now: number): boolean;
};

/**
 * One place a channel can send something.
 *
 * The server has no address of its own — it is a single connection, not a set of machines — so it
 * is named rather than addressed, and everything that carries an operation has to handle both.
 */
export type ChannelEndpoint =
    | { kind: 'address'; route: DaemonRoute; baseUrl: string; source: CandidateSource }
    | { kind: 'server' };

/** The URL to send to, or null for an endpoint that is not an address (the server). */
export const endpointBaseUrl = (endpoint: ChannelEndpoint): string | null =>
    endpoint.kind === 'address' ? endpoint.baseUrl : null;

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

/**
 * Why a session ended up on the channel it did.
 *
 * Moved here from the sync engine verbatim, because it is a statement about channels rather than
 * about syncing, and because it is user-visible: the session's info page and the dev pages print
 * it, and a reason that stops being produced is a diagnostic that quietly disappears.
 */
export type ChannelReason =
    | 'pinned'
    | 'reachable'
    | 'session-not-loaded'
    | 'not-declared'
    | 'no-machine-id'
    | 'no-machine-key'
    | 'not-on-network'
    | 'server-down-relay'
    | 'by-priority'
    /** The daemon route answered for this session and had nothing to serve it. */

