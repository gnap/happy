import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { ApiClient } from '@/api/api';
import { logger } from '@/ui/logger';
import { loop } from '@/claude/loop';
import { AgentState, Metadata, getUserMessageText, getUserMessageFiles } from '@/api/types';
import type { UserMessage } from '@/api/types';
import { BUILD_VERSION } from '../version';
import { Credentials, readSettings, getProfileEnvironmentVariables, writeSessionPidFile, removeSessionPidFile, SandboxConfig } from '@/persistence';
import { EnhancedMode, PermissionMode, EffortLevel } from './loop';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import { startCaffeinate, stopCaffeinate } from '@/utils/caffeinate';
import { extractSDKMetadataAsync } from '@/claude/sdk/metadataExtractor';
import { parseSpecialCommand } from '@/parsers/specialCommands';
import { getEnvironmentInfo } from '@/ui/doctor';
import { configuration } from '@/configuration';
import { createEnvelope } from '@slopus/happy-wire';
import { notifyDaemonSessionStarted, notifyDaemonSessionEnding } from '@/daemon/controlClient';
import { startUnixSocketClient } from '@/daemon/unixSocketClient';
import { initialMachineMetadata } from '@/daemon/run';
import { startHappyServer } from '@/claude/utils/startHappyServer';
import { startHookServer } from '@/claude/utils/startHookServer';
import { generateHookSettingsFile, cleanupHookSettingsFile } from '@/claude/utils/generateHookSettings';
import { registerKillSessionHandler } from './registerKillSessionHandler';
import { projectPath } from '../projectPath';
import { detectWorktree } from '../utils/createSessionMetadata';
import { startOfflineReconnection, connectionState } from '@/utils/serverConnectionErrors';
import { claudeLocal } from '@/claude/claudeLocal';
import { createSessionScanner } from '@/claude/utils/sessionScanner';
import { Session } from './session';
import { applySandboxPermissionPolicy, resolveInitialClaudePermissionMode, resolveStoredSessionPermissionMode } from './utils/permissionMode';
import { claudeModelCodeForMetadata, normalizeClaudeModelForSdk } from './utils/model';
import { buildA2ATurnPromptForClaude } from '@/a2a/inbox';
import {
    createA2AInboxTurnController,
    isA2ATriggerMessage,
    pruneA2AInboxOnSessionStart,
} from '@/a2a/inboxTurnController';
import { applyProfileEnvToProcess, mergeProfileIntoEnv } from '@/utils/profileEnv';

/** JavaScript runtime to use for spawning Claude Code */
export type JsRuntime = 'node' | 'bun'

const CLAUDE_SESSION_KEY_FILE = 'claude-session-key';

function getClaudeSessionKeyPaths(sessionTag: string): string[] {
    return [
        join(configuration.happyHomeDir, `${CLAUDE_SESSION_KEY_FILE}-${sessionTag}`),
        join(configuration.happyHomeDir, CLAUDE_SESSION_KEY_FILE),
    ];
}

function readClaudeSessionEncryptionKey(sessionTag: string): Uint8Array | undefined {
    for (const keyPath of getClaudeSessionKeyPaths(sessionTag)) {
        try {
            if (!existsSync(keyPath)) continue;
            const raw = readFileSync(keyPath, 'utf8').trim();
            if (!raw) continue;
            return new Uint8Array(Buffer.from(raw, 'base64'));
        } catch (error) {
            logger.debug('[CLAUDE] Failed to read session encryption key', { keyPath, error });
        }
    }
    return undefined;
}

function writeClaudeSessionEncryptionKey(sessionTag: string, key: Uint8Array): void {
    const encodedKey = Buffer.from(key).toString('base64');
    for (const keyPath of getClaudeSessionKeyPaths(sessionTag)) {
        try {
            writeFileSync(keyPath, encodedKey, 'utf8');
        } catch (error) {
            logger.debug('[CLAUDE] Failed to persist session encryption key', { keyPath, error });
        }
    }
}

export interface StartOptions {
    model?: string
    permissionMode?: PermissionMode
    /** Claude Code effort level (low, medium, high, xhigh, max). Default: medium. */
    effort?: EffortLevel
    startingMode?: 'local' | 'remote'
    shouldStartDaemon?: boolean
    claudeEnvVars?: Record<string, string>
    claudeArgs?: string[]
    startedBy?: 'daemon' | 'terminal'
    noSandbox?: boolean
    /** Per-session sandbox config override (from daemon --sandbox-config flag). Takes priority over settings.json. */
    sandboxOverride?: SandboxConfig
    /** Explicit session tag to resume when daemon respawns this Claude process. */
    resumeSessionTag?: string
    /** Pre-wake server seq from daemon poll (fetch messages with seq > this value). */
    resumeAfterSeq?: number
    /** JavaScript runtime to use for spawning Claude Code (default: 'node') */
    jsRuntime?: JsRuntime
}

