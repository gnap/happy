import type { LanSocketHandle } from './socket';
import type { DaemonRoute } from './types';

/**
 * One App, many daemons.
 *
 * A machine runs one daemon, and that daemon serves several sessions. The App wants to talk to
 * every machine it can reach — the same way it talks to the server, which is a hub that knows
 * machines and sessions. So the unit of connection is a *daemon*: identified by its machine, and
 * reachable over one route at a time (found on the local network, or through the relay). A route is
 * a transport, not a thing to connect to, and holding one socket per route — which is what this
 * used to do — meant the App could only ever talk to one of its machines per transport, replacing
 * the connection every time a different machine's session was read.
 *
 * Everything else says what it wants (per machine and route) and this makes it true: exactly one
 * connection per daemon, opened once, replaced only when the address moves, reconnected on its own
 * schedule after a drop, and never handed to a caller that is writing a session belonging to a
 * different machine.
 */
export type DaemonTarget = {
    route: DaemonRoute;
    baseUrl: string;
    machineId: string;
    machineKey: Uint8Array;
};

/** The identity of a connection: one daemon, over one route. */
export const daemonId = (machineId: string, route: DaemonRoute): string => `${machineId}:${route}`;

export type DaemonConnectionState = {
    /** Which daemon and transport this state is about. Keyed separately, repeated for grouping. */
    machineId: string;
    route: DaemonRoute;
    /**
     * What this connection is doing right now, so a reader can tell "nothing wanted" from "wanted
     * and not working" — a distinction the socket's existence alone cannot express, and the one
     * that matters when a channel is silently carrying nothing.
     */
    phase: 'live' | 'opening' | 'retrying' | 'idle';
    baseUrl?: string;
    /** When the live socket came up. */
    connectedAt?: number;
    /** For `retrying`: how many consecutive drops, and when the next attempt is due. */
    attempt?: number;
    retryAt?: number;
};

type LiveConnection = {
    handle: LanSocketHandle;
    target: DaemonTarget;
    connectedAt: number;
    /** When the outstanding heartbeat was sent, or null while the daemon has answered the last one. */
    awaitingBeatSince: number | null;
    beatTimer: ReturnType<typeof setTimeout> | null;
};

const DEFAULT_HEARTBEAT = { intervalMs: 15_000, timeoutMs: 45_000 };

type DaemonConnectionDeps = {
    /** Opens one connection, or returns null when it could not be established. */
    open: (
        target: DaemonTarget,
        handlers: {
            onUpdate: (payload: unknown) => void;
            onDelivered: (result: { sessionId: string; localId: string; delivered: boolean }) => void;
            onClosed: (info: { deliberate: boolean; code?: number; reason?: string }) => void;
            onBeat: () => void;
        },
    ) => Promise<LanSocketHandle | null>;
    onUpdate: (target: DaemonTarget, payload: unknown) => void;
    onDelivered: (target: DaemonTarget, result: { sessionId: string; localId: string; delivered: boolean }) => void;
    /** A connection came up: the sessions on that machine no longer need their polling fallback. */
    onReady?: (target: DaemonTarget) => void;
    /** A connection went away without this App asking: whatever it was carrying has lost its push. */
    onDropped?: (target: DaemonTarget) => void;
    /**
     * A connection turned out not to answer heartbeats, and is being kept anyway.
     *
     * A daemon whose CLI predates the heartbeat cannot answer one, and treating that as a dead
     * socket tears a working connection down every timeout — forever, since the answer will never
     * come. What is lost by keeping it is only the proof that the peer is alive *now*: reads still
     * work, and the caller is told to keep its polling fallback instead of stopping it.
     */
    onHeartbeatUnsupported?: (target: DaemonTarget) => void;
    /** Published for the rest of the App: what is connected, per daemon. */
    onStateChange: (id: string, state: DaemonConnectionState) => void;
    log: (message: string) => void;
    /** Backstop for a connection that keeps dropping; production uses the default. */
    retryDelayMs?: (attempt: number) => number;
    /**
     * How often to ask a connection to prove it is alive, and how long an answer may take. A socket
     * killed silently — iOS suspending the App is the usual way — still reads as open from this
     * side, so without this the channel would simply stop delivering and nothing would notice.
     */
    heartbeat?: { intervalMs: number; timeoutMs: number };
    /**
     * Which routes this App checks liveness on itself.
     *
     * Liveness belongs to whoever can see the peer. Over the relay this App sees a stream, not the
     * daemon: the relay holds that connection, so it is the one that knows when a machine goes —
     * it says so in the directory and it closes the stream — and a heartbeat through the relay is
     * this App re-deriving a fact the hub already has. It also gets it wrong for any daemon that
     * cannot answer, which reads as a channel dropping every 45 seconds forever.
     *
     * The LAN has no such middleman: there a socket can die without either end being told, so this
     * side is the only thing that can notice.
     */
    heartbeatRoutes?: DaemonRoute[];
};

