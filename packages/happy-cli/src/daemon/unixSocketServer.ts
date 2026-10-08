import { createServer, Server, Socket } from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { logger } from '@/ui/logger';

export interface DaemonSocketMessage {
    type: 'hello' | 'heartbeat' | 'goodbye' | 'session-event' | 'lan-delivered';
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
    /** For `lan-delivered`: which message, and whether the session routed it. */
    localId?: string;
    delivered?: boolean;
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

/**
 * A session reporting whether a LAN-delivered user message reached it. The daemon relays this to
 * the App, which otherwise has no way to tell a delivered message from a dropped one.
 */
export type LanDeliveryHandler = (
    sessionId: string | null,
    localId: string,
    delivered: boolean,
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
    onLanDelivery: LanDeliveryHandler;
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
        // Decodes across chunk boundaries. `Buffer.toString('utf8')` tears a multi-byte character
        // in half when a frame straddles two chunks, and the replacement characters that produces
        // make the line unparseable — which dropped forwarded message frames (full of CJK) while
        // the small ASCII hello/heartbeat frames sailed through.
        const decoder = new StringDecoder('utf8');
        let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;

        const resetHeartbeat = () => {
            if (heartbeatTimer) clearTimeout(heartbeatTimer);
            heartbeatTimer = setTimeout(() => {
                logger.debug(`[UNIX SOCKET] Heartbeat timeout for session ${state.sessionId ?? 'unknown'}`);
                socket.destroy();
            }, HEARTBEAT_TIMEOUT_MS);
        };

        socket.on('data', (data: Buffer) => {
            buf += decoder.write(data);
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
                            // Only the drops are logged: this runs per incoming update, and the
                            // success path would bury the cases worth seeing.
                            if (!state.sessionId || !msg.event) {
                                logger.debug(
                                    `[UNIX SOCKET] session-event dropped: ${state.sessionId ? 'no event' : 'not registered'}`,
                                );
                            }
                            if (state.sessionId && msg.event) {
                                callbacks.onSessionEvent(state.sessionId, msg.event);
                            }
                            break;
                        case 'lan-delivered':
                            if (state.sessionId && typeof msg.localId === 'string') {
                                callbacks.onLanDelivery(state.sessionId, msg.localId, msg.delivered === true);
                            }
                            break;
                        case 'goodbye':
                            logger.debug(`[UNIX SOCKET] Session ${state.sessionId} sent goodbye`);
                            if (heartbeatTimer) clearTimeout(heartbeatTimer);
                            socket.end();
                            break;
                    }
                } catch (error) {
                    // Head, tail and length, not a truncated head: a frame that was torn, doubled,
                    // or genuinely malformed all look identical in the first 80 characters, which
                    // is exactly what made the previous occurrence undiagnosable. Only logged once
                    // parsing has already failed, so it costs nothing on the working path.
                    logger.debug(
                        `[UNIX SOCKET] Invalid JSON from session (${line.length} bytes, ${String(error)}):` +
                        ` head=${line.slice(0, 60)} … tail=${line.slice(-60)}`,
                    );
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
