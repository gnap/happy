import { createServer, Server, Socket } from 'node:net';
import { unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { logger } from '@/ui/logger';

export interface DaemonSocketMessage {
    type: 'hello' | 'heartbeat' | 'goodbye';
    sessionId?: string;
    pid?: number;
    sessionTag?: string;
    metadata?: Record<string, unknown>;
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
}): { stop: () => Promise<void>; socketPath: string; isSessionConnected: (sessionId: string) => boolean } {
    /** Set of session IDs with active socket connections. Survives daemon restart gaps. */
    const connectedSessions = new Set<string>();
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
                            if (state.sessionId) connectedSessions.add(state.sessionId);
                            logger.debug(`[UNIX SOCKET] Session ${msg.sessionId} registered (pid=${msg.pid})`);
                            callbacks.onSessionHello(socket, msg);
                            resetHeartbeat();
                            break;
                        case 'heartbeat':
                            resetHeartbeat();
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
            if (state.sessionId) connectedSessions.delete(state.sessionId);
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
