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
import { randomBytes, randomUUID } from 'node:crypto';
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

import { createEnvelope, type SessionEvent } from '@slopus/happy-wire';

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

interface CursorModelInfo {
  code: string;
  value: string;
  description?: string | null;
}

interface CursorModelListResult {
  models: CursorModelInfo[];
  currentModelId: string;
}

async function fetchCursorModels(): Promise<CursorModelListResult | null> {
  const apiKey = process.env.CURSOR_API_KEY?.trim()
    || process.env.CURSOR_TOKEN?.trim()
    || process.env.CURSOR_AUTH_TOKEN?.trim();
  if (!apiKey) {
    logger.debug('[cursor] fetchCursorModels: no Cursor API key found, skipping');
    return null;
  }

  try {
    const response = await fetch('https://api.cursor.com/v0/models', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      logger.debug(`[cursor] fetchCursorModels: request failed with ${response.status}`);
      return null;
    }

    const payload = await response.json() as { models?: unknown };
    const rawModels = Array.isArray(payload.models) ? payload.models : [];
    const models = rawModels
      .filter((model): model is string => typeof model === 'string' && model.trim().length > 0)
      .map((code) => ({ code, value: code }));

    if (models.length === 0) {
      return null;
    }

    return {
      models,
      currentModelId: models[0]?.code ?? 'auto',
    };
  } catch (error) {
    logger.debug('[cursor] fetchCursorModels threw:', error);
    return null;
  }
}

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
 * Derive a human-readable title from tool name and args.
 * Uses the tool's primary input key (path for file tools, command for bash)
 * so the App can display a meaningful title without relying on the agent's
 * generic title field.
 */
function deriveToolTitle(toolName: string, args: Record<string, unknown> | undefined): string {
  const a = args ?? {};
  const path = typeof (a.path ?? a.file_path ?? a.filePath) === 'string'
    ? String(a.path ?? a.file_path ?? a.filePath)
    : '';
  if (['CursorRead', 'Read', 'CursorWrite', 'Write', 'CursorEdit', 'Edit'].includes(toolName) && path) {
    return path;
  }
  const cmd = typeof a.command === 'string' ? a.command : '';
  if (['CursorBash', 'Bash'].includes(toolName) && cmd) {
    return `Run \`${cmd.length > 80 ? cmd.slice(0, 77) + '...' : cmd}\``;
  }
  return toolName;
}

