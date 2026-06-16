import { logger } from '@/ui/logger'
import { BUILD_VERSION } from '../version'
import { detectWorktree } from '../utils/createSessionMetadata'
import { EventEmitter } from 'node:events'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createTwoFilesPatch } from 'diff'
import { io, Socket } from 'socket.io-client'
import { AgentState, A2AInboxMessage, A2AInboxState, ClientToServerEvents, MessageMeta, Metadata, ServerToClientEvents, Session, Update, UserMessage, UserMessageSchema, Usage, buildSyncedSessionMetadata, sanitizeSessionMetadataForApp, shouldSyncSessionMetadata } from './types'
import { decodeBase64, decrypt, encodeBase64, encrypt } from './encryption';
import { backoff, delay } from '@/utils/time';
import { configuration, serverHttpsAgent } from '@/configuration';
import { RawJSONLines } from '@/claude/types';
import { randomUUID } from 'node:crypto';
import { AsyncLock } from '@/utils/lock';
import { isNode } from '@/utils/runtime';
import { RpcHandlerManager } from './rpc/RpcHandlerManager';
import { registerCommonHandlers } from '../modules/common/registerCommonHandlers';
import { calculateCost } from '@/utils/pricing';
import { type SessionEnvelope, type SessionTurnEndStatus } from '@slopus/happy-wire';
import {
    closeClaudeTurnWithStatus,
    mapClaudeLogMessageToSessionEnvelopes,
    suppressNextUserText,
    type ClaudeSessionProtocolState,
} from '@/claude/utils/sessionProtocolMapper';
import { InvalidateSync } from '@/utils/sync';
import axios from 'axios';
import { resolveSessionLastSeq } from './sessionLastSeq';
import {
    cloneA2AInboxState,
    extractLegacyInboxFromAgentState,
    getServerA2AUnreadCount,
    listA2AInboxMessages,
    markA2AInboxMessageRead,
    markA2AInboxMessagesRead,
    shouldScheduleA2AInboxTurn,
    pruneA2AInboxState,
    loadLocalA2AInbox,
    saveLocalA2AInbox,
    toServerA2AInboxSnapshot,
    upsertA2AInboxMessage,
} from '@/a2a/inbox';

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

// ---------------------------------------------------------------------------
// Lazy tool content: truncate large diff fields on the wire, serve full
// content from memory via RPC (enabled by HAPPY_LAZY_TOOL_CONTENT=1).
// ---------------------------------------------------------------------------

const LAZY_TOOL_CONTENT_ENABLED = process.env.HAPPY_LAZY_TOOL_CONTENT !== '0';

/**
 * Only Cursor tools are lazy-encoded. Their inputs carry full file content
 * (old_string/new_string/streamContent for CursorEdit; content for CursorWrite)
 * which can be many KBs. Claude's Edit/Write use small code-snippet diffs.
 */
const LAZY_DIFF_TOOL_NAMES = new Set(['CursorEdit', 'CursorWrite']);

/** Per-tool: which top-level string fields to truncate in the tool input. */
const LAZY_DIFF_TOOL_FIELDS: Record<string, string[]> = {
    CursorEdit: ['old_string', 'new_string', 'streamContent'],
    CursorWrite: ['content', 'streamContent'],
};

/**
 * Per-tool: which fields inside result.success (or top-level result) to strip entirely
 * (set to undefined) on the wire. Full content is persisted and served via RPC.
 * These are large full-file snapshots only needed by the detail (full) view.
 */
const LAZY_RESULT_STRIP_FIELDS_BY_TOOL: Record<string, string[]> = {
    CursorEdit: ['beforeFullFileContent', 'afterFullFileContent'],
    CursorWrite: ['afterFullFileContent'],
};

/**
 * Per-tool: which fields inside result.success to truncate to a short preview for the
 * compact (message-list) view. diffString is a pre-computed unified diff; keeping the
 * first LAZY_DIFF_STRING_MAX_LINES lines gives enough context for the 4-line card.
 */
const LAZY_RESULT_PREVIEW_FIELDS_BY_TOOL: Record<string, string[]> = {
    CursorEdit: ['diffString'],
    CursorWrite: ['diffString'],
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object';
}

function extractA2ATextFromParts(parts: unknown): string | null {
    if (!Array.isArray(parts)) {
        return null;
    }

    const texts: string[] = [];
    for (const part of parts) {
        if (typeof part === 'string') {
            if (part.trim().length > 0) {
                texts.push(part);
            }
            continue;
        }

        if (!isRecord(part)) {
            continue;
        }

        if (typeof part.text === 'string' && part.text.trim().length > 0) {
            texts.push(part.text);
            continue;
        }

        if (typeof part.message === 'string' && part.message.trim().length > 0) {
            texts.push(part.message);
        }
    }

    if (texts.length === 0) {
        return null;
    }

    return texts.join('\n');
}

/** Max lines kept in the compact diffString preview. */
const LAZY_DIFF_STRING_MAX_LINES = 15;

/**
 * Characters per field kept in the compact (wire) copy for non-diff fields.
 * ~400 chars covers ~4-8 lines of typical code — enough for the compact 4-line preview.
 * Full content is served via RPC when the detail view opens.
 */
const LAZY_CONTENT_THRESHOLD = 400;

/** Truncate a string at a line boundary, keeping at most maxLines lines. */
function truncateByLines(s: string, maxLines: number): string {
    let pos = 0;
    let lineCount = 0;
    while (pos < s.length && lineCount < maxLines) {
        const nl = s.indexOf('\n', pos);
        if (nl === -1) { pos = s.length; lineCount++; break; }
        pos = nl + 1;
        lineCount++;
    }
    return s.slice(0, pos);
}

function truncateDiffArgs(
    name: string,
    args: Record<string, unknown>,
): { truncated: Record<string, unknown>; wasTruncated: boolean } {
    let wasTruncated = false;
    const truncated: Record<string, unknown> = { ...args };

    const fields = LAZY_DIFF_TOOL_FIELDS[name] ?? [];
    for (const field of fields) {
        if (typeof args[field] === 'string' && (args[field] as string).length > LAZY_CONTENT_THRESHOLD) {
            truncated[field] = (args[field] as string).slice(0, LAZY_CONTENT_THRESHOLD);
            wasTruncated = true;
        }
    }

    if (wasTruncated) {
        truncated._lazy = true;
    }

    return { truncated, wasTruncated };
}

export class ApiSessionClient extends EventEmitter {
    private readonly token: string;
    readonly sessionId: string;
    private metadata: Metadata | null;
    private metadataVersion: number;
    private agentState: AgentState | null;
    private agentStateVersion: number;
    /** Full inbox rows; persisted under ~/.happy/a2a-inbox-state/, not on the server. */
    private a2aInbox: A2AInboxState;
    private socket: Socket<ServerToClientEvents, ClientToServerEvents>;
    private pendingMessages: UserMessage[] = [];
    private pendingMessageCallback: ((message: UserMessage) => void) | null = null;
    readonly rpcHandlerManager: RpcHandlerManager;
    private agentStateLock = new AsyncLock();
    private metadataLock = new AsyncLock();
    private encryptionKey: Uint8Array;
    private encryptionVariant: 'legacy' | 'dataKey';
    private requestedMetadata: Metadata | null = null;
    /** The AES session key; exposed so callers can persist it after offline reconnection. */
    get sessionEncryptionKey(): Uint8Array { return this.encryptionKey; }
    /** Resolves when the WebSocket first connects; used by updateMetadata to wait for initial connection. */
    private socketConnectedPromise: Promise<void>;
    private socketConnectedResolve: (() => void) | undefined;
    /** True once we have received at least one metadata push from the server after connecting.
     *  Static sync is deferred until then so we don't overwrite server-side fields with a
     *  snapshot that was captured before the server's authoritative metadata arrived. */
    private serverMetadataReceived = false;
    private routedMessageIds = new Set<string>();
    private routedA2ASessionEnvelopeIds = new Set<string>();
    /** Trigger ids already drained; blocks fetch/reconnect replay from re-opening the inbox. */
    private consumedA2ATriggerIds = new Set<string>();
    private a2aInboxStateSyncTimer: ReturnType<typeof setTimeout> | null = null;
    /** Replace legacy server blob (full messages) with unreadCount-only snapshot. */
    private a2aInboxNeedsServerUnreadSync = false;
    /** Directory where full tool-call args are persisted across session restarts. */
    private get toolContentDir(): string {
        const base = this.metadata?.path ?? process.cwd();
        return join(base, '.happy', 'tool-content');
    }

