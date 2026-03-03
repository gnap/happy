import { io, Socket } from 'socket.io-client';
import { TokenStorage } from '@/auth/tokenStorage';
import { Encryption } from './encryption/encryption';

//
// Constants (aligned with CLI/daemon reconnection behavior)
//

/** Min delay before first reconnection attempt (ms) */
const RECONNECT_DELAY_MIN = 2000;
/** Max delay between attempts (ms) - caps after several failures */
const RECONNECT_DELAY_MAX = 30000;
/** Jitter factor 0–1 to avoid thundering herd */
const RECONNECT_RANDOMIZATION_FACTOR = 0.5;

/** Network error codes that warrant retry (same idea as CLI NETWORK_ERROR_CODES) */
const RETRYABLE_ERROR_HINTS = ['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'ENETUNREACH', 'timeout', 'Network'];

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
    private currentStatus: ConnectionStatus = 'disconnected';
    private lastError: Error | null = null;
    /** When true, do not reconnect (e.g. after 401) */
    private reconnectionDisabled = false;

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
        if (this.socket) {
            // Already have a socket; only force reconnect if we had disabled reconnection (e.g. after token refresh)
            if (this.reconnectionDisabled) {
                this.reconnectionDisabled = false;
                this.disconnect();
            } else {
                return;
            }
        }

        this.updateStatus('connecting');
        this.lastError = null;

        this.socket = io(this.config.endpoint, {
            path: '/v1/updates',
            auth: {
                token: this.config.token,
                clientType: 'user-scoped' as const
            },
            transports: ['websocket'],
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
        const headers = {
            'Authorization': `Bearer ${credentials.token}`,
            ...options?.headers
        };

        return fetch(url, {
            ...options,
            headers
        });
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
    // Private Methods
    //

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
            this.updateStatus('connected');
            if (!this.socket?.recovered) {
                this.reconnectedListeners.forEach(listener => listener());
            }
        });

        this.socket.on('disconnect', (reason) => {
            // io server disconnect = server closed the connection (e.g. auth); socket.io may still retry
            if (this.reconnectionDisabled) return;
            this.updateStatus('disconnected');
        });

        this.socket.on('connect_error', (error: Error & { code?: string; status?: number }) => {
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