import { render } from "ink";
import React from "react";
import { ApiClient } from '@/api/api';
import { CodexAppServerClient } from './codexAppServerClient';
import { readProfileCodexConfig, writeProfileCodexHome } from './profileCodexHome';
import { codexModelOptions, currentTierCode, resolveCodexModel } from './modelTiers';
import { configuration } from '@/configuration';
import { CodexPermissionHandler } from './utils/permissionHandler';
import { ReasoningProcessor } from './utils/reasoningProcessor';
import { DiffProcessor } from './utils/diffProcessor';
import { randomUUID } from 'node:crypto';
import { logger } from '@/ui/logger';
import { Credentials, readSettings, writeSessionPidFile, removeSessionPidFile, SandboxConfig } from '@/persistence';
import { initialMachineMetadata } from '@/daemon/run';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { projectPath } from '@/projectPath';
import { hashObject } from '@/utils/deterministicJson';
import { dirname, join } from 'node:path';
import { createSessionMetadata } from '@/utils/createSessionMetadata';
import fs from 'node:fs';
import { startHappyServer } from '@/claude/utils/startHappyServer';
import { MessageBuffer } from "@/ui/ink/messageBuffer";
import { CodexDisplay } from "@/ui/ink/CodexDisplay";
import { CHANGE_TITLE_INSTRUCTION } from '@/gemini/constants';
import { notifyDaemonSessionStarted, notifyDaemonSessionEnding } from "@/daemon/controlClient";
import { startUnixSocketClient, reportLanDelivery } from '@/daemon/unixSocketClient';
import { registerKillSessionHandler } from "@/claude/registerKillSessionHandler";
import { stopCaffeinate } from "@/utils/caffeinate";
import { connectionState } from '@/utils/serverConnectionErrors';
import { setupOfflineReconnection } from '@/utils/setupOfflineReconnection';
import type { ApiSessionClient } from '@/api/apiSession';
import { getUserMessageText } from '@/api/types';
import type { UserMessage } from '@/api/types';
import { resolveCodexExecutionPolicy } from './executionPolicy';
import { mapCodexMcpMessageToSessionEnvelopes, mapCodexProcessorMessageToSessionEnvelopes } from './utils/sessionProtocolMapper';

type ReadyEventOptions = {
    pending: unknown;
    queueSize: () => number;
    shouldExit: boolean;
    sendReady: () => void;
    notify?: () => void;
};

/**
 * Notify connected clients when Codex finishes processing and the queue is idle.
 * Returns true when a ready event was emitted.
 */
export function emitReadyIfIdle({ pending, queueSize, shouldExit, sendReady, notify }: ReadyEventOptions): boolean {
    if (shouldExit) {
        return false;
    }
    if (pending) {
        return false;
    }
    if (queueSize() > 0) {
        return false;
    }

    sendReady();
    notify?.();
    return true;
}

/**
 * Main entry point for the codex command with ink UI
 */
