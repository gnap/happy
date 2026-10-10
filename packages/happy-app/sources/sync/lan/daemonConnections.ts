import type { LanSocketHandle } from './socket';
import type { DaemonRoute } from './types';

/**
 * The one connection this App holds to a daemon route, and the address it was opened for.
 *
 * One per route is the invariant: a session's messages, its sends and its verdicts all travel the
 * same socket, so there must be exactly one authority over whether it exists and which address it
 * points at. Everything else — reads, resumes, network changes — says what it *wants*, and this
 * makes that true.
 */
export type DaemonTarget = {
    route: DaemonRoute;
    baseUrl: string;
    machineId: string;
    machineKey: Uint8Array;
};

export type DaemonConnectionState = { baseUrl: string; machineId: string; connectedAt: number };

export type DaemonConnectionDeps = {
    /** Opens one connection, or returns null when it could not be established. */
    open: (
        target: DaemonTarget,
        handlers: {
            onUpdate: (payload: unknown) => void;
            onDelivered: (result: { sessionId: string; localId: string; delivered: boolean }) => void;
            onClosed: (info: { deliberate: boolean; code?: number; reason?: string }) => void;
        },
    ) => Promise<LanSocketHandle | null>;
    onUpdate: (target: DaemonTarget, payload: unknown) => void;
    onDelivered: (target: DaemonTarget, result: { sessionId: string; localId: string; delivered: boolean }) => void;
    /** A connection came up: the sessions on that machine no longer need their polling fallback. */
    onReady?: (target: DaemonTarget) => void;
    /** A connection went away without this App asking: whatever it was carrying has lost its push. */
    onDropped?: (target: DaemonTarget) => void;
    /** Published for the rest of the App: what is connected, per route. */
    onStateChange: (route: DaemonRoute, state: DaemonConnectionState | null) => void;
    log: (message: string) => void;
    /** Backstop for a connection that keeps dropping; production uses the default. */
    retryDelayMs?: (attempt: number) => number;
};

type Live = { handle: LanSocketHandle; target: DaemonTarget; drops: number; retryTimer: ReturnType<typeof setTimeout> | null };

/**
 * Holds one live connection per daemon route, and is the only thing that opens or closes one.
 *
 * Callers state what they want (`want`, `unwant`, `wantOnly`) and never touch a socket. That is
 * what makes the failures this replaces impossible: two readers cannot race into opening two
 * sockets (an open in flight is remembered), a network change cannot tear down a connection that
 * is still working (it only changes what is wanted), and nothing sends on a socket that is being
 * replaced (`current` is the only way to get one, and it is the live one or nothing).
 *
 * A connection that drops is the route's problem, not the caller's: the manager reconnects, with a
 * backoff, for as long as the route is wanted. A socket that was closed on purpose reports itself
 * as such and is not reconnected here.
 */
export class DaemonConnections {
    private desired = new Map<DaemonRoute, DaemonTarget>();
    private live = new Map<DaemonRoute, { handle: LanSocketHandle; target: DaemonTarget }>();
    private opening = new Map<DaemonRoute, Promise<void>>();
    /** Consecutive drops per route, for the reconnect backoff; cleared when a connection holds. */
    private drops = new Map<DaemonRoute, number>();
    private retryTimers = new Map<DaemonRoute, ReturnType<typeof setTimeout>>();

    constructor(private readonly deps: DaemonConnectionDeps) {}

    /** Ask for one connection per route, dropping any route not listed. */
    wantOnly(targets: DaemonTarget[]): void {
        const keep = new Set(targets.map((target) => target.route));
        for (const route of [...this.desired.keys()]) {
            if (!keep.has(route)) {
                this.unwant(route, 'no longer wanted');
            }
        }
        for (const target of targets) {
            this.want(target);
        }
    }

    /** Ask for one connection on this route to this address. Idempotent. */
    want(target: DaemonTarget): void {
        const current = this.desired.get(target.route);
        if (current?.baseUrl === target.baseUrl) {
            return;
        }
        if (current) {
            this.close(target.route, `moving to a different address (${current.baseUrl} → ${target.baseUrl})`);
        }
        this.desired.set(target.route, target);
        this.start(target);
    }

    /** Stop wanting a route; its connection is closed if there is one. */
    unwant(route: DaemonRoute, reason: string): void {
        this.desired.delete(route);
        this.close(route, reason);
    }

