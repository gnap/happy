/**
 * Happy Sidecar — the daemon's counterpart inside the user's desktop session.
 *
 * Run by a LaunchAgent in `gui/$UID`, so it starts when a user logs in and stops when they log out.
 * It dials the daemon's socket, says what it can do, and then only executes what the daemon asks:
 * spawn a session process here (where the login keychain and the desktop exist) and report its pid
 * and exit. It holds no session state and speaks to no network.
 */

import { connect, type Socket } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import {
    SIDECAR_PROTOCOL_VERSION,
    decodeSidecarFrame,
    encodeSidecarFrame,
    type SidecarFrame,
} from './sidecar';

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export async function runSidecar(): Promise<void> {
    if (process.platform !== 'darwin') {
        console.error('Happy Sidecar runs on macOS only');
        return;
    }
    const socketPath = join(configuration.happyHomeDir, 'sidecar.sock');
    const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
    let backoff = RECONNECT_MIN_MS;
    let stopped = false;
    let socket: Socket | null = null;
    let buffer = '';
    const children = new Map<string, ChildProcess>();

    const send = (frame: SidecarFrame): void => {
        if (socket && !socket.destroyed) {
            socket.write(encodeSidecarFrame(frame));
        }
    };

    const dial = (): void => {
        if (stopped) return;
        socket = connect(socketPath);
        buffer = '';
        socket.setEncoding('utf8');
        socket.on('connect', () => {
            backoff = RECONNECT_MIN_MS;
            logger.debug('[SIDECAR] connected to the daemon');
            send({
                t: 'hello',
                protocol: SIDECAR_PROTOCOL_VERSION,
                uid,
                capabilities: { gui: true, keychain: 'unknown' },
            });
        });
        socket.on('data', (chunk: string) => {
            buffer += chunk;
            for (;;) {
                const at = buffer.indexOf('\n');
                if (at === -1) return;
                const line = buffer.slice(0, at);
                buffer = buffer.slice(at + 1);
                const frame = decodeSidecarFrame(line);
                if (frame) handle(frame);
            }
        });
        socket.on('error', () => { /* close handles it */ });
        socket.on('close', () => {
            socket = null;
            if (stopped) return;
            const delay = backoff;
            backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
            setTimeout(dial, delay);
        });
    };

    const handle = (frame: SidecarFrame): void => {
        switch (frame.t) {
            case 'ping':
                send({ t: 'pong', at: Date.now() });
                return;
            case 'spawn': {
                try {
                    const [command, ...args] = frame.argv;
                    const child = spawn(command, args, {
                        cwd: frame.cwd,
                        stdio: 'ignore',
                        env: process.env,
                    });
                    if (!child.pid) {
                        throw new Error('the process did not start');
                    }
                    const pid = child.pid;
                    children.set(frame.sessionId, child);
                    send({ t: 'spawned', requestId: frame.requestId, sessionId: frame.sessionId, pid });
                    child.on('exit', (code, signal) => {
                        children.delete(frame.sessionId);
                        send({ t: 'exit', sessionId: frame.sessionId, pid, code, signal });
                    });
                } catch (error) {
                    send({
                        t: 'error',
                        requestId: frame.requestId,
                        code: 'spawn-failed',
                        message: error instanceof Error ? error.message : String(error),
                    });
                }
                return;
            }
            case 'signal': {
                const child = children.get(frame.sessionId);
                if (child) {
                    try { child.kill(frame.signal); } catch { /* already gone */ }
                }
                return;
            }
            default:
                return;
        }
    };

    const shutdown = (): void => {
        stopped = true;
        socket?.destroy();
        for (const child of children.values()) {
            try { child.kill('SIGTERM'); } catch { /* already gone */ }
        }
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
    process.on('SIGHUP', shutdown);

    dial();
    await new Promise<void>((resolve) => {
        const keepAlive = setInterval(() => {
            if (stopped) {
                clearInterval(keepAlive);
                resolve();
            }
        }, 1_000);
    });
}
