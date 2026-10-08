import { createServer, Server, Socket } from 'node:net';
import { unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { logger } from '@/ui/logger';

export interface DaemonSocketMessage {
    type: 'hello' | 'heartbeat' | 'goodbye' | 'session-event';
    sessionId?: string;
    pid?: number;
    sessionTag?: string;
    metadata?: Record<string, unknown>;
    /**
     * A server-shaped update body the session just received, forwarded so the daemon can mirror it
     * onto the LAN socket. Only the body: the daemon re-wraps it in the same `update` envelope the
     * server uses, which is what makes the LAN channel protocol-transparent to the App.
     */
    event?: Record<string, unknown>;
}

interface SessionSocketState {
    sessionId: string | null;
    sessionTag: string | null;
    pid: number | null;
}

export type SessionRegistrationHandler = (
    socket: Socket,
    msg: DaemonSocketMessage,
) => void;

export type SessionDisconnectHandler = (
    sessionId: string | null,
) => void;

/**
 * A session forwarding one of its own server-shaped updates, so the daemon can mirror it onto the
 * LAN socket. The daemon does not otherwise see session traffic — the session talks to the server
 * directly — which is why this leg has to exist for a LAN socket to carry live messages at all.
 */
export type SessionEventHandler = (
    sessionId: string | null,
    event: Record<string, unknown>,
) => void;

const SOCKET_BASE = process.env.HAPPY_HOME_DIR || join(homedir(), '.happy');
const SOCKET_PATH = join(SOCKET_BASE, 'daemon.sock');
const HEARTBEAT_TIMEOUT_MS = 12_000; // 12s without heartbeat = dead (2x heartbeat interval)

/**
 * Start Unix Domain Socket server for daemon ↔ session IPC.
 * Sessions connect and register via { type: 'hello' } messages.
 * Heartbeat-based liveness detection replaces periodic HTTP webhook polling.
 */
export function startUnixSocketServer(callbacks: {
    onSessionHello: SessionRegistrationHandler;
    onSessionDisconnect: SessionDisconnectHandler;
    onSessionEvent: SessionEventHandler;
}): {
    stop: () => Promise<void>;
    socketPath: string;
    isSessionConnected: (sessionId: string) => boolean;
    /** Delivers a message to a session's process. False when it holds no live socket. */
    sendToSession: (sessionId: string, message: Record<string, unknown>) => boolean;
} {
    /** Set of session IDs with active socket connections. Survives daemon restart gaps. */
    const connectedSessions = new Set<string>();
    /**
     * The sockets themselves, so the daemon can reach a session rather than only hear from it.
     * This is what lets a message that arrived over the daemon's LAN API — with the server
     * unreachable — still reach the session process that can act on it.
     */
    const sessionSockets = new Map<string, Socket>();
    // Clean up stale socket file from previous daemon run
    if (existsSync(SOCKET_PATH)) {
        try { unlinkSync(SOCKET_PATH); } catch { /* ignore */ }
    }

    const server: Server = createServer((socket: Socket) => {
        const state: SessionSocketState = { sessionId: null, sessionTag: null, pid: null };
        let buf = '';
        let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;

        const resetHeartbeat = () => {
            if (heartbeatTimer) clearTimeout(heartbeatTimer);
            heartbeatTimer = setTimeout(() => {
                logger.debug(`[UNIX SOCKET] Heartbeat timeout for session ${state.sessionId ?? 'unknown'}`);
                socket.destroy();
            }, HEARTBEAT_TIMEOUT_MS);
        };

        socket.on('data', (data: Buffer) => {
            buf += data.toString('utf-8');
            const lines = buf.split('\n');
            buf = lines.pop() ?? ''; // keep incomplete line in buffer

            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const msg: DaemonSocketMessage = JSON.parse(line);
                    switch (msg.type) {
                        case 'hello':
                            state.sessionId = msg.sessionId ?? null;
                            state.sessionTag = msg.sessionTag ?? null;
                            state.pid = msg.pid ?? null;
                            if (state.sessionId) {
                                connectedSessions.add(state.sessionId);
                                sessionSockets.set(state.sessionId, socket);
                            }
                            logger.debug(`[UNIX SOCKET] Session ${msg.sessionId} registered (pid=${msg.pid})`);
                            callbacks.onSessionHello(socket, msg);
                            resetHeartbeat();
                            break;
                        case 'heartbeat':
                            resetHeartbeat();
                            break;
                        case 'session-event':
                            // Liveness is implied by the heartbeat, so this frame only carries the
                            // body; a malformed one is dropped rather than tearing down the socket.
                            if (state.sessionId && msg.event) {
                                callbacks.onSessionEvent(state.sessionId, msg.event);
                            }
                            break;
                        case 'goodbye':
                            logger.debug(`[UNIX SOCKET] Session ${state.sessionId} sent goodbye`);
                            if (heartbeatTimer) clearTimeout(heartbeatTimer);
                            socket.end();
                            break;
                    }
                } catch {
                    logger.debug(`[UNIX SOCKET] Invalid JSON from session: ${line.slice(0, 80)}`);
                }
            }
        });

        socket.on('close', () => {
            if (heartbeatTimer) clearTimeout(heartbeatTimer);
            if (state.sessionId) {
                connectedSessions.delete(state.sessionId);
                // Only if it is still this socket's entry: a reconnecting session may already have
                // replaced it, and dropping the new one would strand the session.
                if (sessionSockets.get(state.sessionId) === socket) {
                    sessionSockets.delete(state.sessionId);
                }
            }
            logger.debug(`[UNIX SOCKET] Session ${state.sessionId} disconnected`);
            callbacks.onSessionDisconnect(state.sessionId);
        });

        socket.on('error', (err: Error) => {
            logger.debug(`[UNIX SOCKET] Session socket error: ${err.message}`);
            socket.destroy();
        });
    });

    server.listen(SOCKET_PATH, () => {
        logger.debug(`[UNIX SOCKET] Listening on ${SOCKET_PATH}`);
    });

    server.on('error', (err: Error) => {
        logger.debug(`[UNIX SOCKET] Server error: ${err.message}`);
    });

    return {
        socketPath: SOCKET_PATH,
        isSessionConnected: (sessionId: string) => connectedSessions.has(sessionId),
        sendToSession: (sessionId: string, message: Record<string, unknown>) => {
            const socket = sessionSockets.get(sessionId);
            // `writable` rather than just a lookup: a socket can linger after the peer is gone, and
            // reporting success for a write nobody receives would be worse than reporting failure.
            if (!socket || socket.destroyed || !socket.writable) {
                return false;
            }
            // Same newline-delimited framing the sessions use on the way in.
            socket.write(`${JSON.stringify(message)}\n`);
            return true;
        },
        stop: async () => {
            return new Promise<void>((resolve) => {
                server.close(() => {
                    if (existsSync(SOCKET_PATH)) {
                        try { unlinkSync(SOCKET_PATH); } catch { /* ignore */ }
                    }
                    logger.debug('[UNIX SOCKET] Server stopped');
                    resolve();
                });
            });
        },
    };
}