export async function runCodex(opts: {
    credentials: Credentials;
    startedBy?: 'daemon' | 'terminal';
    noSandbox?: boolean;
    sandboxOverride?: SandboxConfig;
    resumeSessionTag?: string;
    resumeAfterSeq?: number;
}): Promise<void> {
    // Use shared PermissionMode type for cross-agent compatibility
    type PermissionMode = import('@/api/types').PermissionMode;
    interface EnhancedMode {
        permissionMode: PermissionMode;
        model?: string;
    }

    //
    // Define session
    //

    const sessionTag = opts.resumeSessionTag?.trim() || randomUUID();

    // Set backend for offline warnings (before any API calls)
    connectionState.setBackend('Codex');

    // A profile states its Codex endpoint as data; Codex reads a config file. Materialise the
    // home here, under Happy's own directory, so the person never manages CODEX_HOME by hand.
    // `CODEX_API_KEY` stays in the process environment: the config only names it.
    const profileCodex = readProfileCodexConfig(process.env);
    if (profileCodex) {
        const previousHome = process.env.CODEX_HOME;
        const home = writeProfileCodexHome(configuration.happyHomeDir, sessionTag, {
            ...profileCodex,
            // A profile may name a tier (“sol”) rather than a version; the file Codex reads
            // needs the concrete model either way.
            ...(profileCodex.model ? { model: resolveCodexModel(profileCodex.model) } : {}),
        });
        process.env.CODEX_HOME = home;
        logger.info(`[codex] profile endpoint ${profileCodex.baseUrl ?? '(default)'} — config at ${home}${previousHome && previousHome !== home ? ` (replaces CODEX_HOME=${previousHome})` : ''}`);
    }

    // A profile can also arrive with a user message (the App sends it every time). Codex reads its
    // provider at process start, so a change means rewriting the managed home and reconnecting the
    // app-server. The signature is over the endpoint itself: a profile edit that changes nothing
    // Codex consumes must not restart it.
    const CODEX_PROFILE_KEYS = ['CODEX_BASE_URL', 'CODEX_API_KEY', 'CODEX_MODEL'] as const;
    const profileEnvSignature = (env: Record<string, string | undefined>): string =>
        CODEX_PROFILE_KEYS.map((key) => `${key}=${env[key] ?? ''}`).join('\0');
    let pendingProfileEnv: Record<string, string> | undefined;
    let appliedProfileKeys: string[] = [];
    let appliedProfileSignature = profileEnvSignature(process.env);

    const applyProfileEnv = async (env: Record<string, string>): Promise<void> => {
        // A key the previous profile set and this one omits must not linger in the process.
        for (const key of appliedProfileKeys) {
            if (!(key in env)) delete process.env[key];
        }
        for (const [key, value] of Object.entries(env)) process.env[key] = value;
        appliedProfileKeys = Object.keys(env);

        const next = readProfileCodexConfig(process.env);
        if (!next) return;
        const home = writeProfileCodexHome(configuration.happyHomeDir, sessionTag, {
            ...next,
            ...(next.model ? { model: resolveCodexModel(next.model) } : {}),
        });
        process.env.CODEX_HOME = home;
        logger.info(`[codex] profile endpoint changed — config at ${home}`);
    };

    const api = await ApiClient.create(opts.credentials);

    // Log startup options
    logger.debug(`[codex] Starting with options: startedBy=${opts.startedBy || 'terminal'}`);

    //
    // Machine
    //

    const settings = await readSettings();
    let machineId = settings?.machineId;
    const sandboxConfig = opts.noSandbox ? undefined : (opts.sandboxOverride ?? settings?.sandboxConfig);
    if (!machineId) {
        console.error(`[START] No machine ID found in settings, which is unexpected since authAndSetupMachineIfNeeded should have created it. Please report this issue on https://github.com/slopus/happy-cli/issues`);
        process.exit(1);
    }
    logger.debug(`Using machineId: ${machineId}`);

    //
    // Create session
    //

    const { state, metadata } = createSessionMetadata({
        flavor: 'codex',
        machineId,
        startedBy: opts.startedBy,
        sessionTag,
        sandbox: sandboxConfig,
    });

    // When started by the daemon, the machine is already registered — skip the redundant call.
    // Otherwise, parallelize machine registration and session creation since they are independent.
    const [, response] = await Promise.all([
        opts.startedBy === 'daemon'
            ? Promise.resolve(null)
            : api.getOrCreateMachine({ machineId, metadata: initialMachineMetadata }),
        api.getOrCreateSession({ tag: sessionTag, site: machineId, metadata, state }),
    ]);

    // Handle server unreachable case - create offline stub with hot reconnection
    let session: ApiSessionClient;
    // Permission handler declared here so it can be updated in onSessionSwap callback
    // (assigned later at line ~385 after client setup)
    let permissionHandler: CodexPermissionHandler;
    const { session: initialSession, reconnectionHandle } = setupOfflineReconnection({
        api,
        sessionTag,
        metadata,
        state,
        response,
        site: machineId,
        initialLastSeq: opts.resumeAfterSeq,
        onSessionSwap: (newSession) => {
            session = newSession;
            // Update permission handler with new session to avoid stale reference
            if (permissionHandler) {
                permissionHandler.updateSession(newSession);
            }
            // Re-register run-specific RPC handlers so kill/abort work after reconnect
            newSession.rpcHandlerManager.registerHandler('abort', handleAbort);
            registerKillSessionHandler(newSession.rpcHandlerManager, handleKillSession);
        }
    });
    session = initialSession;
    writeSessionPidFile(session.sessionId);

    // Announce that this session can be served over the LAN/relay. The App has to know before it
    // picks a channel, and it cannot ask over the LAN without already being on it; agentState
    // travels by the server, so it arrives in time. Claude sessions have said this all along —
    // without it a Codex session stayed on the server channel even with its socket connected.
    session.updateAgentState((state) => ({ ...state, lanSocket: true }));

    // Report to daemon (once at start; also retry periodically so daemon sees us if it wasn't running at start)
    const DAEMON_REPORT_INTERVAL_MS = 60_000;
    const reportToDaemon = () => {
        if (!response) return;
        notifyDaemonSessionStarted(session.sessionId, { ...metadata, hostPid: process.pid, sessionTag }).then((result) => {
            if (result?.error) logger.debug(`[START] Daemon report failed:`, result.error);
        }).catch((err) => logger.debug('[START] Daemon report error:', err));
    };
    reportToDaemon();
    setInterval(reportToDaemon, DAEMON_REPORT_INTERVAL_MS);

    // The daemon's LAN and relay readers reach a session through this socket: it registers the
    // session with them, mirrors the log they page, and routes messages they send. Codex sessions
    // used to start without it, so only the server channel could reach them.
    const stopSocketClient = startUnixSocketClient({
        sessionId: session.sessionId,
        pid: process.pid,
        sessionTag,
        metadata,
    }, reportToDaemon, (payload) => {
        const delivered = session.deliverLanUserMessage(payload);
        logger.debug(`[START] LAN user message ${delivered ? 'routed' : 'rejected (did not decrypt)'}`);
        reportLanDelivery(payload.localId, delivered);
    }, (rpc) => {
        void session.rpcHandlerManager.handleRequest({
            method: `${session.sessionId}:${rpc.method}`,
            params: rpc.params ?? '',
        });
    }, () => session.getPresence());
    process.on('beforeExit', () => stopSocketClient());
    process.on('exit', () => stopSocketClient());

    const messageQueue = new MessageQueue2<EnhancedMode>((mode) => hashObject({
        permissionMode: mode.permissionMode,
        model: mode.model,
    }));

    // Track current overrides to apply per message
    // Use shared PermissionMode type from api/types for cross-agent compatibility
    let currentPermissionMode: import('@/api/types').PermissionMode | undefined = undefined;
    let currentModel: string | undefined = undefined;

    let handleUserMessage: ((message: UserMessage) => void) | null = null;
    handleUserMessage = (message) => {
        const profileEnv = message.meta?.environmentVariables as Record<string, string> | undefined;
        if (profileEnv) {
            pendingProfileEnv = profileEnv;
        }
        // Resolve permission mode (accept all modes, will be mapped in switch statement)
        let messagePermissionMode = currentPermissionMode;
        if (message.meta?.permissionMode) {
            messagePermissionMode = message.meta.permissionMode as import('@/api/types').PermissionMode;
            currentPermissionMode = messagePermissionMode;
            logger.debug(`[Codex] Permission mode updated from user message to: ${currentPermissionMode}`);
        } else {
            logger.debug(`[Codex] User message received with no permission mode override, using current: ${currentPermissionMode ?? 'default (effective)'}`);
        }

        // Resolve model; explicit null resets to default (undefined)
        let messageModel = currentModel;
        if (message.meta?.hasOwnProperty('model')) {
            messageModel = message.meta.model || undefined;
            currentModel = messageModel;
            logger.debug(`[Codex] Model updated from user message: ${messageModel || 'reset to default'}`);
        } else {
            logger.debug(`[Codex] User message received with no model override, using current: ${currentModel || 'default'}`);
        }

        const enhancedMode: EnhancedMode = {
            permissionMode: messagePermissionMode || 'default',
            model: messageModel,
        };
        const isA2A = (message.meta as { origin?: string } | undefined)?.origin === 'a2a';
        if (isA2A) {
            messageQueue.pushIsolated(getUserMessageText(message), enhancedMode);
        } else {
            messageQueue.push(getUserMessageText(message), enhancedMode);
        }
    };
    session.onUserMessage(handleUserMessage);
    let thinking = false;
    let currentTurnId: string | null = null;
    let codexStartedSubagents = new Set<string>();
    let codexActiveSubagents = new Set<string>();
    let codexProviderSubagentToSessionSubagent = new Map<string, string>();

    const sendReady = () => {
        session.sendSessionEvent({ type: 'ready' });
        try {
            api.push().sendToAllDevices(
                "It's ready!",
                'Codex is waiting for your command',
                { sessionId: session.sessionId }
            );
        } catch (pushError) {
            logger.debug('[Codex] Failed to send ready push', pushError);
        }
    };

    // Debug helper: log active handles/requests if DEBUG is enabled
    function logActiveHandles(tag: string) {
        if (!process.env.DEBUG) return;
        const anyProc: any = process as any;
        const handles = typeof anyProc._getActiveHandles === 'function' ? anyProc._getActiveHandles() : [];
        const requests = typeof anyProc._getActiveRequests === 'function' ? anyProc._getActiveRequests() : [];
        logger.debug(`[codex][handles] ${tag}: handles=${handles.length} requests=${requests.length}`);
        try {
            const kinds = handles.map((h: any) => (h && h.constructor ? h.constructor.name : typeof h));
            logger.debug(`[codex][handles] kinds=${JSON.stringify(kinds)}`);
        } catch { }
    }

    //
    // Abort handling
    // IMPORTANT: There are two different operations:
    // 1. Abort (handleAbort): Stops the current inference/task but keeps the session alive
    //    - Used by the 'abort' RPC from mobile app
    //    - Similar to Claude Code's abort behavior
    //    - Allows continuing with new prompts after aborting
    // 2. Kill (handleKillSession): Terminates the entire process
    //    - Used by the 'killSession' RPC
    //    - Completely exits the CLI process
    //

    let abortController = new AbortController();
    let shouldExit = false;

    /**
     * Handles aborting the current task/inference without exiting the process.
     * This is the equivalent of Claude Code's abort - it stops what's currently
     * happening but keeps the session alive for new prompts.
     */
    async function handleAbort() {
        logger.debug('[Codex] Abort requested - stopping current task');
        try {
            // Stop the turn; the thread and its context survive for the next prompt.
            await client.interruptTurn();
            abortController.abort();
            reasoningProcessor.abort();
            logger.debug('[Codex] Abort completed - session remains active');
        } catch (error) {
            logger.debug('[Codex] Error during abort:', error);
        } finally {
            abortController = new AbortController();
        }
    }

    /**
     * Handles session termination and process exit.
     * This is called when the session needs to be completely killed (not just aborted).
     * Abort stops the current inference but keeps the session alive.
     * Kill terminates the entire process.
     */
    const handleKillSession = async (pause = false) => {
        logger.debug(`[Codex] Kill session requested (pause=${pause})`);
        removeSessionPidFile();
        await handleAbort();
        logger.debug('[Codex] Abort completed, proceeding with termination');

        const exitReason = exitSignalName ? `signal: ${exitSignalName}` : (pause ? 'paused' : 'killed by app (RPC)');
        try {
            if (session) {
                if (pause) {
                    await session.updateMetadata((currentMetadata) => ({
                        ...currentMetadata,
                        lifecycleState: 'paused',
                        lifecycleStateSince: Date.now(),
                    }));
                } else {
                    await session.updateMetadata((currentMetadata) => ({
                        ...currentMetadata,
                        lifecycleState: 'archived',
                        lifecycleStateSince: Date.now(),
                        archivedBy: 'cli',
                        archiveReason: 'User terminated'
                    }));
                    session.sendSessionDeath();
                }
                await session.flush();
                await session.close();
            }

            try {
                await client.disconnect();
            } catch (e) {
                logger.debug('[Codex] Error while force closing Codex session during termination', e);
            }

            stopCaffeinate();
            happyServer.stop();

            logger.debug('[Codex] Session termination complete, exiting');
            await notifyDaemonSessionEnding(session.sessionId, process.pid, exitReason, 0, !pause);
            process.exit(0);
        } catch (error) {
            logger.debug('[Codex] Error during session termination:', error);
            await notifyDaemonSessionEnding(session.sessionId, process.pid, `${exitReason} (cleanup error: ${error instanceof Error ? error.message : String(error)})`, 1, !pause);
            process.exit(1);
        }
    };

    session.rpcHandlerManager.registerHandler('abort', handleAbort);
    // App RPC kill: permanent archive (pause=false)
    registerKillSessionHandler(session.rpcHandlerManager, () => handleKillSession(false));

    // Signal handlers: pause so session can be resumed (pause=true)
    let exitHandled = false;
    let exitSignalName: string | null = null;
    const onExitSignal = (sig: string) => {
        exitSignalName = sig;
        if (exitHandled) return;
        exitHandled = true;
        void handleKillSession(true);
    };
    process.on('SIGTERM', () => onExitSignal('SIGTERM'));
    process.on('SIGINT', () => onExitSignal('SIGINT'));
    process.on('SIGHUP', () => onExitSignal('SIGHUP'));

    //
    // Initialize Ink UI
    //

    const messageBuffer = new MessageBuffer();
    const hasTTY = process.stdout.isTTY && process.stdin.isTTY;
    let inkInstance: any = null;

    if (hasTTY) {
        console.clear();
        inkInstance = render(React.createElement(CodexDisplay, {
            messageBuffer,
            logPath: process.env.DEBUG ? logger.getLogPath() : undefined,
            onExit: async () => {
                // Exit the agent
                logger.debug('[codex]: Exiting agent via Ctrl-C');
                shouldExit = true;
                await handleAbort();
            }
        }), {
            exitOnCtrlC: false,
            patchConsole: false
        });
    }

    if (hasTTY) {
        process.stdin.resume();
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
        }
        process.stdin.setEncoding("utf8");
    }

    //
    // Start Context 
    //

    const client = new CodexAppServerClient(sandboxConfig);

    // Codex's own conversation lives in its thread. The id is how a restarted process picks the
    // same one up; nothing outside this machine needs it, so it is kept beside Happy's state.
    const threadIdPath = join(configuration.happyHomeDir, 'codex-threads', `${sessionTag}.txt`);
    function readStoredThreadId(): string | null {
        try {
            const value = fs.readFileSync(threadIdPath, 'utf8').trim();
            return value || null;
        } catch {
            return null;
        }
    }
    function storeThreadId(threadId: string): void {
        try {
            fs.mkdirSync(dirname(threadIdPath), { recursive: true });
            fs.writeFileSync(threadIdPath, threadId, { mode: 0o600 });
        } catch (error) {
            logger.debug('[Codex] Failed to store thread id', error);
        }
    }

    // The App's picker is metadata-driven: publish the stable tier keys and which one this
    // session is on. A tier's concrete model is decided here (see modelTiers.ts).
    let publishedModelKey: string | null = null;
    const publishModelCatalog = (model: string | undefined) => {
        const code = currentTierCode(model);
        if (publishedModelKey === code) return;
        publishedModelKey = code;
        void session.updateMetadata((metadata) => ({
            ...metadata,
            models: codexModelOptions(),
            currentModelCode: code,
        })).catch((error) => logger.debug('[Codex] Failed to publish model catalog', error));
    };

    permissionHandler = new CodexPermissionHandler(session);
    const reasoningProcessor = new ReasoningProcessor((message) => {
        const envelopes = mapCodexProcessorMessageToSessionEnvelopes(message, { currentTurnId });
        for (const envelope of envelopes) {
            session.sendSessionProtocolMessage(envelope);
        }
    });
    const diffProcessor = new DiffProcessor((message) => {
        const envelopes = mapCodexProcessorMessageToSessionEnvelopes(message, { currentTurnId });
        for (const envelope of envelopes) {
            session.sendSessionProtocolMessage(envelope);
        }
    });
    // App-server asks for approvals as server→client RPCs; route them through the same
    // permission handler the App already drives (agent state + the permission RPC), and hand
    // back the decision in the wire vocabulary our handler speaks.
    client.setApprovalHandler(async (params) => {
        const toolName = params.type === 'exec'
            ? 'CodexBash'
            : params.type === 'patch'
                ? 'CodexPatch'
                : (params.toolName ?? 'McpTool');
        const input = params.type === 'exec'
            ? { command: params.command, cwd: params.cwd }
            : params.type === 'patch'
                ? { changes: params.fileChanges }
                : (params.input ?? {});
        try {
            const result = await permissionHandler.handleToolCall(params.callId, toolName, input);
            logger.debug('[Codex] Permission result:', result.decision);
            return result.decision;
        } catch (error) {
            logger.debug('[Codex] Error handling permission:', error);
            return 'denied';
        }
    });
    client.setEventHandler((raw) => {
        const msg = raw as any;
        logger.debug(`[Codex] event: ${JSON.stringify(msg)}`);

        // Add messages to the ink UI buffer based on message type
        if (msg.type === 'agent_message') {
            messageBuffer.addMessage(msg.message, 'assistant');
        } else if (msg.type === 'agent_reasoning_delta') {
            // Skip reasoning deltas in the UI to reduce noise
        } else if (msg.type === 'agent_reasoning') {
            messageBuffer.addMessage(`[Thinking] ${msg.text.substring(0, 100)}...`, 'system');
        } else if (msg.type === 'exec_command_begin') {
            messageBuffer.addMessage(`Executing: ${msg.command}`, 'tool');
        } else if (msg.type === 'exec_command_end') {
            const output = msg.output || msg.error || 'Command completed';
            const truncatedOutput = output.substring(0, 200);
            messageBuffer.addMessage(
                `Result: ${truncatedOutput}${output.length > 200 ? '...' : ''}`,
                'result'
            );
        } else if (msg.type === 'task_started') {
            messageBuffer.addMessage('Starting task...', 'status');
        } else if (msg.type === 'task_complete') {
            messageBuffer.addMessage('Task completed', 'status');
            sendReady();
        } else if (msg.type === 'turn_aborted') {
            messageBuffer.addMessage('Turn aborted', 'status');
            sendReady();
        } else if (msg.type === 'error') {
            const text = typeof msg.message === 'string' && msg.message.length > 0
                ? msg.message
                : 'Codex reported an error';
            messageBuffer.addMessage(`Error: ${text}`, 'status');
            session.sendSessionEvent({ type: 'message', message: text });
        }

        if (msg.type === 'task_started') {
            if (!thinking) {
                logger.debug('thinking started');
                thinking = true;
                session.setThinking(thinking);
            }
        }
        if (msg.type === 'task_complete' || msg.type === 'turn_aborted') {
            if (thinking) {
                logger.debug('thinking completed');
                thinking = false;
                session.setThinking(thinking);
            }
            // Reset diff processor on task end or abort
            diffProcessor.reset();
        }
        if (msg.type === 'agent_reasoning_section_break') {
            // Reset reasoning processor for new section
            reasoningProcessor.handleSectionBreak();
        }
        if (msg.type === 'agent_reasoning_delta') {
            // Process reasoning delta - tool calls are sent automatically via callback
            reasoningProcessor.processDelta(msg.delta);
        }
        if (msg.type === 'agent_reasoning') {
            // Complete the reasoning section - tool results or reasoning messages sent via callback
            reasoningProcessor.complete(msg.text);
        }
        if (msg.type === 'patch_apply_begin') {
            // Handle the start of a patch operation
            const { changes } = msg;

            // Add UI feedback for patch operation
            const changeCount = Object.keys(changes).length;
            const filesMsg = changeCount === 1 ? '1 file' : `${changeCount} files`;
            messageBuffer.addMessage(`Modifying ${filesMsg}...`, 'tool');
        }
        if (msg.type === 'patch_apply_end') {
            // Handle the end of a patch operation
            const { stdout, stderr, success } = msg;

            // Add UI feedback for completion
            if (success) {
                const message = stdout || 'Files modified successfully';
                messageBuffer.addMessage(message.substring(0, 200), 'result');
            } else {
                const errorMsg = stderr || 'Failed to modify files';
                messageBuffer.addMessage(`Error: ${errorMsg.substring(0, 200)}`, 'result');
            }
        }
        if (msg.type === 'turn_diff') {
            // Handle turn_diff messages and track unified_diff changes
            if (msg.unified_diff) {
                diffProcessor.processDiff(msg.unified_diff);
            }
        }

        // Convert Codex MCP events into the unified session-protocol envelope stream.
        // Reasoning deltas are handled by ReasoningProcessor to avoid duplicate text output.
        if (msg.type !== 'agent_reasoning_delta' && msg.type !== 'agent_reasoning' && msg.type !== 'agent_reasoning_section_break' && msg.type !== 'turn_diff') {
            const mapped = mapCodexMcpMessageToSessionEnvelopes(msg, {
                currentTurnId,
                startedSubagents: codexStartedSubagents,
                activeSubagents: codexActiveSubagents,
                providerSubagentToSessionSubagent: codexProviderSubagentToSessionSubagent,
            });
            currentTurnId = mapped.currentTurnId;
            codexStartedSubagents = mapped.startedSubagents;
            codexActiveSubagents = mapped.activeSubagents;
            codexProviderSubagentToSessionSubagent = mapped.providerSubagentToSessionSubagent;
            for (const envelope of mapped.envelopes) {
                session.sendSessionProtocolMessage(envelope);
            }
        }
    });

    // Start Happy MCP server (HTTP) and prepare STDIO bridge config for Codex
    const happyServer = await startHappyServer(() => session, {
        useDaemonA2ARoute: opts.startedBy === 'daemon',
        onA2aMessage: (message) => handleUserMessage?.(message),
        workspacePath: process.cwd(),
    });
    const bridgeCommand = join(projectPath(), 'bin', 'happy-mcp.mjs');
    const mcpServers = {
        happy: {
            command: bridgeCommand,
            args: ['--url', happyServer.url]
        }
    } as const;
    let first = true;

    try {
        logger.debug('[codex]: client.connect begin');
        await client.connect();
        logger.debug('[codex]: client.connect done');
        let pending: { message: string; mode: EnhancedMode; isolate: boolean; hash: string } | null = null;
        publishModelCatalog(undefined);

        while (!shouldExit) {
            logActiveHandles('loop-top');
            // Get next batch; respect mode boundaries like Claude
            let message: { message: string; mode: EnhancedMode; isolate: boolean; hash: string } | null = pending;
            pending = null;
            if (!message) {
                // Capture the current signal to distinguish idle-abort from queue close
                const waitSignal = abortController.signal;
                const batch = await messageQueue.waitForMessagesAndGetAsString(waitSignal);
                if (!batch) {
                    // If wait was aborted (e.g., remote abort with no active inference), ignore and continue
                    if (waitSignal.aborted && !shouldExit) {
                        logger.debug('[codex]: Wait aborted while idle; ignoring and continuing');
                        continue;
                    }
                    logger.debug(`[codex]: batch=${!!batch}, shouldExit=${shouldExit}`);
                    break;
                }
                message = batch;
            }

            // Defensive check for TS narrowing
            if (!message) {
                break;
            }

            // Display user messages in the UI
            messageBuffer.addMessage(message.message, 'user');

            try {
                // Map permission mode to approval policy and sandbox for startSession
                const sandboxManagedByHappy = client.sandboxEnabled;
                const executionPolicy = resolveCodexExecutionPolicy(
                    message.mode.permissionMode,
                    sandboxManagedByHappy,
                );

                if (pendingProfileEnv) {
                    const desiredSignature = profileEnvSignature({ ...process.env, ...pendingProfileEnv });
                    if (desiredSignature !== appliedProfileSignature) {
                        await applyProfileEnv(pendingProfileEnv);
                        appliedProfileSignature = desiredSignature;
                        // The provider is read when the app-server starts; restart it so the new
                        // profile's endpoint and key are the ones this turn uses.
                        await client.disconnect();
                        await client.connect();
                        logger.debug('[Codex] app-server reconnected for a profile change');
                    }
                }

                const model = resolveCodexModel(message.mode.model);
                publishModelCatalog(message.mode.model);

                if (!client.hasActiveThread()) {
                    const storedThreadId = readStoredThreadId();
                    if (storedThreadId) {
                        try {
                            await client.resumeThread({
                                threadId: storedThreadId,
                                model,
                                cwd: process.cwd(),
                                approvalPolicy: executionPolicy.approvalPolicy,
                                sandbox: executionPolicy.sandbox,
                                mcpServers,
                            });
                            logger.debug('[Codex] Resumed thread', storedThreadId);
                        } catch (error) {
                            logger.debug('[Codex] Resume failed; starting a new thread', error);
                        }
                    }
                    if (!client.hasActiveThread()) {
                        await client.startThread({
                            model,
                            cwd: process.cwd(),
                            approvalPolicy: executionPolicy.approvalPolicy,
                            sandbox: executionPolicy.sandbox,
                            mcpServers,
                        });
                    }
                    if (client.threadId) {
                        storeThreadId(client.threadId);
                    }
                }

                const prompt = first
                    ? message.message + '\n\n' + CHANGE_TITLE_INSTRUCTION
                    : message.message;
                first = false;
                const result = await client.sendTurnAndWait(prompt, {
                    model,
                    approvalPolicy: executionPolicy.approvalPolicy,
                    sandbox: executionPolicy.sandbox,
                });
                if (result.aborted) {
                    logger.debug('[Codex] Turn aborted');
                }
            } catch (error) {
                logger.warn('Error in codex session:', error);
                const isAbortError = error instanceof Error && error.name === 'AbortError';
                
                if (isAbortError) {
                    messageBuffer.addMessage('Aborted by user', 'status');
                    session.sendSessionEvent({ type: 'message', message: 'Aborted by user' });
                    // Abort cancels the current task/inference but keeps the Codex session alive.
                    // Do not clear session state here; the next user message should continue on the
                    // existing session if possible.
                } else {
                    messageBuffer.addMessage('Process exited unexpectedly', 'status');
                    session.sendSessionEvent({ type: 'message', message: 'Process exited unexpectedly' });
                }
            } finally {
                // Reset permission handler, reasoning processor, and diff processor
                permissionHandler.reset();
                reasoningProcessor.abort();  // Use abort to properly finish any in-progress tool calls
                diffProcessor.reset();
                thinking = false;
                session.setThinking(thinking);
                emitReadyIfIdle({
                    pending,
                    queueSize: () => messageQueue.size(),
                    shouldExit,
                    sendReady,
                });
                logActiveHandles('after-turn');
            }
        }

    } finally {
        // Clean up resources when main loop exits
        logger.debug('[codex]: Final cleanup start');
        removeSessionPidFile();
        logActiveHandles('cleanup-start');

        // Cancel offline reconnection if still running
        if (reconnectionHandle) {
            logger.debug('[codex]: Cancelling offline reconnection');
            reconnectionHandle.cancel();
        }

        try {
            // Pause: set paused state and close cleanly (no sendSessionDeath)
            await session.updateMetadata((currentMetadata) => ({
                ...currentMetadata,
                lifecycleState: 'paused',
                lifecycleStateSince: Date.now(),
            }));
            logger.debug('[codex]: flush begin');
            await session.flush();
            logger.debug('[codex]: flush done');
            logger.debug('[codex]: session.close begin');
            await session.close();
            logger.debug('[codex]: session.close done');
        } catch (e) {
            logger.debug('[codex]: Error while closing session', e);
        }
        logger.debug('[codex]: client.disconnect begin');
        await client.disconnect();
        logger.debug('[codex]: client.disconnect done');
        stopSocketClient();
        // Stop Happy MCP server
        logger.debug('[codex]: happyServer.stop');
        happyServer.stop();

        // Clean up ink UI
        if (process.stdin.isTTY) {
            logger.debug('[codex]: setRawMode(false)');
            try { process.stdin.setRawMode(false); } catch { }
        }
        // Stop reading from stdin so the process can exit
        if (hasTTY) {
            logger.debug('[codex]: stdin.pause()');
            try { process.stdin.pause(); } catch { }
        }
        if (inkInstance) {
            logger.debug('[codex]: inkInstance.unmount()');
            inkInstance.unmount();
        }
        messageBuffer.clear();

        logActiveHandles('cleanup-end');
        logger.debug('[codex]: Final cleanup completed');
    }
}
