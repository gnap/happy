/**
 * One connection to the relay, for every machine behind it.
 *
 * The relay is a hub, the way the server is: it holds a connection to each daemon that dialled in,
 * knows which machines those are, and what sessions each published. So the App holds *one*
 * connection to it and addresses machines on that connection, instead of one connection per
 * machine, a probe per machine to find out whether it is up, and a per-machine address it has to
 * derive or be told.
 *
 * What that buys, concretely:
 *
 * - **Machines are discovered, not guessed.** `{t:'machines'}` answers with every daemon that is
 *   dialled in, and the relay pushes an update when one comes or goes. A machine being online is
 *   then a fact the App is told rather than one it infers from a probe that may not have run yet.
 * - **Sessions come with them.** Each machine publishes its session summary, so listing sessions
 *   costs no round trips at all when the server cannot say.
 * - **Streams are demultiplexed here.** A stream is opened by tag and behaves like a socket: the
 *   relay routes its frames to that one daemon and back. That is what lets the live channel work
 *   for several machines without the App holding several sockets.
 *
 * The relay still authenticates nothing about the App — it cannot, it holds no account — so every
 * request that reaches a daemon is authenticated by that daemon exactly as it would be on the LAN.
 * Nothing here is a credential.
 */

/** A machine the relay is holding, and what it published about itself. */
export type HubMachine = {
    tag: string;
    /** The daemon's own session summary — the same shape `GET /lan/sessions` returns. */
    sessions: unknown[];
};

/** The bit of a WebSocket a relay stream has to look like, so `openLanSocket` can use either. */
export type SocketLike = {
    readyState: number;
    send: (data: string) => void;
    close: () => void;
    onopen: ((event?: unknown) => void) | null;
    onmessage: ((event: { data: unknown }) => void) | null;
    onclose: ((event: { code?: number; reason?: string }) => void) | null;
    onerror: ((event?: unknown) => void) | null;
};

export type RelayHubHandle = {
    /** What the relay is holding right now. */
    machines: () => HubMachine[];
    /** Called whenever the set of machines, or a machine's sessions, changes. */
    onMachines: (listener: (machines: HubMachine[]) => void) => () => void;
    /** Called when the connection comes up or goes down, so a reader can tell "no machines" from "no relay". */
    onStatus: (listener: (connected: boolean) => void) => () => void;
    /** The tag of the machine whose key derives this tag, for opening a stream to it. */
    stream: (tag: string, path: string) => SocketLike;
    /** Whether the hub connection is up; false means nothing behind it can be reached. */
    isConnected: () => boolean;
    close: () => void;
};

/** A stream that has not been opened by the time a socket is usable is not going to be. */
const STREAM_OPEN_TIMEOUT_MS = 5_000;
/**
 * How often this App asks the relay for a pong, and how long it may take.
 *
 * One check for one connection, and the only liveness check that belongs to this side: whether the
 * *machines* are up is the relay's business — it holds their connections and says so in the
 * directory — while whether this connection is still carrying anything is knowable only here. A
 * socket killed silently (iOS suspending the App) looks open from JS, so without this the App would
 * keep believing it has a relay.
 */
const HUB_BEAT_INTERVAL_MS = 15_000;
const HUB_BEAT_TIMEOUT_MS = 45_000;
/** Long enough not to hammer a relay that is restarting, short enough to recover quickly. */
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

/**
 * A stream, presented as the socket the LAN channel already knows how to speak.
 *
 * The relay answers `open` only implicitly — a frame arrives for that id, or a close does — so
 * "opened" here means "the first frame or close arrived", and a stream that produces neither is
 * closed rather than left as a socket that never resolves.
 */
