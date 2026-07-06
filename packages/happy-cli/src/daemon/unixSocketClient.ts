import { createConnection, Socket } from 'node:net';
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
}

let state: SessionSocketState = {
    socket: null,
    heartbeatTimer: null,
    reconnectTimer: null,
    stopped: false,
    onHeartbeatFallback: null,
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

    socket.on('data', (data: Buffer) => {
        const lines = data.toString('utf-8').split('\n').filter(l => l.trim());
        for (const line of lines) {
            try {
                const msg = JSON.parse(line);
                if (msg.type === 'stop') {
                    logger.debug('[UNIX CLIENT] Received stop command from daemon');
                    socket.end();
                    process.exit(0);
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
): () => void {
    state.stopped = false;
    state.onHeartbeatFallback = heartbeatFallback ?? null;
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
