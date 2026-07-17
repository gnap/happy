import { EnhancedMode } from "./loop";
import { query, type QueryOptions, type SDKMessage, type SDKSystemMessage, AbortError, SDKUserMessage, type SDKResultMessage } from '@/claude/sdk'
import type { Options as SdkOptions, CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import { mapToClaudeMode } from "./utils/permissionMode";
import { claudeCheckSession } from "./utils/claudeCheckSession";
import { join } from 'node:path';
import { execSync } from 'node:child_process';
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

/** Find the system Claude binary for use with the Agent SDK. */
function resolveClaudeBinaryPath(): string {
    // 1. Explicit override
    if (process.env.HAPPY_CLAUDE_PATH) {
        logger.debug('[claudeRemote] Using HAPPY_CLAUDE_PATH:', process.env.HAPPY_CLAUDE_PATH);
        return process.env.HAPPY_CLAUDE_PATH;
    }
    // 2. Find via PATH
    try {
        const fromPath = execSync('which claude', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
        if (fromPath) {
            logger.debug('[claudeRemote] Found claude via PATH:', fromPath);
            return fromPath;
        }
    } catch { /* not in PATH */ }
    // 3. Common fallback locations
    const fallbacks = [
        '/home/linuxbrew/.linuxbrew/bin/claude',
        '/opt/homebrew/bin/claude',
        '/usr/local/bin/claude',
        `${process.env.HOME}/.local/bin/claude`,
    ];
    for (const p of fallbacks) {
        try {
            execSync(`"${p}" --version`, { stdio: ['pipe', 'pipe', 'pipe'] });
            logger.debug('[claudeRemote] Found claude at fallback:', p);
            return p;
        } catch { /* not there */ }
    }
    // 4. Last resort: hope 'claude' is on PATH
    logger.debug('[claudeRemote] No claude binary found, falling back to "claude"');
    return 'claude';
}

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
    /** Port of the hook server. Used to inline SessionStart hook when sandbox prevents --settings. */
    hookServerPort: number,
    /** JavaScript runtime to use for spawning Claude Code (default: 'node') */
    jsRuntime?: JsRuntime,

    // Dynamic parameters
    nextMessage: () => Promise<{ message: string, mode: EnhancedMode, meta?: unknown } | null>,
    onReady: (result: SDKResultMessage) => void,
    /** Called with accurate context size (and optional breakdown) from the running process after each normal turn. */
    onContextUsage?: (usage: { totalTokens: number; maxTokens: number; breakdown?: { systemPrompt: number; systemTools: number; customAgents: number; skills: number; messages: number; freeSpace: number } }) => void,
    /** Called with raw markdown when the initial message is a /context local command. */
    onContextOutput?: (contextMarkdown: string) => void,
    isAborted: (toolCallId: string) => boolean,
    /** Called with session_crons from the Stop hook so the launcher can schedule wakeups. */
    onSessionCrons?: (crons: Array<{ id: string; schedule: string; recurring: boolean; prompt: string }>) => void,
    /** Called immediately before stopSignal is resolved on a normal result, so the
     *  launcher can mark itself as "stopping" and avoid fetching a new message from
     *  the queue that would then be discarded by the inputLoop race. */
    onBeforeStop?: () => void,
    /**
     * Called after a normal user-turn result to opportunistically claim a pending
     * inbox turn. If one is available the launcher sets it up and returns the
     * inbox prompt; claudeRemote then pushes it directly to the running SDK
     * session (same process, no --resume) instead of spawning a new one.
     * Returns null when no inbox turn is queued.
     */
    tryConsumeInboxTurn?: () => string | null,

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
    /** Per-session sandbox config. When enabled, passed to the SDK as sandbox settings. */
    sandboxConfig?: import('@/persistence').SandboxConfig;
}): Promise<void> {

    let currentGeneration = opts.claudeEnvVarsGeneration;

    // Check if session is valid
    let startFrom = opts.sessionId;
    if (opts.sessionId && !claudeCheckSession(opts.sessionId, opts.path)) {
        startFrom = null;
    }
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

    // Inbox turns must not resume the main session — its history may be huge
    // and contain many "No response requested." patterns that poison the model.
    if (initial.mode.noResume) {
        startFrom = null;
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

    // /context is a local CLI command. When the caller provides onContextOutput,
    // let the SDK process it (it emits system/local_command with the markdown),
    // intercept that message in outputLoop and deliver it — never calling onReady.
    const isContextCommand = specialCommand.type === 'compact' ? false
        : initial.message.trim() === '/context';
    if (isContextCommand && !opts.onContextOutput) {
        // No handler — skip silently, don't send to model.
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

    // Prepare SDK options — build against @anthropic-ai/claude-agent-sdk Options type.
    let mode = initial.mode;
    const model = normalizeClaudeModelForSdk(initial.mode.model);
    const fallbackModel = normalizeClaudeModelForSdk(initial.mode.fallbackModel);

    // Build system prompt: customPrompt → use it + our additions, otherwise our additions as plain string.
    const effectiveSystemPrompt = initial.mode.customSystemPrompt
        ? initial.mode.customSystemPrompt + '\n\n' + systemPrompt
        : initial.mode.appendSystemPrompt
            ? initial.mode.appendSystemPrompt + '\n\n' + systemPrompt
            : systemPrompt;

    // Build abort controller from the caller's signal.
    const abortController = new AbortController();
    if (opts.signal) {
        if (opts.signal.aborted) abortController.abort();
        else opts.signal.addEventListener('abort', () => abortController.abort(), { once: true });
    }

    const sdkOptions: SdkOptions = {
        cwd: opts.path,
        resume: startFrom ?? undefined,
        mcpServers: opts.mcpServers as SdkOptions['mcpServers'],
        permissionMode: mapToClaudeMode(initial.mode.permissionMode),
        model,
        fallbackModel,
        effort: initial.mode.effort,
        systemPrompt: effectiveSystemPrompt,
        allowedTools: initial.mode.allowedTools
            ? initial.mode.allowedTools.concat(opts.allowedTools)
            : opts.allowedTools,
        disallowedTools: initial.mode.disallowedTools,
        canUseTool: ((toolName: string, input: Record<string, unknown>, o: { signal: AbortSignal }) =>
            opts.canCallTool(toolName, input, mode, o)) as CanUseTool,
        executable: (opts.jsRuntime ?? 'node') as SdkOptions['executable'],
        pathToClaudeCodeExecutable: resolveClaudeBinaryPath(),
        abortController,
        extraArgs: (!opts.sandboxConfig?.enabled && opts.hookSettingsPath) ? { settings: opts.hookSettingsPath } : undefined,
        // Pass sandbox config to the SDK so it wraps Bash commands with sandbox-exec
        // rather than the entire Happy process. Much more resilient.
        // When sandbox is enabled, we skip extraArgs (--settings) and use inline
        // hooks instead, because the SDK rejects using both together.
        sandbox: opts.sandboxConfig?.enabled ? {
            enabled: true,
            autoAllowBashIfSandboxed: true,
            failIfUnavailable: false,
            enableWeakerNetworkIsolation: opts.sandboxConfig.networkMode === 'allowed',
            // Never let the model escape the sandbox via dangerouslyDisableSandbox.
            // This is a security-sensitive setting — the model must not be able to
            // override the user's sandbox choice on a per-command basis.
            allowUnsandboxedCommands: false,
        } : undefined,
        env: { ...process.env },
        includeHookEvents: true,
        hooks: {
            // SessionStart hook: forwarded inline when sandbox is enabled (can't
            // use --settings + sandbox together). Mirrors session_hook_forwarder.cjs.
            SessionStart: opts.sandboxConfig?.enabled ? [{
                hooks: [async (input) => {
                    if (input.hook_event_name !== 'SessionStart') return { continue: false };
                    const body = JSON.stringify({
                        session_id: input.session_id,
                        transcript_path: input.transcript_path,
                        cwd: input.cwd,
                        hook_event_name: input.hook_event_name,
                        source: input.source,
                    });
                    fetch(`http://127.0.0.1:${opts.hookServerPort}/hook/session-start`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body,
                        signal: AbortSignal.timeout(5000),
                    }).catch(() => {}); // silently ignore — don't break Claude
                    return { continue: false };
                }],
            }] : undefined,
            // Stop hook: collect pending crons so the launcher can schedule wakeups
            // and keep the session alive across turns.
            Stop: [{
                hooks: [async (input) => {
                    if (input.hook_event_name !== 'Stop') return { continue: false };
                    const crons = input.session_crons ?? [];
                    if (crons.length > 0) {
                        logger.debug(`[claudeRemote] Stop hook: ${crons.length} pending crons`);
                        opts.onSessionCrons?.(crons.map((c: { id: string; schedule: string; recurring: boolean; prompt: string }) => ({
                            id: c.id,
                            schedule: c.schedule,
                            recurring: c.recurring,
                            prompt: c.prompt,
                        })));
                        return { continue: true };
                    }
                    return { continue: false };
                }],
            }],
        },
    };

    // Track thinking state
    let thinking = false;
    /** Session ID assigned by Claude Code on system_init; used for countTokens calls. */
    let currentSessionId: string | null = null;
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
    const initialFiles = (initial as any).files;
    messages.push({
        type: 'user',
        message: {
            role: 'user',
            content: initialFiles && initialFiles.length > 0
                ? [{ type: 'text', text: initial.message },
                   ...initialFiles.map((f: any) => ({ type: 'image', source: { type: 'base64', media_type: f.mimeType, data: f.data } }))]
                : initial.message,
        },
    });

    // Start the SDK query.
    // Cast through any because our permissive SDKUserMessage type differs from the
    // SDK's strict ContentBlockParam[] type. At runtime the formats are compatible.
    const response = query({
        prompt: messages as any,
        options: sdkOptions,
    });

    updateThinking(true);

    // When the caller aborts (user clicked stop), send an interrupt to Claude Code
    // so it stops the current turn immediately rather than finishing the tool call.
    if (opts.signal) {
        opts.signal.addEventListener('abort', () => {
            response.interrupt().catch(() => { /* ignore if process already exited */ });
        }, { once: true });
    }

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
            const nextFiles = (next as any).files;
            const meta = next.meta as Record<string, unknown> | undefined;
            const msg: Record<string, unknown> = {
                type: 'user',
                message: {
                    role: 'user',
                    content: nextFiles && nextFiles.length > 0
                        ? [{ type: 'text', text: next.message },
                           ...nextFiles.map((f: any) => ({ type: 'image', source: { type: 'base64', media_type: f.mimeType, data: f.data } }))]
                        : next.message,
                },
            };
            // Plumb cron metadata through so the SDK and the session protocol
            // mapper recognise auto-continuation messages.
            if (meta?.origin === 'auto-continuation') {
                msg.origin = { kind: 'auto-continuation' };
                if (meta.cronId) (msg as any).cronId = meta.cronId;
            }
            messages.push(msg as any);
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
                // Force-verbose: log every assistant message block type for debugging.
                if (message.type === 'assistant') {
                    const ac = (message as any).message?.content;
                    if (Array.isArray(ac)) {
                        const names = ac.map((b: any) => `${b.type}:${b.name ?? '?'}`).join(', ');
                        logger.debug(`[claudeRemote] ASSISTANT blocks: ${names}`);
                    }
                }
                logger.debugLargeJson(`[claudeRemote] Message ${message.type}`, message);
                if (message.type === 'user') {
                    logger.debug(`[claudeRemote] USER echo origin=${JSON.stringify((message as any).origin)} cronId=${(message as any).cronId} content=${JSON.stringify((message as any).message?.content)?.slice(0, 120)}`);
                }

                // /context local command: intercept system/local_command and deliver
                // markdown via onContextOutput without letting it reach the App.
                if (
                    isContextCommand &&
                    message.type === 'system' &&
                    (message as any).subtype === 'local_command'
                ) {
                    const content: string = (message as any).content ?? '';
                    logger.debug('[claudeRemote] /context local_command output intercepted');
                    opts.onContextOutput?.(content);
                    stopSignal.resolve();
                    continue;
                }

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
                        currentSessionId = systemInit.session_id;
                        opts.onSessionFound(systemInit.session_id);

                    }
                }

                // Background task completed (Workflow, Agent, etc.) — wake Claude
                // so it can process the results even if the turn already ended.
                if (message.type === 'system' && message.subtype === 'task_notification' && !thinking) {
                    const tn = message as any;
                    if (tn.status === 'completed' && !messages.done) {
                        logger.debug('[claudeRemote] Background task completed — waking Claude');
                        updateThinking(true);
                        messages.push({
                            type: 'user',
                            message: { role: 'user', content: tn.summary || 'Task completed.' },
                        });
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
                        const taskResult = (message as unknown as SDKResultMessage).result || '';
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
                        opts.onReady(message as unknown as SDKResultMessage);
                        continue;
                    }

                    // Normal result (user-initiated turn)
                    logger.debug('[claudeRemote] Result received');
                    if (isCompactCommand) {
                        logger.debug('[claudeRemote] Compaction completed');
                        opts.onCompletionEvent?.('Compaction completed');
                        isCompactCommand = false;
                    }
                    opts.onReady(message as unknown as SDKResultMessage);

                    // Opportunistically continue in-process with a pending inbox turn.
                    // Mirrors the interstitial task-notification path: push the inbox
                    // prompt directly into the running SDK session so the agent can
                    // handle it without a new --resume spawn. Falls back to the normal
                    // stop path (new claudeRemote() + resume) when no inbox turn is queued.
                    const inboxPrompt = opts.tryConsumeInboxTurn?.();
                    if (inboxPrompt && !messages.done) {
                        logger.debug('[claudeRemote] Continuing in-process with inbox turn');
                        updateThinking(true);
                        messages.push({
                            type: 'user',
                            message: { role: 'user', content: inboxPrompt },
                        });
                        continue;
                    }

                    // Signal inputLoop to exit so claudeRemote() returns
                    // and the outer launcher loop can peek inbox / pick
                    // up the next queued message.
                    opts.onBeforeStop?.();
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