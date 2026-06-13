import { render } from "ink";
import { Session } from "./session";
import { MessageBuffer } from "@/ui/ink/messageBuffer";
import { RemoteModeDisplay } from "@/ui/ink/RemoteModeDisplay";
import React from "react";
import { claudeRemote } from "./claudeRemote";
import { PermissionHandler } from "./utils/permissionHandler";
import { Future } from "@/utils/future";
import { SDKAssistantMessage, SDKMessage, SDKUserMessage } from "./sdk";
import { formatClaudeMessageForInk } from "@/ui/messageFormatterInk";
import { logger } from "@/ui/logger";
import { SDKToLogConverter } from "./utils/sdkToLogConverter";
import { PLAN_FAKE_REJECT } from "./sdk/prompts";
import { EnhancedMode } from "./loop";
import { RawJSONLines } from "@/claude/types";
import { OutgoingMessageQueue } from "./utils/OutgoingMessageQueue";
import { getToolName } from "./utils/getToolName";
import { buildClaudeTurnUsagePayload } from "./utils/claudeTurnUsage";
import { createEnvelope } from '@slopus/happy-wire';
import { parseContextUsageOutput, buildContextUsagePayload } from './utils/parseContextUsage';

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
    // Removed catch-all stdin handler - now handled by RemoteModeDisplay keyboard handlers

    // Create permission handler
    const permissionHandler = new PermissionHandler(session);
    session.syncPermissionMode = (mode) => permissionHandler.handleModeChange(mode);

    // True while processing a /context fetch turn — suppress all output to the App.
    let suppressContextOutput = false;
    // True between pushing the contextFetch pending and onReady completing it.
    // Prevents the concurrent inputLoop from resetting suppressContextOutput
    // before the outputLoop finishes draining the /context response.
    let contextFetchActive = false;

    // Create outgoing message queue
    const messageQueue = new OutgoingMessageQueue(
        (logMessage) => {
            if (suppressContextOutput) return;
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

    // Pop echo: sent once on first SDK message, after Claude starts processing.
    let pendingPopEcho: { echoedMessageId: string; text: string } | null = null;

    function onMessage(message: SDKMessage) {
        // Send pop echo on first SDK message — Claude has started processing.
        if (pendingPopEcho) {
            const p = pendingPopEcho;
            pendingPopEcho = null;
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
                        logger.debug('[remote]: detected tool use ' + c.id! + ' parent: ' + umessage.parent_tool_use_id);
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
            // Suppress all output during /context fetch mini-turns so only the
            // parsed contextUsage data reaches the App.
            if (suppressContextOutput) return;
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
        /** Carries the previous turn's extras across the /context fetch mini-turn. */
        let pendingTurnContext: { extras: Record<string, unknown>; meta: Record<string, unknown> } | undefined;

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
            let modeHash: string | null = null;
            let mode: EnhancedMode | null = null;
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
                    canCallTool: permissionHandler.handleToolCall,
                    isAborted: (toolCallId: string) => {
                        return permissionHandler.isAborted(toolCallId);
                    },
                    nextMessage: async () => {
                        if (pending) {
                            let p = pending;
                            pending = null;
                            // Suppress output from /context fetch mini-turns.
                            // Only toggle ON for context; let the flag ride through
                            // the queue flush (which runs on setTimeout(0)) and clear
                            // it on the next non-context message.
                            if ((p.meta as any)?.contextFetch) {
                                suppressContextOutput = true;
                            } else {
                                suppressContextOutput = false;
                            }
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
                                mode = p.mode;
                                session.client.suppressNextMapperUserText();
                                session.onThinkingChange(true);
                                return { message: inboxPrompt, mode: p.mode };
                            }
                            return p;
                        }

                        let msg = await session.queue.waitForMessagesAndGetAsString(controller.signal);
                        // Any message from the real queue (not a deferred pending context
                        // fetch) means the suppress flag should be off — but only if a
                        // context fetch isn't currently active (outputLoop might still be
                        // draining the /context response on the other fiber).
                        if (!contextFetchActive) {
                            suppressContextOutput = false;
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
                                mode = msg.mode;
                                permissionHandler.handleModeChange(mode.permissionMode);
                                logger.debug('[remote]: processing A2A inbox turn');
                                // Suppress the inbox notification prompt from appearing as a
                                // user bubble in the App — it is an internal CLI-injected turn.
                                session.client.suppressNextMapperUserText();
                                // Signal thinking immediately on message receipt, before SDK is invoked
                                session.onThinkingChange(true);
                                return {
                                    message: inboxPrompt,
                                    mode: msg.mode,
                                };
                            }
                            wasInboxTurn = false;
                            if ((modeHash && msg.hash !== modeHash) || msg.isolate) {
                                logger.info(`[remote] nextMessage returning null (mode changed): modeHash=${modeHash?.slice(0,8)} msgHash=${msg.hash?.slice(0,8)} isolate=${msg.isolate}`);
                                pending = { message: msg.message, mode: msg.mode, meta: msg.meta };
                                return null;
                            }
                            if (session.claudeTurnActiveRef) {
                                session.claudeTurnActiveRef.current = true;
                            }
                            modeHash = msg.hash;
                            logger.info(`[remote] nextMessage kept in-process: msgHash=${msg.hash?.slice(0,8)}`);
                            mode = msg.mode;
                            permissionHandler.handleModeChange(mode.permissionMode);
                            // Signal thinking immediately on message receipt, before SDK is invoked
                            session.onThinkingChange(true);
                            // Save for pop echo on first SDK response. Deferring until
                            // Claude starts processing shows green check on App.
                            const appMessageId = (msg.meta as any)?.appMessageId as string | undefined;
                            if (appMessageId) {
                                pendingPopEcho = { echoedMessageId: appMessageId, text: msg.message };
                            }
                            return {
                                message: msg.message,
                                mode: msg.mode
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
                    onThinkingChange: session.onThinkingChange,
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
                        if (usage) extras.usage = usage;
                        // Stale /context snapshot for non-context turns (before the next
                        // /context fetch resolves). Updated after context parsing below.
                        const lastCtx = (session.client as any)._lastContextUsage;
                        if (lastCtx) extras.contextUsage = lastCtx;
                        if (typeof result.total_cost_usd === 'number') extras.costUsd = result.total_cost_usd;
                        if (typeof result.duration_ms === 'number') extras.durationMs = result.duration_ms;

                        // Context fetch response: parse and update metadata.
                        const isContextFetch = !!(pendingTurnContext?.meta as any)?.contextFetch;
                        if (isContextFetch && !isError) {
                            const contextParsed = parseContextUsageOutput(
                                typeof result.result === 'string' ? result.result : '',
                            );
                            if (contextParsed) {
                                const ctxUsage = buildContextUsagePayload(contextParsed);
                                const prevExtras = pendingTurnContext?.extras ?? {};
                                // Persist so non-context turns can stamp it.
                                (session.client as any)._lastContextUsage = ctxUsage;
                                // contextUsage is a top-level property alongside costUsd/durationMs.
                                extras.contextUsage = ctxUsage;
                                // Carry forward the previous turn's usage (API data).
                                if (prevExtras.usage) extras.usage = prevExtras.usage;
                                logger.debug(
                                    `[remote]: /context resolved: ${contextParsed.currentTokens} / ${contextParsed.maxTokens} tokens (${Math.round((contextParsed.currentTokens / contextParsed.maxTokens) * 100)}%)`,
                                );
                            }
                            // Consume context fetch, close the PREVIOUS turn, then notify.
                            pendingTurnContext = undefined;
                            contextFetchActive = false;
                            suppressContextOutput = false;
                            session.client.closeClaudeSessionTurn('completed', extras);
                            session.api.push().sendToAllDevices(
                                'It\'s ready!',
                                `Claude is waiting for your command`,
                                { sessionId: session.client.sessionId },
                            );
                            return;
                        }

                        if (isError) {
                            // If context fetch failed, still close the previous turn.
                            if (pendingTurnContext) {
                                contextFetchActive = false;
                                suppressContextOutput = false;
                                session.client.closeClaudeSessionTurn('completed', pendingTurnContext.extras ?? {});
                                pendingTurnContext = undefined;
                                return;
                            }
                            session.client.closeClaudeSessionTurn('failed');
                            const msg = typeof result.result === 'string' && result.result.trim().length > 0
                                ? result.result.trim()
                                : 'Claude exited with an error';
                            session.client.sendSessionEvent({ type: 'message', message: msg });
                        } else {
                            session.client.closeClaudeSessionTurn('completed', extras);
                        }
                        // Per-turn release (Cursor clears currentTurnIdRef before peekA2AInboxInLoop).
                        // claudeTurnActiveRef stayed true across multi-turn claudeRemote() calls, which
                        // blocked scheduleA2ATurnIfNeeded in onTurnEnd until process exit.
                        if (session.claudeTurnActiveRef) {
                            session.claudeTurnActiveRef.current = false;
                        }
                        if (wasInboxTurn) {
                            session.a2aInboxTurn?.setInboxTurnActive(false);
                            // claudeRemote()'s for-await loop keeps iterating across turns, so the
                            // launcher's finally-block onTurnEnd never runs between back-to-back
                            // inbox turns. Settle the inbox turn here so backoff can arm and
                            // unconsumed inbox messages don't tight-loop.
                            session.a2aInboxTurn?.onTurnEnd({
                                succeeded: !isError,
                                cancelled: false,
                                wasInboxTurn: true,
                            });
                            // Already accounted for; prevent the finally block from double-firing.
                            wasInboxTurn = false;
                            turnSucceeded = false;
                        }
                        // Queue /context for the next turn so we get accurate context usage
                        // before "It's ready". Only for successful non-inbox, non-compact turns.
                        // Compact forks the session; the old extras are no longer valid and
                        // the context fetch would leak its output into the App.
                        if (!isError && !wasInboxTurn && !wasCompactTurn) {
                            pendingTurnContext = { extras, meta: { contextFetch: true } };
                            pending = { message: '/context', mode: mode!, meta: { contextFetch: true } };
                            // Set suppress immediately so outputLoop blocks any
                            // SDK output that arrives before nextMessage() runs.
                            // contextFetchActive prevents the concurrent inputLoop
                            // from resetting suppressContextOutput via the queue path.
                            suppressContextOutput = true;
                            contextFetchActive = true;
                            wasCompactTurn = false;
                            return;
                        }
                        wasCompactTurn = false;
                        if (!isError && !pending && session.queue.size() === 0) {
                            session.api.push().sendToAllDevices(
                                'It\'s ready!',
                                `Claude is waiting for your command`,
                                { sessionId: session.client.sessionId }
                            );
                        }
                    },
                    signal: abortController.signal,
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

        // Resolve abort future
        if (abortFuture) { // Just in case of error
            abortFuture.resolve(undefined);
        }
    }

    return exitReason || 'exit';
}