/**
 * Holds one live connection per daemon, and is the only thing that opens or closes one.
 *
 * Callers state what they want (`want`, `unwant`, `wantOnly`) and never touch a socket. That is
 * what makes the failures this replaces impossible: two readers cannot race into opening two
 * sockets (an open in flight is remembered), a network change cannot tear down a connection that
 * is still working (it only changes what is wanted), reading one machine cannot close another
 * machine's connection, and nothing sends on a socket that is being replaced (`current` is the only
 * way to get one, and it is the live one or nothing).
 *
 * A connection that drops is that daemon's problem, not the caller's: the manager reconnects, with
 * a backoff, for as long as it is wanted. A socket that was closed on purpose reports itself as
 * such and is not reconnected here.
 */
export class DaemonConnections {
    /** Keyed by `daemonId(machineId, route)` throughout: one entry per daemon, per transport. */
    private desired = new Map<string, DaemonTarget>();
    private live = new Map<string, LiveConnection>();
    private opening = new Map<string, Promise<void>>();
    /** Consecutive drops, for the reconnect backoff; cleared when a connection holds. */
    private drops = new Map<string, number>();
    private retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
    /** When the pending retry is due, so a reader can say "in 4s" rather than just "retrying". */
    private retryAt = new Map<string, number>();
    /**
     * Connections whose daemon never answers a heartbeat, learned from the first timeout.
     *
     * Remembered per daemon, not per connection: a daemon that cannot answer will not learn to, so
     * a reconnect must not start the same 45-second cycle again.
     */
    private noHeartbeat = new Set<string>();

    constructor(private readonly deps: DaemonConnectionDeps) {}

    /** Ask for one connection per listed daemon, dropping every daemon not listed. */
    wantOnly(targets: DaemonTarget[]): void {
        const keep = new Set(targets.map((target) => daemonId(target.machineId, target.route)));
        for (const id of [...this.desired.keys()]) {
            if (!keep.has(id)) {
                this.unwant(id, 'no longer wanted');
            }
        }
        for (const target of targets) {
            this.want(target);
        }
    }

    /** Ask for one connection to this daemon over this route. Idempotent. */
    want(target: DaemonTarget): void {
        const id = daemonId(target.machineId, target.route);
        const current = this.desired.get(id);
        if (current?.baseUrl === target.baseUrl) {
            return;
        }
        if (current) {
            // Same daemon, different address (it moved, or the route answered at a new one): the old
            // socket is for an address this App no longer believes in.
            this.close(id, `moving to a different address (${current.baseUrl} → ${target.baseUrl})`);
        }
        this.desired.set(id, target);
        this.start(target);
    }

    /** Stop wanting this daemon over this route; its connection is closed if there is one. */
    unwant(id: string, reason: string): void {
        this.desired.delete(id);
        this.close(id, reason);
    }

    /**
     * The connection to write on. A send has to come through here rather than remembering a handle:
     * the one it remembered may have been replaced since, and writing into a socket whose peer is
     * gone is a message accepted locally that never arrives.
     */
    current(machineId: string, route: DaemonRoute): { handle: LanSocketHandle; baseUrl: string; machineId: string } | null {
        const live = this.live.get(daemonId(machineId, route));
        return live ? { handle: live.handle, baseUrl: live.target.baseUrl, machineId: live.target.machineId } : null;
    }

