import { createConnection, Socket } from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { logger } from '@/ui/logger';

const SOCKET_BASE = process.env.HAPPY_HOME_DIR || join(homedir(), '.happy');
const SOCKET_PATH = join(SOCKET_BASE, 'daemon.sock');
const RECONNECT_DELAY_MS = 1_000;
const HEARTBEAT_INTERVAL_MS = 5_000;

interface SessionSocketState {
    socket: Socket | null;
    heartbeatTimer: ReturnType<typeof setInterval> | null;
    reconnectTimer: ReturnType<typeof setTimeout> | null;
    stopped: boolean;
    /**
     * Fallback: if socket is unavailable, call this on each heartbeat tick
     * (e.g., send HTTP POST to daemon's /session-started).
     */
    onHeartbeatFallback: (() => void) | null;
    /**
     * Called when the daemon delivers a user message that arrived over the LAN. The session
     * handles it exactly as it would one from the server; from here the two channels are
     * indistinguishable.
     */
    onDeliver: ((payload: { sessionId: string; localId: string; content: string }) => void) | null;
}

let state: SessionSocketState = {
    socket: null,
    heartbeatTimer: null,
    reconnectTimer: null,
    stopped: false,
    onHeartbeatFallback: null,
    onDeliver: null,
};

function send(socket: Socket, msg: Record<string, unknown>): void {
    if (socket.readyState === 'open') {
        socket.write(JSON.stringify(msg) + '\n');
    }
}

function startHeartbeat(socket: Socket): void {
    if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
    state.heartbeatTimer = setInterval(() => {
        if (socket.readyState === 'open') {
            send(socket, { type: 'heartbeat' });
        }
        // Also invoke fallback if socket dropped
        if (state.onHeartbeatFallback && socket.readyState !== 'open') {
            state.onHeartbeatFallback();
        }
    }, HEARTBEAT_INTERVAL_MS);
}

function connect(helloPayload: Record<string, unknown>): Socket {
    const socket = createConnection(SOCKET_PATH);

    socket.on('connect', () => {
        logger.debug('[UNIX CLIENT] Connected to daemon');
        state.socket = socket;
        if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
        send(socket, { type: 'hello', ...helloPayload });
        startHeartbeat(socket);
    });

    // Decodes across chunk boundaries, and buffers partial lines. `toString('utf8')` tears a
    // multi-byte character in half when a frame straddles two chunks, and splitting without
    // buffering hands a half-line to `JSON.parse` — either way the frame is lost, which for a
    // delivered user message means a message that silently never arrives.
    const decoder = new StringDecoder('utf8');
    let buf = '';
    socket.on('data', (data: Buffer) => {
        buf += decoder.write(data);
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
            if (!line.trim()) {
                continue;
            }
            try {
                const msg = JSON.parse(line);
                if (msg.type === 'stop') {
                    logger.debug('[UNIX CLIENT] Received stop command from daemon');
                    socket.end();
                    process.exit(0);
                }
                if (msg.type === 'deliver' && msg.deliver) {
                    // A user message the daemon took in over its LAN API. Handled off the socket
                    // callback so a slow handler cannot stall the heartbeat.
                    const deliver = msg.deliver as { sessionId: string; localId: string; content: string };
                    setTimeout(() => state.onDeliver?.(deliver), 0);
                }
            } catch { /* ignore */ }
        }
    });

    socket.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') {
            logger.debug('[UNIX CLIENT] Daemon socket not available, will retry');
        } else {
            logger.debug(`[UNIX CLIENT] Socket error: ${err.message}`);
        }
    });

    socket.on('close', () => {
        logger.debug('[UNIX CLIENT] Disconnected from daemon');
        state.socket = null;
        if (state.heartbeatTimer) { clearInterval(state.heartbeatTimer); state.heartbeatTimer = null; }
        // Reconnect after delay
        if (!state.stopped) {
            state.reconnectTimer = setTimeout(() => {
                if (!state.stopped) connect(helloPayload);
            }, RECONNECT_DELAY_MS);
        }
    });

    return socket;
}

/**
 * Connect to the daemon's Unix socket for real-time IPC.
 * Falls back to periodic HTTP webhook calls if socket is unavailable.
 *
 * @param helloPayload - sent as { type: 'hello', ...payload } on connection.
 * @param heartbeatFallback - called periodically when socket is disconnected
 *   (e.g., to send HTTP POST to daemon's /session-started).
 */
export function startUnixSocketClient(
    helloPayload: Record<string, unknown>,
    heartbeatFallback?: () => void,
    onDeliver?: (payload: { sessionId: string; localId: string; content: string }) => void,
): () => void {
    state.stopped = false;
    state.onHeartbeatFallback = heartbeatFallback ?? null;
    state.onDeliver = onDeliver ?? null;
    connect(helloPayload);

    return () => {
        state.stopped = true;
        if (state.socket) {
            send(state.socket, { type: 'goodbye' });
            state.socket.end();
            state.socket = null;
        }
        if (state.heartbeatTimer) { clearInterval(state.heartbeatTimer); state.heartbeatTimer = null; }
        if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
    };
}

/**
 * Forwards one server-shaped update body to the daemon, for it to mirror onto its LAN socket.
 *
 * Fire-and-forget on purpose: the LAN channel is a *mirror*, so a frame lost here must never
 * affect the session's own path to the server, which is the one that actually delivers work. A
 * reader that misses a frame catches up from the session log on its next read.
 *
 * Returns false when there is no daemon socket — the session still runs, just without a mirror.
 */
export function forwardSessionEventToDaemon(event: Record<string, unknown>): boolean {
    // Logged at each exit so a silent drop is distinguishable from a call that never happened —
    // `send` swallows a socket that is not open, so without this the two look identical.
    if (!state.socket) {
        logger.debug(`[UNIX CLIENT] forward ${String(event.t)} skipped: no socket`);
        return false;
    }
    if (state.socket.readyState !== 'open') {
        logger.debug(`[UNIX CLIENT] forward ${String(event.t)} skipped: socket state ${state.socket.readyState}`);
        return false;
    }
    logger.debug(`[UNIX CLIENT] forward ${String(event.t)} (${JSON.stringify(event).length} bytes)`);
    send(state.socket, { type: 'session-event', event });
    return true;
}

/**
 * Check if daemon is reachable via Unix socket without registering.
 */
export function isDaemonReachable(): Promise<boolean> {
    return new Promise((resolve) => {
        const test = createConnection(SOCKET_PATH);
        test.on('connect', () => { test.end(); resolve(true); });
        test.on('error', () => resolve(false));
        setTimeout(() => { test.destroy(); resolve(false); }, 1_000);
    });
}