    private persistToolCallContent(callId: string, args: Record<string, unknown>): void {
        try {
            mkdirSync(this.toolContentDir, { recursive: true });
            writeFileSync(
                join(this.toolContentDir, `${callId}.json`),
                JSON.stringify(args),
                'utf8',
            );
        } catch (err) {
            logger.debug('[lazy] Failed to persist tool content to disk', { callId, err });
        }
    }

    private async loadToolCallContentFromDisk(callId: string): Promise<Record<string, unknown> | null> {
        try {
            const raw = await readFile(join(this.toolContentDir, `${callId}.json`), 'utf8');
            return JSON.parse(raw) as Record<string, unknown>;
        } catch {
            return null;
        }
    }

    private persistToolCallResult(callId: string, result: unknown): void {
        try {
            mkdirSync(this.toolContentDir, { recursive: true });
            writeFileSync(
                join(this.toolContentDir, `${callId}_result.json`),
                JSON.stringify(result),
                'utf8',
            );
        } catch (err) {
            logger.debug('[lazy] Failed to persist tool result to disk', { callId, err });
        }
    }

    private async loadToolCallResultFromDisk(callId: string): Promise<unknown | null> {
        try {
            const raw = await readFile(join(this.toolContentDir, `${callId}_result.json`), 'utf8');
            return JSON.parse(raw);
        } catch {
            return null;
        }
    }

    /**
     * For CursorEdit / CursorWrite tool results:
     * - Strip large full-file fields (beforeFullFileContent, afterFullFileContent) entirely
     *   from the wire payload; they are persisted to disk and served via RPC for the full view.
     * - Truncate diffString to LAZY_DIFF_STRING_MAX_LINES lines for the compact card preview.
     *
     * @returns The encoded output to embed in the wire message.
     */
    maybeLazyEncodeResult(toolName: string, callId: string, output: unknown): unknown {
        if (!LAZY_TOOL_CONTENT_ENABLED) return output;
        const stripFields = LAZY_RESULT_STRIP_FIELDS_BY_TOOL[toolName];
        const previewFields = LAZY_RESULT_PREVIEW_FIELDS_BY_TOOL[toolName];
        if ((!stripFields || stripFields.length === 0) && (!previewFields || previewFields.length === 0)) return output;
        if (!output || typeof output !== 'object') return output;

        const r = output as Record<string, unknown>;
        const successKey = 'success' in r ? 'success' : null;
        const successObj = successKey ? (r[successKey] as Record<string, unknown>) : r;
        if (!successObj || typeof successObj !== 'object') return output;

        let wasTruncated = false;
        const compactSuccess: Record<string, unknown> = { ...successObj };
        // Full diffString with proper @@ headers to persist alongside the full result,
        // so that when lazy content is resolved the compact view still gets correct line numbers.
        let recomputedDiffBody: string | null = null;

        // Strip full-file fields entirely (available via RPC)
        for (const field of stripFields ?? []) {
            if (typeof successObj[field] === 'string' && (successObj[field] as string).length > 0) {
                delete compactSuccess[field];
                wasTruncated = true;
            }
        }

        // Truncate diffString to first LAZY_DIFF_STRING_MAX_LINES lines
        for (const field of previewFields ?? []) {
            if (typeof successObj[field] === 'string') {
                const original = successObj[field] as string;
                const truncated = truncateByLines(original, LAZY_DIFF_STRING_MAX_LINES);
                if (truncated.length < original.length) {
                    compactSuccess[field] = truncated;
                    wasTruncated = true;
                }
            }
        }

        // For CursorEdit: re-compute diffString from full file contents before they are stripped,
        // replacing Cursor's no-hunk-header format with a standard unified diff that includes
        // @@ -N,N +N,N @@ headers so the App can display absolute line numbers.
        // This must run AFTER the previewFields loop above so the recomputed (correct) diffString
        // overwrites any truncated copy of Cursor's original headerless diffString.
        if (toolName === 'CursorEdit') {
            const before = typeof successObj['beforeFullFileContent'] === 'string' ? successObj['beforeFullFileContent'] as string : null;
            const after = typeof successObj['afterFullFileContent'] === 'string' ? successObj['afterFullFileContent'] as string : null;
            const filePath = typeof successObj['path'] === 'string' ? successObj['path'] as string : 'file';
            if (before !== null && after !== null) {
                try {
                    // Strip Index:/====/---/+++ file headers; keep from first @@ header onwards
                    // so all 15 compact lines are actual diff content.
                    const patch = createTwoFilesPatch(filePath, filePath, before, after, '', '', { context: 3 });
                    const patchLines = patch.split('\n');
                    const hunkStart = patchLines.findIndex(l => l.startsWith('@@ -'));
                    recomputedDiffBody = hunkStart >= 0 ? patchLines.slice(hunkStart).join('\n') : patch;
                    compactSuccess['diffString'] = truncateByLines(recomputedDiffBody, LAZY_DIFF_STRING_MAX_LINES);
                    wasTruncated = true;
                } catch (e) {
                    logger.debug('[lazy] Failed to compute unified diff', { callId, err: e });
                }
            }
        }

        if (!wasTruncated) return output;

        compactSuccess._lazyResult = true;
        // Persist with the recomputed diffString (full, not truncated) so that when the lazy
        // result is resolved back into the store, the compact view still has correct @@ headers
        // and absolute line numbers instead of falling back to Cursor's headerless format.
        const persistSuccess = recomputedDiffBody !== null
            ? { ...successObj, diffString: recomputedDiffBody }
            : successObj;
        const persistOutput = successKey ? { ...r, [successKey]: persistSuccess } : persistSuccess;
        this.persistToolCallResult(callId, persistOutput);
        logger.debug('[lazy] Encoded result for', { toolName, callId: callId.slice(0, 8) });
        return successKey ? { ...r, [successKey]: compactSuccess } : compactSuccess;
    }

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
    /** Set in close() so disconnect/connect_error do not re-start fallback poll and leave the process hanging. */
    private closing = false;
    /** Outbound transport: HTTP until first socket connect; WS preferred when connected and not in backoff. */
    private outboundMode: 'ws' | 'http' = 'http';
    private wsOutboundBackoffUntil = 0;
    private wsOutboundFailureStreak = 0;
    private wsUptimeStartedAt: number | null = null;
    private wsUptimeAccumMs = 0;
    private wsDowntimeAccumMs = 0;
    private lastWsUptimeMarkMs = Date.now();
    /** When set, fetchMessages stops once this seq is reached (socket seq-gap catch-up). */
    private receiveCatchUpUntilSeq: number | null = null;
    private receiveHealthInterval: ReturnType<typeof setInterval> | null = null;
    private static readonly RECEIVE_HEALTH_INTERVAL_MS = 120_000;

    getMetadata(): Metadata | null {
        return this.metadata;
    }