    /**
     * The connection to *write* on: `current`, minus the ones that have gone quiet.
     *
     * A socket whose peer vanished — the App was suspended, the network moved under it, the proxy
     * dropped it — is still open as far as this side is concerned, and a write into it succeeds
     * locally and goes nowhere. That is the shape of a lost message: the App is told it sent, the
     * session never hears it, and nothing anywhere records a failure. A heartbeat that has gone
     * unanswered for a whole cycle is the only warning available before the timeout ends the
     * connection outright, so it is what sending waits for: below it the message goes to the other
     * channel, or back to the queue, rather than into a socket that is only pretending.
     *
     * Deliberately weaker than closing the connection: a late pong must not cost a reconnect, and
     * the beat loop is what decides that the socket is really gone.
     */
    trusted(machineId: string, route: DaemonRoute): { handle: LanSocketHandle; baseUrl: string; machineId: string } | null {
        const live = this.live.get(daemonId(machineId, route));
        if (!live) {
            return null;
        }
        const { intervalMs } = this.deps.heartbeat ?? DEFAULT_HEARTBEAT;
        if (live.awaitingBeatSince !== null && Date.now() - live.awaitingBeatSince >= intervalMs) {
            return null;
        }
        return { handle: live.handle, baseUrl: live.target.baseUrl, machineId: live.target.machineId };
    }

    has(machineId: string, route: DaemonRoute): boolean {
        return this.live.has(daemonId(machineId, route));
    }

    /** The machines this App currently holds a live connection to over one route. */
    liveMachineIds(route: DaemonRoute): string[] {
        const machines: string[] = [];
        for (const live of this.live.values()) {
            if (live.target.route === route) {
                machines.push(live.target.machineId);
            }
        }
        return machines;
    }

    get connectedCount(): number {
        return this.live.size;
    }

    /** Nothing is wanted and nothing is connected — for teardown, and for tests. */
    closeAll(reason: string): void {
        for (const id of [...this.desired.keys()]) {
            this.unwant(id, reason);
        }
    }

    private close(id: string, reason: string): void {
        const retry = this.retryTimers.get(id);
        if (retry) {
            clearTimeout(retry);
            this.retryTimers.delete(id);
        }
        this.retryAt.delete(id);
        this.drops.delete(id);
        const live = this.live.get(id);
        if (!live) {
            // Nothing to close: the state is whatever this daemon's wanting says it is.
            if (!this.desired.has(id)) {
                this.publish(id);
            }
            return;
        }
        if (live.beatTimer) {
            clearTimeout(live.beatTimer);
        }
        this.live.delete(id);
        this.deps.log(`🔌 closing the ${live.target.route} connection to ${live.target.machineId.slice(0, 8)} (${live.target.baseUrl}): ${reason}`);
        live.handle.close();
        // Published only when this daemon is now wanted by nobody. A close on a connection that is
        // still wanted is a step in something else — `want` replacing the address, or `endConnection`
        // about to start the next attempt — and announcing `retrying` here would name a state the
        // caller is already moving past.
        if (!this.desired.has(id)) {
            this.publish(id);
        }
    }

    private start(target: DaemonTarget): void {
        const id = daemonId(target.machineId, target.route);
        // An open already in flight *is* this daemon's open. Without this, every caller that arrives
        // while it is in flight opens a connection of its own: one is recorded, the rest leak, and
        // the daemon keeps them as readers that never go away.
        if (this.opening.has(id) || this.live.has(id)) {
            return;
        }
        const opened: { handle: LanSocketHandle | null } = { handle: null };
        const task = (async () => {
            const handle = await this.deps.open(target, {
                onUpdate: (payload) => this.deps.onUpdate(target, payload),
                onBeat: () => this.onBeat(id),
                onDelivered: (result) => this.deps.onDelivered(target, result),
                onClosed: (info) => this.onConnectionEnded(target, opened.handle, info),
            });
            opened.handle = handle;
            if (!handle) {
                this.deps.log(`🔌 could not open the ${target.route} connection to ${target.machineId.slice(0, 8)}`);
                // A failure to open is the same situation as a drop and deserves the same answer:
                // the daemon is still wanted, so the manager retries on its own schedule. Without
                // this, `want` being idempotent meant nothing ever tried again — the connection sat
                // wanted and idle until some unrelated change moved the address.
                this.scheduleRetry(target);
                return;
            }
            // The daemon may have been dropped or pointed elsewhere while this was opening: a socket
            // nobody wants is closed on arrival rather than installed.
            if (this.desired.get(id)?.baseUrl !== target.baseUrl) {
                handle.close();
                return;
            }
            this.live.set(id, {
                handle,
                target,
                connectedAt: Date.now(),
                awaitingBeatSince: null,
                beatTimer: null,
            });
            this.drops.delete(id);
            this.retryAt.delete(id);
            // One probe per connection: a daemon that has since been updated answers, and one that
            // has not is written off again after a single timeout rather than never being asked.
            this.noHeartbeat.delete(id);
            this.deps.log(`🔌 ${target.route} connection live to ${target.machineId.slice(0, 8)} at ${target.baseUrl}`);
            this.publish(id);
            this.deps.onReady?.(target);
            this.beatLoop(id);
        })();
        // Registered *before* awaiting, so an open in flight is visible as such: a second caller
        // must not start one of its own, and the published phase has to say `opening` meanwhile.
        this.opening.set(id, task);
        this.publish(id);
        void task.finally(() => {
            if (this.opening.get(id) === task) {
                this.opening.delete(id);
            }
        });
    }