export async function runClaude(credentials: Credentials, options: StartOptions = {}): Promise<void> {
    logger.debug(`[CLAUDE] ===== CLAUDE MODE STARTING =====`);
    logger.debug(`[CLAUDE] This is the Claude agent, NOT Gemini`);
    
    const workingDirectory = process.cwd();
    const sessionTag = options.resumeSessionTag?.trim() || randomUUID();

    // Log environment info at startup
    logger.debugLargeJson('[START] Happy process started', getEnvironmentInfo());
    logger.debug(`[START] Options: startedBy=${options.startedBy}, startingMode=${options.startingMode}`);

    // Validate daemon spawn requirements - fail fast on invalid config
    if (options.startedBy === 'daemon' && options.startingMode === 'local') {
        throw new Error('Daemon-spawned sessions cannot use local/interactive mode. Use --happy-starting-mode remote or spawn sessions directly from terminal.');
    }

    // Set backend for offline warnings (before any API calls)
    connectionState.setBackend('Claude');

    // Create session service
    const api = await ApiClient.create(credentials);
    const existingEncryptionKey = readClaudeSessionEncryptionKey(sessionTag);

    // Create a new session
    let state: AgentState = {};

    // Get machine ID from settings (should already be set up)
    const settings = await readSettings();
    let machineId = settings?.machineId
    // Priority: --no-sandbox > --sandbox-config (per-session from daemon) > settings.json
    // Mutable: user messages may change sandbox isolation at runtime without restart.
    let sandboxConfig = options.noSandbox ? undefined : (options.sandboxOverride ?? settings?.sandboxConfig);
    let sandboxEnabled = Boolean(sandboxConfig?.enabled);
    let initialPermissionMode = applySandboxPermissionPolicy(
        resolveInitialClaudePermissionMode(options.permissionMode, options.claudeArgs),
        sandboxEnabled,
    );
    const dangerouslySkipPermissions =
        initialPermissionMode === 'bypassPermissions' ||
        initialPermissionMode === 'yolo' ||
        sandboxEnabled ||
        Boolean(options.claudeArgs?.includes('--dangerously-skip-permissions'));
    if (!machineId) {
        console.error(`[START] No machine ID found in settings, which is unexpected since authAndSetupMachineIfNeeded should have created it. Please report this issue on https://github.com/slopus/happy-cli/issues`);
        process.exit(1);
    }
    logger.debug(`Using machineId: ${machineId}`);

    const worktree = detectWorktree(workingDirectory);
    let metadata: Metadata = {
        path: workingDirectory,
        host: os.hostname(),
        version: BUILD_VERSION,
        os: os.platform(),
        machineId: machineId,
        homeDir: os.homedir(),
        happyHomeDir: configuration.happyHomeDir,
        happyLibDir: projectPath(),
        happyToolsDir: resolve(projectPath(), 'tools', 'unpacked'),
        startedFromDaemon: options.startedBy === 'daemon',
        hostPid: process.pid,
        sessionTag,
        startedBy: options.startedBy || 'terminal',
        // Initialize lifecycle state
        lifecycleState: 'running',
        lifecycleStateSince: Date.now(),
        flavor: 'claude',
        sandbox: sandboxConfig?.enabled ? sandboxConfig : null,
        dangerouslySkipPermissions,
        ...(worktree ? {
            projectPath: worktree.projectPath,
            branchName: worktree.branchName,
            isWorktree: worktree.isWorktree,
        } : {}),
    };

    // When started by the daemon, the machine is already registered — skip the redundant call.
    // Otherwise, parallelize machine registration and session creation since they are independent.
    const [, response] = await Promise.all([
        options.startedBy === 'daemon'
            ? Promise.resolve(null)
            : api.getOrCreateMachine({ machineId, metadata: initialMachineMetadata }),
        api.getOrCreateSession({ tag: sessionTag, metadata, state, existingEncryptionKey }),
    ]);

    // Handle server unreachable case - run Claude locally with hot reconnection
    // Note: connectionState.notifyOffline() was already called by api.ts with error details
    if (!response) {
        let offlineSessionId: string | null = null;

        const reconnection = startOfflineReconnection({
            serverUrl: configuration.serverUrl,
            onReconnected: async () => {
                const resp = await api.getOrCreateSession({ tag: randomUUID(), metadata, state });
                if (!resp) throw new Error('Server unavailable');
                const session = api.sessionSyncClient(resp);
                const scanner = await createSessionScanner({
                    sessionId: null,
                    workingDirectory,
                    onMessage: (msg) => session.sendClaudeSessionMessage(msg)
                });
                if (offlineSessionId) scanner.onNewSession(offlineSessionId);
                return { session, scanner };
            },
            onNotify: console.log,
            onCleanup: () => {
                // Scanner cleanup handled automatically when process exits
            }
        });

        try {
            await claudeLocal({
                path: workingDirectory,
                sessionId: null,
                onSessionFound: (id) => { offlineSessionId = id; },
                onThinkingChange: () => {},
                abort: new AbortController().signal,
                claudeEnvVars: options.claudeEnvVars,
                claudeArgs: options.claudeArgs,
                mcpServers: {},
                allowedTools: [],
                sandboxConfig,
            });
        } finally {
            reconnection.cancel();
            stopCaffeinate();
        }
        process.exit(0);
    }

    logger.debug(`Session created: ${response.id}`);
    writeClaudeSessionEncryptionKey(sessionTag, response.encryptionKey);
    const restoredPermissionMode = resolveStoredSessionPermissionMode(
        response.metadata?.currentOperatingModeCode,
        initialPermissionMode,
        sandboxEnabled,
    );
    if (restoredPermissionMode !== undefined) {
        initialPermissionMode = restoredPermissionMode;
        logger.debug(
            `[START] Restored permission mode from session metadata `
            + `(stored=${response.metadata?.currentOperatingModeCode ?? 'none'}, effective=${initialPermissionMode})`,
        );
    }
    const initialClaudeSessionId = response.metadata?.claudeSessionId ?? null;
    if (initialClaudeSessionId) {
        logger.debug(`[START] Restoring Claude session ID from metadata: ${initialClaudeSessionId}`);
    }

    // Report to daemon on startup and every 60s so daemon re-discovers sessions after restart
    const reportToDaemon = () => {
        notifyDaemonSessionStarted(response.id, metadata).then((result) => {
            if (result?.error) logger.debug(`[START] Daemon report failed:`, result.error);
        }).catch((err) => logger.debug('[START] Daemon report error:', err));
    };
    reportToDaemon();
    setInterval(reportToDaemon, 60_000);

    // Connect to daemon's Unix socket for real-time IPC (registration + heartbeat).
    // Falls back to HTTP webhook (above) when socket is unavailable.
    const stopSocketClient = startUnixSocketClient({
        sessionId: response.id,
        pid: process.pid,
        sessionTag,
        metadata,
    }, reportToDaemon);
    // Cleanup socket on graceful exit
    process.on('beforeExit', () => stopSocketClient());
    process.on('exit', () => stopSocketClient());

    // Extract SDK metadata in background and update session when ready.
    // The callback fires asynchronously after extractSDKMetadata completes, so `session`
    // (declared below) is already initialized by the time this runs.
    extractSDKMetadataAsync((sdkMetadata) => {
        logger.debug('[start] SDK metadata extracted, updating session:', sdkMetadata);
        session.updateMetadata((currentMetadata) => ({
            ...currentMetadata,
            tools: sdkMetadata.tools,
            slashCommands: sdkMetadata.slashCommands,
        })).then(() => {
            logger.debug('[start] Session metadata updated with SDK capabilities');
        }).catch((err: unknown) => {
            logger.debug('[start] Failed to update session metadata:', err);
        });
    });

    // Create realtime session
    const sessionClientOpts = options.resumeAfterSeq !== undefined
        ? { initialLastSeq: options.resumeAfterSeq }
        : undefined;
    const session = api.sessionSyncClient(response, true, sessionClientOpts);
    writeSessionPidFile(session.sessionId);

    // Resume ignores new metadata (server returns stored). Explicitly sync sandbox
    // so restart-with-sandbox correctly updates the session's isolation level.
    if (sandboxConfig?.enabled) {
        session.updateMetadata((current) => ({ ...current, sandbox: sandboxConfig }))
            .catch((err: unknown) => logger.debug('[START] Failed to sync sandbox to session metadata:', err));
    }

    let handleUserMessage: ((message: UserMessage) => Promise<void>) | null = null;
    let isA2AInboxTurnActiveFn: () => boolean = () => false;
    let describeInboxMcpScopeFn: () => string = () => 'empty';

    // Start Happy MCP server
    const happyServer = await startHappyServer(() => session, {
        useDaemonA2ARoute: options.startedBy === 'daemon',
        onA2aMessage: (message) => handleUserMessage?.(message),
        isA2AInboxTurnActive: () => isA2AInboxTurnActiveFn(),
        describeInboxMcpScope: () => describeInboxMcpScopeFn(),
        workspacePath: workingDirectory,
    });
    logger.debug(`[START] Happy MCP server started at ${happyServer.url}`);

    // Variable to track current session instance (updated via onSessionReady callback)
    // Used by hook server to notify Session when Claude changes session ID
    let currentSession: Session | null = null;

    // Start Hook server for receiving Claude session notifications
    const hookServer = await startHookServer({
        onSessionHook: (sessionId, data) => {
            logger.debug(`[START] Session hook received: ${sessionId}`, data);

            // Update session ID in the Session instance
            if (currentSession) {
                const previousSessionId = currentSession.sessionId;
                if (previousSessionId !== sessionId) {
                    logger.debug(`[START] Claude session ID changed: ${previousSessionId} -> ${sessionId}`);
                    currentSession.onSessionFound(sessionId);
                }
            }
        }
    });
    logger.debug(`[START] Hook server started on port ${hookServer.port}`);

    // Generate hook settings file for Claude
    const hookSettingsPath = generateHookSettingsFile(hookServer.port);
    logger.debug(`[START] Generated hook settings file: ${hookSettingsPath}`);

    // Print log file path
    const logPath = logger.logFilePath;
    logger.infoDeveloper(`Session: ${response.id}`);
    logger.infoDeveloper(`Logs: ${logPath}`);

    // Set initial agent state
    session.updateAgentState((currentState) => ({
        ...currentState,
        controlledByUser: options.startingMode !== 'remote'
    }));

    // Start caffeinate to prevent sleep on macOS
    const caffeinateStarted = startCaffeinate();
    if (caffeinateStarted) {
        logger.infoDeveloper('Sleep prevention enabled (macOS)');
    }

    // Import MessageQueue2 and create message queue
    const messageQueue = new MessageQueue2<EnhancedMode>(mode => hashObject({
        isPlan: mode.permissionMode === 'plan',
        model: mode.model,
        fallbackModel: mode.fallbackModel,
        effort: mode.effort,
        customSystemPrompt: mode.customSystemPrompt,
        appendSystemPrompt: mode.appendSystemPrompt,
        allowedTools: mode.allowedTools,
        disallowedTools: mode.disallowedTools,
        sandboxIsolation: mode.sandboxIsolation,
    }));

    // Forward messages to the queue
    // Permission modes: Use the unified 7-mode type, mapping happens at SDK boundary in claudeRemote.ts
    let currentPermissionMode: PermissionMode | undefined = initialPermissionMode;
    let currentModel = normalizeClaudeModelForSdk(options.model); // Track current model state
    let currentFallbackModel: string | undefined = undefined; // Track current fallback model
    let currentEffort: EffortLevel = options.effort ?? 'medium';
    let currentCustomSystemPrompt: string | undefined = undefined; // Track current custom system prompt
    let currentAppendSystemPrompt: string | undefined = undefined; // Track current append system prompt
    let currentAllowedTools: string[] | undefined = undefined; // Track current allowed tools
    let currentDisallowedTools: string[] | undefined = undefined; // Track current disallowed tools
    let currentProfileId: string | null | undefined = undefined; // Track current env profile id for change detection
    const daemonClaudeEnvVars: Record<string, string> = (() => {
        const explicit = options.claudeEnvVars;
        if (explicit && Object.keys(explicit).length > 0) return { ...explicit };
        // Fallback: capture profile-managed keys from process.env at startup
        const fromEnv: Record<string, string> = {};
        for (const [key, value] of Object.entries(process.env)) {
            if (value !== undefined && (key.startsWith('ANTHROPIC_') || key.startsWith('CLAUDE_CODE_'))) {
                fromEnv[key] = value;
            }
        }
        return fromEnv;
    })();
    let currentClaudeEnvVars: Record<string, string> = { ...daemonClaudeEnvVars };
    const claudeTurnActiveRef = { current: false };
    const currentEnhancedMode = (): EnhancedMode => ({
        permissionMode: currentPermissionMode || 'default',
        model: currentModel,
        fallbackModel: currentFallbackModel,
        effort: currentEffort,
        customSystemPrompt: currentCustomSystemPrompt,
        appendSystemPrompt: currentAppendSystemPrompt,
        allowedTools: currentAllowedTools,
        disallowedTools: currentDisallowedTools,
        sandboxIsolation: sandboxEnabled ? (sandboxConfig?.sessionIsolation ?? 'workspace') : 'off',
    });
    const a2aInbox = createA2AInboxTurnController({
        logTag: 'claude',
        messageQueue,
        session,
        getMode: () => {
            const mode = currentEnhancedMode();
            if (mode.model) return mode;
            // currentModel not yet set (e.g., inbox fires before the first user
            // message arrives). Fall back to session metadata currentModelCode
            // (persisted from the last turn) so inbox turns use the same model
            // the session was already running rather than the profile's
            // ANTHROPIC_MODEL default.
            const persistedModel = normalizeClaudeModelForSdk(session.getMetadata()?.currentModelCode);
            return persistedModel ? { ...mode, model: persistedModel } : mode;
        },
        isAgentTurnActive: () => claudeTurnActiveRef.current,
        workspacePath: workingDirectory,
        sessionId: session.sessionId,
        buildTurnPrompt: buildA2ATurnPromptForClaude,
        scheduleCompactTurn: (mode) => messageQueue.pushIsolateAndClear('', mode),
    });
    isA2AInboxTurnActiveFn = a2aInbox.isInboxMcpAllowed;
    describeInboxMcpScopeFn = a2aInbox.describeInboxMcpScope;
    pruneA2AInboxOnSessionStart('claude', workingDirectory, session.sessionId, options.startedBy === 'daemon');
    a2aInbox.peekInbox();


    handleUserMessage = async (message) => {

        // Resolve permission mode from meta - pass through as-is, mapping happens at SDK boundary
        let messagePermissionMode: PermissionMode | undefined = currentPermissionMode;
        if (message.meta?.permissionMode) {
            messagePermissionMode = applySandboxPermissionPolicy(message.meta.permissionMode, sandboxEnabled);
            currentPermissionMode = messagePermissionMode;
            logger.debug(`[loop] Permission mode updated from user message to: ${currentPermissionMode}`);
            currentSession?.syncPermissionMode?.(currentPermissionMode || 'default');
        } else {
            logger.debug(`[loop] User message received with no permission mode override, using current: ${currentPermissionMode}`);
        }

        // Resolve model - use message.meta.model if provided, otherwise use current model
        let messageModel = currentModel;
        if (message.meta?.hasOwnProperty('model')) {
            messageModel = normalizeClaudeModelForSdk(message.meta.model);
            currentModel = messageModel;
            logger.debug(`[loop] Model updated from user message: ${messageModel || 'reset to default'}`);
        } else {
            logger.debug(`[loop] User message received with no model override, using current: ${currentModel || 'default'}`);
        }

        // Resolve sandbox isolation — runtime switchable like model/permission mode, no restart needed.
        let messageSandboxIsolation: string | undefined;
        let sandboxIsolationChanged = false;
        if (message.meta !== undefined && Object.prototype.hasOwnProperty.call(message.meta, 'sandboxIsolation')) {
            messageSandboxIsolation = message.meta.sandboxIsolation as string;
            if (messageSandboxIsolation === 'off') {
                sandboxEnabled = false;
                sandboxConfig = undefined;
            } else {
                sandboxEnabled = true;
                sandboxConfig = {
                    enabled: true,
                    sessionIsolation: (messageSandboxIsolation as 'strict' | 'workspace' | 'custom') || 'workspace',
                    workspaceRoot: sandboxConfig?.workspaceRoot,
                    customWritePaths: sandboxConfig?.customWritePaths ?? [],
                    denyReadPaths: sandboxConfig?.denyReadPaths ?? ['~/.ssh', '~/.aws', '~/.gnupg'],
                    extraWritePaths: sandboxConfig?.extraWritePaths ?? ['/tmp'],
                    denyWritePaths: sandboxConfig?.denyWritePaths ?? ['.env'],
                    networkMode: sandboxConfig?.networkMode ?? 'allowed',
                    allowedDomains: sandboxConfig?.allowedDomains ?? [],
                    deniedDomains: sandboxConfig?.deniedDomains ?? [],
                    allowLocalBinding: sandboxConfig?.allowLocalBinding ?? true,
                };
            }
            sandboxIsolationChanged = true;
            logger.debug(`[loop] Sandbox isolation updated from user message: ${messageSandboxIsolation} (enabled=${sandboxEnabled})`);
            if (currentSession) {
                currentSession.sandboxConfig = sandboxConfig;
            }
            // Update local metadata and notify daemon so restart preserves the new sandbox.
            metadata.sandbox = sandboxConfig?.enabled ? sandboxConfig : null;
            notifyDaemonSessionStarted(session.sessionId, metadata).catch(() => {});
        }

        // Resolve custom system prompt - use message.meta.customSystemPrompt if provided, otherwise use current
        let messageCustomSystemPrompt = currentCustomSystemPrompt;
        if (message.meta?.hasOwnProperty('customSystemPrompt')) {
            messageCustomSystemPrompt = message.meta.customSystemPrompt || undefined; // null becomes undefined
            currentCustomSystemPrompt = messageCustomSystemPrompt;
            logger.debug(`[loop] Custom system prompt updated from user message: ${messageCustomSystemPrompt ? 'set' : 'reset to none'}`);
        } else {
            logger.debug(`[loop] User message received with no custom system prompt override, using current: ${currentCustomSystemPrompt ? 'set' : 'none'}`);
        }

        // Resolve fallback model - use message.meta.fallbackModel if provided, otherwise use current fallback model
        let messageFallbackModel = currentFallbackModel;
        if (message.meta?.hasOwnProperty('fallbackModel')) {
            messageFallbackModel = normalizeClaudeModelForSdk(message.meta.fallbackModel);
            currentFallbackModel = messageFallbackModel;
            logger.debug(`[loop] Fallback model updated from user message: ${messageFallbackModel || 'reset to none'}`);
        } else {
            logger.debug(`[loop] User message received with no fallback model override, using current: ${currentFallbackModel || 'none'}`);
        }

        // Resolve effort - use message.meta.effort if provided, otherwise use current effort
        let messageEffort: EffortLevel = currentEffort;
        if (message.meta?.hasOwnProperty('effort')) {
            const candidates: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
            const candidate = message.meta.effort as string;
            if (candidates.includes(candidate as EffortLevel)) {
                messageEffort = candidate as EffortLevel;
                currentEffort = messageEffort;
                // Bump generation so claudeRemote re-spawns with the new --effort flag.
                if (currentSession) {
                    currentSession.claudeEnvVarsGeneration++;
                }
                logger.debug(`[loop] Effort updated from user message to: ${messageEffort}`);
            } else {
                logger.debug(`[loop] Ignoring unknown effort from user message: ${candidate}`);
            }
        } else {
            logger.debug(`[loop] User message received with no effort override, using current: ${currentEffort}`);
        }

        // Resolve append system prompt - use message.meta.appendSystemPrompt if provided, otherwise use current
        let messageAppendSystemPrompt = currentAppendSystemPrompt;
        if (message.meta?.hasOwnProperty('appendSystemPrompt')) {
            messageAppendSystemPrompt = message.meta.appendSystemPrompt || undefined; // null becomes undefined
            currentAppendSystemPrompt = messageAppendSystemPrompt;
            logger.debug(`[loop] Append system prompt updated from user message: ${messageAppendSystemPrompt ? 'set' : 'reset to none'}`);
        } else {
            logger.debug(`[loop] User message received with no append system prompt override, using current: ${currentAppendSystemPrompt ? 'set' : 'none'}`);
        }

        // Resolve allowed tools - use message.meta.allowedTools if provided, otherwise use current
        let messageAllowedTools = currentAllowedTools;
        if (message.meta?.hasOwnProperty('allowedTools')) {
            messageAllowedTools = message.meta.allowedTools || undefined; // null becomes undefined
            currentAllowedTools = messageAllowedTools;
            logger.debug(`[loop] Allowed tools updated from user message: ${messageAllowedTools ? messageAllowedTools.join(', ') : 'reset to none'}`);
        } else {
            logger.debug(`[loop] User message received with no allowed tools override, using current: ${currentAllowedTools ? currentAllowedTools.join(', ') : 'none'}`);
        }

        // Resolve disallowed tools - use message.meta.disallowedTools if provided, otherwise use current
        let messageDisallowedTools = currentDisallowedTools;
        if (message.meta?.hasOwnProperty('disallowedTools')) {
            messageDisallowedTools = message.meta.disallowedTools || undefined; // null becomes undefined
            currentDisallowedTools = messageDisallowedTools;
            logger.debug(`[loop] Disallowed tools updated from user message: ${messageDisallowedTools ? messageDisallowedTools.join(', ') : 'reset to none'}`);
        } else {
            logger.debug(`[loop] User message received with no disallowed tools override, using current: ${currentDisallowedTools ? currentDisallowedTools.join(', ') : 'none'}`);
        }

        // Profile env: apply when profileId or environmentVariables change.
        // Missing meta.profileId means "no override, keep current"; explicit null means "clear".
        // Uses pre-resolved environmentVariables from the App meta; falls back to local
        // settings lookup if environmentVariables is absent (backward compat).
        const profileIdProvided =
            message.meta !== undefined && Object.prototype.hasOwnProperty.call(message.meta, 'profileId');
        if (profileIdProvided) {
            const messageProfileId = message.meta!.profileId ?? null;
            const messageEnv = message.meta?.environmentVariables;

            // Detect env change even when profileId is the same (user edited env vars for the active profile).
            let envChanged = false;
            if (messageProfileId === currentProfileId && messageEnv && Object.keys(messageEnv).length > 0) {
                // Compute what the merged env WOULD be and compare against current.
                const candidateClaudeEnv = mergeProfileIntoEnv(
                    currentClaudeEnvVars,
                    messageEnv,
                    process.env,
                );
                const envKeysNow = Object.keys(currentClaudeEnvVars)
                    .filter((k) => (currentClaudeEnvVars as Record<string, string>)[k] !== undefined)
                    .sort();
                const envKeysNext = Object.keys(candidateClaudeEnv)
                    .filter((k) => (candidateClaudeEnv as Record<string, string>)[k] !== undefined)
                    .sort();
                if (
                    envKeysNow.length !== envKeysNext.length ||
                    !envKeysNow.every(
                        (k, i) =>
                            k === envKeysNext[i] &&
                            (currentClaudeEnvVars as Record<string, string>)[k] ===
                                (candidateClaudeEnv as Record<string, string>)[k],
                    )
                ) {
                    envChanged = true;
                }
            }

            if (messageProfileId !== currentProfileId || envChanged) {
                currentProfileId = messageProfileId;
                if (messageProfileId) {
                    const profileEnv = messageEnv;
                    if (profileEnv && Object.keys(profileEnv).length > 0) {
                        applyProfileEnvToProcess(profileEnv);
                        currentClaudeEnvVars = mergeProfileIntoEnv(currentClaudeEnvVars, profileEnv, process.env);
                        logger.debug(`[loop] Profile env applied from meta: ${messageProfileId} (${Object.keys(profileEnv).join(', ')})`);
                    } else {
                        // Fallback: resolve from local settings (backward compat or App didn't send env vars)
                        try {
                            const settings = await readSettings();
                            const profile = settings.profiles.find(p => p.id === messageProfileId);
                            if (profile) {
                                const localEnv = getProfileEnvironmentVariables(profile);
                                applyProfileEnvToProcess(localEnv);
                                currentClaudeEnvVars = mergeProfileIntoEnv(currentClaudeEnvVars, localEnv, process.env);
                                logger.debug(`[loop] Profile env resolved from local settings: ${messageProfileId} (${Object.keys(localEnv).join(', ')})`);
                            }
                        } catch (error) {
                            logger.debug('[loop] Failed to resolve profile env from local settings:', error);
                        }
                    }
                    if (currentSession) {
                        currentSession.claudeEnvVars = currentClaudeEnvVars;
                        currentSession.claudeEnvVarsGeneration++;
                    }
                } else {
                    // profileId explicitly null → reset to daemon-spawn-time baseline
                    applyProfileEnvToProcess(daemonClaudeEnvVars);
                    currentClaudeEnvVars = { ...daemonClaudeEnvVars };
                    if (currentSession) {
                        currentSession.claudeEnvVars = currentClaudeEnvVars;
                        currentSession.claudeEnvVarsGeneration++;
                    }
                    logger.debug(`[loop] Profile cleared (profileId: null) → reset to daemon baseline: ${Object.keys(daemonClaudeEnvVars).join(', ') || '(none)'}`);
                }
                // Sync profileId to session metadata so the App can read it on session list / load
                session.updateMetadata((m) => ({ ...m, profileId: currentProfileId }))
                    .catch((err) => logger.debug('[loop] Failed to persist profileId to session metadata', err));
            }
        } else {
            logger.debug(`[loop] User message received with no profileId override, using current: ${currentProfileId ?? '(none)'}`);
        }

        // Check for special commands before processing
        const specialCommand = parseSpecialCommand(getUserMessageText(message));

        if (specialCommand.type === 'compact') {
            logger.debug('[start] Detected /compact command');
            const enhancedMode: EnhancedMode = {
                permissionMode: messagePermissionMode || 'default',
                model: messageModel,
                fallbackModel: messageFallbackModel,
                effort: messageEffort,
                customSystemPrompt: messageCustomSystemPrompt,
                appendSystemPrompt: messageAppendSystemPrompt,
                allowedTools: messageAllowedTools,
                disallowedTools: messageDisallowedTools,
                sandboxIsolation: sandboxEnabled ? (sandboxConfig?.sessionIsolation ?? 'workspace') : 'off',
            };
            messageQueue.pushIsolateAndClear(specialCommand.originalMessage || getUserMessageText(message), enhancedMode, message.meta);
            logger.debugLargeJson('[start] /compact command pushed to queue:', message);
            return;
        }

        if (specialCommand.type === 'clear') {
            logger.debug('[start] Detected /clear command');
            const enhancedMode: EnhancedMode = {
                permissionMode: messagePermissionMode || 'default',
                model: messageModel,
                fallbackModel: messageFallbackModel,
                effort: messageEffort,
                customSystemPrompt: messageCustomSystemPrompt,
                appendSystemPrompt: messageAppendSystemPrompt,
                allowedTools: messageAllowedTools,
                disallowedTools: messageDisallowedTools,
                sandboxIsolation: sandboxEnabled ? (sandboxConfig?.sessionIsolation ?? 'workspace') : 'off',
            };
            messageQueue.pushIsolateAndClear(specialCommand.originalMessage || getUserMessageText(message), enhancedMode, message.meta);
            logger.debugLargeJson('[start] /compact command pushed to queue:', message);
            return;
        }

        // Push with resolved permission mode, model, system prompts, and tools
        const enhancedMode: EnhancedMode = {
            permissionMode: messagePermissionMode || 'default',
            model: messageModel,
            fallbackModel: messageFallbackModel,
            effort: messageEffort,
            customSystemPrompt: messageCustomSystemPrompt,
            appendSystemPrompt: messageAppendSystemPrompt,
            allowedTools: messageAllowedTools,
            disallowedTools: messageDisallowedTools,
            sandboxIsolation: sandboxEnabled ? (sandboxConfig?.sessionIsolation ?? 'workspace') : 'off',
        };
        const metaChanged =
            message.meta?.permissionMode !== undefined
            || (message.meta !== undefined && Object.prototype.hasOwnProperty.call(message.meta, 'model'))
            || (message.meta !== undefined && Object.prototype.hasOwnProperty.call(message.meta, 'effort'));
        if (metaChanged) {
            session.updateMetadata((m) => {
                const patch: Record<string, unknown> = {};
                if (message.meta?.permissionMode !== undefined) {
                    patch.currentOperatingModeCode = messagePermissionMode || 'default';
                }
                if (message.meta !== undefined && Object.prototype.hasOwnProperty.call(message.meta, 'model')) {
                    patch.currentModelCode = claudeModelCodeForMetadata(message.meta.model);
                }
                if (message.meta !== undefined && Object.prototype.hasOwnProperty.call(message.meta, 'effort')) {
                    patch.currentEffort = messageEffort;
                }
                return { ...m, ...patch };
            }).catch((err) => logger.debug('[loop] Failed to persist permission/model to session metadata', err));
        }

        if (isA2ATriggerMessage(message.meta)) {
            logger.debug('[loop] A2A message recorded in inbox; poking message loop');
            messageQueue.poke();
            a2aInbox.peekInbox();
            return;
        }
        // No explicit echo — the turn output from the SDK serves as the
        // user message echo once the server processes it. This avoids
        // the seq gap caused by a separate envelope round-trip.
        // Pass message.meta so claudeRemoteLauncher can read appMessageId
        // and echo it back for outbox cleanup.
        const msgText = getUserMessageText(message);
        const files = getUserMessageFiles(message);
        // Sandbox isolation changes trigger an isolated push so the launcher
        // resets the mode hash and respawns the SDK process immediately, rather
        // than waiting until the next turn.
        if (sandboxIsolationChanged) {
            messageQueue.pushIsolated(msgText, enhancedMode, { meta: message.meta, files });
            logger.debug('[loop] Sandbox changed — pushing with isolate for immediate respawn');
            // Persist sandbox change to session metadata so the App sees the update.
            session.updateMetadata((m) => ({
                ...m,
                sandbox: sandboxConfig?.enabled ? sandboxConfig : null,
                currentSandboxIsolation: messageSandboxIsolation ?? 'off',
            })).catch((err) => logger.debug('[loop] Failed to persist sandbox to session metadata', err));
        } else {
            messageQueue.push(msgText, enhancedMode, { meta: message.meta, files });
        }
        logger.debugLargeJson('User message pushed to queue:', message)
    };
    session.onUserMessage(handleUserMessage);

    // Setup signal handlers for graceful shutdown
    let cleanupStarted = false;
    let exitSignalName: string | null = null;

    const cleanup = async (archive = false) => {
        if (cleanupStarted) return;
        cleanupStarted = true;

        logger.debug(`[START] Cleaning up (archive=${archive})...`);
        removeSessionPidFile();

        try {
            // Update lifecycle state to archived before closing
            if (session) {
                if (archive) {
                    await session.updateMetadata((currentMetadata) => ({
                        ...currentMetadata,
                        lifecycleState: 'archived',
                        lifecycleStateSince: Date.now(),
                        archivedBy: 'cli',
                        archiveReason: 'User terminated'
                    }));
                }

                // Cleanup session resources (intervals, callbacks)
                currentSession?.cleanup();

                // Send session death message
                session.sendSessionDeath();
                await session.flush();
                await notifyDaemonSessionEnding(
                    session.sessionId,
                    process.pid,
                    exitSignalName ? `signal: ${exitSignalName}` : (archive ? 'killed by app (RPC)' : 'terminated'),
                    0,
                    archive
                );
                await session.close();
            }

            // Stop caffeinate
            stopCaffeinate();

            a2aInbox.dispose();


            // Stop Happy MCP server
            happyServer.stop();

            // Stop Hook server and cleanup settings file
            hookServer.stop();
            cleanupHookSettingsFile(hookSettingsPath);

            logger.debug('[START] Cleanup complete, exiting');
            process.exit(0);
        } catch (error) {
            logger.debug('[START] Error during cleanup:', error);
            if (session) {
                await notifyDaemonSessionEnding(
                    session.sessionId,
                    process.pid,
                    exitSignalName ? `signal: ${exitSignalName} (cleanup error: ${error instanceof Error ? error.message : String(error)})` : `cleanup error: ${error instanceof Error ? error.message : String(error)}`,
                    1,
                    archive
                ).catch(() => {});
            }
            process.exit(1);
        }
    };

    // Handle termination signals (反注册: send session-end on exit)
    process.on('SIGTERM', () => { exitSignalName = 'SIGTERM'; void cleanup(false); });
    process.on('SIGINT', () => { exitSignalName = 'SIGINT'; void cleanup(false); });
    process.on('SIGHUP', () => { exitSignalName = 'SIGHUP'; void cleanup(false); });

    // Handle uncaught exceptions and rejections
    process.on('uncaughtException', (error) => {
        logger.debug('[START] Uncaught exception:', error);
        void cleanup(false);
    });

    process.on('unhandledRejection', (reason) => {
        logger.debug('[START] Unhandled rejection:', reason);
        void cleanup(false);
    });

    registerKillSessionHandler(session.rpcHandlerManager, () => cleanup(true));

    // Create claude loop
    const exitCode = await loop({
        path: workingDirectory,
        model: normalizeClaudeModelForSdk(options.model),
        permissionMode: initialPermissionMode,
        startingMode: options.startingMode,
        initialSessionId: initialClaudeSessionId,
        messageQueue,
        api,
        allowedTools: happyServer.toolNames.map(toolName => `mcp__happy__${toolName}`),
        onModeChange: (newMode) => {
            session.sendSessionEvent({ type: 'switch', mode: newMode });
            session.updateAgentState((currentState) => ({
                ...currentState,
                controlledByUser: newMode === 'local'
            }));
        },
        onSessionReady: (sessionInstance) => {
            // Store reference for hook server callback
            currentSession = sessionInstance;
            sessionInstance.a2aInboxTurn = a2aInbox;
            sessionInstance.claudeTurnActiveRef = claudeTurnActiveRef;
        },
        mcpServers: {
            'happy': {
                type: 'http' as const,
                url: happyServer.url,
            }
        },
        session,
        claudeEnvVars: currentClaudeEnvVars,
        claudeArgs: options.claudeArgs,
        sandboxConfig,
        hookSettingsPath,
        hookServerPort: hookServer.port,
        jsRuntime: options.jsRuntime
    });

    // Cleanup session resources (intervals, callbacks) - prevents memory leak
    // Note: currentSession is set by onSessionReady callback during loop()
    (currentSession as Session | null)?.cleanup();

    removeSessionPidFile();

    // Send session death message
    session.sendSessionDeath();

    // Wait for socket to flush
    logger.debug('Waiting for socket to flush...');
    await session.flush();

    await notifyDaemonSessionEnding(session.sessionId, process.pid, 'completed normally (exit 0)', 0, false);

    // Close session
    logger.debug('Closing session...');
    await session.close();

    // Stop caffeinate before exiting
    stopCaffeinate();
    logger.debug('Stopped sleep prevention');

    // Stop Happy MCP server
    happyServer.stop();
    logger.debug('Stopped Happy MCP server');

    // Stop Hook server and cleanup settings file
    hookServer.stop();
    cleanupHookSettingsFile(hookSettingsPath);
    logger.debug('Stopped Hook server and cleaned up settings file');

    // Exit with the code from Claude
    process.exit(exitCode);
}
