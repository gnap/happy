/**
 * Cursor Agent CLI Entry Point
 *
 * Main entry point for running the Cursor agent through Happy CLI.
 * Follows the same architecture as runCodex/runGemini:
 * - Session management via Happy server
 * - Message queue for user prompts from mobile/web
 * - PTY-wrapped cursor-agent process per turn
 * - Stream-json output parsed into session protocol envelopes
 *
 * Dual send for old vs new App:
 * - Old App uses output format: sendOutputFormatMessage (assistant/user with content, tool_result in content).
 * - New App uses session protocol: sendSessionProtocolMessage (t: 'text' | 'tool-call' | 'tool-call-end' etc).
 * - For tool results: old App gets full tool_result in output; new App gets only tool-call-result + tool-call-end
 *   (result is shown in tool card), no session t:'text' for tool result — avoids duplicate in new App.
 */

import { render } from 'ink';
import React from 'react';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { configuration } from '@/configuration';

import { ApiClient } from '@/api/api';
import { logger } from '@/ui/logger';
import { Credentials, readSettings } from '@/persistence';
import { createSessionMetadata } from '@/utils/createSessionMetadata';
import { initialMachineMetadata } from '@/daemon/run';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import { projectPath } from '@/projectPath';
import { startHappyServer } from '@/claude/utils/startHappyServer';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { CodexDisplay } from '@/ui/ink/CodexDisplay';
import { notifyDaemonSessionStarted } from '@/daemon/controlClient';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import { stopCaffeinate } from '@/utils/caffeinate';
import { connectionState } from '@/utils/serverConnectionErrors';
import { setupOfflineReconnection } from '@/utils/setupOfflineReconnection';
import type { ApiSessionClient } from '@/api/apiSession';
import type { PermissionMode } from '@/api/types';

/**
 * Use native codex message format (type: 'codex') instead of ACP format
 * because the mobile app has dedicated handling for codex messages.
 */

import { createEnvelope } from '@slopus/happy-wire';
import { createId } from '@paralleldrive/cuid2';
import { CursorProcess } from './cursorProcess';
import { CursorMessageParser, type CursorParsedMessage } from './cursorMessageParser';
import type { CursorStreamMessage, CursorMode } from './types';

const CURSOR_SESSION_TAG_FILE = 'cursor-session-tag';
const CURSOR_SESSION_WORKSPACE_FILE = 'cursor-session-workspace';
const CURSOR_SESSION_KEY_FILE = 'cursor-session-key';

/** Ensure workspace .cursor/mcp.json has mcpServers.happy.url so cursor-agent can load Happy MCP. Merges with existing. */
function ensureCursorMcpHappy(workspacePath: string, happyUrl: string): void {
  const dir = join(workspacePath, '.cursor');
  const path = join(dir, 'mcp.json');
  let mcp: { mcpServers?: Record<string, { url?: string; command?: string; args?: string[] }> } = {};
  try {
    if (existsSync(path)) {
      const raw = readFileSync(path, 'utf8');
      mcp = JSON.parse(raw) as typeof mcp;
    }
  } catch {
    /* use empty */
  }
  if (!mcp.mcpServers) mcp.mcpServers = {};
  mcp.mcpServers.happy = { url: happyUrl };
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify(mcp, null, 2), 'utf8');
    logger.debug(`[cursor] MCP: wrote ${path} with happy url=${happyUrl} (cursor-agent will use --workspace + --approve-mcps)`);
  } catch (e) {
    logger.debug('[cursor] Could not write .cursor/mcp.json:', e);
  }
}

/**
 * Map Cursor tool name/args to Codex/app shape so the mobile app shows readable titles
 * instead of a raw object (e.g. CodexBash → "$ command", Read → file path).
 */