/** Enable with DEBUG=1 or HAPPY_SESSION_TIMING=1 to log startup phase timings (ms from runCursor entry). */
function shouldLogStartupTiming(): boolean {
  return process.env.DEBUG === '1' || process.env.HAPPY_SESSION_TIMING === '1';
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
  /** Explicit session tag to resume when daemon respawns this cursor process. */
  resumeSessionTag?: string;
  /** Set by index.ts: Date.now() at start of CLI async IIFE, so we can report "time to runCursor entry". */
  cliStartTime?: number;
}): Promise<void> {
  const workspacePath = opts.workspaceRoot != null ? resolve(opts.workspaceRoot) : process.cwd();

  // Reuse session only when workspace unchanged; workspace change => new session.
  const tagPath = join(configuration.happyHomeDir, CURSOR_SESSION_TAG_FILE);
  const workspacePathFile = join(configuration.happyHomeDir, CURSOR_SESSION_WORKSPACE_FILE);
  let sessionTag: string;
  let tagReused = false;
  const explicitResumeTag = opts.resumeSessionTag?.trim() || null;
  if (explicitResumeTag) {
    sessionTag = explicitResumeTag;
    tagReused = true;
    logger.debug(`[cursor] Using session tag from CLI arg (--resume-session-tag): ${sessionTag.slice(0, 8)}...`);
  } else if (opts.resumeSession) {
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

  // For new sessions (tagReused=false), generate a stable key upfront so all POST
  // attempts — including offline reconnect retries — use the same AES key.
  // Without this, each retry generates a fresh random key: if the first timed-out
  // request reached the server, the server creates the session with key_1, but the
  // App caches key_1 while the reconnect writes key_2 to disk, causing a permanent
  // decrypt mismatch after "pause on exit" keeps the App's cached key stale.
  if (!existingEncryptionKey) {
    existingEncryptionKey = new Uint8Array(randomBytes(32));
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
    flavor: 'cursor',
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

  // Persist session tag, workspace, and encryption key so next restart reuses correctly.
  // The key is written unconditionally (using the pre-generated stable key) so that
  // even if the first getOrCreateSession request times out client-side but succeeds
  // server-side, the same key is available for subsequent reconnect retries and restarts.
  try {
    writeFileSync(tagPath, sessionTag, 'utf8');
    writeFileSync(workspacePathFile, workspacePath, 'utf8');
    writeFileSync(
      keyPath,
      Buffer.from(response?.encryptionKey ?? existingEncryptionKey!).toString('base64'),
      'utf8',
    );
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
      // Persist the encryption key after successful offline→online reconnection.
      // The pre-generated key was already written above when response was available;
      // writing it again here ensures it's on disk even when the first request timed out.
      try {
        writeFileSync(keyPath, Buffer.from(newSession.sessionEncryptionKey).toString('base64'), 'utf8');
      } catch (e) {
        logger.debug('[cursor] Could not write session key file after reconnect:', e);
      }
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

  // Refresh models from cursor-agent and update session metadata.
  // If the stored currentModelCode is no longer in the list (model was renamed/removed),
  // it resets to whatever cursor-agent currently considers the active model.
  const refreshModelsMetadata = () => {
    fetchCursorModels().then((result) => {
      if (!result || result.models.length === 0) {
        logger.debug('[cursor] refreshModelsMetadata: no models returned, skipping');
        return;
      }
      logger.debug(`[cursor] refreshModelsMetadata: ${result.models.length} models, current=${result.currentModelId}`);
      session.updateMetadata((m) => {
        const validCodes = new Set(result.models.map((mo) => mo.code));
        const stored = m.currentModelCode;
        const isStoredValid = !stored || stored === 'default' || stored === 'auto' || validCodes.has(stored);
        if (!isStoredValid) {
          logger.debug(`[cursor] refreshModelsMetadata: stored model "${stored}" not in new list, resetting to "${result.currentModelId}"`);
        }
        return {
          ...m,
          models: result.models,
          currentModelCode: isStoredValid ? (stored ?? result.currentModelId) : result.currentModelId,
        };
      }).catch((err) => logger.debug('[cursor] refreshModelsMetadata: failed to update metadata', err));
    }).catch((err) => logger.debug('[cursor] refreshModelsMetadata threw:', err));
  };

  // Initial fetch at session start
  refreshModelsMetadata();

  // Periodic refresh so the App sees model list updates pushed by cursor-agent (every 5 min)
  const MODEL_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
  const modelRefreshInterval = setInterval(refreshModelsMetadata, MODEL_REFRESH_INTERVAL_MS);


  // Sync current PID to server metadata so App always sees the latest PID after respawn.
  session.updateMetadata((m) => ({ ...m, hostPid: process.pid }))
    .catch((err) => logger.debug('[cursor] Failed to update hostPid in session metadata', err));

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
      agentLabel: 'Cursor',
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
  // Start Happy MCP server and register it for cursor-agent via .cursor/mcp.json
  // Expose current turn id and session send so spawn_subagent can emit subagent envelopes.
  //

  let currentTurnIdRef: string | null = null;
  const happyServer = await startHappyServer(session, {
    cursorContext: {
      getCurrentTurnId: () => currentTurnIdRef,
      sendSessionEnvelope: (envelope) => session.sendSessionProtocolMessage(envelope),
      workspacePath,
      getAbortSignal: () => abortController.signal,
    },
  });
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

      // Send user message so both old and new App show it in the session message list
      session.sendOutputFormatMessage({ type: 'user', uuid: randomUUID(), message: { role: 'user', content: userMessage } });
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
          session.sendSessionProtocolMessage(createEnvelope('agent', { t: 'text', text }, { turn: turnId }));
        }
      };

      // Deadline-based flush: ensures accumulated text is sent even if no \n\n or tool call arrives.
      const TEXT_FLUSH_DEADLINE_MS = 3000;
      let textFlushTimer: ReturnType<typeof setTimeout> | null = null;
      const scheduleTextFlush = () => {
        if (textFlushTimer !== null) return;
        textFlushTimer = setTimeout(() => {
          textFlushTimer = null;
          flushAccumulatedText();
        }, TEXT_FLUSH_DEADLINE_MS);
      };
      const cancelTextFlushTimer = () => {
        if (textFlushTimer !== null) {
          clearTimeout(textFlushTimer);
          textFlushTimer = null;
        }
      };

      try {
        thinking = true;
        session.keepAlive(thinking, 'remote');

        // Send turn-start in wrapped shape (type: 'session', data) so store App lifecycle check sees contentType === 'session'
        session.sendSessionProtocolMessage(createEnvelope('agent', { t: 'turn-start' }, { turn: turnId }));
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
              if (accumulatedResponse.includes('\n\n')) {
                cancelTextFlushTimer();
                flushAccumulatedText();
              } else {
                scheduleTextFlush();
              }
              break;

            case 'thinking_delta':
              messageBuffer.updateLastMessage(`[Thinking] ${msg.text.slice(0, 100)}...`, 'system');
              break;

            case 'tool_call_start':
              // Sidechain tool calls (from taskToolCall conversationSteps) — only send session envelope with subagent.
              if (msg.subagentId) {
                const sidechainTitle = msg.description ?? deriveToolTitle(msg.toolName, msg.args);
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
              cancelTextFlushTimer();
              flushAccumulatedText();
              hadToolCalls = true;
              const toolArgs = JSON.stringify(msg.args).slice(0, 100);
              const cmdPreview = (msg.toolName === 'CursorBash' && typeof msg.args?.command === 'string')
                ? msg.args.command.slice(0, 60) + (msg.args.command.length > 60 ? '...' : '')
                : toolArgs;
              logger.debug(`[cursor] Shell/tool started: ${msg.toolName} ${cmdPreview} (callId: ${msg.callId.slice(0, 8)}..., pending: ${codexIdByCallId.size + 1})`);
              messageBuffer.addMessage(`Executing: ${msg.toolName} ${toolArgs}`, 'tool');
              const toolTitle = msg.description ?? deriveToolTitle(msg.toolName, msg.args);
              codexIdByCallId.set(msg.callId, msg.callId);
              session.sendSessionProtocolMessage(createEnvelope('agent', {
                t: 'tool-call-start',
                call: msg.callId,
                name: msg.toolName,
                title: toolTitle,
                description: toolTitle,
                args: msg.args,
              }, { turn: turnId }));
              // Per-tool timeout: stop App timer and show "running in background"; process keeps running, conversation continues
              const handle = setTimeout(() => {
                toolCallTimeoutHandles.delete(msg.callId);
                const bgResult = { runningInBackground: true, message: 'Tool still running; timer stopped. Response will continue when it completes.' };
                logger.debug(`[cursor] Per-tool timeout for ${msg.callId.slice(0, 8)}... – sending tool_call_end (running in background)`);
                messageBuffer.addMessage('Still running (timer stopped)', 'result');
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
              codexIdByCallId.delete(msg.callId);
              const lazyResult = session.maybeLazyEncodeResult(msg.toolName, msg.callId, msg.result) as string | Record<string, unknown>;
              logger.debug(`[cursor] tool-call-result callId=${msg.callId.slice(0, 8)}... success=${msg.success}`);
              session.sendSessionProtocolMessage(createEnvelope('agent', { t: 'tool-call-end', call: msg.callId, result: lazyResult } as SessionEvent, { turn: turnId }));
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
              for (const [callId] of codexIdByCallId) {
                logger.debug(`[cursor] Closing pending tool call ${callId} (turn completed without tool end)`);
                messageBuffer.addMessage('Ended (turn completed)', 'result');
                session.sendSessionProtocolMessage(createEnvelope('agent', { t: 'tool-call-end', call: callId }, { turn: turnId }));
              }
              codexIdByCallId.clear();
              break;

            case 'error':
              messageBuffer.addMessage(`Error: ${msg.message}`, 'status');
              const errorText = `Error: ${msg.message}`;
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
          session.sendSessionProtocolMessage(createEnvelope('agent', { t: 'text', text: 'Aborted by user' }, { turn: turnId }));
        } else {
          const errorMsg = error instanceof Error ? error.message : 'Process error';
          logger.debug('[cursor] Error:', error);
          messageBuffer.addMessage(errorMsg, 'status');
          session.sendSessionProtocolMessage(createEnvelope('agent', { t: 'text', text: errorMsg }, { turn: turnId }));
        }
      } finally {
        flushAccumulatedText();
        for (const h of toolCallTimeoutHandles.values()) clearTimeout(h);
        toolCallTimeoutHandles.clear();

        // Close any tool calls that never got tool_call_end (cursor-agent aborted, crashed, or timed out)
        const abortedResult = { aborted: true, message: 'Tool call ended without result (agent aborted or exited)' };
        for (const [callId] of codexIdByCallId) {
          logger.debug(`[cursor] Closing pending tool call ${callId} (no end from cursor-agent)`);
          messageBuffer.addMessage('Ended without result (aborted or exited)', 'result');
          session.sendSessionProtocolMessage(createEnvelope('agent', { t: 'tool-call-end', call: callId }, { turn: turnId }));
        }
        const hadPendingToolCalls = codexIdByCallId.size > 0;
        codexIdByCallId.clear();

        // If the turn didn't complete normally (no result message received), it's either
        // cancelled (user abort) or failed (cursor-agent killed/crashed), never 'completed'.
        const status: 'completed' | 'failed' | 'cancelled' =
          turnCompletedNormally ? 'completed' : (turnEndStatus === 'cancelled' ? 'cancelled' : 'failed');
        // Single turn-end signal: session lifecycle only. Sending codex + cursor task_complete as well caused turn summary to appear three times in the App.
        session.sendSessionLifecycleEnvelope(createEnvelope('agent', { t: 'turn-end', status }, { turn: turnId }));

        // 1.5.0 App only stops timer via ephemeral activity (keepAlive), not message content; send before flush so it’s not delayed
        thinking = false;
        session.keepAlive(thinking, 'remote');

        await session.flush();

        // Clear parser state for next turn
        messageParser.clear();

        emitReadyIfIdle();

        logger.debug(`[cursor] Turn completed (queue: ${messageQueue.size()})`);

        // Re-fetch models after each turn: cursor-agent may have received upstream model updates.
        // This also validates currentModel and resets it if the key is no longer recognised.
        refreshModelsMetadata();
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
    clearInterval(modelRefreshInterval);
    if (inkInstance) {
      inkInstance.unmount();
    }
    messageBuffer.clear();

    logger.debug('[cursor]: Final cleanup completed');
  }
}