    /** The daemon answered: the connection was alive when the heartbeat was sent. */
    private onBeat(id: string): void {
        const live = this.live.get(id);
        if (live) {
            live.awaitingBeatSince = null;
        }
    }

    /**
     * Ask, on a timer, whether the connection is still there.
     *
     * An unanswered heartbeat ends the connection and lets the ordinary reconnect path take over.
     * That is the only way a silently dead socket is ever noticed: it is open as far as this side
     * can tell, so nothing else would report it, and the sessions behind it would just go quiet.
     */
    private beatLoop(id: string): void {
        const live = this.live.get(id);
        if (!live) {
            return;
        }
        if (!(this.deps.heartbeatRoutes ?? ['lan']).includes(live.target.route)) {
            // Nothing to check from here: the transport in between is the one that knows.
            return;
        }
        const { intervalMs, timeoutMs } = this.deps.heartbeat ?? DEFAULT_HEARTBEAT;
        const timer = setTimeout(() => {
            const entry = this.live.get(id);
            if (!entry || entry.handle !== live.handle) {
                return;
            }
            entry.beatTimer = null;
            if (entry.awaitingBeatSince !== null && Date.now() - entry.awaitingBeatSince >= timeoutMs) {
                // Learned once. From here this daemon is never asked again and never dropped for not
                // answering — which is what stops a working connection from being torn down and
                // rebuilt every 45 seconds for as long as the App runs.
                this.noHeartbeat.add(id);
                entry.awaitingBeatSince = null;
                this.deps.log(
                    `🔌 ${entry.target.route} connection to ${entry.target.machineId.slice(0, 8)} does not answer heartbeats; keeping it and leaving the polling fallback on`,
                );
                this.deps.onHeartbeatUnsupported?.(entry.target);
                this.beatLoop(id);
                return;
            }
            // A daemon known not to answer is not asked: an unanswered ping is only meaningful
            // against one that can.
            if (entry.awaitingBeatSince === null && !this.noHeartbeat.has(id)) {
                if (!entry.handle.ping()) {
                    this.endConnection(entry.target, 'the socket would not take a heartbeat');
                    return;
                }
                entry.awaitingBeatSince = Date.now();
            }
            this.beatLoop(id);
        }, intervalMs);
        (timer as unknown as { unref?: () => void }).unref?.();
        live.beatTimer = timer;
    }

    /**
     * End a connection this App decided to end, and reconnect if the daemon is still wanted. Kept
     * apart from the peer-drop path because the socket has to be closed *deliberately* here: it is
     * still open, and telling it to close is how it stops being a channel.
     */
    private endConnection(target: DaemonTarget, reason: string): void {
        const id = daemonId(target.machineId, target.route);
        const live = this.live.get(id);
        if (!live || live.target.baseUrl !== target.baseUrl) {
            return;
        }
        this.live.delete(id);
        if (live.beatTimer) {
            clearTimeout(live.beatTimer);
        }
        this.deps.log(`🔌 closing the ${target.route} connection to ${target.machineId.slice(0, 8)} (${target.baseUrl}): ${reason}`);
        this.deps.onDropped?.(target);
        live.handle.close();
        if (this.desired.get(id)?.baseUrl === target.baseUrl) {
            this.start({ ...target });
        } else {
            this.publish(id);
        }
    }

