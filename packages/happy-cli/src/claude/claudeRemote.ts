import { EnhancedMode } from "./loop";
import { query, type QueryOptions, type SDKMessage, type SDKSystemMessage, AbortError, SDKUserMessage, type SDKResultMessage } from '@/claude/sdk'
import { mapToClaudeMode } from "./utils/permissionMode";
import { claudeCheckSession } from "./utils/claudeCheckSession";
import { join, resolve } from 'node:path';
import { projectPath } from "@/projectPath";
import { parseSpecialCommand } from "@/parsers/specialCommands";
import { logger } from "@/lib";
import { PushableAsyncIterable } from "@/utils/PushableAsyncIterable";
import { Future } from "@/utils/future";
import { getProjectPath } from "./utils/path";
import { awaitFileExist } from "@/modules/watcher/awaitFileExist";
import { systemPrompt } from "./utils/systemPrompt";
import { PermissionResult } from "./sdk/types";
import type { JsRuntime } from "./runClaude";
import { normalizeClaudeModelForSdk } from "./utils/model";

export async function claudeRemote(opts: {

    // Fixed parameters
    sessionId: string | null,
    path: string,
    mcpServers?: Record<string, any>,
    claudeEnvVars?: Record<string, string>,
    /** Snapshot of session.claudeEnvVarsGeneration at call time — if it changes mid-turn, return to force re-spawn. */
    claudeEnvVarsGeneration: number,
    /** Returns current session.claudeEnvVarsGeneration to detect mid-turn profile changes. */
    getClaudeEnvVarsGeneration: () => number,
    claudeArgs?: string[],
    allowedTools: string[],
    signal?: AbortSignal,
    canCallTool: (toolName: string, input: unknown, mode: EnhancedMode, options: { signal: AbortSignal }) => Promise<PermissionResult>,
    /** Path to temporary settings file with SessionStart hook (required for session tracking) */
    hookSettingsPath: string,
    /** JavaScript runtime to use for spawning Claude Code (default: 'node') */
    jsRuntime?: JsRuntime,

    // Dynamic parameters
    nextMessage: () => Promise<{ message: string, mode: EnhancedMode } | null>,
    onReady: (result: SDKResultMessage) => void,
    isAborted: (toolCallId: string) => boolean,

    // Callbacks
    onSessionFound: (id: string) => void,
    onThinkingChange?: (thinking: boolean) => void,
    onMessage: (message: SDKMessage) => void,
    onCompletionEvent?: (message: string) => void,
    onSessionReset?: () => void,
    /** Called when env changed mid-turn — launcher should set this message as pending for re-spawn. */
    onEnvChanged?: (msg: { message: string; mode: EnhancedMode }) => void;
    /** Called when the SDK emits the system init message with model/capability info. */
    onModelInit?: (info: { model: string; version: string; sessionId: string }) => void;
}): Promise<void> {

    let currentGeneration = opts.claudeEnvVarsGeneration;

    // Check if session is valid
    let startFrom = opts.sessionId;
    if (opts.sessionId && !claudeCheckSession(opts.sessionId, opts.path)) {
        startFrom = null;
    }
    
    // Extract --resume from claudeArgs if present (for first spawn)
    if (!startFrom && opts.claudeArgs) {
        for (let i = 0; i < opts.claudeArgs.length; i++) {
            if (opts.claudeArgs[i] === '--resume') {
                // Check if next arg exists and looks like a session ID
                if (i + 1 < opts.claudeArgs.length) {
                    const nextArg = opts.claudeArgs[i + 1];
                    // If next arg doesn't start with dash and contains dashes, it's likely a UUID
                    if (!nextArg.startsWith('-') && nextArg.includes('-')) {
                        startFrom = nextArg;
                        logger.debug(`[claudeRemote] Found --resume with session ID: ${startFrom}`);
                        break;
                    } else {
                        // Just --resume without UUID - SDK doesn't support this
                        logger.debug('[claudeRemote] Found --resume without session ID - not supported in remote mode');
                        break;
                    }
                } else {
                    // --resume at end of args - SDK doesn't support this
                    logger.debug('[claudeRemote] Found --resume without session ID - not supported in remote mode');
                    break;
                }
            }
        }
    }

    // Set environment variables for Claude Code SDK
    if (opts.claudeEnvVars) {
        Object.entries(opts.claudeEnvVars).forEach(([key, value]) => {
            process.env[key] = value;
        });
    }

    // Get initial message
    const initial = await opts.nextMessage();
    if (!initial) { // No initial message - exit
        return;
    }

    // Handle special commands
    const specialCommand = parseSpecialCommand(initial.message);

    // Handle /clear command
    if (specialCommand.type === 'clear') {
        if (opts.onCompletionEvent) {
            opts.onCompletionEvent('Context was reset');
        }
        if (opts.onSessionReset) {
            opts.onSessionReset();
        }
        return;
    }

    // Handle /compact command
    let isCompactCommand = false;
    if (specialCommand.type === 'compact') {
        logger.debug('[claudeRemote] /compact command detected - will process as normal but with compaction behavior');
        isCompactCommand = true;
        if (opts.onCompletionEvent) {
            opts.onCompletionEvent('Compaction started');
        }
    }

    // Prepare SDK options
    let mode = initial.mode;
    const model = normalizeClaudeModelForSdk(initial.mode.model);
    const fallbackModel = normalizeClaudeModelForSdk(initial.mode.fallbackModel);
    const sdkOptions: QueryOptions = {
        cwd: opts.path,
        resume: startFrom ?? undefined,
        mcpServers: opts.mcpServers,
        permissionMode: mapToClaudeMode(initial.mode.permissionMode),
        model,
        fallbackModel,
        effort: initial.mode.effort,
        customSystemPrompt: initial.mode.customSystemPrompt ? initial.mode.customSystemPrompt + '\n\n' + systemPrompt : undefined,
        appendSystemPrompt: initial.mode.appendSystemPrompt ? initial.mode.appendSystemPrompt + '\n\n' + systemPrompt : systemPrompt,
        allowedTools: initial.mode.allowedTools ? initial.mode.allowedTools.concat(opts.allowedTools) : opts.allowedTools,
        disallowedTools: initial.mode.disallowedTools,
        canCallTool: (toolName: string, input: unknown, options: { signal: AbortSignal }) => opts.canCallTool(toolName, input, mode, options),
        executable: opts.jsRuntime ?? 'node',
        abort: opts.signal,
        pathToClaudeCodeExecutable: (() => {
            return resolve(join(projectPath(), 'scripts', 'claude_remote_launcher.cjs'));
        })(),
        settingsPath: opts.hookSettingsPath,
    }

    // Track thinking state
    let thinking = false;
    const updateThinking = (newThinking: boolean) => {
        if (thinking !== newThinking) {
            thinking = newThinking;
            logger.debug(`[claudeRemote] Thinking state changed to: ${thinking}`);
            if (opts.onThinkingChange) {
                opts.onThinkingChange(thinking);
            }
        }
    };

    // Push initial message
    let messages = new PushableAsyncIterable<SDKUserMessage>();
    messages.push({
        type: 'user',
        message: {
            role: 'user',
            content: initial.message,
        },
    });

    // Start the SDK query
    const response = query({
        prompt: messages,
        options: sdkOptions,
    });

    updateThinking(true);

    const stopSignal = new Future<void>();

    // Input Loop: continuously reads user messages from the queue
    // and pushes them to the SDK. Independent of output processing.
    async function inputLoop(): Promise<void> {
        while (true) {
            const next = await Promise.race([
                opts.nextMessage(),
                stopSignal.promise.then(() => null),
            ]);
            if (next === null || next === undefined) break;

            const latestGeneration = opts.getClaudeEnvVarsGeneration();
            if (latestGeneration !== currentGeneration) {
                logger.debug(`[claudeRemote] Profile env changed (gen ${currentGeneration} → ${latestGeneration}), returning to re-spawn`);
                opts.onEnvChanged?.({ message: next.message, mode: next.mode });
                break;
            }
            currentGeneration = latestGeneration;
            mode = next.mode;
            updateThinking(true);
            messages.push({
                type: 'user',
                message: { role: 'user', content: next.message },
            });
        }
        messages.end();
    }

    // Output Loop: processes all SDK response messages.
    // Task-notifications are reported (onReady) but never trigger
    // input-side actions. Normal results call onReady and continue;
    // the input loop handles fetching the next message.
    async function outputLoop(): Promise<void> {
        try {
            for await (const message of response) {
                logger.debugLargeJson(`[claudeRemote] Message ${message.type}`, message);

                opts.onMessage(message);

                // System init
                if (message.type === 'system' && message.subtype === 'init') {
                    const systemInit = message as SDKSystemMessage;

                    if (systemInit.model && systemInit.session_id) {
                        opts.onModelInit?.({
                            model: systemInit.model,
                            version: (systemInit as any).claude_code_version || '',
                            sessionId: systemInit.session_id,
                        });
                    }

                    if (systemInit.session_id) {
                        logger.debug(`[claudeRemote] Waiting for session file: ${systemInit.session_id}`);
                        const projectDir = getProjectPath(opts.path);
                        const found = await awaitFileExist(join(projectDir, `${systemInit.session_id}.jsonl`));
                        logger.debug(`[claudeRemote] Session file found: ${systemInit.session_id} ${found}`);
                        opts.onSessionFound(systemInit.session_id);
                    }
                }

                // Result handling
                if (message.type === 'result') {
                    updateThinking(false);

                    const isTaskNotification = (message as any).origin?.kind === 'task-notification';
                    const hasTerminalReason = typeof (message as any).terminal_reason === 'string'
                        && (message as any).terminal_reason.length > 0;

                    // Interstitial: feed result back to Claude, continue draining
                    if (isTaskNotification && !hasTerminalReason) {
                        logger.debug('[claudeRemote] Task-notification (interstitial) — feeding result back to Claude');
                        const taskResult = (message as SDKResultMessage).result || '';
                        updateThinking(true);
                        if (!messages.done) {
                            messages.push({
                                type: 'user',
                                message: { role: 'user', content: taskResult || 'Continue.' },
                            });
                        }
                        continue;
                    }

                    // Terminal task-notification: SDK-internal turn complete.
                    // Notify App but leave the input loop alone.
                    if (isTaskNotification && hasTerminalReason) {
                        logger.debug('[claudeRemote] Task-notification (terminal) — reporting, not touching input loop');
                        opts.onReady(message as SDKResultMessage);
                        continue;
                    }

                    // Normal result (user-initiated turn)
                    logger.debug('[claudeRemote] Result received');
                    if (isCompactCommand) {
                        logger.debug('[claudeRemote] Compaction completed');
                        opts.onCompletionEvent?.('Compaction completed');
                        isCompactCommand = false;
                    }
                    opts.onReady(message as SDKResultMessage);
                    // Signal inputLoop to exit so claudeRemote() returns
                    // and the outer launcher loop can peek inbox / pick
                    // up the next queued message.
                    stopSignal.resolve();
                }

                // Abort check
                if (message.type === 'user') {
                    const msg = message as SDKUserMessage;
                    if (msg.message.role === 'user' && Array.isArray(msg.message.content)) {
                        for (let c of msg.message.content) {
                            if (c.type === 'tool_result' && c.tool_use_id && opts.isAborted(c.tool_use_id)) {
                                logger.debug('[claudeRemote] Tool aborted, exiting claudeRemote');
                                return;
                            }
                        }
                    }
                }
            }
        } catch (e) {
            if (e instanceof AbortError) {
                logger.debug('[claudeRemote] Aborted');
            } else {
                throw e;
            }
        } finally {
            stopSignal.resolve();
            updateThinking(false);
        }
    }

    // Run both loops concurrently
    try {
        await Promise.all([inputLoop(), outputLoop()]);
    } finally {
        messages.end();
        updateThinking(false);
    }
}