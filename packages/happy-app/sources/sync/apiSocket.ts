import type { Socket } from 'socket.io-client';
import { io } from 'socket.io-client';
import { TokenStorage } from '@/auth/tokenStorage';
import { Encryption } from './encryption/encryption';
import { isRunningInTauri } from '@/utils/platform';
import { log } from '@/log';

type IoFn = typeof io;

//
// Constants (aligned with CLI/daemon reconnection behavior)
//

/** Min delay before first reconnection attempt (ms) */
const RECONNECT_DELAY_MIN = 2000;
/** Max delay between attempts (ms) - caps after several failures */
const RECONNECT_DELAY_MAX = 30000;
/** Jitter factor 0–1 to avoid thundering herd */
const RECONNECT_RANDOMIZATION_FACTOR = 0.5;
/** HTTP request timeout for sync RPCs */
const REQUEST_TIMEOUT_MS = 30_000;

/** Network error codes that warrant retry (same idea as CLI NETWORK_ERROR_CODES) */
const RETRYABLE_ERROR_HINTS = ['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'ENETUNREACH', 'timeout', 'Network'];

/**
 * engine.io hides the useful part of a transport failure on `error.description`
 * (the underlying Event / XHR status), so `error.message` alone is usually just
 * "websocket error" and tells us nothing about why the socket cannot open.
 */
function describeSocketError(error: unknown): string {
    if (!error || typeof error !== 'object') return String(error);
    const err = error as Error & { description?: unknown; context?: unknown; type?: string };
    const parts = [err.message || String(error)];
    if (err.type) parts.push(`type=${err.type}`);
    const description = err.description;
    if (typeof description === 'number' || typeof description === 'string') {
        parts.push(`description=${description}`);
    } else if (description && typeof description === 'object') {
        const desc = description as { type?: string; code?: number; message?: string };
        parts.push(`description=${desc.type ?? desc.message ?? ''}${desc.code !== undefined ? `(${desc.code})` : ''}`);
    }
    return parts.join(' ');
}

function shouldUseTauriHttp(path: string, method: string): boolean {
    // Tauri plugin-http drops POST /messages responses on Linux, causing permanent
    // spinner (outbox stuck in 'sending' despite the server receiving the message).
    // Browser fetch works correctly for all request types.
    return false;
}

//
// Types
//

export interface SyncSocketConfig {
    endpoint: string;
    token: string;
}

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error' | 'auth_error';

export interface SyncSocketState {
    isConnected: boolean;
    connectionStatus: ConnectionStatus;
    lastError: Error | null;
    /** If true, reconnection was stopped due to auth failure (e.g. 401) */
    authFailure?: boolean;
}

export type SyncSocketListener = (state: SyncSocketState) => void;

//
// Main Class
//

class ApiSocket {

    // State
    private socket: Socket | null = null;
    private config: SyncSocketConfig | null = null;
    private encryption: Encryption | null = null;
    private messageHandlers: Map<string, (data: any) => void> = new Map();
    private reconnectedListeners: Set<() => void> = new Set();
    private statusListeners: Set<(status: ConnectionStatus) => void> = new Set();
    private authErrorListeners: Set<() => void> = new Set();
    private _hasNetworkListeners = false;
    private currentStatus: ConnectionStatus = 'disconnected';
    private lastError: Error | null = null;
    /** When true, do not reconnect (e.g. after 401) */
    private reconnectionDisabled = false;
    /** Guards against multiple parallel async loaders racing inside connect(). */
    private connectInFlight = false;
    /** Timestamp of the last message/event received on the socket. Used for health checks. */
    private lastMessageReceivedAt = 0;
    /** The transport currently in use (websocket / polling). For detecting downgrades. */
    private lastTransportType: string | null = null;

    //
    // Initialization
    //

    initialize(config: SyncSocketConfig, encryption: Encryption) {
        this.config = config;
        this.encryption = encryption;
        this.connect();
    }

    //
    // Connection Management
    //

    connect() {
        if (!this.config) return;

        // Listen for browser online/offline events to recover from sleep/wake
        // where socket.io may not detect network restoration on Linux.
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function' && !this._hasNetworkListeners) {
            this._hasNetworkListeners = true;
            window.addEventListener('online', () => {
                if (!this.socket?.connected) {
                    this.socket?.disconnect();
                    this.socket = null;
                    this.connect();
                }
            });
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'visible' && !this.socket?.connected) {
                    this.socket?.disconnect();
                    this.socket = null;
                    this.connect();
                }
            });
        }

        if (this.socket) {
            // Already have a socket; only force reconnect if we had disabled reconnection (e.g. after token refresh)
            if (this.reconnectionDisabled) {
                this.reconnectionDisabled = false;
                this.disconnect();
            } else if (this.socket.connected) {
                return;
            } else if (this.socket.active) {
                // socket.io is still driving reconnection attempts; avoid tearing down its backoff.
                return;
            } else {
                // Stale instance (not connected, not reconnecting) — replace so explicit connect() can recover.
                this.socket.removeAllListeners();
                this.socket.disconnect();
                this.socket = null;
            }
        }

        this.updateStatus('connecting');
        this.lastError = null;

        // Another connect() is already awaiting the dynamic socket.io-client import;
        // it will pick up the latest this.config when it resumes. Dedupe.
        if (this.connectInFlight) return;
        this.connectInFlight = true;
        void this.#doConnect().finally(() => {
            this.connectInFlight = false;
        });
    }

    async #doConnect(): Promise<void> {
        if (!this.config) return;

        // While we awaited, the world may have moved on.
        if (!this.config) return;
        if (this.socket) return;
        // Allow any non-stable state — status may have been flipped by lifecycle events.
        if (this.currentStatus === 'disconnected' && this.reconnectionDisabled) return;

        const config = this.config;
        this.socket = io(config.endpoint, {
            path: '/v1/updates',
            auth: {
                token: config.token,
                clientType: 'user-scoped' as const
            },
            // WebSocket preferred but fall back to polling for weak/recovering networks (iOS suspend,
            // cellular) and for webviews whose native WebSocket wedges while plain HTTP still works.
            // engine.io only walks past transports[0] when tryAllTransports is set — without it the
            // 'polling' entry is inert and a WebSocket that cannot open never recovers.
            transports: ['websocket', 'polling'],
            tryAllTransports: true,
            reconnection: !this.reconnectionDisabled,
            reconnectionDelay: RECONNECT_DELAY_MIN,
            reconnectionDelayMax: RECONNECT_DELAY_MAX,
            reconnectionAttempts: Infinity,
            randomizationFactor: RECONNECT_RANDOMIZATION_FACTOR,
        });

        this.setupEventHandlers();
    }

    disconnect() {
        this.reconnectionDisabled = false;
        this.connectInFlight = false;
        if (this.socket) {
            this.socket.removeAllListeners();
            this.socket.disconnect();
            this.socket = null;
        }
        this.updateStatus('disconnected');
    }

    //
    // Listener Management
    //

    onReconnected = (listener: () => void) => {
        this.reconnectedListeners.add(listener);
        return () => this.reconnectedListeners.delete(listener);
    };

    onStatusChange = (listener: (status: ConnectionStatus) => void) => {
        this.statusListeners.add(listener);
        listener(this.currentStatus);
        return () => this.statusListeners.delete(listener);
    };

    /** Called when server returns 401 / auth invalid; reconnection is stopped until token refresh. */
    onAuthError = (listener: () => void) => {
        this.authErrorListeners.add(listener);
        return () => this.authErrorListeners.delete(listener);
    };

    getLastError = (): Error | null => this.lastError;
    isAuthFailure = (): boolean => this.currentStatus === 'auth_error';

    //
    // Message Handling
    //

    onMessage(event: string, handler: (data: any) => void) {
        this.messageHandlers.set(event, handler);
        return () => this.messageHandlers.delete(event);
    }

    offMessage(event: string, handler: (data: any) => void) {
        this.messageHandlers.delete(event);
    }

    /**
     * RPC call for sessions - uses session-specific encryption
     */
    async sessionRPC<R, A>(sessionId: string, method: string, params: A): Promise<R> {
        const sessionEncryption = this.encryption!.getSessionEncryption(sessionId);
        if (!sessionEncryption) {
            throw new Error(`Session encryption not found for ${sessionId}`);
        }
        
        const result = await this.socket!.emitWithAck('rpc-call', {
            method: `${sessionId}:${method}`,
            params: await sessionEncryption.encryptRaw(params)
        });
        
        if (result.ok) {
            return await sessionEncryption.decryptRaw(result.result) as R;
        }
        const message = (result as { error?: string }).error || 'RPC call failed';
        throw new Error(message);
    }

    /**
     * RPC call for machines - uses legacy/global encryption (for now)
     */
    async machineRPC<R, A>(machineId: string, method: string, params: A): Promise<R> {
        const machineEncryption = this.encryption!.getMachineEncryption(machineId);
        if (!machineEncryption) {
            throw new Error(`Machine encryption not found for ${machineId}`);
        }

        const result = await this.socket!.emitWithAck('rpc-call', {
            method: `${machineId}:${method}`,
            params: await machineEncryption.encryptRaw(params)
        });

        if (result.ok) {
            return await machineEncryption.decryptRaw(result.result) as R;
        }
        const message = (result as { error?: string }).error || 'RPC call failed';
        throw new Error(message);
    }

    send(event: string, data: any) {
        this.socket!.emit(event, data);
        return true;
    }

    async emitWithAck<T = any>(event: string, data: any): Promise<T> {
        if (!this.socket) {
            throw new Error('Socket not connected');
        }
        return await this.socket.emitWithAck(event, data);
    }

    //
    // HTTP Requests
    //

    async request(path: string, options?: RequestInit): Promise<Response> {
        if (!this.config) {
            throw new Error('SyncSocket not initialized');
        }

        const credentials = await TokenStorage.getCredentials();
        if (!credentials) {
            throw new Error('No authentication credentials');
        }

        const url = `${this.config.endpoint}${path}`;
        const method = (options?.method ?? 'GET').toUpperCase();
        const headers = {
            'Authorization': `Bearer ${credentials.token}`,
            ...options?.headers
        };

        const timeoutController = new AbortController();
        let timedOut = false;
        const timeoutId = setTimeout(() => {
            timedOut = true;
            timeoutController.abort();
        }, REQUEST_TIMEOUT_MS);

        const abortListener = () => {
            timeoutController.abort();
        };
        if (options?.signal) {
            if (options.signal.aborted) {
                clearTimeout(timeoutId);
                throw new Error(`Request aborted before start: ${path}`);
            }
            options.signal.addEventListener('abort', abortListener, { once: true });
        }

        try {
            const requestInit: RequestInit = {
                ...options,
                headers,
                signal: timeoutController.signal,
            };

            if (shouldUseTauriHttp(path, method)) {
                const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http');
                return await tauriFetch(url, requestInit);
            }

            return await fetch(url, requestInit);
        } catch (error) {
            if (timedOut) {
                throw new Error(`Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s: ${path}`);
            }
            throw error;
        } finally {
            clearTimeout(timeoutId);
            options?.signal?.removeEventListener('abort', abortListener);
        }
    }

    //
    // Token Management
    //

    updateToken(newToken: string) {
        if (this.config && this.config.token !== newToken) {
            this.config.token = newToken;

            if (this.socket) {
                this.disconnect();
                this.connect();
            }
        }
    }

    //
    // Background / Foreground Lifecycle
    //

    /**
     * Called when the app goes to background.
     * A live connected socket is left intact so the OS can keep it open.
     * If we're already in an error/disconnected state, tear down the socket so
     * socket.io's reconnection timers don't keep running in the background.
     * If we're mid-connect, leave the in-flight attempt alone.
     */
    pauseReconnection() {
        // Tear down on any non-connected state — a stale connecting/error socket
        // will not recover after iOS suspend. resumeReconnection() creates a fresh one.
        if (this.currentStatus !== 'connected') {
            this.disconnect();
        }
    }

    /**
     * Called when the app comes back to foreground, or network becomes reachable,
     * or network interface switches (WiFi ↔ Cellular).
     *
     * Probes the existing connection with an application-level ping first.
     * If the probe succeeds the connection is reused. If it fails a fresh
     * connection is created. The probe timeout is short (1.5s) because it's
     * just a small ping/pong round-trip — if it takes longer the connection
     * is almost certainly dead (silent TCP drop after iOS suspend, etc.).
     */
    async resumeReconnection(): Promise<boolean> {
        if (this.currentStatus === 'connected' && this.socket?.connected) {
            return await this.probeConnection();
        }
        // For any other state (disconnected, connecting, error):
        // tear down the old socket and start fresh. A stale 'connecting' state
        // from before sleep will never complete — burn it down.
        if (this.socket) {
            this.socket.removeAllListeners();
            this.socket.disconnect();
            this.socket = null;
        }
        this.reconnectionDisabled = false;
        this.connect();
        return false;
    }

    /**
     * Returns true if the connection appears healthy: socket reports connected
     * AND a message has been received within the last windowMs. A silent TCP
     * drop (common after iOS suspend) leaves `socket.connected === true` but
     * no data flows — the last-message check catches that.
     */
    isConnectionHealthy(windowMs: number = 30000): boolean {
        if (!this.socket?.connected) return false;
        if (this.lastMessageReceivedAt === 0) return true; // Just connected, give it time
        return (Date.now() - this.lastMessageReceivedAt) < windowMs;
    }

    /**
     * Emits an application-level ping and waits for the server ACK.
     * If no response within timeoutMs the connection is treated as stale and
     * a fresh reconnect is forced. The timeout is short because the probe is
     * just a ping/pong — a live connection responds in < 200ms.
     */
    private probeConnection(timeoutMs = 1500): Promise<boolean> {
        const socket = this.socket;
        if (!socket) return Promise.resolve(false);
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | null = null;

        return new Promise<boolean>((resolve) => {
            const finish = (value: boolean) => {
                if (settled) return;
                settled = true;
                if (timer !== null) {
                    clearTimeout(timer);
                }
                resolve(value);
            };

            timer = setTimeout(() => {
                finish(false);
                // Only reconnect if the probe was the one that detected staleness —
                // guard against socket already being replaced by another call path.
                if (this.socket === socket) {
                    this.disconnect();
                    this.connect();
                }
            }, timeoutMs);

            try {
                socket.emit('ping', () => {
                    finish(true);
                });
            } catch {
                finish(false);
                if (this.socket === socket) {
                    this.disconnect();
                    this.connect();
                }
            }
        });
    }

    /**
     * Periodic health check called from sync.ts's refresh interval.
     * Detects silent TCP drops (socket.connected === true but no data flowing)
     * and forces a reconnect. This catches the case where the app stays in
     * foreground but the OS silently drops the connection (e.g., iOS long idle).
     *
     * Only acts when the socket appears connected but no message has been
     * received in the last 45 seconds. On mobile this triggers a fresh connect;
     * on desktop it probes first.
     */
    checkHealthAndReconnect() {
        if (this.currentStatus !== 'connected') return;
        if (!this.socket?.connected) return;
        if (this.lastMessageReceivedAt === 0) return; // Just connected

        const silentMs = Date.now() - this.lastMessageReceivedAt;
        if (silentMs < 45000) return; // Still within healthy window

        // Socket appears connected but no data for 45+ seconds — likely a silent TCP drop.
        // Reconnect to restore data flow.
        console.warn(`[apiSocket] Silent connection detected (${Math.round(silentMs / 1000)}s without messages), forcing reconnect`);
        this.disconnect();
        this.connect();
    }

    //
    // Private Methods
    //

    private currentTransportName(): string | null {
        return (this.socket?.io as any)?.engine?.transport?.name ?? this.lastTransportType;
    }

    private updateStatus(status: ConnectionStatus, error?: Error) {
        if (error) this.lastError = error;
        if (this.currentStatus !== status) {
            this.currentStatus = status;
            this.statusListeners.forEach(listener => listener(status));
        }
    }

    /** Stop reconnection and mark as auth failure (e.g. 401). Call from connect_error. */
    private stopReconnectionAndNotifyAuthError(error: Error) {
        this.reconnectionDisabled = true;
        this.lastError = error;
        if (this.socket) {
            this.socket.removeAllListeners();
            this.socket.disconnect();
            this.socket = null;
        }
        this.updateStatus('auth_error', error);
        this.authErrorListeners.forEach(listener => listener());
    }

    private isAuthError(error: unknown): boolean {
        if (!error || typeof error !== 'object') return false;
        const msg = String((error as Error).message ?? '').toLowerCase();
        const code = (error as { code?: string; status?: number }).code ?? (error as { status?: number }).status;
        if (code === 401 || code === 'UNAUTHORIZED') return true;
        if (msg.includes('401') || msg.includes('unauthorized') || msg.includes('authentication')) return true;
        return false;
    }

    private setupEventHandlers() {
        if (!this.socket) return;


        // Connection events
        this.socket.on('connect', () => {
            this.lastError = null;
            this.lastMessageReceivedAt = Date.now(); // Treat connect as activity
            log.log(`🔌 socket connected via ${this.currentTransportName() ?? 'unknown'}`);
            this.updateStatus('connected');
            if (!this.socket?.recovered) {
                this.reconnectedListeners.forEach(listener => listener());
            }
        });

        // Track transport upgrades/downgrades for diagnostics
        this.socket.io.engine.on('upgrade', (transport: any) => {
            this.lastTransportType = transport?.name ?? 'unknown';
        });
        // Capture initial transport type (transport may not be created yet at setup time)
        try {
            const initialTransport = (this.socket.io as any)?.engine?.transport;
            if (initialTransport?.name) {
                this.lastTransportType = initialTransport.name;
            }
        } catch {
            // Transport not yet initialised — will be captured by 'upgrade' event
        }

        // While status stays on the last `connect_error`, socket.io may still be retrying in the
        // background — surface that so the UI isn't stuck looking "idle" on error.
        const manager = this.socket.io;
        manager.on('reconnect_attempt', (attempt: number) => {
            log.log(`🔌 socket reconnect attempt #${attempt}`);
            this.updateStatus('connecting');
        });
        manager.on('reconnect_error', (err: Error) => {
            log.log(`🔌 socket reconnect error: ${describeSocketError(err)}`);
            if (!this.isAuthError(err)) {
                this.updateStatus('error', err);
            }
        });
        manager.on('reconnect_failed', () => {
            // With Infinity attempts this should never fire, but if it does,
            // stay in error state — don't loop. A manual resume or foreground
            // event will trigger a fresh connect().
            if (!this.reconnectionDisabled && this.config) {
                const err = new Error('Socket reconnection failed');
                this.updateStatus('error', err);
            }
        });

        this.socket.on('disconnect', (reason) => {
            log.log(`🔌 socket disconnected: ${reason}`);
            // io server disconnect = server closed the connection (e.g. auth); socket.io may still retry
            if (this.reconnectionDisabled) return;
            this.updateStatus('disconnected');
        });

        this.socket.on('connect_error', (error: Error & { code?: string; status?: number }) => {
            log.log(`🔌 socket connect_error on ${this.currentTransportName() ?? 'unknown'}: ${describeSocketError(error)}`);
            if (this.isAuthError(error)) {
                this.stopReconnectionAndNotifyAuthError(error);
                return;
            }
            this.updateStatus('error', error);
        });

        this.socket.on('error', (error: Error) => {
            if (this.isAuthError(error)) {
                this.stopReconnectionAndNotifyAuthError(error);
                return;
            }
            this.updateStatus('error', error);
        });

        // Message handling
        this.socket.onAny((event, data) => {
            // Track last message receipt for health checks
            this.lastMessageReceivedAt = Date.now();
            // console.log(`📥 SyncSocket: Received event '${event}':`, JSON.stringify(data).substring(0, 200));
            const handler = this.messageHandlers.get(event);
            if (handler) {
                // console.log(`📥 SyncSocket: Calling handler for '${event}'`);
                handler(data);
            } else {
                // console.log(`📥 SyncSocket: No handler registered for '${event}'`);
            }
        });
    }
}

//
// Singleton Export
//

export const apiSocket = new ApiSocket();