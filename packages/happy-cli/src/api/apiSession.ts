import { logger } from '@/ui/logger'
import { EventEmitter } from 'node:events'
import { io, Socket } from 'socket.io-client'
import { AgentState, ClientToServerEvents, Metadata, ServerToClientEvents, Session, Update, UserMessage, UserMessageSchema, Usage } from './types'
import { decodeBase64, decrypt, encodeBase64, encrypt } from './encryption';
import { backoff, delay } from '@/utils/time';
import { configuration, serverHttpsAgent } from '@/configuration';
import { RawJSONLines } from '@/claude/types';
import { randomUUID } from 'node:crypto';
import { AsyncLock } from '@/utils/lock';
import { RpcHandlerManager } from './rpc/RpcHandlerManager';
import { registerCommonHandlers } from '../modules/common/registerCommonHandlers';
import { calculateCost } from '@/utils/pricing';
import { type SessionEnvelope, type SessionTurnEndStatus } from '@slopus/happy-wire';
import {
    closeClaudeTurnWithStatus,
    mapClaudeLogMessageToSessionEnvelopes,
    type ClaudeSessionProtocolState,
} from '@/claude/utils/sessionProtocolMapper';
import { InvalidateSync } from '@/utils/sync';
import axios from 'axios';

/**
 * ACP (Agent Communication Protocol) message data types.
 * This is the unified format for all agent messages - CLI adapts each provider's format to ACP.
 */
export type ACPMessageData =
    // Core message types
    | { type: 'message'; message: string }
    | { type: 'reasoning'; message: string }
    | { type: 'thinking'; text: string }
    // Tool interactions
    | { type: 'tool-call'; callId: string; name: string; input: unknown; id: string }
    | { type: 'tool-result'; callId: string; output: unknown; id: string; isError?: boolean }
    // File operations
    | { type: 'file-edit'; description: string; filePath: string; diff?: string; oldContent?: string; newContent?: string; id: string }
    // Terminal/command output
    | { type: 'terminal-output'; data: string; callId: string }
    // Task lifecycle events
    | { type: 'task_started'; id: string }
    | { type: 'task_complete'; id: string }
    | { type: 'turn_aborted'; id: string }
    // Permissions
    | { type: 'permission-request'; permissionId: string; toolName: string; description: string; options?: unknown }
    // Usage/metrics
    | { type: 'token_count';[key: string]: unknown };

export type ACPProvider = 'gemini' | 'codex' | 'claude' | 'opencode';

/** Legacy Claude "output" format data shape for old App compatibility. App requires uuid or message is dropped. */
export type OutputFormatData =
    | { type: 'assistant'; uuid: string; parentUuid?: string | null; message: { role: 'assistant'; model: string; content: Array<{ type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown }> } }
    | { type: 'user'; uuid: string; parentUuid?: string | null; message: { role: 'user'; content: string } }
    | { type: 'user'; uuid: string; parentUuid?: string | null; message: { role: 'user'; content: Array<{ type: 'tool_result'; tool_use_id: string; content: unknown; is_error?: boolean }> } };

type V3SessionMessage = {
    id: string;
    seq: number;
    content: { t: 'encrypted'; c: string };
    localId: string | null;
    createdAt: number;
    updatedAt: number;
};

type V3GetSessionMessagesResponse = {
    messages: V3SessionMessage[];
    hasMore: boolean;
};

type V3PostSessionMessagesResponse = {
    messages: Array<{
        id: string;
        seq: number;
        localId: string | null;
        createdAt: number;
        updatedAt: number;
    }>;
};

