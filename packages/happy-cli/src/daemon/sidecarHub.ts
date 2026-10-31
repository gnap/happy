/**
 * The daemon's end of the sidecar control channel.
 *
 * Listens on a unix socket the sidecar dials. One sidecar at a time: the socket file is 0600 in the
 * user's Happy home, so only that user can connect; a second connection replaces the first (the
 * sidecar restarted), and the old socket is closed rather than left half-supervised.
 *
 * The hub owns no policy: it validates frames, tracks presence, and forwards spawn/signal requests
 * and sidecar events to the daemon. Whether GUI work is allowed is `SidecarPresence`'s answer, and
 * what a spawn means is the daemon's.
 */

import { createServer, type Server, type Socket } from 'node:net';
import { chmodSync, existsSync, unlinkSync } from 'node:fs';
import {
    SIDECAR_PROTOCOL_VERSION,
    SIDECAR_TIMEOUT_MS,
    SidecarPresence,
    decodeSidecarFrame,
    encodeSidecarFrame,
    type SidecarFrame,
} from './sidecar';

export type SpawnRequest = { requestId: string; sessionId: string; cwd: string; argv: string[] };

export type SidecarHubOptions = {
    socketPath: string;
    /** The uid allowed to talk to this daemon — the owner of Happy's home directory. */
    expectedUid: number;
    onSpawn: (request: SpawnRequest) => void;
    onSignal: (sessionId: string, signal: 'SIGTERM' | 'SIGKILL') => void;
    /** `spawned`, `error` and `exit` frames, for the daemon's session bookkeeping. */
    onEvent: (frame: SidecarFrame) => void;
    log: (message: string) => void;
};

const HEARTBEAT_INTERVAL_MS = 5_000;

export class SidecarHub {
    private server: Server | null = null;
    private client: Socket | null = null;
    private buffer = '';
    private heartbeat: ReturnType<typeof setInterval> | null = null;
    private readonly presence = new SidecarPresence();

    constructor(private readonly options: SidecarHubOptions) {}

    get state() {
        return this.presence.current;
    }

    get usable(): boolean {
        return this.presence.usable;
    }

    get keychainUsable(): boolean {
        return this.presence.keychainUsable;
    }

    start(): void {
        if (this.server) return;
        try {
            if (existsSync(this.options.socketPath)) {
                unlinkSync(this.options.socketPath);
            }
        } catch {
            // A socket another process is using is not ours to remove; listen() reports it.
        }
        this.server = createServer((socket) => this.accept(socket));
        this.server.on('error', (error) => {
            this.options.log(`[SIDECAR] hub error: ${String(error)}`);
        });
        this.server.listen(this.options.socketPath, () => {
            try {
                chmodSync(this.options.socketPath, 0o600);
            } catch {
                this.options.log('[SIDECAR] could not restrict the socket permissions');
            }
            this.options.log(`[SIDECAR] listening on ${this.options.socketPath}`);
        });
        this.heartbeat = setInterval(() => this.tick(), HEARTBEAT_INTERVAL_MS);
        (this.heartbeat as unknown as { unref?: () => void }).unref?.();
    }

    stop(): void {
        if (this.heartbeat) {
            clearInterval(this.heartbeat);
            this.heartbeat = null;
        }
        this.client?.destroy();
        this.client = null;
        this.server?.close();
        this.server = null;
        try {
            if (existsSync(this.options.socketPath)) unlinkSync(this.options.socketPath);
        } catch {
            // best effort
        }
    }

    /** Sends a frame to the sidecar; false when there is nobody to send it to. */
    send(frame: SidecarFrame): boolean {
        if (!this.client || this.client.destroyed) {
            return false;
        }
        try {
            this.client.write(encodeSidecarFrame(frame));
            return true;
        } catch {
            return false;
        }
    }

    private tick(): void {
        const now = Date.now();
        if (this.presence.timedOut(now)) {
            this.options.log('[SIDECAR] no pong; treating the sidecar as gone');
            this.drop('heartbeat timeout', now);
            return;
        }
        if (this.client && !this.client.destroyed) {
            this.send({ t: 'ping' });
        }
    }

    private accept(socket: Socket): void {
        // One supervisor: a reconnecting sidecar replaces the old connection instead of leaving a
        // stale socket that would keep receiving spawn requests nothing answers.
        if (this.client && this.client !== socket) {
            this.client.destroy();
        }
        this.client = socket;
        this.buffer = '';
        const now = Date.now();

        socket.setEncoding('utf8');
        socket.on('data', (chunk: string) => this.consume(chunk, now));
        socket.on('error', () => { /* close handles it */ });
        socket.on('close', () => {
            if (this.client === socket) {
                this.drop('socket closed', Date.now());
            }
        });
    }

    private consume(chunk: string, now: number): void {
        this.buffer += chunk;
        for (;;) {
            const newline = this.buffer.indexOf('\n');
            if (newline === -1) {
                // A client that never sends a newline is not sending control frames.
                if (this.buffer.length > 64 * 1024) {
                    this.drop('oversized frame', now);
                }
                return;
            }
            const line = this.buffer.slice(0, newline);
            this.buffer = this.buffer.slice(newline + 1);
            const frame = decodeSidecarFrame(line);
            if (!frame) {
                continue;
            }
            this.handle(frame, now);
        }
    }

    private handle(frame: SidecarFrame, now: number): void {
        switch (frame.t) {
            case 'hello': {
                if (frame.protocol !== SIDECAR_PROTOCOL_VERSION) {
                    this.options.log(`[SIDECAR] rejected protocol ${frame.protocol}`);
                    this.send({ t: 'error', requestId: 'hello', code: 'protocol', message: `expected ${SIDECAR_PROTOCOL_VERSION}` });
                    this.client?.destroy();
                    return;
                }
                if (frame.uid !== this.options.expectedUid) {
                    this.options.log(`[SIDECAR] rejected uid ${frame.uid}`);
                    this.client?.destroy();
                    return;
                }
                this.presence.hello(frame.capabilities, now);
                this.options.log(`[SIDECAR] ready: gui=${frame.capabilities.gui} keychain=${frame.capabilities.keychain}`);
                return;
            }
            case 'state':
                this.presence.capabilitiesChanged(frame.capabilities, now);
                this.options.log(`[SIDECAR] state: keychain=${frame.capabilities.keychain}`);
                return;
            case 'pong':
                this.presence.pong(now);
                return;
            case 'spawn':
                if (!this.presence.usable) {
                    this.send({ t: 'error', requestId: frame.requestId, code: 'sidecar-unavailable', message: this.presence.refusal().message });
                    return;
                }
                this.options.onSpawn({ requestId: frame.requestId, sessionId: frame.sessionId, cwd: frame.cwd, argv: frame.argv });
                return;
            case 'signal':
                this.options.onSignal(frame.sessionId, frame.signal);
                return;
            case 'spawned':
            case 'error':
            case 'exit':
                this.options.onEvent(frame);
                return;
            default:
                return;
        }
    }

    private drop(reason: string, now: number): void {
        this.presence.lose(reason, now);
        this.client?.destroy();
        this.client = null;
        this.options.log(`[SIDECAR] lost: ${reason}`);
    }
}
