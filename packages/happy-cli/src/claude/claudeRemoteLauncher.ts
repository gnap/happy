import { render } from "ink";
import { Session } from "./session";
import { MessageBuffer } from "@/ui/ink/messageBuffer";

/** Parse a 5-field cron expression and return the next fire time (ms). */
function nextCronFire(expr: string, from: number): number {
    const parts = expr.trim().split(/\s+/);
    if (parts.length !== 5) return from + 60_000; // fallback: 1min
    const [min, hour, dom, month, dow] = parts;

    const now = new Date(from);

    // For explicit or partially-explicit one-shot patterns: "52 22 28 6 0",
    // "8 14 * * *" (ScheduleWakeup), etc. Treat numeric min+hour as an absolute
    // time today; if it's in the past, fire immediately.
    const minNum = /^\d+$/.test(min) ? parseInt(min) : -1;
    const hourNum = /^\d+$/.test(hour) ? parseInt(hour) : -1;
    if (minNum >= 0 && hourNum >= 0) {
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hourNum, minNum, 0);
        if (d.getTime() <= from) return from; // already past — fire immediately
        return d.getTime();
    }

    for (let off = 0; off < 60; off++) {
        const d = new Date(from + off * 60_000);
        const m = d.getMinutes();
        const h = d.getHours();
        const D = d.getDate();
        const M = d.getMonth() + 1;
        const w = d.getDay();

        if (!fieldMatch(min, m, 0, 59)) continue;
        if (!fieldMatch(hour, h, 0, 23)) continue;
        if (!fieldMatch(dom, D, 1, 31)) continue;
        if (!fieldMatch(month, M, 1, 12)) continue;
        if (!fieldMatch(dow, w, 0, 6)) continue;

        return d.getTime();
    }
    return from + 3600_000; // fallback: 1h
}

function fieldMatch(pattern: string, value: number, _min: number, _max: number): boolean {
    if (pattern === '*') return true;
    const stepMatch = pattern.match(/^\*\/(\d+)$/);
    if (stepMatch) return value % parseInt(stepMatch[1]) === 0;
    if (/^\d+$/.test(pattern)) return parseInt(pattern) === value;
    // comma-separated values
    for (const p of pattern.split(',')) {
        if (parseInt(p.trim()) === value) return true;
    }
    return false;
}
import { RemoteModeDisplay } from "@/ui/ink/RemoteModeDisplay";
import React from "react";
import { claudeRemote } from "./claudeRemote";
import { PermissionHandler } from "./utils/permissionHandler";
import { Future } from "@/utils/future";
import { SDKAssistantMessage, SDKMessage, SDKUserMessage } from "./sdk";
import { formatClaudeMessageForInk } from "@/ui/messageFormatterInk";
import { logger } from "@/ui/logger";
import { SDKToLogConverter } from "./utils/sdkToLogConverter";
import { PLAN_FAKE_REJECT } from "./constants";
import { EnhancedMode } from "./loop";
import { RawJSONLines } from "@/claude/types";
import { OutgoingMessageQueue } from "./utils/OutgoingMessageQueue";
import { getToolName } from "./utils/getToolName";
import { buildClaudeTurnUsagePayload } from "./utils/claudeTurnUsage";
import { createEnvelope } from '@slopus/happy-wire';

interface PermissionsField {
    date: number;
    result: 'approved' | 'denied';
    mode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
    allowedTools?: string[];
}

function formatLaunchError(error: unknown): Record<string, unknown> {
    if (error instanceof Error) {
        return {
            name: error.name,
            message: error.message,
            stack: error.stack,
            cause: error.cause instanceof Error
                ? formatLaunchError(error.cause)
                : error.cause,
        };
    }

    if (error && typeof error === 'object') {
        const record = error as Record<string, unknown>;
        return {
            ...record,
            name: record.name ?? 'UnknownError',
            message: record.message ?? 'Unknown launch error',
            stack: record.stack,
        };
    }

    return {
        rawType: typeof error,
        value: String(error),
    };
}