export class ApiSessionClient extends EventEmitter {
    private readonly token: string;
    readonly sessionId: string;
    private metadata: Metadata | null;
    private metadataVersion: number;
    private agentState: AgentState | null;
    private agentStateVersion: number;
    private socket: Socket<ServerToClientEvents, ClientToServerEvents>;
    private pendingMessages: UserMessage[] = [];
    private pendingMessageCallback: ((message: UserMessage) => void) | null = null;
    readonly rpcHandlerManager: RpcHandlerManager;
    private agentStateLock = new AsyncLock();
    private metadataLock = new AsyncLock();
    private encryptionKey: Uint8Array;
    private encryptionVariant: 'legacy' | 'dataKey';
    private claudeSessionProtocolState: ClaudeSessionProtocolState = {
        currentTurnId: null,
        uuidToProviderSubagent: new Map<string, string>(),
        taskPromptToSubagents: new Map<string, string[]>(),
        providerSubagentToSessionSubagent: new Map<string, string>(),
        subagentTitles: new Map<string, string>(),
        bufferedSubagentMessages: new Map<string, RawJSONLines[]>(),
        hiddenParentToolCalls: new Set<string>(),
        startedSubagents: new Set<string>(),
        activeSubagents: new Set<string>(),
    };
    private lastSeq: number;
    private pendingOutbox: Array<{ content: string; localId: string }> = [];
    private readonly sendSync: InvalidateSync;
    private readonly receiveSync: InvalidateSync;
    private fallbackPollInterval: ReturnType<typeof setInterval> | null = null;

