/**
 * WebSocket client for machine/daemon communication with Happy server
 * Similar to ApiSessionClient but for machine-scoped connections
 */

import { io, Socket } from 'socket.io-client';
import os from 'os';
import { logger } from '@/ui/logger';
import { configuration, serverHttpsAgent } from '@/configuration';
import { projectPath } from '@/projectPath';
import { MachineMetadata, DaemonState, Machine, Update, UpdateMachineBody } from './types';
import { registerCommonHandlers, SpawnSessionOptions, SpawnSessionResult } from '../modules/common/registerCommonHandlers';
import { encodeBase64, decodeBase64, encrypt, decrypt } from './encryption';
import { backoff } from '@/utils/time';
import { isBun, isNode } from '@/utils/runtime';
import { RpcHandlerManager } from './rpc/RpcHandlerManager';
import type { ArchiveSessionResult, RestartSessionResult } from '../daemon/types';

/** How long a best-effort daemon-state write may take before the caller moves on. */
const DAEMON_STATE_WRITE_TIMEOUT_MS = 2000;

function getLocalMachineMetadata(): MachineMetadata {
    return {
        host: os.hostname(),
        platform: os.platform(),
        happyCliVersion: configuration.currentCliVersion,
        homeDir: os.homedir(),
        happyHomeDir: configuration.happyHomeDir,
        happyLibDir: projectPath(),
    };
}

export function shouldSyncMachineMetadata(current: MachineMetadata | null, next: MachineMetadata): boolean {
    if (!current) {
        return true;
    }

    return (
        current.host !== next.host ||
        current.platform !== next.platform ||
        current.happyCliVersion !== next.happyCliVersion ||
        current.homeDir !== next.homeDir ||
        current.happyHomeDir !== next.happyHomeDir ||
        current.happyLibDir !== next.happyLibDir ||
        // The route names are what an App offers in a profile, so a route silently appearing or
        // disappearing has to reach the server even when nothing else about the machine changed.
        // Order is not meaningful here: the list is a set of names.
        !sameNames(current.proxyRoutes, next.proxyRoutes)
    );
}

function sameNames(a: string[] | undefined, b: string[] | undefined): boolean {
    const left = a ?? [];
    const right = b ?? [];
    if (left.length !== right.length) return false;
    const sortedLeft = [...left].sort();
    const sortedRight = [...right].sort();
    return sortedLeft.every((name, i) => name === sortedRight[i]);
}

export function buildSyncedMachineMetadata(current: MachineMetadata | null, local: MachineMetadata): MachineMetadata {
    return {
        ...(current ?? {}),
        ...local,
    };
}

interface ServerToDaemonEvents {
    update: (data: Update) => void;
    'rpc-request': (data: { method: string, params: string }, callback: (response: string) => void) => void;
    'rpc-registered': (data: { method: string }) => void;
    'rpc-unregistered': (data: { method: string }) => void;
    'rpc-error': (data: { type: string, error: string }) => void;
    auth: (data: { success: boolean, user: string }) => void;
    error: (data: { message: string }) => void;
}

interface DaemonToServerEvents {
    'machine-alive': (data: {
        machineId: string;
        time: number;
    }) => void;

    'machine-update-metadata': (data: {
        machineId: string;
        metadata: string; // Encrypted MachineMetadata
        expectedVersion: number
    }, cb: (answer: {
        result: 'error'
    } | {
        result: 'version-mismatch'
        version: number,
        metadata: string
    } | {
        result: 'success',
        version: number,
        metadata: string
    }) => void) => void;

    'machine-update-state': (data: {
        machineId: string;
        daemonState: string; // Encrypted DaemonState
        expectedVersion: number
    }, cb: (answer: {
        result: 'error'
    } | {
        result: 'version-mismatch'
        version: number,
        daemonState: string
    } | {
        result: 'success',
        version: number,
        daemonState: string
    }) => void) => void;

    'rpc-register': (data: { method: string }) => void;
    'rpc-unregister': (data: { method: string }) => void;
    'rpc-call': (data: { method: string, params: any }, callback: (response: {
        ok: boolean
        result?: any
        error?: string
    }) => void) => void;
}