function toCodexToolShape(
  toolName: string,
  args: Record<string, unknown>,
): { codexName: string; codexInput: Record<string, unknown> } {
  if (toolName === 'CursorBash') {
    const cmd =
      typeof args?.command === 'string'
        ? args.command
        : Array.isArray(args?.command)
          ? (args.command as string[]).join(' ')
          : '';
    return {
      codexName: 'CodexBash',
      codexInput: {
        command: [cmd],
        parsed_cmd: [{ type: 'bash', cmd }],
      },
    };
  }
  if (toolName === 'CursorRead') {
    const path = (args?.path ?? args?.file_path) as string | undefined;
    return {
      codexName: 'Read',
      codexInput: { file_path: path ?? '' },
    };
  }
  if (toolName === 'CursorWrite') {
    const path = (args?.path ?? args?.file_path) as string | undefined;
    const content = (args?.content as string) ?? '';
    return {
      codexName: 'Write',
      codexInput: { file_path: path ?? '', content },
    };
  }
  if (toolName === 'CursorEdit') {
    const file_path = (args?.path ?? args?.file_path ?? args?.filePath) as string | undefined;
    const old_string = (args?.old_string ?? args?.oldString ?? args?.oldText) as string | undefined;
    const new_string = (args?.new_string ?? args?.newString ?? args?.newText) as string | undefined;
    return {
      codexName: 'Edit',
      codexInput: { file_path: file_path ?? '', old_string: old_string ?? '', new_string: new_string ?? '' },
    };
  }
  return { codexName: toolName, codexInput: args };
}

/**
 * Main entry point for the cursor command with ink UI.
 */