export async function claudeRemoteLauncher(session: Session): Promise<'switch' | 'exit'> {
    logger.debug('[claudeRemoteLauncher] Starting remote launcher');

    // Check if we have a TTY for UI rendering
    const hasTTY = process.stdout.isTTY && process.stdin.isTTY;
    logger.debug(`[claudeRemoteLauncher] TTY available: ${hasTTY}`);

    // Configure terminal
    let messageBuffer = new MessageBuffer();
    let inkInstance: any = null;

    if (hasTTY) {
        console.clear();
        inkInstance = render(React.createElement(RemoteModeDisplay, {
            messageBuffer,
            logPath: process.env.DEBUG ? session.logPath : undefined,
            onExit: async () => {
                // Exit the entire client
                logger.debug('[remote]: Exiting client via Ctrl-C');
                if (!exitReason) {
                    exitReason = 'exit';
                }
                await abort();
            },
            onSwitchToLocal: () => {
                // Switch to local mode
                logger.debug('[remote]: Switching to local mode via double space');
                doSwitch();
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

    // Handle abort
    let exitReason: 'switch' | 'exit' | null = null;
    let cronLoopPromise: Promise<void> | null = null;
    let abortController: AbortController | null = null;
    let abortFuture: Future<void> | null = null;

    async function abort() {
        if (abortController && !abortController.signal.aborted) {
            abortController.abort();
        }
        await abortFuture?.promise;
    }

    async function doAbort() {
        logger.debug('[remote]: doAbort');
        await abort();
    }

    async function doSwitch() {
        logger.debug('[remote]: doSwitch');
        if (!exitReason) {
            exitReason = 'switch';
        }
        await abort();
    }

    // When to abort
    session.client.rpcHandlerManager.registerHandler('abort', doAbort); // When abort clicked
    session.client.rpcHandlerManager.registerHandler('switch', doSwitch); // When switch clicked

    // When a new A2A inbox message arrives while the session is idle (while-loop blocked
    // in nextMessage()), the inbox peek in the loop head won't fire until the next message.
    // Listen here and push a synthetic wakeup so the queue drains immediately.
    session.client.on('a2aMessageReceived', () => {
        session.a2aInboxTurn?.peekInbox();
    });

    // Create permission handler
    const permissionHandler = new PermissionHandler(session);
    session.syncPermissionMode = (mode) => permissionHandler.handleModeChange(mode);

    // Create outgoing message queue
    const messageQueue = new OutgoingMessageQueue(
        (logMessage) => {
            session.client.sendClaudeSessionMessage(logMessage);
        }
    );

    // Set up callback to release delayed messages when permission is requested
    permissionHandler.setOnPermissionRequest((toolCallId: string) => {
        messageQueue.releaseToolCall(toolCallId);
    });

    // Create SDK to Log converter (pass responses from permissions)
    const sdkToLogConverter = new SDKToLogConverter({
        sessionId: session.sessionId || 'unknown',
        cwd: session.path,
        version: process.env.npm_package_version
    }, permissionHandler.getResponses());


    // Handle messages
    let planModeToolCalls = new Set<string>();
    let ongoingToolCalls = new Map<string, { parentToolCallId: string | null }>();
    let pendingSkillSuppress = false;
    // Real model name as reported by the assistant message itself (e.g. "claude-sonnet-5").
    // Unlike the configured model code (ANTHROPIC_MODEL / ANTHROPIC_DEFAULT_*_MODEL, which can
    // be any operator-chosen string), this reflects what the provider actually routed the turn to.
    // Seeded from metadata.contextUsage.model (persisted by a prior process) so a freshly
    // resumed/restarted process doesn't fall back to the configured model code for the turns
    // before its first real assistant message arrives.
    let lastRealModel: string | undefined = session.client.getMetadata()?.contextUsage?.model;

    // Pop echo: sent once on first SDK message, after Claude starts processing.
    let pendingPopEcho: { echoedMessageId: string; text: string } | null = null;

    function onMessage(message: SDKMessage) {
        // Filter out <synthetic> assistant messages replayed from session history on resume.
        // These are historical messages re-streamed by the SDK when --resume is used.
        // Sending them to the App would duplicate conversation history, and /context
        // results from previous runs would appear as new assistant messages.
        if (
            message.type === 'assistant' &&
            (message as SDKAssistantMessage).message != null &&
            ((message as SDKAssistantMessage).message as any).model === '<synthetic>'
        ) {
            return;
        }

        // Track the real provider-reported model from assistant messages (e.g. "claude-sonnet-5").
        // This is the authoritative model name — unlike the configured model code from
        // system init / ANTHROPIC_DEFAULT_*_MODEL, which is just an operator-chosen string.
        // Only track the main agent's model (parent_tool_use_id == null) — subagent Task calls
        // (e.g. Agent tool_use with model: "sonnet") can run a different model than the main
        // agent, and we don't want their model to override what the App shows for the session.
        if (message.type === 'assistant' && (message as SDKAssistantMessage).parent_tool_use_id == null) {
            const realModel = ((message as SDKAssistantMessage).message as any)?.model;
            if (typeof realModel === 'string' && realModel.length > 0) {
                lastRealModel = realModel;
            }
        }

        // Send pop echo on first SDK message — Claude has started processing.
        if (pendingPopEcho) {
            const p = pendingPopEcho;
            pendingPopEcho = null;
            logger.debug(`[remote] popEcho firing: echoedMessageId=${p.echoedMessageId} text=${p.text.slice(0, 60)}`);
            session.client.sendSessionProtocolMessage(
                createEnvelope('user', { t: 'text', text: p.text }),
                { echoedMessageId: p.echoedMessageId }
            );
        }

        // Write to message log
        formatClaudeMessageForInk(message, messageBuffer);

        // Write to permission handler for tool id resolving
        permissionHandler.onMessage(message);

        // Detect plan mode tool call
        if (message.type === 'assistant') {
            let umessage = message as SDKAssistantMessage;
            if (umessage.message.content && Array.isArray(umessage.message.content)) {
                for (let c of umessage.message.content) {
                    if (c.type === 'tool_use' && (c.name === 'exit_plan_mode' || c.name === 'ExitPlanMode')) {
                        logger.debug('[remote]: detected plan mode tool call ' + c.id!);
                        planModeToolCalls.add(c.id! as string);
                    }
                }
            }
        }

        // Track active tool calls + Skill suppression
        if (message.type === 'assistant') {
            let umessage = message as SDKAssistantMessage;
            if (umessage.message.content && Array.isArray(umessage.message.content)) {
                for (let c of umessage.message.content) {
                    if (c.type === 'tool_use') {
                        logger.debug('[remote] V2 detected tool use ' + c.name + ' ' + c.id! + ' parent: ' + umessage.parent_tool_use_id);
                        ongoingToolCalls.set(c.id!, { parentToolCallId: umessage.parent_tool_use_id ?? null });
                        if (c.name === 'Skill') {
                            logger.debug('[remote] Skill tool_use detected: ' + JSON.stringify(c.input).slice(0, 100));
                            pendingSkillSuppress = true;
                        }
                    }
                }
            }
        }
        if (message.type === 'user') {
            let umessage = message as SDKUserMessage;
            if (umessage.message.content && Array.isArray(umessage.message.content)) {
                for (let c of umessage.message.content) {
                    if (c.type === 'tool_result' && c.tool_use_id) {
                        ongoingToolCalls.delete(c.tool_use_id);

                        // When tool result received, release any delayed messages for this tool call
                        messageQueue.releaseToolCall(c.tool_use_id);
                    }
                }
            }
        }

        // Convert SDK message to log format and send to client
        let msg = message;

        // Hack plan mode exit
        if (message.type === 'user') {
            let umessage = message as SDKUserMessage;
            if (umessage.message.content && Array.isArray(umessage.message.content)) {
                msg = {
                    ...umessage,
                    message: {
                        ...umessage.message,
                        content: umessage.message.content.map((c) => {
                            if (c.type === 'tool_result' && c.tool_use_id && planModeToolCalls.has(c.tool_use_id!)) {
                                if (c.content === PLAN_FAKE_REJECT) {
                                    logger.debug('[remote]: hack plan mode exit');
                                    logger.debugLargeJson('[remote]: hack plan mode exit', c);
                                    return {
                                        ...c,
                                        is_error: false,
                                        content: 'Plan approved',
                                        mode: c.mode
                                    }
                                } else {
                                    return c;
                                }
                            }
                            return c;
                        })
                    }
                }
            }
        }

        const logMessage = sdkToLogConverter.convert(msg);
        if (logMessage) {
            // Suppress Skill-injected user messages
            if (pendingSkillSuppress && logMessage.type === 'user') {
                logger.debug('[remote] Suppressing Skill user message, text: ' + JSON.stringify(logMessage.message?.content).slice(0,100));
                pendingSkillSuppress = false;
                return;
            }
            // Add permissions field to tool result content
            if (logMessage.type === 'user' && logMessage.message?.content) {
                const content = Array.isArray(logMessage.message.content)
                    ? logMessage.message.content
                    : [];

                // Modify the content array to add permissions to each tool_result
                for (let i = 0; i < content.length; i++) {
                    const c = content[i];
                    if (c.type === 'tool_result' && c.tool_use_id) {
                        const responses = permissionHandler.getResponses();
                        const response = responses.get(c.tool_use_id);

                        if (response) {
                            const permissions: PermissionsField = {
                                date: response.receivedAt || Date.now(),
                                result: response.approved ? 'approved' : 'denied'
                            };

                            // Add optional fields if they exist
                            if (response.mode) {
                                permissions.mode = response.mode;
                            }

                            if (response.allowTools && response.allowTools.length > 0) {
                                permissions.allowedTools = response.allowTools;
                            }

                            // Add permissions directly to the tool_result content object
                            content[i] = {
                                ...c,
                                permissions
                            };
                        }
                    }
                }
            }

            // Queue message with optional delay for tool calls
            if (logMessage.type === 'assistant' && message.type === 'assistant') {
                const assistantMsg = message as SDKAssistantMessage;
                const toolCallIds: string[] = [];

                if (assistantMsg.message.content && Array.isArray(assistantMsg.message.content)) {
                    for (const block of assistantMsg.message.content) {
                        if (block.type === 'tool_use' && block.id) {
                            toolCallIds.push(block.id);
                        }
                    }
                }

                if (toolCallIds.length > 0) {
                    // Check if this is a sidechain tool call (has parent_tool_use_id)
                    const isSidechain = assistantMsg.parent_tool_use_id !== undefined;

                    if (!isSidechain) {
                        // Top-level tool call - queue with delay
                        messageQueue.enqueue(logMessage, {
                            delay: 250,
                            toolCallIds
                        });
                        return; // Don't queue again below
                    }
                }
            }

            // Queue all other messages immediately (no delay)
            messageQueue.enqueue(logMessage);
        }

        // Insert a fake message to start the sidechain
        if (message.type === 'assistant') {
            let umessage = message as SDKAssistantMessage;
            if (umessage.message.content && Array.isArray(umessage.message.content)) {
                for (let c of umessage.message.content) {
                    if (c.type === 'tool_use' && c.name === 'Task' && c.input && typeof (c.input as any).prompt === 'string') {
                        const logMessage2 = sdkToLogConverter.convertSidechainUserMessage(c.id!, (c.input as any).prompt);
                        if (logMessage2) {
                            messageQueue.enqueue(logMessage2);
                        }
                    }
                }
            }
        }
    }

    try {
        let pending: {
            message: string;
            mode: EnhancedMode;
            meta?: unknown;
            hash?: string | null;
        } | null = null;
        let wasInboxTurn = false;
        let wasCompactTurn = false;
        let turnSucceeded = false;
        /** Last accurate contextUsage from get_context_usage control request (includes breakdown). */
        let lastContextUsage: { currentTokens: number; maxTokens: number; pct: number; fetchedAt: number; breakdown?: { systemPrompt: number; systemTools: number; customAgents: number; skills: number; messages: number; freeSpace: number } } | undefined;

        // Track session ID to detect when it actually changes
        // This prevents context loss when mode changes (permission mode, model, etc.)
        // without starting a new session. Only reset parent chain when session ID
        // actually changes (e.g., new session started or /clear command used).
        // See: https://github.com/anthropics/happy-cli/issues/143
        let previousSessionId: string | null = null;
        while (!exitReason) {
            // Before each turn, peek inbox: if there are unread messages,
            // push an isolated inbox turn to the message queue.
            session.a2aInboxTurn?.peekInbox();
            logger.debug('[remote]: launch');
            messageBuffer.addMessage('═'.repeat(40), 'status');

            // Only reset parent chain and show "new session" message when session ID actually changes
            const isNewSession = session.sessionId !== previousSessionId;
            if (isNewSession) {
                messageBuffer.addMessage('Starting new Claude session...', 'status');
                permissionHandler.reset(); // Reset permissions before starting new session
                sdkToLogConverter.resetParentChain(); // Reset parent chain for new conversation
                logger.debug(`[remote]: New session detected (previous: ${previousSessionId}, current: ${session.sessionId})`);
            } else {
                messageBuffer.addMessage('Continuing Claude session...', 'status');
                logger.debug(`[remote]: Continuing existing session: ${session.sessionId}`);
            }

            previousSessionId = session.sessionId;
            const controller = new AbortController();
            abortController = controller;
            abortFuture = new Future<void>();
            // Start the independent cron producer if not already running.
            if (!cronLoopPromise) {
                cronLoopPromise = (async () => {
                    const sig = controller.signal;
                    while (!sig.aborted) {
                        const crons = session.pendingCrons
                            ? Array.from(session.pendingCrons.values())
                            : [];
                        if (crons.length === 0) {
                            await new Promise<void>(r => {
                                const t = setTimeout(r, 5000);
                                sig.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true });
                            });
                            continue;
                        }
                        const now = Date.now();
                        for (const c of crons) c.nextFireAt = nextCronFire(c.schedule, now);
                        const soonest = crons.reduce((a, b) => a.nextFireAt < b.nextFireAt ? a : b);
                        if (soonest.nextFireAt <= now) {
                            session.pendingCrons?.delete(soonest.id);
                            if (!soonest.recurring) {
                                if (!session.firedCronIds) session.firedCronIds = new Set();
                                session.firedCronIds.add(soonest.id);
                            }
                            // Sync compact cron list to agentState after removal
                            const remainingCrons: Record<string, { schedule: string; recurring: boolean }> = {};
                            for (const c of session.pendingCrons?.values() ?? []) {
                                remainingCrons[c.id] = { schedule: c.schedule, recurring: c.recurring };
                            }
                            session.client.updateAgentState(s => ({ ...s, crons: remainingCrons }));
                            logger.debug(`[remote] cron injecting: ${soonest.id} "${soonest.prompt.slice(0, 60)}"`);
                            session.queue.push(soonest.prompt,
                                { permissionMode: 'default', model: null as string | null, fallbackModel: null as string | null } as EnhancedMode,
                                { origin: 'auto-continuation', cronId: soonest.id });
                        } else {
                            const delay = soonest.nextFireAt - now;
                            await new Promise<void>(r => {
                                const t = setTimeout(r, delay);
                                sig.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true });
                            });
                        }
                    }
                })();
            }
            let modeHash: string | null = null;
            let mode: EnhancedMode | null = null;
            /** Set by onBeforeStop just before stopSignal resolves; prevents nextMessage
             *  from consuming another queue item that would then be lost by the inputLoop. */
            let turnStopping = false;
            wasInboxTurn = false;
            wasCompactTurn = false;
            turnSucceeded = false;
            try {
                const remoteResult = await claudeRemote({
                    sessionId: session.sessionId,
                    path: session.path,
                    allowedTools: session.allowedTools ?? [],
                    mcpServers: session.mcpServers,
                    hookSettingsPath: session.hookSettingsPath,
                    jsRuntime: session.jsRuntime,
                    signal: controller.signal,
                    canCallTool: permissionHandler.handleToolCall,
                    isAborted: (toolCallId: string) => {
                        return permissionHandler.isAborted(toolCallId);
                    },
                    nextMessage: async () => {
                        if (pending) {
                            let p = pending;
                            pending = null;
                            permissionHandler.handleModeChange(p.mode.permissionMode);
                            // A deferred inbox turn needs the same setup that the inline
                            // inbox path does: setInboxTurnActive + prepareInboxTurnPrompt
                            // (which also resets a2aTurnQueued so peekInbox can re-fire).
                            const inboxHooksP = session.a2aInboxTurn;
                            if (inboxHooksP?.isInboxTurnMeta(p.meta)) {
                                inboxHooksP.setInboxTurnActive(true);
                                const inboxPrompt = inboxHooksP.prepareInboxTurnPrompt();
                                if (!inboxPrompt) {
                                    inboxHooksP.setInboxTurnActive(false);
                                    return null;
                                }
                                wasInboxTurn = true;
                                if (session.claudeTurnActiveRef) {
                                    session.claudeTurnActiveRef.current = true;
                                }
                                modeHash = p.hash ?? null;
                                // Inbox turns must not change the model — use the current
                                // session mode so the agent keeps running on the same model.
                                const inboxMode = mode ?? p.mode;
                                mode = inboxMode;
                                session.client.suppressNextMapperUserText();
                                session.onThinkingChange(true);
                                return { message: inboxPrompt, mode: inboxMode };
                            }
                            return p;
                        }

                        const msg = await session.queue.waitForMessagesAndGetAsString(controller.signal);

                        // If the turn is stopping (stopSignal about to resolve), the inputLoop
                        // will discard our return value. Stash the message in pending so
                        // the next claudeRemote() call picks it up rather than losing it.
                        if (msg && turnStopping) {
                            logger.debug(`[remote] nextMessage stashing msg to pending (turn stopping): msgHash=${msg.hash?.slice(0,8)}`);
                            pending = { message: msg.message, mode: msg.mode, meta: msg.meta, hash: msg.hash };
                            return null;
                        }

                        // Echo the app's messageId back via session protocol so the App
                        // can clear its outbox. The envelope id becomes the server localId,
                        // which the App matches via claimSentMessageLocalIdByValue.

                        // Check if mode has changed
                        if (msg) {
                            const inboxHooks = session.a2aInboxTurn;
                            const isInboxTurn = inboxHooks?.isInboxTurnMeta(msg.meta) ?? false;
                            if (isInboxTurn) {
                                // If a turn is already in progress (modeHash set), the inputLoop
                                // is running concurrently with the outputLoop. Injecting an inbox
                                // turn mid-stream sends the inbox prompt to Claude while it is
                                // still processing the previous task — Claude won't drain the
                                // inbox, triggering false backoff. Defer to the next
                                // claudeRemote() call so it starts as a fresh turn.
                                if (modeHash !== null) {
                                    logger.debug('[remote] nextMessage deferring inbox turn (turn in progress, modeHash set)');
                                    pending = { message: msg.message, mode: msg.mode, meta: msg.meta, hash: msg.hash };
                                    return null;
                                }
                                inboxHooks?.setInboxTurnActive(true);
                                const inboxPrompt = inboxHooks?.prepareInboxTurnPrompt();
                                if (!inboxPrompt) {
                                    inboxHooks?.setInboxTurnActive(false);
                                    return null;
                                }
                                wasInboxTurn = true;
                                if (session.claudeTurnActiveRef) {
                                    session.claudeTurnActiveRef.current = true;
                                }
                                modeHash = msg.hash;
                                // Inbox turns must not change the model — use the current
                                // session mode so the agent keeps running on the same model.
                                const inboxMode = mode ?? msg.mode;
                                mode = inboxMode;
                                permissionHandler.handleModeChange(inboxMode.permissionMode);
                                logger.debug('[remote]: processing A2A inbox turn');
                                // Suppress the inbox notification prompt from appearing as a
                                // user bubble in the App — it is an internal CLI-injected turn.
                                session.client.suppressNextMapperUserText();
                                // Signal thinking immediately on message receipt, before SDK is invoked
                                session.onThinkingChange(true);
                                return {
                                    message: inboxPrompt,
                                    mode: inboxMode,
                                };
                            }
                            wasInboxTurn = false;
                            if ((modeHash && msg.hash !== modeHash) || msg.isolate) {
                                logger.info(`[remote] nextMessage returning null (mode changed): modeHash=${modeHash?.slice(0,8)} msgHash=${msg.hash?.slice(0,8)} isolate=${msg.isolate}`);
                                pending = { message: msg.message, mode: msg.mode, meta: msg.meta, hash: msg.hash };
                                return null;
                            }
                            // When a permission request is pending (e.g. AskUserQuestion),
                            // the SDK is blocked on canCallTool.  The input loop pushes
                            // messages into the SDK's input stream, but the SDK won't
                            // consume them until canCallTool resolves.  If the turn fails,
                            // those messages are permanently lost.  Defer to the next turn
                            // so they are safely re-processed via the pending path above.
                            if (permissionHandler.hasPendingRequests()) {
                                logger.debug('[remote] nextMessage deferring message (permission request pending)');
                                pending = { message: msg.message, mode: msg.mode, meta: msg.meta, hash: msg.hash };
                                return null;
                            }
                            if (session.claudeTurnActiveRef) {
                                session.claudeTurnActiveRef.current = true;
                            }
                            modeHash = msg.hash;
                            logger.info(`[remote] nextMessage kept in-process: msgHash=${msg.hash?.slice(0,8)} appMessageId=${(msg.meta as any)?.appMessageId ?? 'none'} origin=${(msg.meta as any)?.origin ?? 'none'}`);
                            mode = msg.mode;
                            permissionHandler.handleModeChange(mode.permissionMode);
                            // Signal thinking immediately on message receipt, before SDK is invoked
                            session.onThinkingChange(true);
                            // Cron/auto-continuation: send user message envelope at dequeue time.
                            // No echoedMessageId — there's no App outbox to clear.
                            if ((msg.meta as any)?.origin === 'auto-continuation') {
                                session.client.sendSessionProtocolMessage(
                                    createEnvelope('user', { t: 'text', text: msg.message }, {
                                        meta: { origin: 'auto-continuation', cronId: (msg.meta as any).cronId },
                                    }),
                                );
                                logger.debug(`[remote] cron envelope sent for ${(msg.meta as any).cronId}`);
                            }
                            // Pop echo for App messages: deferred to first SDK response so the
                            // App sees the green check when Claude starts processing.
                            const appMessageId = (msg.meta as any)?.appMessageId as string | undefined;
                            if (appMessageId) {
                                pendingPopEcho = { echoedMessageId: appMessageId, text: msg.message };
                                logger.debug(`[remote] popEcho pending for appMessageId=${appMessageId}`);
                            }
                            const wrapperMeta = msg.meta as { meta?: unknown; files?: unknown[] } | undefined;
                            return {
                                message: msg.message,
                                mode: msg.mode,
                                meta: msg.meta,
                                files: wrapperMeta?.files as any[] | undefined,
                            }
                        }

                        // Exit
                        return null;
                    },
                    onSessionFound: (sessionId) => {
                        // Update converter's session ID when new session is found
                        sdkToLogConverter.updateSessionId(sessionId);
                        session.onSessionFound(sessionId);
                    },
                    onModelInit: (info) => {
                        session.onModelInit(info);
                    },
                    onThinkingChange: (t) => {
                        session.onThinkingChange(t);
                    },
                    claudeEnvVars: session.claudeEnvVars,
                    claudeEnvVarsGeneration: session.claudeEnvVarsGeneration,
                    getClaudeEnvVarsGeneration: () => session.claudeEnvVarsGeneration,
                    claudeArgs: session.claudeArgs,
                    onMessage,
                    onCompletionEvent: (message: string) => {
                        logger.debug(`[remote]: Completion event: ${message}`);
                        session.client.sendSessionEvent({ type: 'message', message });
                        // Tag compact turns so the subsequent /context fetch is skipped.
                        // Compact forks the session; the next turn should be a fresh user
                        // message, not an inline context query on the old extras.
                        if (message === 'Compaction completed') {
                            wasCompactTurn = true;
                        }
                    },
                    onSessionReset: () => {
                        logger.debug('[remote]: Session reset');
                        session.clearSessionId();
                    },
                    onEnvChanged: (msg: { message: string; mode: EnhancedMode }) => {
                        logger.debug('[remote]: Env changed, re-queuing message as pending');
                        pending = msg;
                    },
                    onReady: (result) => {
                        const isError = result.is_error === true;
                        turnSucceeded = !isError;
                        const usage = buildClaudeTurnUsagePayload(result);
                        const extras: Record<string, unknown> = {};
                        // Prefer the real provider-reported model (from assistant messages) over
                        // modelUsage's key, which is just the configured model code and can be
                        // any operator-chosen string (e.g. a custom ANTHROPIC_DEFAULT_*_MODEL).
                        if (usage) extras.usage = lastRealModel ? { ...usage, model: lastRealModel } : usage;
                        if (typeof result.total_cost_usd === 'number') extras.costUsd = result.total_cost_usd;
                        if (typeof result.duration_ms === 'number') extras.durationMs = result.duration_ms;
                        // Attach contextUsage — use last known accurate value from get_context_usage.
                        // Do not fall back to usage.context_size here: that value is an estimate
                        // from cumulative cacheRead tokens which can exceed the context window for
                        // long autoloop sessions. The control_request result will follow shortly.
                        if (lastContextUsage) extras.contextUsage = lastContextUsage as any;

                        if (isError) {
                            session.client.closeClaudeSessionTurn('failed');
                            const msg = typeof result.result === 'string' && result.result.trim().length > 0
                                ? result.result.trim()
                                : 'Claude exited with an error';
                            session.client.sendSessionEvent({ type: 'message', message: msg });
                        } else {
                            session.client.closeClaudeSessionTurn('completed', extras);
                            // Update metadata's contextUsage.model with the real provider-reported
                            // model name (cheap — just captured from assistant messages). Only
                            // patches into existing contextUsage so we don't create a dummy entry
                            // with zero tokens that would show a broken 0% progress bar in the App.
                            if (lastRealModel) {
                                void session.client.updateMetadata((m) => {
                                    if (!m.contextUsage) return m;
                                    return { ...m, contextUsage: { ...m.contextUsage, model: lastRealModel } };
                                });
                            }
                        }
                        if (session.claudeTurnActiveRef) {
                            session.claudeTurnActiveRef.current = false;
                        }
                        if (wasInboxTurn) {
                            session.a2aInboxTurn?.setInboxTurnActive(false);
                            session.a2aInboxTurn?.onTurnEnd({
                                succeeded: !isError,
                                cancelled: false,
                                wasInboxTurn: true,
                            });
                            wasInboxTurn = false;
                            turnSucceeded = false;
                        }
                        wasCompactTurn = false;
                        if (!pending && session.queue.size() === 0) {
                            session.api.push().sendToAllDevices(
                                'It\'s ready!',
                                `Claude is waiting for your command`,
                                { sessionId: session.client.sessionId }
                            );
                        }
                    },
                    onContextUsage: (usage) => {
                        lastContextUsage = {
                            currentTokens: usage.totalTokens,
                            maxTokens: usage.maxTokens,
                            pct: Math.round((usage.totalTokens / usage.maxTokens) * 100),
                            fetchedAt: Date.now(),
                            ...(usage.breakdown ? { breakdown: usage.breakdown } : {}),
                        };
                        logger.debug(`[remote]: context via control_request: ${usage.totalTokens} / ${usage.maxTokens} (${Math.round((usage.totalTokens / usage.maxTokens) * 100)}%)`);
                    },
                    onContextOutput: undefined,
                    onSessionCrons: (crons) => {
                        if (!session.pendingCrons) {
                            session.pendingCrons = new Map();
                        }
                        if (!session.firedCronIds) {
                            session.firedCronIds = new Set();
                        }
                        for (const c of crons) {
                            // Skip one-shot crons that already fired — the Stop hook
                            // re-reports them from Claude's in-memory state.
                            if (session.firedCronIds.has(c.id)) continue;
                            session.pendingCrons.set(c.id, {
                                id: c.id,
                                schedule: c.schedule,
                                recurring: c.recurring,
                                prompt: c.prompt,
                                nextFireAt: 0, // computed by nextCronFire on each loop iteration
                            });
                        }
                        // Sync compact cron list to agentState so the App can show
                        // a badge / count in the session list without downloading full prompts.
                        const cronState: Record<string, { schedule: string; recurring: boolean }> = {};
                        for (const c of crons) {
                            if (session.firedCronIds?.has(c.id)) continue;
                            cronState[c.id] = { schedule: c.schedule, recurring: c.recurring };
                        }
                        session.client.updateAgentState(s => ({ ...s, crons: cronState }));
                        logger.debug(`[remote] stored ${crons.length} crons from Stop hook`);
                    },
                    onBeforeStop: () => { turnStopping = true; },
                    tryConsumeInboxTurn: () => {
                        const inboxHooks = session.a2aInboxTurn;
                        if (!inboxHooks) return null;
                        const claimed = session.queue.tryConsumeIsolated();
                        if (!claimed || !inboxHooks.isInboxTurnMeta(claimed.meta)) return null;
                        inboxHooks.setInboxTurnActive(true);
                        const inboxPrompt = inboxHooks.prepareInboxTurnPrompt();
                        if (!inboxPrompt) {
                            inboxHooks.setInboxTurnActive(false);
                            return null;
                        }
                        wasInboxTurn = true;
                        if (session.claudeTurnActiveRef) {
                            session.claudeTurnActiveRef.current = true;
                        }
                        session.client.suppressNextMapperUserText();
                        logger.debug('[remote]: processing A2A inbox turn in-process');
                        return inboxPrompt;
                    },
                });
                
                // Consume one-time Claude flags after spawn
                session.consumeOneTimeFlags();
                
                if (!exitReason && abortController.signal.aborted) {
                    session.client.closeClaudeSessionTurn('cancelled');
                    session.client.sendSessionEvent({ type: 'message', message: 'Aborted by user' });
                }
            } catch (e) {
                logger.debug('[remote]: launch error', formatLaunchError(e));
                if (!exitReason) {
                    session.client.closeClaudeSessionTurn('failed');
                    session.client.sendSessionEvent({ type: 'message', message: 'Process exited unexpectedly' });
                    continue;
                }
            } finally {

                logger.debug('[remote]: launch finally');

                // Terminate all ongoing tool calls
                for (let [toolCallId, { parentToolCallId }] of ongoingToolCalls) {
                    const converted = sdkToLogConverter.generateInterruptedToolResult(toolCallId, parentToolCallId);
                    if (converted) {
                        logger.debug('[remote]: terminating tool call ' + toolCallId + ' parent: ' + parentToolCallId);
                        session.client.sendClaudeSessionMessage(converted);
                    }
                }
                ongoingToolCalls.clear();

                // Flush any remaining messages in the queue
                logger.debug('[remote]: flushing message queue');
                await messageQueue.flush();
                messageQueue.destroy();
                logger.debug('[remote]: message queue flushed');

                const turnCancelled = abortController?.signal.aborted ?? false;
                // Reset abort controller and future
                abortController = null;
                abortFuture?.resolve(undefined);
                abortFuture = null;
                logger.debug('[remote]: launch done');
                permissionHandler.reset();
                if (session.claudeTurnActiveRef) {
                    session.claudeTurnActiveRef.current = false;
                }
                // onReady pops inbox-turn MCP scope on the happy path. When claudeRemote()
                // returns without ever delivering a result (env-changed re-spawn, abort,
                // unexpected exit), the scope leaks and every future peekInbox() sees
                // hasScope('inbox-turn') === true and defers forever, deadlocking the inbox.
                if (wasInboxTurn && session.a2aInboxTurn?.isInboxTurnActive()) {
                    session.a2aInboxTurn.setInboxTurnActive(false);
                }
                session.a2aInboxTurn?.onTurnEnd({
                    succeeded: turnSucceeded && !turnCancelled,
                    cancelled: turnCancelled,
                    wasInboxTurn,
                });
                modeHash = null;
                mode = null;
            }
        }
    } finally {

        // Clean up permission handler
        permissionHandler.reset();

        // Reset Terminal
        process.stdin.off('data', abort);
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(false);
        }
        if (inkInstance) {
            inkInstance.unmount();
        }
        messageBuffer.clear();

        // Stop the cron loop and resolve abort future
        cronLoopPromise?.catch(() => {});
        if (abortFuture) { // Just in case of error
            abortFuture.resolve(undefined);
        }
    }

    return exitReason || 'exit';
}