    /**
     * The connection to write on. A send has to come through here rather than remembering a
     * handle: the one it remembered may have been replaced since, and writing into a socket whose
     * peer is gone is a message accepted locally that never arrives.
     */
    current(route: DaemonRoute): { handle: LanSocketHandle; baseUrl: string; machineId: string } | null {
        const live = this.live.get(route);
        return live ? { handle: live.handle, baseUrl: live.target.baseUrl, machineId: live.target.machineId } : null;
    }

    has(route: DaemonRoute): boolean {
        return this.live.has(route);
    }

    get connectedCount(): number {
        return this.live.size;
    }

    /** Nothing is wanted and nothing is connected — for teardown, and for tests. */
    closeAll(reason: string): void {
        for (const route of [...this.desired.keys()]) {
            this.unwant(route, reason);
        }
    }

    private close(route: DaemonRoute, reason: string): void {
        const retry = this.retryTimers.get(route);
        if (retry) {
            clearTimeout(retry);
            this.retryTimers.delete(route);
        }
        this.drops.delete(route);
        const live = this.live.get(route);
        if (!live) {
            return;
        }
        this.live.delete(route);
        this.deps.onStateChange(route, null);
        this.deps.log(`🔌 closing the ${route} connection (${live.target.baseUrl}): ${reason}`);
        live.handle.close();
    }

    private start(target: DaemonTarget): void {
        // An open already in flight *is* this route's open. Without this, every caller that arrives
        // while it is in flight opens a connection of its own: one is recorded, the rest leak, and
        // the daemon keeps them as readers that never go away.
        if (this.opening.has(target.route) || this.live.has(target.route)) {
            return;
        }
        // Read through a box so the drop handler can name the handle this attempt produced, without
        // the closure having to exist before the open returns.
        const opened: { handle: LanSocketHandle | null } = { handle: null };
        const task = (async () => {
            const handle = await this.deps.open(target, {
                onUpdate: (payload) => this.deps.onUpdate(target, payload),
                onDelivered: (result) => this.deps.onDelivered(target, result),
                onClosed: (info) => this.onConnectionEnded(target, opened.handle, info),
            });
            opened.handle = handle;
            if (!handle) {
                this.deps.log(`🔌 could not open the ${target.route} connection to ${target.baseUrl}`);
                return;
            }
            // The route may have been dropped or pointed elsewhere while this was opening: a socket
            // nobody wants is closed on arrival rather than installed.
            if (this.desired.get(target.route)?.baseUrl !== target.baseUrl) {
                handle.close();
                return;
            }
            this.live.set(target.route, { handle, target });
            this.drops.delete(target.route);
            this.deps.onStateChange(target.route, {
                baseUrl: target.baseUrl,
                machineId: target.machineId,
                connectedAt: Date.now(),
            });
            this.deps.log(`🔌 ${target.route} connection live at ${target.baseUrl}`);
            this.deps.onReady?.(target);
        })();
        this.opening.set(target.route, task);
        void task.finally(() => {
            if (this.opening.get(target.route) === task) {
                this.opening.delete(target.route);
            }
        });
    }

    /**
     * A connection ended without this App asking. Reconnecting is this manager's job, not a
     * caller's: the route is still wanted, and whoever writes on it should find a connection there
     * rather than have to notice it went away.
     */
    private onConnectionEnded(target: DaemonTarget, handle: LanSocketHandle | null, info: { deliberate: boolean; code?: number; reason?: string }): void {
        if (info.deliberate) {
            return; // closed by this App, which said why when it did
        }
        const live = this.live.get(target.route);
        if (!live || (handle && live.handle !== handle)) {
            return; // a drop from a connection that has already been replaced
        }
        this.live.delete(target.route);
        this.deps.onStateChange(target.route, null);
        this.deps.log(`🔌 ${target.route} connection dropped (${target.baseUrl}): code=${info.code ?? 'none'} reason=${info.reason || 'none'}`);
        this.deps.onDropped?.(target);
        if (this.desired.get(target.route)?.baseUrl !== target.baseUrl) {
            return; // nobody wants it any more
        }
        const drops = (this.drops.get(target.route) ?? 0) + 1;
        this.drops.set(target.route, drops);
        const delay = this.deps.retryDelayMs ? this.deps.retryDelayMs(drops) : Math.min(30_000, 1_000 * 2 ** (drops - 1));
        const timer = setTimeout(() => {
            this.retryTimers.delete(target.route);
            if (this.desired.get(target.route)?.baseUrl === target.baseUrl) {
                this.start({ ...target });
            }
        }, delay);
        (timer as unknown as { unref?: () => void }).unref?.();
        this.retryTimers.set(target.route, timer);
    }
}