export async function runCursor(opts: {
  credentials: Credentials;
  startedBy?: 'daemon' | 'terminal';
  /** Workspace root for session, .cursor/mcp.json, and cursor-agent cwd. Defaults to process.cwd(). Set via --cwd or HAPPY_CURSOR_WORKSPACE when running from monorepo so MCP is under repo root. */
  workspaceRoot?: string;
}): Promise<void> {
  const workspacePath = opts.workspaceRoot != null ? resolve(opts.workspaceRoot) : process.cwd();

  // Reuse session only when workspace unchanged; workspace change => new session
  const tagPath = join(configuration.happyHomeDir, CURSOR_SESSION_TAG_FILE);
  const workspacePathFile = join(configuration.happyHomeDir, CURSOR_SESSION_WORKSPACE_FILE);
  let sessionTag: string;
  let tagReused = false;
  if (process.env.HAPPY_CURSOR_NEW_SESSION === '1') {
    sessionTag = randomUUID();
  } else {
    let savedTag: string | null = null;
    let savedWorkspace: string | null = null;
    try {
      if (existsSync(tagPath)) savedTag = readFileSync(tagPath, 'utf8').trim() || null;
      if (existsSync(workspacePathFile)) savedWorkspace = readFileSync(workspacePathFile, 'utf8').trim() || null;
    } catch {
      /* ignore */
    }
    const sameWorkspace = savedWorkspace != null && resolve(savedWorkspace) === resolve(workspacePath);
    if (savedTag && sameWorkspace) {
      sessionTag = savedTag;
      tagReused = true;
    } else {
      sessionTag = randomUUID();
    }
  }

  // Load existing encryption key when reusing session to avoid key mismatch
  const keyPath = join(configuration.happyHomeDir, CURSOR_SESSION_KEY_FILE);
  let existingEncryptionKey: Uint8Array | undefined;
  if (tagReused) {
    try {
      if (existsSync(keyPath)) {
        existingEncryptionKey = new Uint8Array(Buffer.from(readFileSync(keyPath, 'utf8').trim(), 'base64'));
      }
    } catch { /* ignore */ }
  }

  // Set backend for offline warnings
  connectionState.setBackend('Cursor');

  const api = await ApiClient.create(opts.credentials);

  //
  // Machine
  //

  const settings = await readSettings();
  const machineId = settings?.machineId;
  if (!machineId) {
    console.error(`[START] No machine ID found. Run "happy auth login" first.`);
    process.exit(1);
  }
  logger.debug(`Using machineId: ${machineId}`);
  await api.getOrCreateMachine({
    machineId,
    metadata: initialMachineMetadata,
  });

  //
  // Create session
  //

  const { state, metadata } = createSessionMetadata({
    flavor: 'codex', // Disguised as codex until mobile app supports 'cursor'
    machineId,
    startedBy: opts.startedBy,
    path: workspacePath,
  });
  const response = await api.getOrCreateSession({ tag: sessionTag, metadata, state, existingEncryptionKey });

  const sessionId = response?.id ?? `offline-${sessionTag}`;
  logger.debug(`[cursor] Session: ${sessionId} (tag: ${sessionTag.slice(0, 8)}..., reused: ${tagReused})`);
  logger.debug(`[cursor] Workspace: ${workspacePath}`);
  if (tagReused) {
    logger.debug('[cursor] Reusing session – open this same conversation in the app (or tap "It\'s ready!" push) so CLI and phone stay in sync.');
  } else if (response && process.stdout.isTTY) {
    // New session: show in terminal so user can refresh App list or tap push
    console.log(`[cursor] New session created: ${sessionId}`);
    console.log('[cursor] In the App: pull-to-refresh the session list, or tap the "It\'s ready!" push to open this session.');
  }

  // Persist session tag, workspace, and encryption key so next restart reuses correctly
  try {
    writeFileSync(tagPath, sessionTag, 'utf8');
    writeFileSync(workspacePathFile, workspacePath, 'utf8');
    if (response) {
      writeFileSync(keyPath, Buffer.from(response.encryptionKey).toString('base64'), 'utf8');
    }
  } catch (e) {
    logger.debug('[cursor] Could not write session tag/workspace/key file:', e);
  }

  // Message queue and user-message handler (must exist before setupOfflineReconnection so onSessionSwap can re-register)
  const messageQueue = new MessageQueue2<CursorMode>((mode) => hashObject({
    permissionMode: mode.permissionMode,
  }));
  let currentPermissionMode: PermissionMode | undefined = undefined;
  const handleUserMessage = (message: { content: { text: string }; meta?: { permissionMode?: string } }) => {
    let messagePermissionMode = currentPermissionMode;
    if (message.meta?.permissionMode) {
      const validModes: PermissionMode[] = ['default', 'read-only', 'safe-yolo', 'yolo'];
      if (validModes.includes(message.meta.permissionMode as PermissionMode)) {
        messagePermissionMode = message.meta.permissionMode as PermissionMode;
        currentPermissionMode = messagePermissionMode;
        logger.debug(`[Cursor] Permission mode: ${currentPermissionMode}`);
      }
    }
    if (currentPermissionMode === undefined) {
      currentPermissionMode = 'default';
    }
    const mode: CursorMode = {
      permissionMode: messagePermissionMode || 'default',
    };
    messageQueue.push(message.content.text, mode);
  };

  // Handle server unreachable - offline stub with hot reconnection
  let session: ApiSessionClient;
  const { session: initialSession, reconnectionHandle } = setupOfflineReconnection({
    api,
    sessionTag,
    metadata,
    state,
    response,
    existingEncryptionKey,
    onSessionSwap: (newSession) => {
      session = newSession;
      newSession.onUserMessage(handleUserMessage);
    },
  });
  session = initialSession;
  session.onUserMessage(handleUserMessage);

  // Report to daemon
  if (response) {
    try {
      logger.debug(`[START] Reporting session ${response.id} to daemon`);
      const result = await notifyDaemonSessionStarted(response.id, metadata);
      if (result.error) {
        logger.debug(`[START] Failed to report to daemon:`, result.error);
      }
    } catch (error) {
      logger.debug('[START] Failed to report to daemon:', error);
    }
  }


  //
  // Keep-alive
  //

  let thinking = false;
  session.keepAlive(thinking, 'remote');
  const keepAliveInterval = setInterval(() => {
    session.keepAlive(thinking, 'remote');
  }, 2000);


  const sendReady = () => {
    session.sendSessionEvent({ type: 'ready' });
    try {
      api.push().sendToAllDevices(
        "It's ready!",
        'Cursor is waiting for your command',
        { sessionId: session.sessionId },
      );
    } catch (pushError) {
      logger.debug('[Cursor] Failed to send ready push', pushError);
    }
  };

  const emitReadyIfIdle = (): boolean => {
    if (shouldExit) return false;
    if (thinking) return false;
    if (messageQueue.size() > 0) return false;
    sendReady();
    return true;
  };

  //
  // Abort handling
  //

  let abortController = new AbortController();
  let shouldExit = false;
  let cursorChatId: string | null = null;

  async function handleAbort() {
    logger.debug('[Cursor] Abort requested');
    session.sendCodexMessage( {
      type: 'turn_aborted',
      id: randomUUID(),
    });
    try {
      abortController.abort();
      messageQueue.reset();
    } catch (error) {
      logger.debug('[Cursor] Error during abort:', error);
    } finally {
      abortController = new AbortController();
    }
  }

  const handleKillSession = async () => {
    logger.debug('[Cursor] Kill session requested');
    await handleAbort();

    try {
      if (session) {
        session.updateMetadata((currentMetadata) => ({
          ...currentMetadata,
          lifecycleState: 'archived',
          lifecycleStateSince: Date.now(),
          archivedBy: 'cli',
          archiveReason: 'User terminated',
        }));
        session.sendSessionDeath();
        await session.flush();
        await session.close();
      }
      stopCaffeinate();
      happyServer.stop();
      process.exit(0);
    } catch (error) {
      logger.debug('[Cursor] Error during session termination:', error);
      process.exit(1);
    }
  };

  session.rpcHandlerManager.registerHandler('abort', handleAbort);
  registerKillSessionHandler(session.rpcHandlerManager, handleKillSession);

  //
  // Initialize Ink UI (reuse CodexDisplay since layout is similar)
  //

  const messageBuffer = new MessageBuffer();
  const hasTTY = process.stdout.isTTY && process.stdin.isTTY;
  let inkInstance: ReturnType<typeof render> | null = null;

  if (hasTTY) {
    console.clear();
    inkInstance = render(React.createElement(CodexDisplay, {
      messageBuffer,
      logPath: process.env.DEBUG ? logger.getLogPath() : undefined,
      onExit: async () => {
        logger.debug('[cursor]: Exiting agent via Ctrl-C');
        shouldExit = true;
        await handleAbort();
      },
    }), {
      exitOnCtrlC: false,
      patchConsole: false,
    });
  }

  if (hasTTY) {
    process.stdin.resume();
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.setEncoding('utf8');
  }

  //
  // Start Happy MCP server
  //

  const happyServer = await startHappyServer(session);
  ensureCursorMcpHappy(workspacePath, happyServer.url);
  logger.debug(`[cursor] Happy MCP: url=${happyServer.url}, workspacePath=${workspacePath}, cursor-agent will be spawned with --approve-mcps`);

  //
  // Main loop
  //

  let first = true;

  // Send "It's ready!" once on startup so mobile can open this session (critical when reusing session after restart)
  emitReadyIfIdle();

  // Log connection state after a short delay (helps debug remote/SSH: socket vs HTTP fallback)
  setTimeout(() => {
    const connected = session.isSocketConnected();
    logger.debug(`[cursor] Session real-time: ${connected ? 'socket connected' : 'disconnected (using HTTP poll)'} sessionId=${sessionId}`);
    if (!connected) {
      logger.debug('[cursor] If remote/SSH: ensure outbound access to HAPPY_SERVER_URL. App↔CLI messages still work via HTTP fallback.');
    }
  }, 3500);

  try {
    while (!shouldExit) {
      const waitSignal = abortController.signal;
      const batch = await messageQueue.waitForMessagesAndGetAsString(waitSignal);
      if (!batch) {
        if (waitSignal.aborted && !shouldExit) {
          logger.debug('[cursor] Wait aborted while idle, continuing');
          continue;
        }
        break;
      }

      const { message: userMessage, mode } = batch;
      messageBuffer.addMessage(userMessage, 'user');
      logger.debug(`[cursor] Received message (length: ${userMessage.length})`);

      // Cursor has no change_title MCP tool, so don't append that instruction (unlike Codex/Gemini)
      const prompt = userMessage;

      // Accumulated response text for final message to mobile
      let accumulatedResponse = '';
      let hadToolCalls = false;
      const turnId = createId();
      const messageParser = new CursorMessageParser();
      const codexIdByCallId = new Map<string, string>();
      /** Per-tool timeout: when fired we send tool_call_end (running in background) so App stops timer; process keeps running. */
      const toolCallTimeoutHandles = new Map<string, ReturnType<typeof setTimeout>>();
      let turnCompletedNormally = false;
      let turnEndStatus: 'completed' | 'failed' | 'cancelled' = 'completed';

      const flushAccumulatedText = () => {
        if (accumulatedResponse.trim()) {
          session.sendCodexMessage({
            type: 'message',
            message: accumulatedResponse,
          });
          accumulatedResponse = '';
        }
      };

      try {
        thinking = true;
        session.keepAlive(thinking, 'remote');

        // Send task_started (codex) and turn-start (session protocol) so mobile starts timer
        session.sendCodexMessage( {
          type: 'task_started',
          id: randomUUID(),
        });
        session.sendSessionProtocolMessage(createEnvelope('agent', { t: 'turn-start' }, { turn: turnId }));
        messageBuffer.addMessage('Thinking...', 'system');

        // Spawn cursor-agent process (second+ turn uses --resume so cursor-agent continues same chat)
        const cursorModel = process.env.CURSOR_MODEL || 'auto';
        const resumeId = cursorChatId || undefined;
        if (resumeId) {
          logger.debug(`[cursor] Resuming chat: ${resumeId}`);
        } else {
          logger.debug('[cursor] First turn, no resume');
        }
        // Process timeout: safety net only (default 1h). Long tool calls are handled by per-tool timeout below.
        const processTimeoutMs = process.env.CURSOR_AGENT_PROCESS_TIMEOUT_MS
          ? parseInt(process.env.CURSOR_AGENT_PROCESS_TIMEOUT_MS, 10)
          : 3600000; // 1 hour; set to 0 to disable
        const cursorProc = new CursorProcess({
          cwd: workspacePath,
          resumeChatId: resumeId,
          model: cursorModel,
          signal: abortController.signal,
          timeoutMs: processTimeoutMs,
        });
        // Per-tool timeout: after this we send tool_call_end (running in background) so App stops timer; process keeps running.
        const perToolTimeoutMs = process.env.CURSOR_TOOL_CALL_TIMEOUT_MS
          ? parseInt(process.env.CURSOR_TOOL_CALL_TIMEOUT_MS, 10)
          : 600000; // 10 min; long builds e.g. yarn ios:dev may exceed, but timer stops and conversation continues

        // Handle stream-json messages
        cursorProc.on('message', (rawMsg: CursorStreamMessage) => {
          const typeInfo = 'type' in rawMsg ? `${rawMsg.type}` : 'unknown';
          const subtypeInfo = 'subtype' in rawMsg && rawMsg.subtype ? ` subtype=${rawMsg.subtype}` : '';
          logger.debug(`[cursor] stream-json: ${typeInfo}${subtypeInfo} (pending tool calls: ${codexIdByCallId.size})`);

          const parsed = messageParser.parse(rawMsg);
          for (const msg of parsed) {
            handleParsedMessage(msg);
          }
        });

        function handleParsedMessage(msg: CursorParsedMessage) {
          switch (msg.type) {
            case 'session_init':
              if (msg.sessionId) {
                cursorChatId = msg.sessionId;
                logger.debug(`[cursor] Chat ID: ${cursorChatId}`);
              }
              break;

            case 'text_delta':
              accumulatedResponse += msg.text;
              messageBuffer.removeLastMessage('system');
              messageBuffer.addMessage(msg.text, 'assistant');
              break;

            case 'thinking_delta':
              messageBuffer.updateLastMessage(`[Thinking] ${msg.text.slice(0, 100)}...`, 'system');
              session.sendCodexMessage( {
                type: 'thinking',
                text: msg.text,
              });
              break;

            case 'tool_call_start':
              flushAccumulatedText();
              hadToolCalls = true;
              const toolArgs = JSON.stringify(msg.args).slice(0, 100);
              const cmdPreview = (msg.toolName === 'CursorBash' && typeof msg.args?.command === 'string')
                ? msg.args.command.slice(0, 60) + (msg.args.command.length > 60 ? '...' : '')
                : toolArgs;
              logger.debug(`[cursor] Shell/tool started: ${msg.toolName} ${cmdPreview} (callId: ${msg.callId.slice(0, 8)}..., pending: ${codexIdByCallId.size + 1})`);
              messageBuffer.addMessage(`Executing: ${msg.toolName} ${toolArgs}`, 'tool');
              const { codexName, codexInput } = toCodexToolShape(msg.toolName, msg.args);
              const codexId = randomUUID();
              codexIdByCallId.set(msg.callId, codexId);
              session.sendCodexMessage( {
                type: 'tool-call',
                name: codexName,
                callId: msg.callId,
                input: codexInput,
                id: codexId,
              });
              // Session protocol: timer uses tool-call-start / tool-call-end to stop
              const cmd = Array.isArray((codexInput as { command?: unknown })?.command)
                ? (codexInput as { command: string[] }).command.join(' ')
                : (codexInput as { command?: string })?.command ?? '';
              const toolTitle = cmd ? `Run \`${cmd.length > 80 ? cmd.slice(0, 77) + '...' : cmd}\`` : `${codexName} call`;
              session.sendSessionProtocolMessage(createEnvelope('agent', {
                t: 'tool-call-start',
                call: msg.callId,
                name: codexName,
                title: toolTitle,
                description: toolTitle,
                args: codexInput,
              }, { turn: turnId }));
              // Per-tool timeout: stop App timer and show "running in background"; process keeps running, conversation continues
              const handle = setTimeout(() => {
                toolCallTimeoutHandles.delete(msg.callId);
                const bgCodexId = codexIdByCallId.get(msg.callId);
                const bgResult = { runningInBackground: true, message: 'Tool still running; timer stopped. Response will continue when it completes.' };
                logger.debug(`[cursor] Per-tool timeout for ${msg.callId.slice(0, 8)}... – sending tool_call_end (running in background)`);
                messageBuffer.addMessage('Still running (timer stopped)', 'result');
                if (bgCodexId) {
                  session.sendCodexMessage( { type: 'tool-call-result', callId: msg.callId, output: bgResult, id: bgCodexId } );
                }
                const timeoutResultPayload = { type: 'tool-call-result' as const, callId: msg.callId, id: msg.callId, output: bgResult, is_error: false };
                logger.debug(`[cursor] codex/cursor tool-call-result callId=${msg.callId.slice(0, 8)}... (timeout)`);
                session.sendCodexMessage(timeoutResultPayload);
                // New App: session only tool-call-end; no t:'text' for tool result
                session.sendSessionProtocolMessage(createEnvelope('agent', { t: 'tool-call-end', call: msg.callId }, { turn: turnId }));
              }, perToolTimeoutMs);
              toolCallTimeoutHandles.set(msg.callId, handle);
              break;

            case 'tool_call_end':
              const existingHandle = toolCallTimeoutHandles.get(msg.callId);
              if (existingHandle) {
                clearTimeout(existingHandle);
                toolCallTimeoutHandles.delete(msg.callId);
              }
              logger.debug(`[cursor] Shell/tool ended: ${msg.toolName} (callId: ${msg.callId.slice(0, 8)}..., success: ${msg.success}, pending after: ${codexIdByCallId.size - 1})`);
              const resultText = typeof msg.result === 'string'
                ? msg.result.slice(0, 200)
                : JSON.stringify(msg.result).slice(0, 200);
              messageBuffer.addMessage(
                msg.success ? `Result: ${resultText}` : `Error: ${resultText}`,
                'result',
              );
              const sameId = codexIdByCallId.get(msg.callId) ?? randomUUID();
              codexIdByCallId.delete(msg.callId);
              session.sendCodexMessage( {
                type: 'tool-call-result',
                callId: msg.callId,
                output: msg.result,
                id: sameId,
              });
              const resultPayload = { type: 'tool-call-result' as const, callId: msg.callId, id: msg.callId, output: msg.result, is_error: !msg.success };
              logger.debug(`[cursor] codex/cursor tool-call-result callId=${msg.callId.slice(0, 8)}... success=${msg.success}`);
              session.sendCodexMessage(resultPayload);
              // New App: session only gets tool-call-end; result is in tool card (no t:'text' for tool result)
              session.sendSessionProtocolMessage(createEnvelope('agent', { t: 'tool-call-end', call: msg.callId }, { turn: turnId }));
              break;

            case 'task_complete':
              turnCompletedNormally = true;
              for (const h of toolCallTimeoutHandles.values()) clearTimeout(h);
              toolCallTimeoutHandles.clear();
              if (msg.sessionId) {
                cursorChatId = msg.sessionId;
              }
              if (msg.costUsd !== undefined) {
                logger.debug(`[cursor] Cost: $${msg.costUsd}, Duration: ${msg.durationMs}ms`);
              }
              // Close any tool calls that never got tool_call_end (e.g. long-running shell still running when turn ended)
              // so the App stops their timers as soon as we know the turn is complete
              const turnEndedResult = { turnEnded: true, message: 'Turn completed; tool did not report end' };
              for (const [callId, codexId] of codexIdByCallId) {
                logger.debug(`[cursor] Closing pending tool call ${callId} (turn completed without tool end)`);
                messageBuffer.addMessage('Ended (turn completed)', 'result');
                session.sendCodexMessage( {
                  type: 'tool-call-result',
                  callId,
                  output: turnEndedResult,
                  id: codexId,
                });
                const turnEndPayload = { type: 'tool-call-result' as const, callId, id: callId, output: turnEndedResult, is_error: false };
                logger.debug(`[cursor] codex/cursor tool-call-result callId=${callId.slice(0, 8)}... (turn ended)`);
                session.sendCodexMessage(turnEndPayload);
                // New App: session only tool-call-end; no t:'text' for tool result
                session.sendSessionProtocolMessage(createEnvelope('agent', { t: 'tool-call-end', call: callId }, { turn: turnId }));
              }
              codexIdByCallId.clear();
              break;

            case 'error':
              messageBuffer.addMessage(`Error: ${msg.message}`, 'status');
              session.sendCodexMessage( {
                type: 'message',
                message: `Error: ${msg.message}`,
              });
              break;
          }
        }

        // Run the process (blocks until exit)
        await cursorProc.run(prompt);

        first = false;

      } catch (error) {
        const isAbortError = error instanceof Error && error.name === 'AbortError';
        turnEndStatus = isAbortError ? 'cancelled' : 'failed';
        if (isAbortError) {
          messageBuffer.addMessage('Aborted by user', 'status');
          session.sendCodexMessage({ type: 'message', message: 'Aborted by user' });
        } else {
          const errorMsg = error instanceof Error ? error.message : 'Process error';
          logger.debug('[cursor] Error:', error);
          messageBuffer.addMessage(errorMsg, 'status');
          session.sendCodexMessage( {
            type: 'message',
            message: errorMsg,
          });
        }
      } finally {
        flushAccumulatedText();
        for (const h of toolCallTimeoutHandles.values()) clearTimeout(h);
        toolCallTimeoutHandles.clear();

        // Close any tool calls that never got tool_call_end (cursor-agent aborted, crashed, or timed out)
        const abortedResult = { aborted: true, message: 'Tool call ended without result (agent aborted or exited)' };
        for (const [callId, codexId] of codexIdByCallId) {
          logger.debug(`[cursor] Closing pending tool call ${callId} (no end from cursor-agent)`);
          messageBuffer.addMessage('Ended without result (aborted or exited)', 'result');
          session.sendCodexMessage( {
            type: 'tool-call-result',
            callId,
            output: abortedResult,
            id: codexId,
          });
          const abortedPayload = { type: 'tool-call-result' as const, callId, id: callId, output: abortedResult, is_error: false };
          logger.debug(`[cursor] codex/cursor tool-call-result callId=${callId.slice(0, 8)}... (aborted)`);
          session.sendCodexMessage(abortedPayload);
          // New App: session only tool-call-end; no t:'text' for tool result
          session.sendSessionProtocolMessage(createEnvelope('agent', { t: 'tool-call-end', call: callId }, { turn: turnId }));
        }
        const hadPendingToolCalls = codexIdByCallId.size > 0;
        codexIdByCallId.clear();

        const status: 'completed' | 'failed' | 'cancelled' =
          turnCompletedNormally ? 'completed' : (hadPendingToolCalls ? 'failed' : turnEndStatus);
        session.sendCodexMessage( {
          type: 'task_complete',
          id: randomUUID(),
        });
        session.sendSessionProtocolMessage(createEnvelope('agent', { t: 'turn-end', status }, { turn: turnId }));

        await session.flush();

        // Clear parser state for next turn
        messageParser.clear();

        thinking = false;
        session.keepAlive(thinking, 'remote');
        emitReadyIfIdle();

        logger.debug(`[cursor] Turn completed (queue: ${messageQueue.size()})`);
      }
    }

  } finally {
    // Cleanup
    logger.debug('[cursor]: Final cleanup start');

    if (reconnectionHandle) {
      reconnectionHandle.cancel();
    }

    try {
      session.sendSessionDeath();
      await session.flush();
      await session.close();
    } catch (e) {
      logger.debug('[cursor]: Error closing session', e);
    }

    happyServer.stop();

    if (process.stdin.isTTY) {
      try { process.stdin.setRawMode(false); } catch { /* ignore */ }
    }
    if (hasTTY) {
      try { process.stdin.pause(); } catch { /* ignore */ }
    }

    clearInterval(keepAliveInterval);
    if (inkInstance) {
      inkInstance.unmount();
    }
    messageBuffer.clear();

    logger.debug('[cursor]: Final cleanup completed');
  }
}
