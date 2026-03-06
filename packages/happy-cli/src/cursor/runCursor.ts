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
import { Credentials, readSettings, writeSessionPidFile, removeSessionPidFile } from '@/persistence';
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

/**
 * Convert tool result to App output-format shape: content must be string (or array of { type, text }).
 * App schema does not accept object (e.g. { stdout, exitCode }); non-zero exitCode is treated as error.
 */
function toolResultForOutputFormat(result: unknown, isError: boolean): { content: string; is_error: boolean } {
  if (typeof result === 'string') return { content: result, is_error: isError };
  if (result && typeof result === 'object') {
    const o = result as Record<string, unknown>;
    if (typeof o.stdout === 'string') {
      const exitCode = typeof o.exitCode === 'number' ? o.exitCode : 0;
      return { content: o.stdout, is_error: isError || exitCode !== 0 };
    }
    if (typeof o.message === 'string') return { content: o.message, is_error: isError };
    if (typeof o.stderr === 'string' && isError) return { content: o.stderr, is_error: true };
  }
  return { content: JSON.stringify(result ?? ''), is_error: isError };
}
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
  /** Resume last session for same workspace (--resume / -r). Default: false (new session). */
  resumeSession?: boolean;
}): Promise<void> {
  const workspacePath = opts.workspaceRoot != null ? resolve(opts.workspaceRoot) : process.cwd();

  // Default: new session. Resume only with --resume/-r.
  const tagPath = join(configuration.happyHomeDir, CURSOR_SESSION_TAG_FILE);
  const workspacePathFile = join(configuration.happyHomeDir, CURSOR_SESSION_WORKSPACE_FILE);
  let sessionTag: string;
  let tagReused = false;
  if (opts.resumeSession) {
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
  } else {
    sessionTag = randomUUID();
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

  // flavor 'cursor' – revert to real flavor; was 'claude' temporarily so old App would show session
  // dangerouslySkipPermissions: false until user sends message with permissionMode (force => true); align with Claude/yolo
  const { state, metadata } = createSessionMetadata({
    flavor: 'cursor',
    machineId,
    startedBy: opts.startedBy,
    path: workspacePath,
    dangerouslySkipPermissions: false,
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
    model: mode.model ?? null,
  }));
  let currentPermissionMode: PermissionMode | undefined = undefined;
  let currentModel: string | undefined = undefined;
  const syncModeToSessionMetadata = (permissionMode: PermissionMode, model: string | undefined) => {
    const dangerouslySkipPermissions = permissionMode === 'force';
    session.updateMetadata((m) => ({
      ...m,
      currentOperatingModeCode: permissionMode,
      currentModelCode: model ?? undefined,
      dangerouslySkipPermissions,
    })).catch((err) => logger.debug('[Cursor] Failed to sync mode to session metadata', err));
  };

  const handleUserMessage = (message: { content: { text: string }; meta?: { permissionMode?: string; model?: string | null } }) => {
    let messagePermissionMode = currentPermissionMode;
    if (message.meta?.permissionMode) {
      const validModes: PermissionMode[] = ['default', 'plan', 'ask', 'force'];
      if (validModes.includes(message.meta.permissionMode as PermissionMode)) {
        messagePermissionMode = message.meta.permissionMode as PermissionMode;
        currentPermissionMode = messagePermissionMode;
        logger.debug(`[Cursor] Permission mode: ${currentPermissionMode}`);
      }
    }
    if (currentPermissionMode === undefined) {
      currentPermissionMode = 'default';
    }
    // Resolve model; explicit null from app resets to default (env or 'auto')
    let messageModel = currentModel;
    if (message.meta && Object.prototype.hasOwnProperty.call(message.meta, 'model')) {
      messageModel = message.meta.model ?? undefined;
      currentModel = messageModel;
      logger.debug(`[Cursor] Model: ${messageModel ?? 'default (reset)'}`);
    }
    const mode: CursorMode = {
      permissionMode: messagePermissionMode || 'default',
      model: messageModel,
    };
    // Persist permission/model and dangerouslySkipPermissions to session metadata so App can read them on next fetch (align with Claude: force = skip permissions)
    const metaChanged = message.meta?.permissionMode !== undefined || (message.meta && Object.prototype.hasOwnProperty.call(message.meta, 'model'));
    if (metaChanged) {
      const effectivePermission = messagePermissionMode || 'default';
      const effectiveModel = messageModel ?? 'default';
      const dangerouslySkipPermissions = effectivePermission === 'force';
      session.updateMetadata((m) => ({ ...m, currentOperatingModeCode: effectivePermission, currentModelCode: effectiveModel, dangerouslySkipPermissions })).catch((err) => logger.debug('[Cursor] Failed to persist permission/model to session metadata', err));
    }
    logger.debug(`[cursor] User message queued (length: ${message.content.text.length})`);
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
      // Re-register run-specific RPC handlers so kill/abort work after reconnect (they are not on the new session by default).
      newSession.rpcHandlerManager.registerHandler('abort', handleAbort);
      registerKillSessionHandler(newSession.rpcHandlerManager, handleKillSession);
    },
  });
  session = initialSession;
  session.onUserMessage(handleUserMessage);
  writeSessionPidFile(session.sessionId);
  // Persist initial default mode so app reload can restore it
  syncModeToSessionMetadata('default', undefined);

  // Report to daemon (once at start; also retry periodically so daemon sees us if it wasn't running at start)
  const DAEMON_REPORT_INTERVAL_MS = 60_000;
  const reportToDaemon = () => {
    if (!response) return;
    notifyDaemonSessionStarted(session.sessionId, { ...metadata, hostPid: process.pid }).then((result) => {
      if (result?.error) logger.debug(`[START] Daemon report failed:`, result.error);
    }).catch((err) => logger.debug('[START] Daemon report error:', err));
  };
  reportToDaemon();
  const daemonReportInterval = setInterval(reportToDaemon, DAEMON_REPORT_INTERVAL_MS);

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
    // Cursor format disabled: only send session protocol (old App / pretend Claude)
    // session.sendCursorMessage( {
    //   type: 'turn_aborted',
    //   id: randomUUID(),
    // });
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
    removeSessionPidFile();
    await handleAbort();

    try {
      if (session) {
        await session.updateMetadata((currentMetadata) => ({
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

  // Exit handlers: always run cleanup so server gets session-end (反注册)
  let exitHandled = false;
  const onExitSignal = () => {
    if (exitHandled) return;
    exitHandled = true;
    void handleKillSession();
  };
  process.on('SIGTERM', onExitSignal);
  process.on('SIGINT', onExitSignal);
  process.on('SIGHUP', onExitSignal);

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
  // Start Happy MCP server and register it for cursor-agent via .cursor/mcp.json.
  // Subagent tools (spawn_subagent etc.) are only injected when HAPPY_SUBAGENT_MCP=1,
  // as the cursor-agent native taskToolCall is preferred and doesn't need them.
  //

  let currentTurnIdRef: string | null = null;
  const enableSubagentMcp = process.env.HAPPY_SUBAGENT_MCP === '1';
  const happyServer = await startHappyServer(session, enableSubagentMcp ? {
    cursorContext: {
      getCurrentTurnId: () => currentTurnIdRef,
      sendSessionEnvelope: (envelope) => session.sendSessionProtocolMessage(envelope),
      workspacePath,
      getAbortSignal: () => abortController.signal,
    },
  } : {});
  ensureCursorMcpHappy(workspacePath, happyServer.url);
  logger.debug(`[cursor] Happy MCP: url=${happyServer.url}, workspacePath=${workspacePath}, subagentMcp=${enableSubagentMcp}`);

  // Optional: report Cursor IDE quota to server (monitor-only; path from cursorQuotaPaths, respects CURSOR_STATE_DB_PATH / CURSOR_USER_DATA_DIR)
  void (async () => {
    try {
      const { getCursorQuotaInfo, buildCursorUsageReportPayload, hasCursorStateDb } = await import('./cursorQuotaFetcher');
      if (!hasCursorStateDb()) return;
      const result = await getCursorQuotaInfo();
      if (result?.info && session.isSocketConnected()) {
        const payload = buildCursorUsageReportPayload(result.info);
        session.client.sendCursorQuotaReport(payload);
      }
    } catch (_) {
      // Ignore: sqlite3 missing, no Cursor auth, or API failure
    }
  })();

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
      logger.debug(`[cursor] Processing message (length: ${userMessage.length}); spawning cursor-agent`);

      // Cursor has no change_title MCP tool, so don't append that instruction (unlike Codex/Gemini)
      const prompt = userMessage;

      // Accumulated response text for final message to mobile
      let accumulatedResponse = '';
      let hadToolCalls = false;
      const turnId = createId();
      currentTurnIdRef = turnId;

      // Send user message: session protocol only. Store (old) App already has the user message from app send; dual-send output format would duplicate it. New App renders from this envelope.
      session.sendSessionProtocolMessage(createEnvelope('user', { t: 'text', text: userMessage }, { turn: turnId }));
      const messageParser = new CursorMessageParser();
      const codexIdByCallId = new Map<string, string>();
      /** Per-tool timeout: when fired we send tool_call_end (running in background) so App stops timer; process keeps running. */
      const toolCallTimeoutHandles = new Map<string, ReturnType<typeof setTimeout>>();
      let turnCompletedNormally = false;
      let turnEndStatus: 'completed' | 'failed' | 'cancelled' = 'completed';

      const flushAccumulatedText = () => {
        if (accumulatedResponse.trim()) {
          const text = accumulatedResponse;
          accumulatedResponse = '';
          // Dual-send: output (old App) + session (new App)
          session.sendOutputFormatMessage({ type: 'assistant', uuid: randomUUID(), message: { role: 'assistant', model: 'cursor', content: [{ type: 'text', text }] } });
          session.sendSessionProtocolMessage(createEnvelope('agent', { t: 'text', text }, { turn: turnId }));
        }
      };

      try {
        thinking = true;
        session.keepAlive(thinking, 'remote');

        // Send turn-start in wrapped shape (type: 'session', data) so store App lifecycle check sees contentType === 'session'
        session.sendSessionLifecycleEnvelope(createEnvelope('agent', { t: 'turn-start' }, { turn: turnId }));
        messageBuffer.addMessage('Thinking...', 'system');

        // Spawn cursor-agent process (second+ turn uses --resume so cursor-agent continues same chat)
        const cursorModel = mode.model ?? process.env.CURSOR_MODEL ?? 'auto';
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
          executionMode: mode.permissionMode === 'plan' ? 'plan' : mode.permissionMode === 'ask' ? 'ask' : undefined,
          force: mode.permissionMode === 'force',
          signal: abortController.signal,
          timeoutMs: processTimeoutMs,
          approveMcps: true, // load Happy MCP from .cursor/mcp.json without prompting
        });
        // Per-tool timeout: after this we send tool_call_end (running in background) so App stops timer; process keeps running.
        // 0 = disabled (Codex-style: no per-tool cutoff, only process timeout or natural tool_call_end).
        const perToolTimeoutMsRaw = process.env.CURSOR_TOOL_CALL_TIMEOUT_MS;
        const perToolTimeoutMs = perToolTimeoutMsRaw === undefined || perToolTimeoutMsRaw === ''
          ? 600000 // default 10 min
          : Math.max(0, parseInt(perToolTimeoutMsRaw, 10));

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
              // Show thinking in CLI only; do not stream thinking content to app (align with Codex: state via task_started/task_complete only).
              messageBuffer.updateLastMessage(`[Thinking] ${msg.text.slice(0, 100)}...`, 'system');
              break;

            case 'subagent_start':
              session.sendSessionProtocolMessage(createEnvelope('agent', { t: 'start' }, { turn: turnId, subagent: msg.subagentId }));
              break;

            case 'subagent_stop':
              session.sendSessionProtocolMessage(createEnvelope('agent', { t: 'stop' }, { turn: turnId, subagent: msg.subagentId }));
              break;

            case 'subagent_text': {
              const ev = msg.thinking
                ? { t: 'text' as const, text: msg.text, thinking: true }
                : { t: 'text' as const, text: msg.text };
              session.sendSessionProtocolMessage(createEnvelope('agent', ev, { turn: turnId, subagent: msg.subagentId }));
              break;
            }

            case 'tool_call_start':
              // Sidechain tool calls (from taskToolCall conversationSteps) — only send session envelope with subagent
              if (msg.subagentId) {
                const sidechainTitle = msg.description
                  ?? (typeof msg.args?.command === 'string' ? `Run \`${(msg.args.command as string).slice(0, 80)}\`` : `${msg.toolName} call`);
                session.sendSessionProtocolMessage(createEnvelope('agent', {
                  t: 'tool-call-start',
                  call: msg.callId,
                  name: msg.toolName,
                  title: sidechainTitle,
                  description: sidechainTitle,
                  args: msg.args,
                }, { turn: turnId, subagent: msg.subagentId }));
                break;
              }
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
              // Dual-send: output (old App) + session (new App)
              session.sendOutputFormatMessage({ type: 'assistant', uuid: randomUUID(), message: { role: 'assistant', model: 'cursor', content: [{ type: 'tool_use', id: msg.callId, name: codexName, input: codexInput }] } });
              // Session protocol: use original Cursor tool names and args so new App matches CursorBash/CursorRead/etc. knownTools entries
              const cursorCmd = typeof msg.args?.command === 'string' ? msg.args.command : null;
              const toolTitle = msg.description
                ?? (cursorCmd ? `Run \`${cursorCmd.length > 80 ? cursorCmd.slice(0, 77) + '...' : cursorCmd}\`` : `${msg.toolName} call`);
              session.sendSessionProtocolMessage(createEnvelope('agent', {
                t: 'tool-call-start',
                call: msg.callId,
                name: msg.toolName,
                title: toolTitle,
                description: toolTitle,
                args: msg.args,
              }, { turn: turnId }));
              // Codex + cursor tool-call for store App 1.5.0 (schema requires id; reducer uses callId)
              logger.debug(`[cursor] codex/cursor tool-call callId=${msg.callId.slice(0, 8)}... name=${codexName}`);
              const toolCallPayload = { type: 'tool-call' as const, callId: msg.callId, id: msg.callId, name: codexName, input: codexInput };
              session.sendCodexMessage(toolCallPayload);
              session.sendCursorMessage(toolCallPayload);
              session.flush().catch(() => {});
              // Per-tool timeout (Codex-style: 0 = disabled). When > 0: stop App timer and show "running in background"; process keeps running.
              if (perToolTimeoutMs > 0) {
                const handle = setTimeout(() => {
                  toolCallTimeoutHandles.delete(msg.callId);
                  const bgCodexId = codexIdByCallId.get(msg.callId);
                  const bgResult = { runningInBackground: true, message: 'Tool still running; timer stopped. Response will continue when it completes.' };
                  logger.debug(`[cursor] Per-tool timeout for ${msg.callId.slice(0, 8)}... – sending tool_call_end (running in background)`);
                  messageBuffer.addMessage('Still running (timer stopped)', 'result');
                  if (bgCodexId) {
                    const out = toolResultForOutputFormat(bgResult, false);
                    session.sendOutputFormatMessage({ type: 'user', uuid: randomUUID(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: msg.callId, content: out.content, is_error: out.is_error }] } });
                  }
                  const timeoutResultPayload = { type: 'tool-call-result' as const, callId: msg.callId, id: msg.callId, output: bgResult, is_error: false };
                  logger.debug(`[cursor] codex/cursor tool-call-result callId=${msg.callId.slice(0, 8)}... (timeout)`);
                  session.sendCodexMessage(timeoutResultPayload);
                  session.sendCursorMessage(timeoutResultPayload);
                  session.sendSessionProtocolMessage(createEnvelope('agent', { t: 'tool-call-end', call: msg.callId }, { turn: turnId }));
                }, perToolTimeoutMs);
                toolCallTimeoutHandles.set(msg.callId, handle);
              }
              break;

            case 'tool_call_end':
              // Sidechain tool calls — only send session envelope with subagent
              if (msg.subagentId) {
                session.sendSessionProtocolMessage(createEnvelope('agent', { t: 'tool-call-end', call: msg.callId }, { turn: turnId, subagent: msg.subagentId }));
                break;
              }
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
              const out = toolResultForOutputFormat(msg.result, !msg.success);
              session.sendOutputFormatMessage({ type: 'user', uuid: randomUUID(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: msg.callId, content: out.content, is_error: out.is_error }] } });
              const resultPayload = { type: 'tool-call-result' as const, callId: msg.callId, id: msg.callId, output: msg.result, is_error: out.is_error };
              logger.debug(`[cursor] codex/cursor tool-call-result callId=${msg.callId.slice(0, 8)}... success=${msg.success}`);
              session.sendCodexMessage(resultPayload);
              session.sendCursorMessage(resultPayload);
              // New App: session only gets tool-call-end; result is in tool card (no t:'text' for tool result)
              session.sendSessionProtocolMessage(createEnvelope('agent', { t: 'tool-call-end', call: msg.callId }, { turn: turnId }));
              session.flush().catch(() => {});
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
                const out = toolResultForOutputFormat(turnEndedResult, false);
                session.sendOutputFormatMessage({ type: 'user', uuid: randomUUID(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: callId, content: out.content, is_error: out.is_error }] } });
                const turnEndPayload = { type: 'tool-call-result' as const, callId, id: callId, output: turnEndedResult, is_error: false };
                logger.debug(`[cursor] codex/cursor tool-call-result callId=${callId.slice(0, 8)}... (turn ended)`);
                session.sendCodexMessage(turnEndPayload);
                session.sendCursorMessage(turnEndPayload);
                // New App: session only tool-call-end; no t:'text' for tool result
                session.sendSessionProtocolMessage(createEnvelope('agent', { t: 'tool-call-end', call: callId }, { turn: turnId }));
              }
              codexIdByCallId.clear();
              break;

            case 'error':
              messageBuffer.addMessage(`Error: ${msg.message}`, 'status');
              const errorText = `Error: ${msg.message}`;
              session.sendOutputFormatMessage({ type: 'assistant', uuid: randomUUID(), message: { role: 'assistant', model: 'cursor', content: [{ type: 'text', text: errorText }] } });
              session.sendSessionProtocolMessage(createEnvelope('agent', { t: 'text', text: errorText }, { turn: turnId }));
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
          session.sendOutputFormatMessage({ type: 'assistant', uuid: randomUUID(), message: { role: 'assistant', model: 'cursor', content: [{ type: 'text', text: 'Aborted by user' }] } });
          session.sendSessionProtocolMessage(createEnvelope('agent', { t: 'text', text: 'Aborted by user' }, { turn: turnId }));
        } else {
          const errorMsg = error instanceof Error ? error.message : 'Process error';
          logger.debug('[cursor] Error:', error);
          messageBuffer.addMessage(errorMsg, 'status');
          session.sendOutputFormatMessage({ type: 'assistant', uuid: randomUUID(), message: { role: 'assistant', model: 'cursor', content: [{ type: 'text', text: errorMsg }] } });
          session.sendSessionProtocolMessage(createEnvelope('agent', { t: 'text', text: errorMsg }, { turn: turnId }));
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
          const out = toolResultForOutputFormat(abortedResult, false);
          session.sendOutputFormatMessage({ type: 'user', uuid: randomUUID(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: callId, content: out.content, is_error: out.is_error }] } });
          const abortedPayload = { type: 'tool-call-result' as const, callId, id: callId, output: abortedResult, is_error: false };
          logger.debug(`[cursor] codex/cursor tool-call-result callId=${callId.slice(0, 8)}... (aborted)`);
          session.sendCodexMessage(abortedPayload);
          session.sendCursorMessage(abortedPayload);
          // New App: session only tool-call-end; no t:'text' for tool result
          session.sendSessionProtocolMessage(createEnvelope('agent', { t: 'tool-call-end', call: callId }, { turn: turnId }));
        }
        const hadPendingToolCalls = codexIdByCallId.size > 0;
        codexIdByCallId.clear();

        const status: 'completed' | 'failed' | 'cancelled' =
          turnCompletedNormally ? 'completed' : (hadPendingToolCalls ? 'failed' : turnEndStatus);
        // Codex + cursor task_complete for App builds that check them; id = task/turn id
        session.sendCodexMessage({ type: 'task_complete', id: turnId });
        session.sendCursorMessage({ type: 'task_complete', id: turnId });
        // Wrapped session turn-end so store App lifecycle (content.type === 'session', data.ev.t) stops timer
        session.sendSessionLifecycleEnvelope(createEnvelope('agent', { t: 'turn-end', status }, { turn: turnId }));

        // 1.5.0 App only stops timer via ephemeral activity (keepAlive), not message content; send before flush so it’s not delayed
        thinking = false;
        session.keepAlive(thinking, 'remote');

        await session.flush();

        // Clear parser state for next turn
        messageParser.clear();
        currentTurnIdRef = null;
        emitReadyIfIdle();

        logger.debug(`[cursor] Turn completed (queue: ${messageQueue.size()})`);
      }
    }

  } finally {
    // Cleanup
    logger.debug('[cursor]: Final cleanup start');
    removeSessionPidFile();

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