    constructor(token: string, session: Session) {
        super()
        this.token = token;
        this.sessionId = session.id;
        this.metadata = session.metadata;
        this.metadataVersion = session.metadataVersion;
        this.agentState = session.agentState;
        this.agentStateVersion = session.agentStateVersion;
        this.encryptionKey = session.encryptionKey;
        this.encryptionVariant = session.encryptionVariant;
        this.lastSeq = session.seq ?? 0;
        this.sendSync = new InvalidateSync(() => this.flushOutbox());
        this.receiveSync = new InvalidateSync(() => this.fetchMessages());

        // Initialize RPC handler manager
        this.rpcHandlerManager = new RpcHandlerManager({
            scopePrefix: this.sessionId,
            encryptionKey: this.encryptionKey,
            encryptionVariant: this.encryptionVariant,
            logger: (msg, data) => logger.debug(msg, data)
        });
        const workingDir = this.metadata?.path ?? process.cwd();
        registerCommonHandlers(this.rpcHandlerManager, workingDir);

        //
        // Create socket
        //

        this.socket = io(configuration.serverUrl, {
            auth: {
                token: this.token,
                clientType: 'session-scoped' as const,
                sessionId: this.sessionId
            },
            path: '/v1/updates',
            reconnection: true,
            reconnectionAttempts: Infinity,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
            transports: ['polling', 'websocket'],
            withCredentials: true,
            autoConnect: false,
            ...(typeof process !== 'undefined' && process.versions?.node && { agent: serverHttpsAgent as any }),
        });

        //
        // Handlers
        //

        this.socket.on('connect', () => {
            logger.debug('Socket connected successfully');
            this.stopFallbackPoll();
            this.rpcHandlerManager.onSocketConnect(this.socket);
            this.receiveSync.invalidate();
        })

        // Set up global RPC request handler
        this.socket.on('rpc-request', async (data: { method: string, params: string }, callback: (response: string) => void) => {
            callback(await this.rpcHandlerManager.handleRequest(data));
        })

        this.socket.on('disconnect', (reason) => {
            logger.debug('[API] Socket disconnected:', reason);
            this.rpcHandlerManager.onSocketDisconnect();
            this.startFallbackPoll();
        })

        this.socket.on('connect_error', (error) => {
            const msg = error?.message ?? String(error);
            logger.debug('[API] Socket connection error:', msg);
            if (msg && msg.length < 200) {
                logger.debug('[API] If running remotely (SSH/devcontainer), ensure outbound HTTPS/WSS to server is allowed. Using HTTP fallback for messages.');
            }
            this.rpcHandlerManager.onSocketDisconnect();
            this.startFallbackPoll();
        })

        // Server events
        this.socket.on('update', (data: Update) => {
            try {
                logger.debugLargeJson('[SOCKET] [UPDATE] Received update:', data);

                if (!data.body) {
                    logger.debug('[SOCKET] [UPDATE] [ERROR] No body in update!');
                    return;
                }

                if (data.body.t === 'new-message') {
                    const messageSeq = data.body.message?.seq;
                    const isEncrypted = data.body.message?.content?.t === 'encrypted';
                    const acceptSeq = typeof messageSeq === 'number' && (this.lastSeq === 0 || messageSeq === this.lastSeq + 1);
                    if (isEncrypted && acceptSeq) {
                        const body = decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(data.body.message.content.c));
                        logger.debugLargeJson('[SOCKET] [UPDATE] Received update:', body);
                        this.routeIncomingMessage(body);
                        this.lastSeq = messageSeq;
                        return;
                    }
                    if (!acceptSeq) {
                        logger.debug('[API] new-message skipped (seq mismatch or missing seq), will fetch via HTTP', {
                            messageSeq,
                            lastSeq: this.lastSeq,
                            expectedNext: this.lastSeq + 1,
                        });
                    } else if (!isEncrypted) {
                        logger.debug('[API] new-message skipped (content not encrypted), will fetch via HTTP');
                    }
                    this.receiveSync.invalidate();
                    return;
                } else if (data.body.t === 'update-session') {
                    if (data.body.metadata && data.body.metadata.version > this.metadataVersion) {
                        this.metadata = decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(data.body.metadata.value));
                        this.metadataVersion = data.body.metadata.version;
                    }
                    if (data.body.agentState && data.body.agentState.version > this.agentStateVersion) {
                        this.agentState = data.body.agentState.value ? decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(data.body.agentState.value)) : null;
                        this.agentStateVersion = data.body.agentState.version;
                    }
                } else if (data.body.t === 'update-machine') {
                    // Session clients shouldn't receive machine updates - log warning
                    logger.debug(`[SOCKET] WARNING: Session client received unexpected machine update - ignoring`);
                } else {
                    // If not a user message, it might be a permission response or other message type
                    this.emit('message', data.body);
                }
            } catch (error) {
                logger.debug('[SOCKET] [UPDATE] [ERROR] Error handling update', { error });
            }
        });

        // DEATH
        this.socket.on('error', (error) => {
            logger.debug('[API] Socket error:', error);
        });

        //
        // Connect (after short delay to give a time to add handlers)
        //

        this.socket.connect();
    }

    onUserMessage(callback: (data: UserMessage) => void) {
        this.pendingMessageCallback = callback;
        while (this.pendingMessages.length > 0) {
            callback(this.pendingMessages.shift()!);
        }
    }

    private authHeaders() {
        return {
            'Authorization': `Bearer ${this.token}`,
            'Content-Type': 'application/json'
        };
    }

    private routeIncomingMessage(message: unknown) {
        const userResult = UserMessageSchema.safeParse(message);
        if (userResult.success) {
            logger.debug('[API] User message from app received, routing to CLI');
            if (this.pendingMessageCallback) {
                this.pendingMessageCallback(userResult.data);
            } else {
                this.pendingMessages.push(userResult.data);
            }
            return;
        }
        // Relaxed fallback: if it looks like a user text message (e.g. app sends content.type !== 'text'), normalize and route
        const relaxed = this.normalizeToUserMessage(message);
        if (relaxed) {
            logger.debug('[API] User message from app received (relaxed parse), routing to CLI');
            if (this.pendingMessageCallback) {
                this.pendingMessageCallback(relaxed);
            } else {
                this.pendingMessages.push(relaxed);
            }
            return;
        }
        // Message from app didn't match UserMessageSchema - CLI won't show reply flow; log for debugging
        logger.debug('[API] Incoming message not parsed as user message (no reply will be triggered)', {
            parseError: userResult.error?.message,
            receivedKeys: message && typeof message === 'object' ? Object.keys(message as object) : [],
            contentType: message && typeof message === 'object' && (message as any).content ? (message as any).content?.type : undefined,
        });
        this.emit('message', message);
    }

    /** Normalize app payload to UserMessage when strict schema fails (e.g. content.type is 'input' or missing). */
    private normalizeToUserMessage(raw: unknown): UserMessage | null {
        if (!raw || typeof raw !== 'object') return null;
        const o = raw as Record<string, unknown>;
        if (o.role !== 'user') return null;
        const content = o.content;
        if (!content || typeof content !== 'object') return null;
        const c = content as Record<string, unknown>;
        const text = typeof c.text === 'string' ? c.text : undefined;
        if (text === undefined) return null;
        return {
            role: 'user',
            content: { type: 'text', text },
            localKey: typeof o.localKey === 'string' ? o.localKey : undefined,
            meta: o.meta && typeof o.meta === 'object' ? (o.meta as UserMessage['meta']) : undefined,
        };
    }

    /** For debugging: whether the real-time socket to the server is connected (vs HTTP fallback polling). */
    isSocketConnected(): boolean {
        return this.socket?.connected === true;
    }

    private async fetchMessages() {
        let afterSeq = this.lastSeq;
        while (true) {
            const response = await axios.get<V3GetSessionMessagesResponse>(
                `${configuration.serverUrl}/v3/sessions/${encodeURIComponent(this.sessionId)}/messages`,
                {
                    params: {
                        after_seq: afterSeq,
                        limit: 100
                    },
                    headers: this.authHeaders(),
                    timeout: 60000,
                    httpsAgent: serverHttpsAgent,
                }
            );

            const messages = Array.isArray(response.data.messages) ? response.data.messages : [];
            let maxSeq = afterSeq;

            for (const message of messages) {
                if (message.seq > maxSeq) {
                    maxSeq = message.seq;
                }

                if (message.content?.t !== 'encrypted') {
                    continue;
                }

                try {
                    const body = decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(message.content.c));
                    this.routeIncomingMessage(body);
                } catch (error) {
                    logger.debug('[API] Failed to decrypt fetched message', {
                        sessionId: this.sessionId,
                        seq: message.seq,
                        error
                    });
                }
            }

            this.lastSeq = Math.max(this.lastSeq, maxSeq);
            const hasMore = !!response.data.hasMore;
            if (hasMore && maxSeq === afterSeq) {
                logger.debug('[API] fetchMessages pagination stalled, stopping to avoid infinite loop', {
                    sessionId: this.sessionId,
                    afterSeq
                });
                break;
            }
            afterSeq = maxSeq;
            if (!hasMore) {
                break;
            }
        }
    }

    private static readonly MAX_OUTBOX_BATCH_SIZE = 50;
    private static readonly FLUSH_RETRY_STATUSES = [502, 503, 504];
    private static readonly FLUSH_RETRY_MAX = 3;
    private static readonly FLUSH_RETRY_BASE_MS = 1000;

    private async flushOutbox() {
        // Send latest messages first so the user sees recent activity immediately,
        // then backfill older messages in subsequent batches.
        while (this.pendingOutbox.length > 0) {
            const batchSize = Math.min(this.pendingOutbox.length, ApiSessionClient.MAX_OUTBOX_BATCH_SIZE);
            const batch = this.pendingOutbox.splice(-batchSize, batchSize);

            for (let attempt = 0; attempt <= ApiSessionClient.FLUSH_RETRY_MAX; attempt++) {
                try {
                    if (attempt > 0) {
                        const delayMs = ApiSessionClient.FLUSH_RETRY_BASE_MS * Math.pow(2, attempt - 1);
                        logger.debug(`[API] flushOutbox retry ${attempt}/${ApiSessionClient.FLUSH_RETRY_MAX} after ${delayMs}ms`);
                        await new Promise((r) => setTimeout(r, delayMs));
                    }
                    const response = await axios.post<V3PostSessionMessagesResponse>(
                        `${configuration.serverUrl}/v3/sessions/${encodeURIComponent(this.sessionId)}/messages`,
                        {
                            messages: batch
                        },
                        {
                            headers: this.authHeaders(),
                            timeout: 60000,
                        httpsAgent: serverHttpsAgent,
                        }
                    );

                    const messages = Array.isArray(response.data.messages) ? response.data.messages : [];
                    const maxSeq = messages.reduce((acc, message) => (
                        message.seq > acc ? message.seq : acc
                    ), this.lastSeq);
                    this.lastSeq = maxSeq;
                    logger.debug(`[API] flushOutbox: sent ${batch.length} message(s) to server (replies visible in app)`);
                    break;
                } catch (error: unknown) {
                    const status = axios.isAxiosError(error) ? error.response?.status : undefined;
                    const isRetryable = status !== undefined && ApiSessionClient.FLUSH_RETRY_STATUSES.includes(status);
                    if (!isRetryable || attempt === ApiSessionClient.FLUSH_RETRY_MAX) {
                        const data = axios.isAxiosError(error) ? error.response?.data : undefined;
                        logger.debug('[API] flushOutbox failed', { sessionId: this.sessionId, batchLength: batch.length, status, data, error });
                        throw error;
                    }
                    logger.debug('[API] flushOutbox retryable error', { status, attempt: attempt + 1, maxRetries: ApiSessionClient.FLUSH_RETRY_MAX });
                }
            }
        }
    }

    private enqueueMessage(content: unknown, invalidate: boolean = true) {
        const encrypted = encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, content));
        this.pendingOutbox.push({
            content: encrypted,
            localId: randomUUID()
        });
        if (invalidate) {
            this.sendSync.invalidate();
        }
    }

    /**
     * Send message to session
     * @param body - Message body (can be MessageContent or raw content for agent messages)
     */
    sendClaudeSessionMessage(body: RawJSONLines): void | Promise<void> {
        const mapped = mapClaudeLogMessageToSessionEnvelopes(body, this.claudeSessionProtocolState);
        this.claudeSessionProtocolState.currentTurnId = mapped.currentTurnId;
        for (const envelope of mapped.envelopes) {
            this.sendSessionProtocolMessage(envelope);
        }
        // Track usage from assistant messages
        if (body.type === 'assistant' && body.message?.usage) {
            try {
                this.sendUsageData(body.message.usage, body.message.model);
            } catch (error) {
                logger.debug('[SOCKET] Failed to send usage data:', error);
            }
        }

        // Update metadata with summary if this is a summary message (await so change_title can report failure)
        if (body.type === 'summary' && 'summary' in body && 'leafUuid' in body) {
            return this.updateMetadata((metadata) => ({
                ...metadata,
                summary: {
                    text: body.summary,
                    updatedAt: Date.now()
                }
            }));
        }
    }

    closeClaudeSessionTurn(status: SessionTurnEndStatus = 'completed') {
        const mapped = closeClaudeTurnWithStatus(this.claudeSessionProtocolState, status);
        this.claudeSessionProtocolState.currentTurnId = mapped.currentTurnId;
        for (const envelope of mapped.envelopes) {
            this.sendSessionProtocolMessage(envelope);
        }
    }

    sendCodexMessage(body: any) {
        let content = {
            role: 'agent',
            content: {
                type: 'codex',
                data: body  // This wraps the entire Claude message
            },
            meta: {
                sentFrom: 'cli'
            }
        };
        this.enqueueMessage(content);
    }

    /**
     * Legacy output-format message used by the older App.
     * Keep the payload as-is so the App can render the session list entry.
     */
    sendOutputFormatMessage(body: OutputFormatData) {
        this.enqueueMessage(body);
    }

    /**
     * Cursor-specific compatibility wrapper.
     * Cursor tool/result payloads currently follow the same shape as codex payloads.
     */
    sendCursorMessage(body: unknown) {
        this.sendCodexMessage(body);
    }

    /**
     * Encode tool results lazily when needed.
     * Current cursor-acp flow already normalizes edit payloads upstream, so this is a pass-through.
     */
    maybeLazyEncodeResult(_toolName: string, _callId: string, result: unknown): unknown {
        return result;
    }

    private enqueueSessionProtocolEnvelope(envelope: SessionEnvelope, invalidate: boolean = true) {
        const content = {
            role: 'session',
            content: envelope,
            meta: {
                sentFrom: 'cli'
            }
        };

        this.enqueueMessage(content, invalidate);
    }

    sendSessionProtocolMessage(envelope: SessionEnvelope) {
        if (envelope.role !== 'user') {
            this.enqueueSessionProtocolEnvelope(envelope);
            return;
        }

        if (envelope.ev.t !== 'text') {
            this.enqueueSessionProtocolEnvelope(envelope);
            return;
        }

        this.enqueueSessionProtocolEnvelope(envelope);
    }

    /**
     * Send a turn-end (or turn-start) session envelope in the shape the app expects for
     * lifecycle/thinking timer: content.content.type === 'session' and content.content.data.ev.t.
     * Use this only for turn-end/turn-start so the mobile app stops the timer; other session
     * messages keep the normal envelope shape.
     */
    sendSessionLifecycleEnvelope(envelope: SessionEnvelope) {
        const content = {
            role: 'session',
            content: { type: 'session', data: envelope },
            meta: { sentFrom: 'cli' },
        };
        this.enqueueMessage(content);
    }

    /**
     * Send a generic agent message to the session using ACP (Agent Communication Protocol) format.
     * Works for any agent type (Gemini, Codex, Claude, etc.) - CLI normalizes to unified ACP format.
     * 
     * @param provider - The agent provider sending the message (e.g., 'gemini', 'codex', 'claude')
     * @param body - The message payload (type: 'message' | 'reasoning' | 'tool-call' | 'tool-result')
     */
    sendAgentMessage(provider: 'gemini' | 'codex' | 'claude' | 'cursor' | 'opencode' | 'openclaw' | 'acp', body: ACPMessageData) {
        let content = {
            role: 'agent',
            content: {
                type: 'acp',
                provider,
                data: body
            },
            meta: {
                sentFrom: 'cli'
            }
        };

        logger.debug(`[SOCKET] Sending ACP message from ${provider}:`, { type: body.type, hasMessage: 'message' in body });

        this.enqueueMessage(content);
    }

    sendSessionEvent(event: {
        type: 'switch', mode: 'local' | 'remote'
    } | {
        type: 'message', message: string
    } | {
        type: 'permission-mode-changed', mode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'
    } | {
        type: 'ready'
    }, id?: string) {
        let content = {
            role: 'agent',
            content: {
                id: id ?? randomUUID(),
                type: 'event',
                data: event
            }
        };
        this.enqueueMessage(content);
    }

    /**
     * Send a ping message to keep the connection alive
     */
    keepAlive(thinking: boolean, mode: 'local' | 'remote') {
        if (process.env.DEBUG) { // too verbose for production
            logger.debug(`[API] Sending keep alive message: ${thinking}`);
        }
        this.socket.volatile.emit('session-alive', {
            sid: this.sessionId,
            time: Date.now(),
            thinking,
            mode
        });
    }

    /**
     * Send session death message
     */
    sendSessionDeath() {
        this.socket.emit('session-end', { sid: this.sessionId, time: Date.now() });
    }

    /**
     * Send usage data to the server
     */
    sendUsageData(usage: Usage, model?: string) {
        // Calculate total tokens
        const totalTokens = usage.input_tokens + usage.output_tokens + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);

        const costs = calculateCost(usage, model);

        // Transform Claude usage format to backend expected format
        const usageReport = {
            key: 'claude-session',
            sessionId: this.sessionId,
            tokens: {
                total: totalTokens,
                input: usage.input_tokens,
                output: usage.output_tokens,
                cache_creation: usage.cache_creation_input_tokens || 0,
                cache_read: usage.cache_read_input_tokens || 0
            },
            cost: {
                total: costs.total,
                input: costs.input,
                output: costs.output
            }
        }
        logger.debugLargeJson('[SOCKET] Sending usage data:', usageReport)
        this.socket.emit('usage-report', usageReport);
    }

    /**
     * Returns the latest session metadata known to the client.
     */
    getMetadata(): Metadata | null {
        return this.metadata;
    }

    /**
     * Update session metadata
     * @param handler - Handler function that returns the updated metadata
     */
    updateMetadata(handler: (metadata: Metadata) => Metadata): Promise<void> {
        return this.metadataLock.inLock(async () => {
            if (!this.socket.connected) {
                throw new Error('Session real-time disconnected; title update requires WebSocket (check network / HAPPY_SERVER_URL)');
            }
            await backoff(async () => {
                let updated = handler(this.metadata!); // Weird state if metadata is null - should never happen but here we are
                const answer = await this.socket.emitWithAck('update-metadata', { sid: this.sessionId, expectedVersion: this.metadataVersion, metadata: encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, updated)) });
                if (answer.result === 'success') {
                    this.metadata = decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(answer.metadata));
                    this.metadataVersion = answer.version;
                } else if (answer.result === 'version-mismatch') {
                    if (answer.version > this.metadataVersion) {
                        this.metadataVersion = answer.version;
                        this.metadata = decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(answer.metadata));
                    }
                    throw new Error('Metadata version mismatch');
                } else if (answer.result === 'error') {
                    throw new Error('Server rejected metadata update');
                }
            });
        });
    }

    /**
     * Update session agent state
     * @param handler - Handler function that returns the updated agent state
     */
    updateAgentState(handler: (metadata: AgentState) => AgentState) {
        logger.debugLargeJson('Updating agent state', this.agentState);
        this.agentStateLock.inLock(async () => {
            await backoff(async () => {
                let updated = handler(this.agentState || {});
                const answer = await this.socket.emitWithAck('update-state', { sid: this.sessionId, expectedVersion: this.agentStateVersion, agentState: updated ? encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, updated)) : null });
                if (answer.result === 'success') {
                    this.agentState = answer.agentState ? decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(answer.agentState)) : null;
                    this.agentStateVersion = answer.version;
                    logger.debug('Agent state updated', this.agentState);
                } else if (answer.result === 'version-mismatch') {
                    if (answer.version > this.agentStateVersion) {
                        this.agentStateVersion = answer.version;
                        this.agentState = answer.agentState ? decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(answer.agentState)) : null;
                    }
                    throw new Error('Agent state version mismatch');
                } else if (answer.result === 'error') {
                    // console.error('Agent state update error', answer);
                    // Hard error - ignore
                }
            });
        });
    }

    /**
     * Wait for socket buffer to flush
     */
    async flush(): Promise<void> {
        await Promise.race([
            this.sendSync.invalidateAndAwait(),
            delay(10000)
        ]);
        if (!this.socket.connected) {
            return;
        }
        return new Promise((resolve) => {
            this.socket.emit('ping', () => {
                resolve();
            });
            setTimeout(() => {
                resolve();
            }, 10000);
        });
    }

    private startFallbackPoll() {
        if (this.fallbackPollInterval !== null) return;
        const intervalMs = 8000;
        logger.debug(`[API] Socket disconnected, starting fallback HTTP poll every ${intervalMs}ms`);
        this.receiveSync.invalidate();
        this.fallbackPollInterval = setInterval(() => {
            if (this.socket.connected) {
                this.stopFallbackPoll();
                return;
            }
            this.receiveSync.invalidate();
        }, intervalMs);
    }

    private stopFallbackPoll() {
        if (this.fallbackPollInterval !== null) {
            clearInterval(this.fallbackPollInterval);
            this.fallbackPollInterval = null;
            logger.debug('[API] Stopped fallback HTTP poll');
        }
    }

    async close() {
        logger.debug('[API] socket.close() called');
        this.stopFallbackPoll();
        this.sendSync.stop();
        this.receiveSync.stop();
        this.socket.close();
    }
}