type MachineRpcHandlers = {
    spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
    stopSession: (sessionId: string) => boolean;
    archiveSession: (sessionId: string) => ArchiveSessionResult;
    restartSession: (sessionId: string, sandboxConfig?: any, requiresDesktop?: boolean, expectGeneration?: number, mode?: 'wait' | 'accept') => Promise<RestartSessionResult>;
    requestShutdown: () => void;
}

export class ApiMachineClient {
    private socket!: Socket<ServerToDaemonEvents, DaemonToServerEvents>;
    private keepAliveInterval: NodeJS.Timeout | null = null;
    private rpcHandlerManager: RpcHandlerManager;

    constructor(
        private token: string,
        private machine: Machine,
        private websocketOnly: boolean = false
    ) {
        // Initialize RPC handler manager
        this.rpcHandlerManager = new RpcHandlerManager({
            scopePrefix: this.machine.id,
            encryptionKey: this.machine.encryptionKey,
            encryptionVariant: this.machine.encryptionVariant,
            logger: (msg, data) => logger.debug(msg, data)
        });

        registerCommonHandlers(this.rpcHandlerManager, process.cwd());
    }

    setRPCHandlers({
        spawnSession,
        stopSession,
        archiveSession,
        restartSession,
        requestShutdown
    }: MachineRpcHandlers) {
        // Register spawn session handler
        this.rpcHandlerManager.registerHandler('spawn-happy-session', async (params: any) => {
            const { directory, sessionId, machineId, approvedNewDirectoryCreation, agent, token, environmentVariables, sandboxConfig, requiresDesktop, expect, generation, proxyViaRelay } = params || {};
            // Keys only: the values carry provider tokens, and a profile can name its SOCKS5 hop
            // there too — a URL with credentials this log has no business holding.
            logger.debug(`[API MACHINE] Spawning session in ${directory ?? '(none)'} agent=${agent ?? '(default)'} envKeys=${Object.keys(environmentVariables ?? {}).join(',') || '(none)'} proxyViaRelay=${typeof proxyViaRelay === 'boolean' ? proxyViaRelay : '(unset)'}`);

            if (!directory) {
                throw new Error('Directory is required');
            }

            const result = await spawnSession({
                directory, sessionId, machineId, approvedNewDirectoryCreation, agent, token, environmentVariables, sandboxConfig,
                ...(requiresDesktop === true ? { requiresDesktop: true } : {}),
                ...(expect === 'accepted' ? { expectAccepted: true } : {}),
                ...(typeof generation === 'number' ? { generation } : {}),
                ...(typeof proxyViaRelay === 'boolean' ? { proxyViaRelay } : {}),
            });

            switch (result.type) {
                case 'success':
                    logger.debug(`[API MACHINE] Spawned session ${result.sessionId}`);
                    // Additive: `type`/`sessionId` are what earlier Apps read; the rest says
                    // which generation was realized and that it is settled.
                    return {
                        type: 'success',
                        sessionId: result.sessionId,
                        accepted: true,
                        stage: 'running',
                        ref: result.sessionId,
                        ...(result.tag ? { tag: result.tag } : {}),
                        ...(result.generation !== undefined ? { generation: result.generation } : {}),
                        phase: 'Running',
                    };

                case 'accepted':
                    logger.debug(`[API MACHINE] Session accepted (tag ${result.tag.slice(0, 8)}…), waiting to register`);
                    return {
                        type: 'accepted',
                        success: true,
                        accepted: true,
                        stage: 'starting',
                        ref: result.ref,
                        tag: result.tag,
                        generation: result.generation,
                        phase: result.phase,
                    };

                case 'requestToApproveDirectoryCreation':
                    logger.debug(`[API MACHINE] Requesting directory creation approval for: ${result.directory}`);
                    return { type: 'requestToApproveDirectoryCreation', directory: result.directory };

                case 'error':
                    throw new Error(result.errorMessage);
            }
        });

        // Register stop session handler  
        this.rpcHandlerManager.registerHandler('stop-session', (params: any) => {
            const { sessionId } = params || {};

            if (!sessionId) {
                throw new Error('Session ID is required');
            }

            const success = stopSession(sessionId);
            if (!success) {
                throw new Error('Session not found or failed to stop');
            }

            logger.debug(`[API MACHINE] Stopped session ${sessionId}`);
            return { message: 'Session stopped' };
        });

        // Register kill session handler (handles both active and stopped sessions)
        this.rpcHandlerManager.registerHandler('killSession', (params: any) => {
            const { sessionId } = params || {};

            if (!sessionId) {
                throw new Error('Session ID is required');
            }

            // Stop first if still running
            const stopped = stopSession(sessionId);

            // Then record the deletion. This is applied even when the machine has no row for the
            // id: the tombstone is what the server replay consumes, and it is the App's delete.
            const archived = archiveSession(sessionId);
            logger.debug(`[API MACHINE] killSession: ${sessionId} — stopped=${stopped} applied=${archived.applied} known=${archived.known}`);
            // `success` remains for older Apps; accepted/applied/reason are what a newer one reads.
            // A stopped process and a recorded deletion are different facts, and the caller now
            // gets both instead of a single boolean that hid the one that did not happen.
            return {
                success: archived.applied,
                accepted: true,
                applied: archived.applied,
                // Additive to the fields older Apps read: which stage the deletion reached and
                // what the session is now. A tombstone that landed means the row is Archived.
                stage: archived.applied ? 'done' : 'failed',
                ref: sessionId,
                ...(archived.applied ? { phase: 'Archived' } : {}),
                stopped,
                known: archived.known,
                reason: archived.applied
                    ? (stopped ? 'stopped-and-archived' : 'archived')
                    : 'archive-failed',
                message: archived.applied
                    ? (stopped ? 'Session stopped and archived' : 'Session archived')
                    : 'Session could not be archived',
            };
        });

        // Register restart session handler.
        // Returns immediately (fire-and-forget) to avoid server-side RPC timeout.
        // The actual restart runs asynchronously; the App will see the session come
        // back online through normal session update events.
        this.rpcHandlerManager.registerHandler('restartSession', async (params: any) => {
            const { sessionId, sandboxConfig, requiresDesktop, expect, generation } = params || {};
            if (!sessionId) {
                throw new Error('Session ID is required');
            }
            logger.debug(`[API MACHINE] restartSession params: sessionId=${sessionId}, sandboxConfig=${JSON.stringify(sandboxConfig)}, expect=${expect ?? 'legacy'}, generation=${generation ?? '-'}`);
            const desktop = typeof requiresDesktop === 'boolean' ? requiresDesktop : undefined;

            if (expect === 'accepted' || typeof generation === 'number') {
                // The acceptance answer is synchronous work (the generation checks and recording
                // the desired state), so awaiting it does not wait for the restart itself. This is
                // what lets a refusal — a generation this machine does not know — reach the caller
                // instead of being silently dropped.
                const result = await restartSession(sessionId, sandboxConfig, desktop, typeof generation === 'number' ? generation : undefined, 'accept');
                logger.debug(`[API MACHINE] restartSession: ${sessionId} — accepted=${result.accepted} stage=${result.stage} reason=${result.reason ?? '-'}`);
                return result;
            }

            // Legacy callers get the same fire-and-forget they always got; the added fields say
            // what this machine can honestly say at this point in the work.
            restartSession(sessionId, sandboxConfig, desktop).then(r => {
                logger.debug(`[API MACHINE] restartSession: ${sessionId} — success=${r.success}`);
            }).catch(err => {
                logger.debug(`[API MACHINE] restartSession: ${sessionId} — error:`, err);
            });
            return { success: true, accepted: true, stage: 'scheduled', ref: sessionId, phase: 'Restarting' };
        });

        // Register stop daemon handler
        this.rpcHandlerManager.registerHandler('stop-daemon', () => {
            logger.debug('[API MACHINE] Received stop-daemon RPC request');

            // Trigger shutdown callback after a delay
            setTimeout(() => {
                logger.debug('[API MACHINE] Initiating daemon shutdown from RPC');
                requestShutdown();
            }, 100);

            return { message: 'Daemon stop request acknowledged, starting shutdown sequence...' };
        });
    }