class HubSocket implements SocketLike {
    readyState = 0;
    onopen: ((event?: unknown) => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onclose: ((event: { code?: number; reason?: string }) => void) | null = null;
    onerror: ((event?: unknown) => void) | null = null;

    private inbound: string[] = [];
    private timer: ReturnType<typeof setTimeout> | null = null;

    constructor(
        private readonly hub: RelayHub,
        readonly id: number,
        readonly tag: string,
    ) {
        // The daemon answers an upgrade with its first frame, so a stream that stays silent is one
        // the daemon refused or that never arrived. Waiting forever would hand the caller a socket
        // that never opens and never reports a failure.
        this.timer = setTimeout(() => {
            if (this.readyState === 0) {
                this.hub.send({ t: 'close', id: this.id });
                this.fail(4408, 'stream did not open');
            }
        }, STREAM_OPEN_TIMEOUT_MS);
        (this.timer as unknown as { unref?: () => void }).unref?.();
    }

    private opened(): void {
        if (this.readyState !== 0) {
            return;
        }
        this.readyState = 1;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        this.onopen?.();
        for (const data of this.inbound.splice(0)) {
            this.onmessage?.({ data });
        }
    }

    /** A frame from the daemon. */
    deliver(data: string): void {
        if (this.readyState === 3) {
            return;
        }
        if (this.readyState === 0) {
            // A frame *is* the stream being open: the daemon answered the upgrade.
            this.inbound.push(data);
            this.opened();
            return;
        }
        this.onmessage?.({ data });
    }

    fail(code: number, reason: string): void {
        if (this.readyState === 3) {
            return;
        }
        const wasOpen = this.readyState === 1;
        this.readyState = 3;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        if (wasOpen) {
            this.onclose?.({ code, reason });
        } else {
            // Never opened: the caller is waiting on a handshake, and `onclose` before `onopen` is
            // what a WebSocket that failed to connect reports.
            this.onerror?.();
            this.onclose?.({ code, reason });
        }
    }

    send(data: string): void {
        if (this.readyState !== 1) {
            throw new Error('stream is not open');
        }
        this.hub.send({ t: 'msg', id: this.id, data });
    }

    close(): void {
        if (this.readyState === 3) {
            return;
        }
        this.readyState = 3;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        this.hub.send({ t: 'close', id: this.id });
        this.hub.forget(this.id);
    }
}

/**
 * The relay a machine published, as an origin: `https://host/r/<tag>` → `https://host`.
 *
 * This is how the App learns where the relay is. A daemon is configured with it (`HAPPY_RELAY_URL`)
 * and publishes the route it built from it, so the address travels with the machines — the App is
 * not told it by a person, and does not have to be. Null for anything that is not that shape, since
 * a malformed value must not become a URL the App connects to.
 */
export function relayOriginOf(relayBaseUrl: string): string | null {
    const match = /^(https?:\/\/[^/]+)\/r\/[0-9a-f]{32}$/.exec(relayBaseUrl.replace(/\/+$/, ''));
    return match ? match[1] : null;
}

/**
 * The relay deployment this App is built against, used only until a machine has published one.
 *
 * Every daemon in a deployment is pointed at the same relay, so the first published route is the
 * truth and this is the seed for a device that has never synced with the server: without *some*
 * address there is nothing to connect to, and the whole point of the relay is the case where the
 * server cannot say.
 */
export const DEFAULT_RELAY_URL = 'https://47.80.241.214';

/** The relay addresses a machine by tag; this is the one place that turns it into a URL. */
export function relayHubUrl(relayUrl: string): string {
    return relayUrl.replace(/\/+$/, '').replace(/^http/, 'ws') + '/client';
}

export class RelayHub {
    private socket: WebSocket | null = null;
    private streams = new Map<number, HubSocket>();
    private nextId = 1;
    private connected = false;
    private known: HubMachine[] = [];
    private listeners = new Set<(machines: HubMachine[]) => void>();
    private statusListeners = new Set<(connected: boolean) => void>();
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private backoff = RECONNECT_MIN_MS;
    private stopped = false;
    private beatTimer: ReturnType<typeof setTimeout> | null = null;
    private awaitingBeatSince: number | null = null;

    constructor(
        private readonly url: string,
        private readonly log: (message: string) => void = () => {},
    ) {}

    isConnected(): boolean {
        return this.connected;
    }

    /** What the relay is holding right now. */
    machines(): HubMachine[] {
        return this.known;
    }

    onMachines(listener: (machines: HubMachine[]) => void): () => void {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }

    onStatus(listener: (connected: boolean) => void): () => void {
        this.statusListeners.add(listener);
        listener(this.connected);
        return () => { this.statusListeners.delete(listener); };
    }