    constructor(
        token: string,
        session: Session,
        private websocketOnly: boolean = true,
        opts?: { initialLastSeq?: number },
    ) {
        super()
        this.token = token;
        this.sessionId = session.id;
        this.metadata = session.metadata;
        this.metadataVersion = session.metadataVersion;
        this.agentState = session.agentState;
        this.agentStateVersion = session.agentStateVersion;
        const legacyFromServer = extractLegacyInboxFromAgentState(session.agentState);
        const localInbox = loadLocalA2AInbox(session.id);
        if (localInbox.messages.length === 0 && legacyFromServer && legacyFromServer.messages.length > 0) {
            this.a2aInbox = legacyFromServer;
            saveLocalA2AInbox(session.id, this.a2aInbox);
            this.a2aInboxNeedsServerUnreadSync = true;
            logger.debug(
                `[API] Migrated ${legacyFromServer.messages.length} legacy A2A inbox row(s) from server agentState to local storage`,
            );
        } else {
            this.a2aInbox = localInbox;
        }
        if (this.a2aInbox.consumedTriggerIds?.length) {
            for (const id of this.a2aInbox.consumedTriggerIds) {
                this.consumedA2ATriggerIds.add(id);
            }
        }
        this.requestedMetadata = session.requestedMetadata ?? null;
        this.encryptionKey = session.encryptionKey;
        this.encryptionVariant = session.encryptionVariant;
        this.lastSeq = resolveSessionLastSeq(session.seq, opts?.initialLastSeq);
        if (opts?.initialLastSeq !== undefined && this.lastSeq !== opts.initialLastSeq) {
            logger.debug(
                `[API] Session ${session.id} resume cursor adjusted: requested=${opts.initialLastSeq}, `
                + `effective=${this.lastSeq} (server session.seq=${session.seq ?? 0})`,
            );
        } else if (opts?.initialLastSeq !== undefined && opts.initialLastSeq !== session.seq) {
            logger.debug(
                `[API] Session ${session.id} initial lastSeq=${opts.initialLastSeq} (server session.seq=${session.seq ?? 0})`,
            );
        }
        this.sendSync = new InvalidateSync(() => this.flushOutbox());
        this.receiveSync = new InvalidateSync(() => this.fetchMessages());
        this.socketConnectedPromise = new Promise<void>((resolve) => {
            this.socketConnectedResolve = resolve;
        });

        // Initialize RPC handler manager
        this.rpcHandlerManager = new RpcHandlerManager({
            scopePrefix: this.sessionId,
            encryptionKey: this.encryptionKey,
            encryptionVariant: this.encryptionVariant,
            logger: (msg, data) => logger.debug(msg, data)
        });
        const workingDir = this.metadata?.path ?? process.cwd();
        registerCommonHandlers(this.rpcHandlerManager, workingDir);
        // RPC so callers (e.g. server or app) can get this session's id (e.g. to map connection → sessionId)
        this.rpcHandlerManager.registerHandler('getSessionId', () => ({ sessionId: this.sessionId }));
        // Lazy tool content: serve full args and/or result from disk
        this.rpcHandlerManager.registerHandler<
            { callId: string },
            { success: boolean; args?: Record<string, unknown>; result?: unknown; error?: string }
        >('getToolCallFullContent', async (req) => {
            const [args, result] = await Promise.all([
                this.loadToolCallContentFromDisk(req.callId),
                this.loadToolCallResultFromDisk(req.callId),
            ]);
            if (args || result) {
                return { success: true, ...(args ? { args } : {}), ...(result !== null ? { result } : {}) };
            }
            return { success: false, error: 'Content not found' };
        });

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
            transports: this.websocketOnly ? ['websocket'] : ['polling', 'websocket'],
            withCredentials: true,
            autoConnect: false,
            ...(isNode() && { agent: serverHttpsAgent as any }),
        });

        //
        // Handlers
        //

        this.socket.on('connect', () => {
            logger.debug('Socket connected successfully');
            this.markWsConnected();
            this.tryPreferWsOutbound('socket_connect');
            this.socketConnectedResolve?.();
            this.socketConnectedResolve = undefined;
            this.stopFallbackPoll();
            this.rpcHandlerManager.onSocketConnect(this.socket);
            // Sync CLI version and git info (projectPath, branchName, isWorktree) on every connect.
            this.updateMetadata((metadata) => {
                const git = detectWorktree(metadata.path ?? process.cwd());
                // Strip previous git fields so stale values don't persist.
                const { projectPath: _pp, branchName: _bn, isWorktree: _iw, worktreeBranch: _wb, ...rest } = metadata as any;
                return {
                    ...(rest as Metadata),
                    version: BUILD_VERSION,
                    ...(git ? {
                        projectPath: git.projectPath,
                        branchName: git.branchName,
                        isWorktree: git.isWorktree,
                    } : {}),
                };
            }).catch((error) => {
                logger.debug('[API] Failed to sync CLI version/git-info on connect:', error);
            });
            // Static sync (requestedMetadata) is deferred to after the first
            // server metadata push so we don't overwrite App-side fields with
            // a snapshot captured before the authoritative metadata arrived.
            this.serverMetadataReceived = false;
            this.receiveSync.invalidate();
            // Fallback: if no metadata push arrives within 3 s (e.g. brand-new session),
            // run the static sync anyway so CLI version/git info reaches the server.
            setTimeout(() => {
                if (!this.serverMetadataReceived && this.requestedMetadata && shouldSyncSessionMetadata(this.metadata, this.requestedMetadata)) {
                    logger.debug('[API] Session metadata fallback sync (no server push received)');
                    this.updateMetadata((currentMetadata) => buildSyncedSessionMetadata(currentMetadata, this.requestedMetadata as Metadata)).catch(() => {});
                }
            }, 3000);
            this.startReceiveHealthPoll();
            if (this.a2aInboxNeedsServerUnreadSync) {
                this.a2aInboxNeedsServerUnreadSync = false;
                this.scheduleA2AInboxAgentStateSync({ immediate: true });
            }
        })

        // Set up global RPC request handler
        this.socket.on('rpc-request', async (data: { method: string, params: string }, callback: (response: string) => void) => {
            callback(await this.rpcHandlerManager.handleRequest(data));
        })

        this.socket.on('disconnect', (reason) => {
            logger.debug('[API] Socket disconnected:', reason);
            this.markWsDisconnected();
            this.forceHttpOutbound('socket_disconnect');
            this.rpcHandlerManager.onSocketDisconnect();
            if (!this.closing) this.startFallbackPoll();
        })

        this.socket.on('connect_error', (error) => {
            const msg = error?.message ?? String(error);
            logger.debug('[API] Socket connection error:', msg);
            this.markWsDisconnected();
            this.forceHttpOutbound('socket_connect_error');
            if (msg && msg.length < 200) {
                logger.debug('[API] If running remotely (SSH/devcontainer), ensure outbound HTTPS/WSS to server is allowed. Using HTTP fallback for messages.');
            }
            this.rpcHandlerManager.onSocketDisconnect();
            if (!this.closing) this.startFallbackPoll();
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
                    const acceptSeq = typeof messageSeq === 'number' && this.lastSeq > 0 && messageSeq === this.lastSeq + 1;
                    if (isEncrypted && acceptSeq) {
                        const body = decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(data.body.message.content.c));
                        logger.debugLargeJson('[SOCKET] [UPDATE] Received update:', body);
                        if (body == null || typeof body !== 'object') {
                            logger.debug('[API] new-message decrypted to null or non-object (encryption key mismatch or bad payload), will fetch via HTTP', {
                                sessionId: this.sessionId,
                                messageSeq,
                                bodyType: body === null ? 'null' : typeof body,
                            });
                            this.receiveSync.invalidate();
                            return;
                        }
                        this.routeIncomingMessage(body, messageSeq);
                        this.lastSeq = messageSeq;
                        return;
                    }
                    if (typeof messageSeq === 'number' && messageSeq <= this.lastSeq) {
                        logger.debug('[API] new-message ignored (seq already applied via HTTP or outbox)', {
                            messageSeq,
                            lastSeq: this.lastSeq,
                            reason: messageSeq === this.lastSeq ? 'duplicate' : 'stale',
                        });
                        return;
                    }

                    if (typeof messageSeq !== 'number') {
                        logger.debug('[API] new-message missing seq, will fetch via HTTP', {
                            lastSeq: this.lastSeq,
                        });
                        this.receiveSync.invalidate();
                    } else {
                        if (messageSeq > this.lastSeq + 1) {
                            logger.debug('[API] new-message seq gap, will fetch via HTTP', {
                                messageSeq,
                                lastSeq: this.lastSeq,
                                expectedNext: this.lastSeq + 1,
                                gap: messageSeq - this.lastSeq,
                            });
                        } else if (!isEncrypted) {
                            logger.debug('[API] new-message not encrypted, will fetch via HTTP', {
                                messageSeq,
                                lastSeq: this.lastSeq,
                            });
                        } else {
                            logger.debug('[API] new-message needs HTTP catch-up', {
                                messageSeq,
                                lastSeq: this.lastSeq,
                            });
                        }
                        // Steady-state: advance local lastSeq via fetchMessages, stop at this notification.
                        this.requestReceiveCatchUp(messageSeq);
                    }
                    return;
                } else if (data.body.t === 'update-session') {
                    if (data.body.metadata && data.body.metadata.version > this.metadataVersion) {
                        const decrypted = decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(data.body.metadata.value));
                        this.metadata = decrypted ? (sanitizeSessionMetadataForApp(decrypted) as Metadata) : decrypted;
                        this.metadataVersion = data.body.metadata.version;
                        this.emit('metadata-updated', this.metadata);
                        // First metadata push after (re)connect: now safe to sync static fields
                        // without clobbering App-side fields that arrived in this push.
                        if (!this.serverMetadataReceived) {
                            this.serverMetadataReceived = true;
                            if (this.requestedMetadata && shouldSyncSessionMetadata(this.metadata, this.requestedMetadata)) {
                                logger.debug('[API] Session metadata changed, syncing static metadata to server');
                                this.updateMetadata((currentMetadata) => buildSyncedSessionMetadata(currentMetadata, this.requestedMetadata as Metadata)).catch((error) => {
                                    logger.debug('[API] Failed to sync session metadata on connect:', error);
                                });
                            }
                        }
                    }
                    if (data.body.agentState && data.body.agentState.version > this.agentStateVersion) {
                        this.agentState = data.body.agentState.value ? decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(data.body.agentState.value)) : null;
                        this.agentStateVersion = data.body.agentState.version;
                        this.reconcileLocalA2AInboxWithServerAgentState();
                        this.stripServerInboxFromAgentState();
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

        // Trigger an initial HTTP poll so we get any messages already on the server (e.g. user sent
        // from App before socket connected). Otherwise we only fetch after socket 'connect' or
        // after connect_error (fallback poll every 8s), so new sessions can appear unresponsive.
        this.receiveSync.invalidate();
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

    private ingestA2AInboxFromTrigger(raw: unknown): string | undefined {
        if (!isRecord(raw) || raw.role !== 'user') {
            return undefined;
        }

        const meta = isRecord(raw.meta) ? raw.meta : null;
        if (meta?.origin !== 'a2a' && meta?.a2aTrigger !== true) {
            return undefined;
        }

        const inboxMessage = isRecord(raw.a2aInboxMessage) ? raw.a2aInboxMessage : null;
        if (!inboxMessage || typeof inboxMessage.text !== 'string' || inboxMessage.text.trim().length === 0) {
            return undefined;
        }

        const triggerId = typeof raw.localKey === 'string' && raw.localKey.trim().length > 0 ? raw.localKey : randomUUID();
        if (this.consumedA2ATriggerIds.has(triggerId)) {
            logger.debug(`[API] Ignoring duplicate A2A inbox trigger id=${triggerId}`);
            return triggerId;
        }
        this.recordA2AMessage({
            id: triggerId,
            title: typeof inboxMessage.title === 'string' && inboxMessage.title.trim().length > 0 ? inboxMessage.title.trim() : undefined,
            text: inboxMessage.text.trim(),
            createdAt: typeof inboxMessage.createdAt === 'number' ? inboxMessage.createdAt : Date.now(),
        });
        return triggerId;
    }

    private withA2AInboxMessageMeta<T extends { meta?: MessageMeta; localKey?: string }>(
        message: T,
        triggerInboxMessageId?: string,
    ): T {
        if (!triggerInboxMessageId) {
            return message;
        }
        return {
            ...message,
            meta: {
                ...(message.meta ?? {}),
                a2aInboxMessageId: triggerInboxMessageId,
            },
        };
    }

    private routeIncomingMessage(message: unknown, seq?: number) {
        // Deduplicate by seq: WebSocket push and HTTP fetch may deliver
        // the same message concurrently.
        if (typeof seq === 'number') {
            const key = String(seq);
            if (this.routedMessageIds.has(key)) return;
            this.routedMessageIds.add(key);
            if (this.routedMessageIds.size > 1000) this.routedMessageIds.clear();
        }

        const triggerInboxMessageId = this.ingestA2AInboxFromTrigger(message);
        // When an A2A trigger was ingested into the local inbox, it is an
        // internal CLI notification — not a user text message for Claude.
        // Skip user message routing so the inbox turn controller picks it up
        // via its own peekInbox / scheduleA2ATurnIfNeeded cycle instead of
        // injecting it mid-turn as a stray user turn.
        if (triggerInboxMessageId) {
            return;
        }

        const userResult = UserMessageSchema.safeParse(message);
        if (userResult.success) {
            logger.debug('[API] User message from app received, routing to CLI');
            const routed = this.withA2AInboxMessageMeta(userResult.data, triggerInboxMessageId);
            if (this.pendingMessageCallback) {
                this.pendingMessageCallback(routed);
            } else {
                this.pendingMessages.push(routed);
            }
            return;
        }
        // Relaxed fallback: if it looks like a user text message (e.g. app sends content.type !== 'text'), normalize and route
        const relaxed = this.normalizeToUserMessage(message);
        if (relaxed) {
            logger.debug(`[API] User message from ${relaxed.meta?.origin === 'a2a' ? 'A2A compat' : 'relaxed'} parse, routing to CLI`);
            const routed = this.withA2AInboxMessageMeta(relaxed, triggerInboxMessageId);
            if (this.pendingMessageCallback) {
                this.pendingMessageCallback(routed);
            } else {
                this.pendingMessages.push(routed);
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

    /** Normalize app payload to UserMessage when strict schema fails (e.g. content.type is 'input', parts[] payload, or missing). */
    private normalizeToUserMessage(raw: unknown): UserMessage | null {
        const a2aSessionMessage = this.normalizeA2ASessionEnvelopeToUserMessage(raw);
        if (a2aSessionMessage) {
            return a2aSessionMessage;
        }

        if (!isRecord(raw) || raw.role !== 'user') return null;

        const localKey = typeof raw.localKey === 'string' ? raw.localKey : undefined;
        const meta = isRecord(raw.meta) ? (raw.meta as UserMessage['meta']) : undefined;

        const content = raw.content;
        const text = typeof content === 'string'
            ? content
            : isRecord(content) && typeof content.text === 'string'
                ? content.text
                : isRecord(content) && content.type === 'content' && Array.isArray(content.blocks)
                    ? content.blocks.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n')
                    : extractA2ATextFromParts(content)
                ?? (isRecord(content) && 'parts' in content ? extractA2ATextFromParts(content.parts) : null)
                ?? extractA2ATextFromParts(raw.parts);

        if (text === null) return null;

        const isA2A = Array.isArray(raw.parts) || Array.isArray(content) || (isRecord(content) && Array.isArray(content.parts));
        return {
            role: 'user',
            content: { type: 'text', text },
            localKey,
            meta: isA2A
                ? { ...(meta ?? {}), origin: 'a2a', a2aTrigger: true }
                : meta,
        };
    }

    private normalizeA2ASessionEnvelopeToUserMessage(raw: unknown): UserMessage | null {
        if (!isRecord(raw) || raw.role !== 'session') return null;

        const meta = isRecord(raw.meta) ? raw.meta : null;
        if (meta?.origin !== 'a2a') return null;

        const content = isRecord(raw.content) ? raw.content : null;
        if (!content || content.role !== 'agent') return null;
        const envelopeId = typeof content.id === 'string' ? content.id : null;
        if (envelopeId && this.routedA2ASessionEnvelopeIds.has(envelopeId)) {
            return null;
        }

        const ev = isRecord(content.ev) ? content.ev : null;
        if (!ev || ev.t !== 'text' || typeof ev.text !== 'string' || ev.text.trim().length === 0) {
            return null;
        }

        if (envelopeId) {
            this.routedA2ASessionEnvelopeIds.add(envelopeId);
            if (this.routedA2ASessionEnvelopeIds.size > 1000) {
                this.routedA2ASessionEnvelopeIds.clear();
                this.routedA2ASessionEnvelopeIds.add(envelopeId);
            }
        }

        this.recordA2AMessage({
            id: envelopeId ?? randomUUID(),
            text: ev.text.trim(),
            createdAt: typeof content.time === 'number' ? content.time : Date.now(),
        });
        return null;
    }

    getAgentState(): AgentState | null {
        if (!this.agentState) {
            return null;
        }
        return {
            ...this.agentState,
            a2aInbox: toServerA2AInboxSnapshot(this.a2aInbox),
        };
    }

    getA2AInbox() {
        return cloneA2AInboxState(this.a2aInbox);
    }

    getServerA2AUnreadCount(): number | undefined {
        return getServerA2AUnreadCount(this.agentState);
    }

    shouldEnqueueA2AInboxTurn(): boolean {
        return shouldScheduleA2AInboxTurn(
            this.a2aInbox,
            getServerA2AUnreadCount(this.agentState),
            { consumedTriggerIds: this.consumedA2ATriggerIds },
        );
    }

    noteA2ATriggersConsumed(ids: string[]): void {
        for (const id of ids) {
            this.rememberConsumedA2ATriggerId(id);
        }
    }

    /** Force-clear local unread when server already reports unreadCount=0 (stuck drain loop). */
    abandonLocalA2AInboxWhenServerDrained(): number {
        if (getServerA2AUnreadCount(this.agentState) !== 0) {
            return 0;
        }
        const unread = listA2AInboxMessages(this.a2aInbox, { unreadOnly: true });
        if (unread.length === 0) {
            return 0;
        }
        this.noteA2ATriggersConsumed(unread.map((message) => message.id));
        this.markA2AMessagesRead(unread.map((message) => message.id));
        logger.debug(
            `[API] Abandoned ${unread.length} local A2A unread message(s) `
            + '(server unreadCount=0, inbox drain gave up)',
        );
        return unread.length;
    }

    /**
     * Drop ghost local unread rows that were already consumed while server unreadCount=0.
     */
    reconcileLocalA2AInboxWithServerAgentState(): number {
        if (getServerA2AUnreadCount(this.agentState) !== 0) {
            return 0;
        }
        const ghosts = listA2AInboxMessages(this.a2aInbox, { unreadOnly: true })
            .filter((message) => this.consumedA2ATriggerIds.has(message.id));
        if (ghosts.length === 0) {
            return 0;
        }
        this.markA2AMessagesRead(ghosts.map((message) => message.id));
        logger.debug(
            `[API] Reconciled ${ghosts.length} ghost local A2A unread message(s) `
            + '(server unreadCount=0, trigger already consumed)',
        );
        return ghosts.length;
    }

    private rememberConsumedA2ATriggerId(id: string): void {
        this.consumedA2ATriggerIds.add(id);
        if (this.consumedA2ATriggerIds.size > 2000) {
            this.consumedA2ATriggerIds.clear();
            this.consumedA2ATriggerIds.add(id);
        }
        this.a2aInbox = {
            ...this.a2aInbox,
            consumedTriggerIds: [...this.consumedA2ATriggerIds],
        };
    }

    private stripServerInboxFromAgentState(): void {
        if (!this.agentState) {
            return;
        }
        this.agentState = {
            ...this.agentState,
            a2aInbox: toServerA2AInboxSnapshot(this.a2aInbox),
        };
    }

    private applyA2AInboxLocally(): void {
        this.a2aInbox = pruneA2AInboxState(this.a2aInbox);
        saveLocalA2AInbox(this.sessionId, this.a2aInbox);
    }

    private scheduleA2AInboxAgentStateSync(options?: { immediate?: boolean }): void {
        this.applyA2AInboxLocally();
        if (options?.immediate) {
            if (this.a2aInboxStateSyncTimer !== null) {
                clearTimeout(this.a2aInboxStateSyncTimer);
                this.a2aInboxStateSyncTimer = null;
            }
            this.flushA2AInboxAgentStateSync();
            return;
        }
        if (this.a2aInboxStateSyncTimer !== null) {
            return;
        }
        this.a2aInboxStateSyncTimer = setTimeout(() => {
            this.a2aInboxStateSyncTimer = null;
            this.flushA2AInboxAgentStateSync();
        }, 400);
    }

    private flushA2AInboxAgentStateSync(): void {
        const snapshot = toServerA2AInboxSnapshot(this.a2aInbox);
        const localCount = this.a2aInbox.messages.length;
        const localUnread = this.a2aInbox.messages.filter((m) => !m.readAt).length;
        logger.debug(
            `[API] Syncing A2A inbox to server: unreadCount=${snapshot.unreadCount} `
            + `(local messages=${localCount}, unread=${localUnread}, ids=${this.a2aInbox.messages.map((m) => `${m.id.slice(-12)}:${m.readAt ? 'R' : 'U'}`).join(',')})`,
        );
        this.updateAgentState((currentState) => ({
            ...currentState,
            a2aInbox: snapshot,
        }));
    }

    recordA2AMessage(message: A2AInboxMessage): void {
        this.a2aInbox = upsertA2AInboxMessage(this.a2aInbox, message);
        this.scheduleA2AInboxAgentStateSync();
    }

    markA2AMessageRead(id: string): void {
        this.rememberConsumedA2ATriggerId(id);
        this.a2aInbox = markA2AInboxMessageRead(this.a2aInbox, id);
        this.scheduleA2AInboxAgentStateSync({ immediate: true });
    }

    markA2AMessagesRead(ids: string[]): void {
        for (const id of ids) {
            this.rememberConsumedA2ATriggerId(id);
        }
        this.a2aInbox = markA2AInboxMessagesRead(this.a2aInbox, ids);
        this.scheduleA2AInboxAgentStateSync({ immediate: true });
    }

    /** For debugging: whether the real-time socket to the server is connected (vs HTTP fallback polling). */
    isSocketConnected(): boolean {
        return this.socket?.connected === true;
    }

    /** Rolling WS uptime ratio since session client construction (0–1). */
    getWsUptimeRatio(): number {
        this.accumulateWsUptimeSample();
        const total = this.wsUptimeAccumMs + this.wsDowntimeAccumMs;
        if (total <= 0) {
            return this.socket.connected ? 1 : 0;
        }
        return this.wsUptimeAccumMs / total;
    }

    getOutboundTransportMode(): 'ws' | 'http' {
        return this.outboundMode;
    }

    private accumulateWsUptimeSample() {
        const now = Date.now();
        const delta = now - this.lastWsUptimeMarkMs;
        if (delta <= 0) {
            return;
        }
        if (this.socket.connected) {
            this.wsUptimeAccumMs += delta;
        } else {
            this.wsDowntimeAccumMs += delta;
        }
        this.lastWsUptimeMarkMs = now;
    }

    private markWsConnected() {
        this.accumulateWsUptimeSample();
        this.wsUptimeStartedAt = Date.now();
    }

    private markWsDisconnected() {
        this.accumulateWsUptimeSample();
        this.wsUptimeStartedAt = null;
    }

    private tryPreferWsOutbound(reason: string) {
        if (Date.now() < this.wsOutboundBackoffUntil) {
            logger.debug('[API] outbound: staying on HTTP (WS backoff)', {
                reason,
                backoffMsRemaining: this.wsOutboundBackoffUntil - Date.now(),
                wsUptimeRatio: this.getWsUptimeRatio(),
            });
            return;
        }
        this.outboundMode = 'ws';
        this.wsOutboundFailureStreak = 0;
        logger.debug('[API] outbound: WS preferred', {
            reason,
            wsUptimeRatio: this.getWsUptimeRatio(),
        });
    }

    private forceHttpOutbound(reason: string) {
        this.outboundMode = 'http';
        logger.debug('[API] outbound: forced HTTP', { reason, wsUptimeRatio: this.getWsUptimeRatio() });
    }

    private switchToHttpOutboundAfterWsFailure(reason: string, error?: unknown) {
        this.outboundMode = 'http';
        this.wsOutboundFailureStreak += 1;
        const backoffMs = Math.min(
            60_000,
            ApiSessionClient.WS_OUTBOUND_BACKOFF_BASE_MS * Math.pow(2, this.wsOutboundFailureStreak - 1),
        );
        this.wsOutboundBackoffUntil = Date.now() + backoffMs;
        logger.debug('[API] outbound: WS send failed, using HTTP with backoff', {
            reason,
            backoffMs,
            error: error instanceof Error ? error.message : error,
            wsUptimeRatio: this.getWsUptimeRatio(),
        });
    }

    private shouldFlushOutboxViaWs(): boolean {
        return this.outboundMode === 'ws'
            && this.socket.connected
            && Date.now() >= this.wsOutboundBackoffUntil;
    }

    private requestReceiveCatchUp(targetSeq: number) {
        this.receiveCatchUpUntilSeq = this.receiveCatchUpUntilSeq === null
            ? targetSeq
            : Math.max(this.receiveCatchUpUntilSeq, targetSeq);
        this.receiveSync.invalidate();
    }

    private startReceiveHealthPoll() {
        if (this.receiveHealthInterval !== null || this.closing) {
            return;
        }
        this.receiveHealthInterval = setInterval(() => {
            if (!this.socket.connected || this.closing) {
                return;
            }
            this.receiveSync.invalidate();
        }, ApiSessionClient.RECEIVE_HEALTH_INTERVAL_MS);
    }

    private stopReceiveHealthPoll() {
        if (this.receiveHealthInterval !== null) {
            clearInterval(this.receiveHealthInterval);
            this.receiveHealthInterval = null;
        }
    }

    private async fetchMessages() {
        const untilSeq = this.receiveCatchUpUntilSeq;
        const startLastSeq = this.lastSeq;
        let afterSeq = this.lastSeq;
        let pages = 0;
        // Absolute deadline: axios `timeout` only covers socket inactivity and can fail to fire
        // on reused keep-alive connections, leaving the request permanently hung. AbortController
        // enforces a hard wall-clock limit so fetchMessages always completes.
        const abort = new AbortController();
        const abortTimer = setTimeout(() => abort.abort(), 90000);
        logger.debug('[API] fetchMessages start', {
            sessionId: this.sessionId,
            afterSeq,
            untilSeq,
            lastSeq: this.lastSeq,
        });
        try {
            while (true) {
                pages += 1;
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
                        signal: abort.signal,
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
                        if (body == null || typeof body !== 'object') {
                            logger.debug('[API] Fetched message decrypted to null or non-object (encryption key mismatch or bad payload)', {
                                sessionId: this.sessionId,
                                seq: message.seq,
                                bodyType: body === null ? 'null' : typeof body,
                            });
                            continue;
                        }
                        this.routeIncomingMessage(body, message.seq);
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
                if (untilSeq !== null && maxSeq >= untilSeq) {
                    this.receiveCatchUpUntilSeq = null;
                    break;
                }
                if (!hasMore) {
                    break;
                }
            }
        } catch (error) {
            logger.debug('[API] fetchMessages failed', {
                sessionId: this.sessionId,
                afterSeq,
                untilSeq,
                pages,
                error: error instanceof Error ? error.message : error,
            });
            throw error;
        } finally {
            clearTimeout(abortTimer);
            const catchUpTarget = untilSeq;
            if (catchUpTarget !== null && this.lastSeq < catchUpTarget) {
                logger.debug('[API] fetchMessages stopped before catch-up target (will retry on next sync)', {
                    sessionId: this.sessionId,
                    lastSeq: this.lastSeq,
                    untilSeq: catchUpTarget,
                });
            }
            logger.debug('[API] fetchMessages done', {
                sessionId: this.sessionId,
                pages,
                startLastSeq,
                endLastSeq: this.lastSeq,
                untilSeq: this.receiveCatchUpUntilSeq,
            });
        }
    }

    private static readonly MAX_BATCH_SIZE = 80;
    // 404 is included: /v3/sessions/{id}/messages can transiently 404 during server deploys/routing issues
    private static readonly FLUSH_RETRY_STATUSES = [404, 502, 503, 504];
    private static readonly FLUSH_RETRY_MAX = 3;
    private static readonly FLUSH_RETRY_BASE_MS = 1000;
    private static readonly WS_OUTBOUND_BACKOFF_BASE_MS = 2000;

    /**
     * Drain outbox head-of-line: one transport per chunk, never WS+HTTP in parallel.
     * WS success skips HTTP for that chunk; WS failure continues with HTTP on the current queue head only.
     */
    private async flushOutbox() {
        if (this.pendingOutbox.length === 0) {
            return;
        }

        const total = this.pendingOutbox.length;

        while (this.pendingOutbox.length > 0) {
            const chunk = this.pendingOutbox.slice(0, ApiSessionClient.MAX_BATCH_SIZE);
            if (this.shouldFlushOutboxViaWs()) {
                try {
                    await this.flushOutboxViaWs(chunk);
                    continue;
                } catch (error) {
                    this.switchToHttpOutboundAfterWsFailure('ws_flush_failed', error);
                    if (this.pendingOutbox.length === 0) {
                        continue;
                    }
                }
            }
            const httpChunk = this.pendingOutbox.slice(0, ApiSessionClient.MAX_BATCH_SIZE);
            if (httpChunk.length === 0) {
                continue;
            }
            await this.flushOutboxViaHttp(httpChunk);
        }

        if (total > ApiSessionClient.MAX_BATCH_SIZE) {
            logger.debug(`[API] flushOutbox chunked: ${total} messages in ${Math.ceil(total / ApiSessionClient.MAX_BATCH_SIZE)} batches`);
        }
    }

    private async flushOutboxViaWs(chunk: Array<{ content: string; localId: string }>) {
        let sent = 0;
        try {
            for (const message of chunk) {
                if (!this.socket.connected) {
                    throw new Error('ws_disconnected_mid_flush');
                }
                this.socket.emit('message', {
                    sid: this.sessionId,
                    message: message.content,
                    localId: message.localId,
                });
                sent += 1;
            }
        } finally {
            if (sent > 0) {
                this.pendingOutbox.splice(0, sent);
                logger.debug(`[API] flushOutbox via WS (optimistic): sent ${sent} message(s) to server (replies visible in app)`);
                // WS send has no seq ack — pull receive cursor forward via HTTP (health poll is backup).
                this.receiveSync.invalidate();
            }
        }
        if (sent < chunk.length) {
            throw new Error('ws_disconnected_mid_flush');
        }
    }

    private async flushOutboxViaHttp(chunk: Array<{ content: string; localId: string }>) {
        let flushed = 0;
        const total = this.pendingOutbox.length;
        for (let attempt = 0; attempt <= ApiSessionClient.FLUSH_RETRY_MAX; attempt++) {
            try {
                if (attempt > 0) {
                    const delayMs = ApiSessionClient.FLUSH_RETRY_BASE_MS * Math.pow(2, attempt - 1);
                    logger.debug(`[API] flushOutbox HTTP retry ${attempt}/${ApiSessionClient.FLUSH_RETRY_MAX} after ${delayMs}ms`);
                    await new Promise((r) => setTimeout(r, delayMs));
                }
                const response = await axios.post<V3PostSessionMessagesResponse>(
                    `${configuration.serverUrl}/v3/sessions/${encodeURIComponent(this.sessionId)}/messages`,
                    {
                        messages: chunk
                    },
                    {
                        headers: this.authHeaders(),
                        timeout: 120000, // 2 min so slow server or large cursor reply can complete; timeout is retried
                        httpsAgent: serverHttpsAgent,
                    }
                );

                this.pendingOutbox.splice(0, chunk.length);
                flushed += chunk.length;

                const messages = Array.isArray(response.data.messages) ? response.data.messages : [];
                const maxSeq = messages.reduce((acc, message) => (
                    message.seq > acc ? message.seq : acc
                ), this.lastSeq);
                this.lastSeq = maxSeq;
                logger.debug(`[API] flushOutbox via HTTP: sent ${chunk.length} message(s) to server (replies visible in app)`);
                return;
            } catch (error: unknown) {
                const status = axios.isAxiosError(error) ? error.response?.status : undefined;
                const isTimeout = axios.isAxiosError(error) && error.code === 'ECONNABORTED';
                const isNetworkReset = axios.isAxiosError(error) && error.code === 'ECONNRESET';
                const isRetryableStatus = status !== undefined && ApiSessionClient.FLUSH_RETRY_STATUSES.includes(status);
                const isRetryable = isRetryableStatus || (isTimeout && attempt < ApiSessionClient.FLUSH_RETRY_MAX) || isNetworkReset;
                if (!isRetryable || attempt === ApiSessionClient.FLUSH_RETRY_MAX) {
                    const data = axios.isAxiosError(error) ? error.response?.data : undefined;
                    logger.debug('[API] flushOutbox HTTP failed', { sessionId: this.sessionId, batchLength: chunk.length, flushed, total, status, isTimeout, data, error });
                    logger.warn(`[API] Failed to send ${chunk.length} reply message(s) to server (will retry). Check network and server.`, { status, isTimeout, sessionId: this.sessionId });
                    throw error;
                }
                logger.debug('[API] flushOutbox HTTP retryable error (will retry)', { status, isTimeout, attempt: attempt + 1, maxRetries: ApiSessionClient.FLUSH_RETRY_MAX });
            }
        }
    }

    private enqueueMessage(content: unknown, invalidate: boolean = true, localId?: string) {
        const encrypted = encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, content));
        this.pendingOutbox.push({
            content: encrypted,
            localId: localId ?? randomUUID()
        });
        if (invalidate) {
            this.sendSync.invalidate();
        }
    }

    /**
     * If HAPPY_LAZY_TOOL_CONTENT is set, intercept tool-call-start envelopes for
     * diff-type tools, truncate large string fields, and cache the full args.
     */
    private maybeLazyEncodeEnvelope(envelope: SessionEnvelope): SessionEnvelope {
        if (!LAZY_TOOL_CONTENT_ENABLED) return envelope;
        const ev = envelope.ev as Record<string, unknown>;
        if (ev.t !== 'tool-call-start') return envelope;
        const name = ev.name as string;
        if (!LAZY_DIFF_TOOL_NAMES.has(name)) return envelope;
        const callId = ev.call as string;
        const args = ev.args as Record<string, unknown>;
        const { truncated, wasTruncated } = truncateDiffArgs(name, args);
        if (!wasTruncated) return envelope;
        this.persistToolCallContent(callId, args);
        return { ...envelope, ev: { ...ev, args: truncated } } as SessionEnvelope;
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

    closeClaudeSessionTurn(status: SessionTurnEndStatus = 'completed', extras?: Record<string, unknown>) {
        const mapped = closeClaudeTurnWithStatus(this.claudeSessionProtocolState, status, extras);
        this.claudeSessionProtocolState.currentTurnId = mapped.currentTurnId;
        for (const envelope of mapped.envelopes) {
            // Use the lifecycle path for turn-end so the App stops the thinking timer
            // (same shape Cursor uses; otherwise the timer can stick on after a long turn).
            const isTurnEnd = (envelope.ev as { t?: string }).t === 'turn-end';
            if (isTurnEnd) {
                this.sendSessionLifecycleEnvelope(envelope);
            } else {
                this.sendSessionProtocolMessage(envelope);
            }
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

    /** Same shape as codex but type: 'cursor' so the app normalizes thinking as thinking (no dependency on session.metadata.flavor). */
    sendCursorMessage(body: Parameters<ApiSessionClient['sendCodexMessage']>[0]) {
        let content = {
            role: 'agent',
            content: {
                type: 'cursor',
                data: body
            },
            meta: {
                sentFrom: 'cli'
            }
        };
        this.enqueueMessage(content);
    }

    /**
     * Send message in legacy Claude "output" format (role: 'agent', content.type: 'output', data: body).
     * Used for old App compatibility; dual-send alongside session protocol when needed.
     */
    sendOutputFormatMessage(data: OutputFormatData) {
        const content = {
            role: 'agent' as const,
            content: {
                type: 'output' as const,
                data,
            },
            meta: { sentFrom: 'cli' as const },
        };
        this.enqueueMessage(content);
    }

    private enqueueSessionProtocolEnvelope(envelope: SessionEnvelope, invalidate: boolean = true, extraMeta?: Record<string, unknown>) {
        const content = {
            role: 'session',
            content: envelope,
            meta: {
                sentFrom: 'cli',
                ...(extraMeta ?? {}),
            }
        };
        // Use envelope.id as localId so server dedupes by localId; same envelope sent multiple times becomes one row.
        this.enqueueMessage(content, invalidate, envelope.id);
    }

    /** Count of envelopes sent this process (for trace log); resets only by process restart. */
    private _envelopeSendCount = 0;

    /** Suppress the next N non-sidechain user text envelopes produced by the mapper.
     *  Call before injecting an internal CLI prompt (e.g. inbox turn notification) so it
     *  does not appear as a user bubble in the App. */
    suppressNextMapperUserText(count = 1): void {
        suppressNextUserText(this.claudeSessionProtocolState, count);
    }

    sendSessionProtocolMessage(envelope: SessionEnvelope, extraMeta?: Record<string, unknown>) {
        // Apply lazy encoding at the single exit point so all code paths
        // (Claude via sendClaudeSessionMessage, Cursor via direct call, etc.) are covered.
        const finalEnvelope = this.maybeLazyEncodeEnvelope(envelope);
        if (finalEnvelope.role === 'user' && finalEnvelope.ev.t === 'text') {
            const stack = new Error().stack?.split('\n').slice(1, 4).map(s => s.trim()).join(' <- ');
            logger.debug(`[API] USER ENVELOPE: "${(finalEnvelope.ev as any).text?.slice(0,50)}" callstack: ${stack}`);
        }
        if (process.env.HAPPY_CURSOR_TRACE_ENVELOPES === '1') {
            this._envelopeSendCount += 1;
            const ev = finalEnvelope.ev as { t?: string; text?: string; call?: string };
            const textLen = ev.t === 'text' && typeof ev.text === 'string' ? ev.text.length : 0;
            const line = `[envelope #${this._envelopeSendCount}] id=${finalEnvelope.id} role=${finalEnvelope.role} ev.t=${ev.t}${textLen ? ` textLen=${textLen}` : ''}${ev.call ? ` call=${String(ev.call).slice(0, 8)}` : ''}`;
            console.error(line);
            try {
                appendFileSync(process.env.HAPPY_CURSOR_TRACE_LOG ?? '/tmp/cursor-envelope-trace.log', `${line}\n`);
            } catch { /* ignore */ }
        }
        this.enqueueSessionProtocolEnvelope(finalEnvelope, true, extraMeta);
    }

    /**
     * Send a turn-end (or turn-start) session envelope in the shape the app expects for
     * lifecycle/thinking timer: content.content.type === 'session' and content.content.data.ev.t.
     * Use this only for turn-end/turn-start so the mobile app stops the timer; other session
     * messages keep the normal envelope shape.
     */
    sendSessionLifecycleEnvelope(envelope: SessionEnvelope) {
        if (process.env.HAPPY_CURSOR_TRACE_ENVELOPES === '1') {
            this._envelopeSendCount += 1;
            const ev = envelope.ev as { t?: string; status?: string };
            const line = `[envelope #${this._envelopeSendCount} lifecycle] id=${envelope.id} ev.t=${ev.t} status=${ev.status ?? ''}`;
            console.error(line);
            try {
                appendFileSync(process.env.HAPPY_CURSOR_TRACE_LOG ?? '/tmp/cursor-envelope-trace.log', `${line}\n`);
            } catch { /* ignore */ }
        }
        const content = {
            role: 'session',
            content: { type: 'session', data: envelope },
            meta: { sentFrom: 'cli' },
        };
        this.enqueueMessage(content, true, envelope.id);
    }

    /**
     * Send a generic agent message to the session using ACP (Agent Communication Protocol) format.
     * Works for any agent type (Gemini, Codex, Claude, etc.) - CLI normalizes to unified ACP format.
     * 
     * @param provider - The agent provider sending the message (e.g., 'gemini', 'codex', 'claude')
     * @param body - The message payload (type: 'message' | 'reasoning' | 'tool-call' | 'tool-result')
     */
    sendAgentMessage(provider: 'gemini' | 'codex' | 'claude' | 'cursor' | 'opencode', body: ACPMessageData) {
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
        const payload = {
            sid: this.sessionId,
            time: Date.now(),
            thinking,
            mode,
        };
        // Both directions must be reliable: volatile thinking=true is often dropped (App stuck idle),
        // volatile thinking=false left sessions stuck "thinking" on flaky WSS.
        this.socket.emit('session-alive', payload);
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
        this.socket.emit('usage-report', usageReport, (ack: { success?: boolean; error?: string }) => {
            if (ack && !ack.success) {
                logger.warn('[SOCKET] usage-report ack error:', ack.error);
            }
        });
    }

    /**
     * Send Cursor IDE quota/usage to the server (monitor-only; key: 'cursor-ide').
     * Payload must have tokens: { total, ... }, cost: { total, ... } (see cursorQuotaFetcher.buildCursorUsageReportPayload).
     */
    sendCursorQuotaReport(payload: { tokens: { total: number; [key: string]: number }; cost: { total: number; [key: string]: number } }) {
        const usageReport = {
            key: 'cursor-ide',
            sessionId: this.sessionId,
            tokens: payload.tokens,
            cost: payload.cost,
        };
        logger.debug('[SOCKET] Sending Cursor quota report');
        this.socket.emit('usage-report', usageReport, (ack: { success?: boolean; error?: string }) => {
            if (ack && ack.success) {
                logger.debug('[SOCKET] Cursor quota report saved by server');
            } else if (ack && !ack.success) {
                logger.warn('[SOCKET] Cursor quota report ack error:', ack.error);
            }
        });
    }

    /**
     * Update session metadata
     * @param handler - Handler function that returns the updated metadata
     * @returns Promise that resolves when the server has acked the update (callers can await for kill path)
     */
    updateMetadata(handler: (metadata: Metadata) => Metadata): Promise<void> {
        return this.metadataLock.inLock(async () => {
            if (!this.socket.connected) {
                // Wait for initial socket connection (e.g. called at startup before socket connects).
                // Give up after 15s so a permanently-offline session doesn't block indefinitely.
                const timeout = new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error('Session real-time disconnected; title update requires WebSocket (check network / HAPPY_SERVER_URL)')), 15_000)
                );
                await Promise.race([this.socketConnectedPromise, timeout]);
            }
            await backoff(async () => {
                let updated = sanitizeSessionMetadataForApp(handler(this.metadata!)) as Metadata; // Weird state if metadata is null - should never happen but here we are
                const answer = await this.socket.emitWithAck('update-metadata', { sid: this.sessionId, expectedVersion: this.metadataVersion, metadata: encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, updated)) });
                if (answer.result === 'success') {
                    const decrypted = decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(answer.metadata));
                    this.metadata = decrypted ? (sanitizeSessionMetadataForApp(decrypted) as Metadata) : decrypted;
                    this.metadataVersion = answer.version;
                    this.emit('metadata-updated', this.metadata);
                } else if (answer.result === 'version-mismatch') {
                    if (answer.version > this.metadataVersion) {
                        this.metadataVersion = answer.version;
                        const decrypted = decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(answer.metadata));
                        this.metadata = decrypted ? (sanitizeSessionMetadataForApp(decrypted) as Metadata) : decrypted;
                        this.emit('metadata-updated', this.metadata);
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
                    this.stripServerInboxFromAgentState();
                    logger.debug('Agent state updated', this.agentState);
                } else if (answer.result === 'version-mismatch') {
                    if (answer.version > this.agentStateVersion) {
                        this.agentStateVersion = answer.version;
                        this.agentState = answer.agentState ? decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(answer.agentState)) : null;
                        this.stripServerInboxFromAgentState();
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
        await new Promise<void>((resolve) => {
            this.socket.emit('ping', () => {
                resolve();
            });
            setTimeout(() => {
                resolve();
            }, 10000);
        });
        // After flushing outbox, kick off one receive-sync so lastSeq is current before
        // we go idle. This way the next user message's socket event will always hit the
        // fast path (seq === lastSeq + 1) instead of falling back to an HTTP catch-up
        // that could batch it with a second message sent in frustration.
        this.receiveSync.invalidate();
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
        this.closing = true;
        if (this.a2aInboxStateSyncTimer !== null) {
            clearTimeout(this.a2aInboxStateSyncTimer);
            this.a2aInboxStateSyncTimer = null;
        }
        this.applyA2AInboxLocally();
        this.flushA2AInboxAgentStateSync();
        this.stopFallbackPoll();
        this.stopReceiveHealthPoll();
        this.sendSync.stop();
        this.receiveSync.stop();
        this.socket.close();
    }
}