    /**
     * Update machine metadata
     * Currently unused, changes from the mobile client are more likely
     * for example to set a custom name.
     */
    async updateMachineMetadata(handler: (metadata: MachineMetadata | null) => MachineMetadata): Promise<void> {
        await backoff(async () => {
            const updated = handler(this.machine.metadata);

            const answer = await this.socket.emitWithAck('machine-update-metadata', {
                machineId: this.machine.id,
                metadata: encodeBase64(encrypt(this.machine.encryptionKey, this.machine.encryptionVariant, updated)),
                expectedVersion: this.machine.metadataVersion
            });

            if (answer.result === 'success') {
                this.machine.metadata = decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(answer.metadata));
                this.machine.metadataVersion = answer.version;
                logger.debug('[API MACHINE] Metadata updated successfully');
            } else if (answer.result === 'version-mismatch') {
                if (answer.version > this.machine.metadataVersion) {
                    this.machine.metadataVersion = answer.version;
                    this.machine.metadata = decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(answer.metadata));
                }
                throw new Error('Metadata version mismatch'); // Triggers retry
            }
        });
    }

    /** Whether the machine socket is currently connected. */
    isSocketConnected(): boolean {
        return this.socket.connected;
    }

    /**
     * Write daemon state once, giving up if the server does not answer in time.
     *
     * `updateDaemonState` wraps its body in `backoff`, which only returns on success -- on an
     * unreachable server it never resolves. That is fine for callers that can afford to wait,
     * but it must never be awaited on the shutdown path: that blocks the rest of the teardown
     * (including withdrawing the LAN advertisement) for as long as the server stays down.
     *
     * Returns whether the write landed. Callers that want eventual delivery retry on a later
     * tick rather than spinning here.
     */
    async tryUpdateDaemonState(handler: (state: DaemonState | null) => DaemonState): Promise<boolean> {
        try {
            const updated = handler(this.machine.daemonState);
            const ack = this.socket.emitWithAck('machine-update-state', {
                machineId: this.machine.id,
                daemonState: encodeBase64(encrypt(this.machine.encryptionKey, this.machine.encryptionVariant, updated)),
                expectedVersion: this.machine.daemonStateVersion
            });
            // The ack may still arrive after we give up on it; swallow it so it cannot
            // surface as an unhandled rejection.
            ack.catch(() => undefined);

            const answer = await Promise.race([
                ack,
                new Promise<null>((resolve) => {
                    setTimeout(() => resolve(null), DAEMON_STATE_WRITE_TIMEOUT_MS).unref?.();
                }),
            ]);
            if (answer === null) {
                logger.debug('[API MACHINE] Daemon state write timed out; continuing without it');
                return false;
            }
            if (answer.result === 'success') {
                this.machine.daemonState = decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(answer.daemonState));
                this.machine.daemonStateVersion = answer.version;
                return true;
            }
            // Someone else wrote first: adopt their version and let the caller retry later,
            // rather than spinning inside an unbounded loop the way updateDaemonState does.
            if (answer.result === 'version-mismatch' && answer.version > this.machine.daemonStateVersion) {
                this.machine.daemonStateVersion = answer.version;
                this.machine.daemonState = decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(answer.daemonState));
            }
            return false;
        } catch (error) {
            logger.debug('[API MACHINE] Daemon state write failed; continuing without it', { error: String(error) });
            return false;
        }
    }

    /**
     * Update daemon state (runtime info) - similar to session updateAgentState
     * Simplified without lock - relies on backoff for retry
     */
    async updateDaemonState(handler: (state: DaemonState | null) => DaemonState): Promise<void> {
        await backoff(async () => {
            const updated = handler(this.machine.daemonState);

            const answer = await this.socket.emitWithAck('machine-update-state', {
                machineId: this.machine.id,
                daemonState: encodeBase64(encrypt(this.machine.encryptionKey, this.machine.encryptionVariant, updated)),
                expectedVersion: this.machine.daemonStateVersion
            });

            if (answer.result === 'success') {
                this.machine.daemonState = decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(answer.daemonState));
                this.machine.daemonStateVersion = answer.version;
                logger.debug('[API MACHINE] Daemon state updated successfully');
            } else if (answer.result === 'version-mismatch') {
                if (answer.version > this.machine.daemonStateVersion) {
                    this.machine.daemonStateVersion = answer.version;
                    this.machine.daemonState = decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(answer.daemonState));
                }
                throw new Error('Daemon state version mismatch'); // Triggers retry
            }
        });
    }

    connect() {
        const serverUrl = configuration.serverUrl;
        logger.debug(`[API MACHINE] Connecting to ${serverUrl}`);

        // Polling is where a hanging request leaks a connection, so it is never the starting
        // transport on Bun — it used to be pinned there as a workaround, which is exactly what made
        // an unreachable server cost a socket per attempt. Node keeps the upgrade path.
        const socketOptions = this.websocketOnly || isBun()
            ? {
                transports: ['websocket'],
                upgrade: false,
              }
            : {
                transports: ['polling', 'websocket'],
              };

        this.socket = io(serverUrl, {
            ...socketOptions,
            auth: {
                token: this.token,
                clientType: 'machine-scoped' as const,
                machineId: this.machine.id
            },
            path: '/v1/updates',
            withCredentials: true,
            reconnection: true,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
            // See apiSession.ts: an attempt that never completes must not be left dangling.
            timeout: 20_000,
            requestTimeout: 30_000,
            ...(isNode() && { agent: serverHttpsAgent as any }),
        });

        this.socket.on('connect', () => {
            logger.debug('[API MACHINE] Connected to server');

            const localMetadata = getLocalMachineMetadata();

            // metadataVersion 0 means registration fell back to offline mode: our copy is the
            // local metadata, not the server's, which may still name a previous CLI version.
            if (this.machine.metadataVersion === 0 || shouldSyncMachineMetadata(this.machine.metadata, localMetadata)) {
                logger.debug('[API MACHINE] Local machine metadata changed, syncing static metadata');
                this.updateMachineMetadata((metadata) => buildSyncedMachineMetadata(metadata, localMetadata)).catch((error) => {
                    logger.debug('[API MACHINE] Failed to sync machine metadata on connect:', error);
                });
            }

            // Update daemon state to running
            // We need to override previous state because the daemon (this process)
            // has restarted with new PID & port
            this.updateDaemonState((state) => ({
                ...state,
                status: 'running',
                pid: process.pid,
                httpPort: this.machine.daemonState?.httpPort,
                startedAt: Date.now()
            }));


            // Register all handlers
            this.rpcHandlerManager.onSocketConnect(this.socket);

            // Start keep-alive
            this.startKeepAlive();
        });

        this.socket.on('disconnect', () => {
            logger.debug('[API MACHINE] Disconnected from server');
            this.rpcHandlerManager.onSocketDisconnect();
            this.stopKeepAlive();
        });

        // Single consolidated RPC handler
        this.socket.on('rpc-request', async (data: { method: string, params: string }, callback: (response: string) => void) => {
            logger.debugLargeJson(`[API MACHINE] Received RPC request:`, data);
            callback(await this.rpcHandlerManager.handleRequest(data));
        });

        // Handle update events from server
        this.socket.on('update', (data: Update) => {
            // Machine clients should only care about machine updates
            if (data.body.t === 'update-machine' && (data.body as UpdateMachineBody).machineId === this.machine.id) {
                // Handle machine metadata or daemon state updates from other clients (e.g., mobile app)
                const update = data.body as UpdateMachineBody;

                if (update.metadata) {
                    logger.debug('[API MACHINE] Received external metadata update');
                    this.machine.metadata = decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(update.metadata.value));
                    this.machine.metadataVersion = update.metadata.version;
                }

                if (update.daemonState) {
                    logger.debug('[API MACHINE] Received external daemon state update');
                    this.machine.daemonState = decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(update.daemonState.value));
                    this.machine.daemonStateVersion = update.daemonState.version;
                }
            } else {
                logger.debug(`[API MACHINE] Received unknown update type: ${(data.body as any).t}`);
            }
        });

        this.socket.on('connect_error', (error) => {
            logger.debug(`[API MACHINE] Connection error: ${error.message}`);
        });

        this.socket.io.on('error', (error: any) => {
            logger.debug('[API MACHINE] Socket error:', error);
        });
    }

    private startKeepAlive() {
        this.stopKeepAlive();
        this.keepAliveInterval = setInterval(() => {
            const payload = {
                machineId: this.machine.id,
                time: Date.now()
            };
            if (process.env.DEBUG) { // too verbose for production
                logger.debugLargeJson(`[API MACHINE] Emitting machine-alive`, payload);
            }
            this.socket.emit('machine-alive', payload);
        }, 20000);
        logger.debug('[API MACHINE] Keep-alive started (20s interval)');
    }

    private stopKeepAlive() {
        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval);
            this.keepAliveInterval = null;
            logger.debug('[API MACHINE] Keep-alive stopped');
        }
    }

    shutdown() {
        logger.debug('[API MACHINE] Shutting down');
        this.stopKeepAlive();
        if (this.socket) {
            this.socket.close();
            logger.debug('[API MACHINE] Socket closed');
        }
    }
}