    connect(): void {
        if (this.stopped || this.socket) {
            return;
        }
        let socket: WebSocket;
        try {
            socket = new WebSocket(this.url);
        } catch (error) {
            this.log(`🔁 relay hub could not open: ${String(error)}`);
            this.scheduleReconnect();
            return;
        }
        this.socket = socket;
        socket.onopen = () => {
            this.log('🔁 relay hub connected');
        };
        socket.onmessage = (event) => {
            if (typeof event.data !== 'string') {
                return;
            }
            let frame: { t?: string; id?: number; data?: string; machines?: HubMachine[]; code?: number; reason?: string };
            try {
                frame = JSON.parse(event.data) as typeof frame;
            } catch {
                return;
            }
            if (frame.t === 'pong') {
                this.awaitingBeatSince = null;
                return;
            }
            if (frame.t === 'ok' || frame.t === 'machines') {
                const wasConnected = this.connected;
                this.connected = true;
                this.backoff = RECONNECT_MIN_MS;
                if (!wasConnected) {
                    for (const listener of this.statusListeners) {
                        listener(true);
                    }
                    this.beatLoop();
                }
                if (frame.machines) {
                    this.setMachines(frame.machines);
                }
                return;
            }
            if (typeof frame.id !== 'number') {
                return;
            }
            const stream = this.streams.get(frame.id);
            if (!stream) {
                return;
            }
            if (frame.t === 'msg' && typeof frame.data === 'string') {
                stream.deliver(frame.data);
                return;
            }
            if (frame.t === 'close') {
                this.streams.delete(frame.id);
                stream.fail(frame.code ?? 1006, frame.reason ?? '');
            }
        };
        socket.onclose = () => {
            this.socket = null;
            if (this.beatTimer) {
                clearTimeout(this.beatTimer);
                this.beatTimer = null;
            }
            this.awaitingBeatSince = null;
            if (this.connected) {
                for (const listener of this.statusListeners) {
                    listener(false);
                }
            }
            this.connected = false;
            this.log('🔁 relay hub closed');
            // Every stream died with it. Reporting that is what turns a relay restart into a
            // reconnect per machine rather than a set of sockets that look alive and deliver
            // nothing.
            for (const [id, stream] of this.streams) {
                this.streams.delete(id);
                stream.fail(1006, 'relay hub closed');
            }
            this.setMachines([]);
            this.scheduleReconnect();
        };
        socket.onerror = () => { /* onclose follows */ };
    }

    /**
     * Opens a stream to one machine. The socket it returns is not usable until the daemon answers,
     * exactly like a WebSocket, so the caller's handshake logic does not change.
     */
    stream(tag: string, path: string): SocketLike {
        const id = this.nextId++;
        const socket = new HubSocket(this, id, tag);
        this.streams.set(id, socket);
        if (!this.send({ t: 'open', id, tag, path })) {
            this.streams.delete(id);
            // Reported on the next tick, not now: a failure that arrives before the caller has the
            // socket in hand is a failure nobody hears, which is exactly how a socket ends up
            // waiting forever for a connection that was never made.
            void Promise.resolve().then(() => socket.fail(4502, 'relay hub is not connected'));
        }
        return socket;
    }

    forget(id: number): void {
        this.streams.delete(id);
    }

    send(frame: unknown): boolean {
        const socket = this.socket;
        if (!socket || socket.readyState !== 1) {
            return false;
        }
        try {
            socket.send(JSON.stringify(frame));
            return true;
        } catch {
            return false;
        }
    }

    close(): void {
        this.stopped = true;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        try { this.socket?.close(); } catch { /* gone */ }
        this.socket = null;
        if (this.connected) {
            for (const listener of this.statusListeners) {
                listener(false);
            }
        }
        this.connected = false;
    }

    /**
     * Ask the relay, on a timer, whether this connection is still carrying anything.
     *
     * A pong that never comes ends the connection and lets the ordinary reconnect take over. Only
     * this connection is checked: a machine's liveness is the relay's to know, and asking a daemon
     * through the relay would be this App re-deriving a fact the hub already holds — and getting it
     * wrong for any daemon that cannot answer, which reads as a channel that drops every 45 seconds.
     */
    private beatLoop(): void {
        if (this.stopped) {
            return;
        }
        this.beatTimer = setTimeout(() => {
            this.beatTimer = null;
            if (!this.connected) {
                return;
            }
            if (this.awaitingBeatSince !== null && Date.now() - this.awaitingBeatSince >= HUB_BEAT_TIMEOUT_MS) {
                this.log('🔁 relay hub stopped answering; reconnecting');
                try { this.socket?.close(); } catch { /* gone */ }
                return;
            }
            if (this.awaitingBeatSince === null) {
                if (!this.send({ t: 'ping' })) {
                    try { this.socket?.close(); } catch { /* gone */ }
                    return;
                }
                this.awaitingBeatSince = Date.now();
            }
            this.beatLoop();
        }, HUB_BEAT_INTERVAL_MS);
        (this.beatTimer as unknown as { unref?: () => void }).unref?.();
    }

    private setMachines(machines: HubMachine[]): void {
        this.known = machines;
        // A stream to a machine the relay no longer holds is dead: the relay is the one that knows,
        // so this is where that is acted on rather than waited for.
        const held = new Set(machines.map((machine) => machine.tag));
        for (const [id, stream] of this.streams) {
            if (!held.has(stream.tag)) {
                this.streams.delete(id);
                stream.fail(4502, 'machine is offline');
            }
        }
        for (const listener of this.listeners) {
            listener(machines);
        }
    }

    private scheduleReconnect(): void {
        if (this.stopped || this.reconnectTimer) {
            return;
        }
        const delay = this.backoff;
        this.backoff = Math.min(this.backoff * 2, RECONNECT_MAX_MS);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, delay);
        (this.reconnectTimer as unknown as { unref?: () => void }).unref?.();
    }
}