    /**
     * A connection ended without this App asking. Reconnecting is this manager's job, not a
     * caller's: the daemon is still wanted, and whoever writes on it should find a connection there
     * rather than have to notice it went away.
     */
    private onConnectionEnded(target: DaemonTarget, handle: LanSocketHandle | null, info: { deliberate: boolean; code?: number; reason?: string }): void {
        if (info.deliberate) {
            return; // closed by this App, which said why when it did
        }
        const id = daemonId(target.machineId, target.route);
        const live = this.live.get(id);
        if (!live || (handle && live.handle !== handle)) {
            return; // a drop from a connection that has already been replaced
        }
        this.live.delete(id);
        this.deps.log(`🔌 ${target.route} connection to ${target.machineId.slice(0, 8)} dropped: code=${info.code ?? 'none'} reason=${info.reason || 'none'}`);
        this.deps.onDropped?.(target);
        if (this.desired.get(id)?.baseUrl !== target.baseUrl) {
            this.publish(id);
            return; // nobody wants it any more
        }
        this.scheduleRetry(target);
    }

    /**
     * Try this daemon again after a backoff, on the same escalating schedule a drop uses.
     *
     * Shared by the two ways a connection ends up wanted and not working — the socket dropped, or
     * the open never produced one — because from the manager's side they are the same fact: nothing
     * is carrying this daemon right now, and something has to try again.
     */
    private scheduleRetry(target: DaemonTarget): void {
        const id = daemonId(target.machineId, target.route);
        const drops = (this.drops.get(id) ?? 0) + 1;
        this.drops.set(id, drops);
        const delay = this.deps.retryDelayMs ? this.deps.retryDelayMs(drops) : Math.min(30_000, 1_000 * 2 ** (drops - 1));
        this.retryAt.set(id, Date.now() + delay);
        this.publish(id);
        const timer = setTimeout(() => {
            this.retryTimers.delete(id);
            this.retryAt.delete(id);
            if (this.desired.get(id)?.baseUrl === target.baseUrl) {
                this.start({ ...target });
            }
        }, delay);
        (timer as unknown as { unref?: () => void }).unref?.();
        this.retryTimers.set(id, timer);
    }

    /**
     * Says what a connection is doing, from the manager's own bookkeeping rather than from whoever
     * made the last call. A connection with a live socket is `live`; one wanted with an open in
     * flight is `opening`; one wanted with neither is waiting on a backoff (`retrying`, and until
     * when); one nobody wants is `idle`.
     *
     * Published on every transition because the states this makes visible are the ones that used to
     * be indistinguishable from a quiet channel — a machine stuck retrying, and a machine the App
     * believes it is talking to while nothing is arriving.
     */
    private publish(id: string): void {
        const live = this.live.get(id);
        if (live) {
            this.deps.onStateChange(id, {
                machineId: live.target.machineId,
                route: live.target.route,
                phase: 'live',
                baseUrl: live.target.baseUrl,
                connectedAt: live.connectedAt,
            });
            return;
        }
        const desired = this.desired.get(id);
        if (!desired) {
            this.deps.onStateChange(id, { ...splitDaemonId(id), phase: 'idle' });
            return;
        }
        if (this.opening.has(id)) {
            this.deps.onStateChange(id, {
                machineId: desired.machineId,
                route: desired.route,
                phase: 'opening',
                baseUrl: desired.baseUrl,
            });
            return;
        }
        this.deps.onStateChange(id, {
            machineId: desired.machineId,
            route: desired.route,
            phase: 'retrying',
            baseUrl: desired.baseUrl,
            attempt: this.drops.get(id) ?? 0,
            retryAt: this.retryAt.get(id),
        });
    }
}

/**
 * Splits an id back into the machine and route it names.
 *
 * Only needed when nothing is wanted for it any more and the target is gone, so the published state
 * can still say *which* daemon went idle rather than leaving the reader to parse the key.
 */
function splitDaemonId(id: string): { machineId: string; route: DaemonRoute } {
    const at = id.lastIndexOf(':');
    return { machineId: id.slice(0, at), route: id.slice(at + 1) as DaemonRoute };
}
