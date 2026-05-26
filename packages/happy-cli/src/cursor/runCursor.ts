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
 * Happy cursor path: only send session protocol (envelope). No output-format dual-send.
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
import { CursorDisplay } from '@/ui/ink/CursorDisplay';
import { notifyDaemonSessionStarted, notifyDaemonSessionEnding } from '@/daemon/controlClient';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import { stopCaffeinate } from '@/utils/caffeinate';
import { connectionState } from '@/utils/serverConnectionErrors';
import { setupOfflineReconnection } from '@/utils/setupOfflineReconnection';
import {
  buildA2AInboxNotificationWithPreview,
  buildA2AInboxTaskTitle,
  buildA2AInboxTaskToolArgs,
  buildA2ATurnPrompt,
  getA2AUnreadCount,
  hasUnreadA2AInboxMessages,
  listA2AInboxMessages,
  pruneA2AInboxSnapshots,
} from '@/a2a/inbox';
import { a2aInboxBackoffDelayMs, isA2AInboxBackoffActive, resolveA2AInboxBackoffSettings } from '@/a2a/inboxBackoff';
import type { ApiSessionClient } from '@/api/apiSession';
import type { PermissionMode } from '@/api/types';
import type { UserMessage } from '@/api/types';
import { parseSpecialCommand } from '@/parsers/specialCommands';

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

type CursorUsageRecord = Record<string, unknown>;

function readUsageNumber(usage: CursorUsageRecord | undefined, keys: string[]): number | undefined {
  if (!usage) return undefined;
  for (const key of keys) {
    const value = usage[key];
    if (typeof value === 'number') return value;
  }
  return undefined;
}

function normalizeCursorUsage(usage?: CursorUsageRecord, apiCallCount = 1): {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  totalTokens?: number;
  contextSize?: number;
  usage?: CursorUsageRecord;
} {
  const inputTokens = readUsageNumber(usage, ['input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens']);
  const outputTokens = readUsageNumber(usage, ['output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens']);
  const cacheReadInputTokens = readUsageNumber(usage, ['cache_read_input_tokens', 'cacheReadInputTokens', 'cacheReadTokens']);
  const cacheCreationInputTokens = readUsageNumber(usage, ['cache_creation_input_tokens', 'cacheCreationInputTokens', 'cacheWriteTokens']);
  const totalTokens = readUsageNumber(usage, ['total_tokens', 'totalTokens', 'tokens', 'tokenCount'])
    ?? (typeof inputTokens === 'number' && typeof outputTokens === 'number'
      ? inputTokens + outputTokens
      : undefined);
  // cursor-agent accumulates cacheReadTokens across all N API calls within a turn.
  // Each call reads ≈ C_final from cache (small per-call growth), so:
  //   accumulated_cacheRead ≈ N × C_final  →  C_final ≈ accumulated_cacheRead / N
  // N = tool_call_count + 1 (each tool call is one round-trip; +1 for the final response).
  const n = Math.max(apiCallCount, 1);
  const contextSize = cacheReadInputTokens !== undefined
    ? Math.round(cacheReadInputTokens / n)
    : ((inputTokens ?? 0) + (cacheCreationInputTokens ?? 0)) || undefined;
  return {
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    totalTokens,
    contextSize,
    usage,
  };
}

function formatCursorUsageLog(params: {
  sessionId: string;
  turnId: string;
  cursorChatId: string | null;
  usage?: CursorUsageRecord;
  apiCallCount?: number;
  costUsd?: number;
  durationMs?: number;
}): string {
  const normalized = normalizeCursorUsage(params.usage, params.apiCallCount);

  return JSON.stringify({
    sessionId: params.sessionId,
    turnId: params.turnId,
    cursorChatId: params.cursorChatId,
    ...normalized,
    costUsd: params.costUsd,
    durationMs: params.durationMs,
  });
}
import { createId } from '@paralleldrive/cuid2';
import { CursorProcess, fetchCursorModels, formatCursorCliErrorLine } from './cursorProcess';
import {
  notifyCursorTurnThinkingStarted,
  notifySessionTurnAbortedIdle,
  notifyUserTurnAborted,
  notifyUserTurnError,
} from './turnUserNotifications';
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

function writeA2AInboxSnapshot(workspacePath: string, sessionId: string, turnId: string, inbox: ReturnType<ApiSessionClient['getA2AInbox']>): string {
  const dir = join(workspacePath, '.happy', 'a2a-inbox');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const filePath = join(dir, `${sessionId}-${turnId}.json`);
  const unreadMessages = listA2AInboxMessages(inbox, { unreadOnly: true, limit: 100 });
  const snapshot = {
    sessionId,
    turnId,
    unreadCount: unreadMessages.length,
    messages: unreadMessages,
  };
  writeFileSync(filePath, JSON.stringify(snapshot, null, 2));
  const removed = pruneA2AInboxSnapshots(dir, sessionId);
  if (removed > 0) {
    logger.debug(`[cursor] Pruned ${removed} old A2A inbox snapshot file(s) for session ${sessionId}`);
  }
  return filePath;
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
  /** Workspace root for session, .cursor/mcp.json, and cursor-agent cwd. Same as other agents: daemon spawns with cwd so process.cwd() is App path; terminal defaults to process.cwd(), optional --cwd to override. */
  workspaceRoot?: string;
  /** Resume last session for same workspace (--resume / -r). Default: false (new session). */
  resumeSession?: boolean;
  /** Explicit session tag to resume when daemon respawns this cursor process. */
  resumeSessionTag?: string;
  /** Pre-wake server seq (daemon wake); CLI fetches messages with seq > this value. */
  resumeAfterSeq?: number;
  /** Set by index.ts: Date.now() at start of CLI async IIFE, so we can report "time to runCursor entry". */
  cliStartTime?: number;
}): Promise<void> {
  const t0 = Date.now();
  const toRunCursorEntryMs = opts.cliStartTime != null ? t0 - opts.cliStartTime : undefined;
  const startupSteps: Record<string, number> = {};
  const step = (name: string) => {
    startupSteps[name] = Date.now() - t0;
    if (shouldLogStartupTiming()) logger.debug(`[cursor] Startup ${name}: ${startupSteps[name]}ms`);
  };

  const workspacePath = opts.workspaceRoot != null ? resolve(opts.workspaceRoot) : process.cwd();
  step('entry');
  if (shouldLogStartupTiming() && toRunCursorEntryMs != null) {
    logger.debug(`[cursor] Startup toRunCursorEntry: ${toRunCursorEntryMs}ms (index load + auth + daemon check → runCursor)`);
  }

  // Default: new session. Resume only with --resume/-r or --resume-session-tag.
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

  // Load existing encryption key when reusing session to avoid key mismatch.
  // Per-session key file (by tag) takes priority over global file to avoid cross-session key confusion.
  const keyPath = join(configuration.happyHomeDir, CURSOR_SESSION_KEY_FILE);
  const perSessionKeyPath = join(configuration.happyHomeDir, `cursor-session-key-${sessionTag}`);
  let existingEncryptionKey: Uint8Array | undefined;
  if (tagReused) {
    try {
      const keyFilePath = existsSync(perSessionKeyPath) ? perSessionKeyPath : keyPath;
      if (existsSync(keyFilePath)) {
        existingEncryptionKey = new Uint8Array(Buffer.from(readFileSync(keyFilePath, 'utf8').trim(), 'base64'));
      }
    } catch { /* ignore */ }
  }

  // Set backend for offline warnings
  connectionState.setBackend('Cursor');

  const api = await ApiClient.create(opts.credentials);
  step('apiClient');

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

  // When started by the daemon, the machine is already registered — skip the redundant call.
  // Otherwise, parallelize machine registration and session creation since they are independent.
  const [, response] = await Promise.all([
    opts.startedBy === 'daemon'
      ? Promise.resolve(null)
      : api.getOrCreateMachine({ machineId, metadata: initialMachineMetadata }),
    api.getOrCreateSession({ tag: sessionTag, metadata, state, existingEncryptionKey }),
  ]);

  const sessionId = response?.id ?? `offline-${sessionTag}`;
  step('sessionApi');
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
  // Also write per-session key file (by tag) so daemon restart can find the right key even when
  // another session has overwritten the global cursor-session-key file in the meantime.
  try {
    writeFileSync(tagPath, sessionTag, 'utf8');
    writeFileSync(workspacePathFile, workspacePath, 'utf8');
    if (response) {
      const keyBase64 = Buffer.from(response.encryptionKey).toString('base64');
      writeFileSync(keyPath, keyBase64, 'utf8');
      writeFileSync(perSessionKeyPath, keyBase64, 'utf8');
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
  let a2aTurnQueued = false;
  let a2aInboxTurnActive = false;
  let a2aInboxBackoffStreak = 0;
  let a2aInboxBackoffUntil = 0;
  let a2aInboxBackoffTimer: ReturnType<typeof setTimeout> | null = null;
  const a2aInboxBackoffSettings = resolveA2AInboxBackoffSettings();
  let scheduleA2ATurnIfNeeded: (mode: CursorMode) => void = () => {};
  const syncModeToSessionMetadata = (permissionMode: PermissionMode, model: string | undefined) => {
    const dangerouslySkipPermissions = permissionMode === 'force';
    session.updateMetadata((m) => ({
      ...m,
      currentOperatingModeCode: permissionMode,
      currentModelCode: model ?? undefined,
      dangerouslySkipPermissions,
    })).catch((err) => logger.debug('[Cursor] Failed to sync mode to session metadata', err));
  };
  const applyInMemorySessionModel = (modelCode: string | undefined, source: string) => {
    const normalized =
      modelCode === undefined || modelCode === 'default' || modelCode === 'auto'
        ? undefined
        : modelCode;
    if (currentModel === normalized) {
      return;
    }
    const previous = currentModel;
    currentModel = normalized;
    logger.debug(
      `[cursor] currentModel updated (${source}): ${previous ?? 'unset'} -> ${normalized ?? 'default'}`,
    );
  };
  const syncInMemoryModelFromSessionMetadata = (source: string) => {
    const code = session.getMetadata()?.currentModelCode;
    if (code === undefined) {
      return;
    }
    applyInMemorySessionModel(code, source);
  };

  const handleUserMessage = (message: UserMessage) => {
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
      applyInMemorySessionModel(messageModel, 'user-message');
      messageModel = currentModel;
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
    const specialCommand = parseSpecialCommand(message.content.text);
    if (specialCommand.type === 'compact') {
      logger.debug('[cursor] Detected /compact command; scheduling interactive compression turn');
      messageQueue.pushIsolateAndClear('', mode, { cursorCompactTurn: true });
      return;
    }
    const isA2ATrigger = (message.meta as { a2aTrigger?: boolean } | undefined)?.a2aTrigger === true;
    if (isA2ATrigger) {
      logger.debug('[cursor] A2A message recorded in inbox; poking message loop');
      messageQueue.poke();
      return;
    }
    logger.debug(`[cursor] User message queued (length: ${message.content.text.length})`);
    messageQueue.pushIsolated(message.content.text, mode);
  };

  // Handle server unreachable - offline stub with hot reconnection
  let session: ApiSessionClient;
  const attachSessionMetadataListener = (s: ApiSessionClient) => {
    s.on('metadata-updated', () => {
      syncInMemoryModelFromSessionMetadata('metadata-updated');
    });
  };
  const { session: initialSession, reconnectionHandle } = setupOfflineReconnection({
    api,
    sessionTag,
    metadata,
    state,
    response,
    existingEncryptionKey,
    initialLastSeq: opts.resumeAfterSeq,
    onSessionSwap: (newSession) => {
      session = newSession;
      newSession.onUserMessage(handleUserMessage);
      attachSessionMetadataListener(newSession);
      // Re-register run-specific RPC handlers so kill/abort work after reconnect (they are not on the new session by default).
      newSession.rpcHandlerManager.registerHandler('abort', handleAbort);
      registerKillSessionHandler(newSession.rpcHandlerManager, handleKillSession);
      syncInMemoryModelFromSessionMetadata('session-reconnect');
    },
  });
  session = initialSession;
  attachSessionMetadataListener(session);
  const currentCursorMode = (): CursorMode => ({
    permissionMode: currentPermissionMode ?? 'default',
    model: currentModel,
  });
  const scheduleA2AInboxRetryPeek = (delayMs: number) => {
    if (a2aInboxBackoffTimer !== null) {
      clearTimeout(a2aInboxBackoffTimer);
      a2aInboxBackoffTimer = null;
    }
    if (delayMs <= 0) {
      return;
    }
    a2aInboxBackoffTimer = setTimeout(() => {
      a2aInboxBackoffTimer = null;
      messageQueue.poke();
    }, delayMs);
  };
  const clearA2AInboxBackoff = () => {
    a2aInboxBackoffStreak = 0;
    a2aInboxBackoffUntil = 0;
    if (a2aInboxBackoffTimer !== null) {
      clearTimeout(a2aInboxBackoffTimer);
      a2aInboxBackoffTimer = null;
    }
  };
  scheduleA2ATurnIfNeeded = (mode: CursorMode) => {
    if (currentTurnIdRef !== null || a2aInboxTurnActive) {
      logger.debug('[cursor] Deferring A2A inbox turn until the active turn finishes');
      return;
    }
    if (isA2AInboxBackoffActive(a2aInboxBackoffUntil)) {
      logger.debug(
        `[cursor] A2A inbox backoff active (streak ${a2aInboxBackoffStreak}, `
        + `retry in ${a2aInboxBackoffUntil - Date.now()}ms)`,
      );
      return;
    }
    const unreadMessages = listA2AInboxMessages(session.getA2AInbox(), { unreadOnly: true });
    const compactMessage = unreadMessages.find((message) => parseSpecialCommand(message.text).type === 'compact');
    if (compactMessage) {
      if (a2aTurnQueued) {
        return;
      }
      a2aTurnQueued = true;
      logger.debug(`[cursor] A2A compact command peek: scheduling interactive compression turn for message ${compactMessage.id}`);
      session.markA2AMessageRead(compactMessage.id);
      messageQueue.pushIsolateAndClear('', mode, { cursorCompactTurn: true });
      return;
    }
    const unreadCount = unreadMessages.length;
    if (unreadCount === 0) {
      return;
    }
    if (a2aTurnQueued) {
      return;
    }
    a2aTurnQueued = true;
    logger.debug(`[cursor] A2A inbox peek: scheduling turn for ${unreadCount} unread message(s)`);
    messageQueue.pushIsolated('', mode, { a2aInboxTurn: true });
  };
  const peekA2AInboxInLoop = (mode?: CursorMode) => {
    scheduleA2ATurnIfNeeded(mode ?? currentCursorMode());
  };
  session.onUserMessage(handleUserMessage);
  // Restore model selection from server metadata on resume (do not wipe on reconnect).
  const serverModelCode = session.getMetadata()?.currentModelCode;
  if (serverModelCode !== undefined) {
    applyInMemorySessionModel(serverModelCode, 'session-resume');
    if (currentModel) {
      logger.debug(`[cursor] Restored model from session metadata: ${currentModel}`);
    }
  }
  step('sessionConnect');
  writeSessionPidFile(session.sessionId);
  const workspaceInboxDir = join(workspacePath, '.happy', 'a2a-inbox');
  const prunedWorkspaceSnapshots = pruneA2AInboxSnapshots(workspaceInboxDir, sessionId);
  const daemonInboxDir = join(configuration.happyHomeDir, 'a2a-inbox');
  const prunedDaemonSnapshots = existsSync(daemonInboxDir)
    ? pruneA2AInboxSnapshots(daemonInboxDir, sessionId)
    : 0;
  if (prunedWorkspaceSnapshots + prunedDaemonSnapshots > 0) {
    logger.debug(
      `[cursor] Pruned ${prunedWorkspaceSnapshots + prunedDaemonSnapshots} A2A inbox snapshot file(s) on session start`,
    );
  }
  // Persist initial permission mode; keep restored model selection when resuming.
  syncModeToSessionMetadata('default', currentModel);

  // Refresh model list from cursor-agent. Only touch currentModelCode when we have an
  // explicit selection (in-memory from this turn, or already in metadata). Never fill
  // undefined with cursor-agent default — that overwrote App's choice after each turn.
  const refreshModelsMetadata = () => {
    fetchCursorModels().then((result) => {
      if (!result || result.models.length === 0) {
        logger.debug('[cursor] refreshModelsMetadata: no models returned, skipping');
        return;
      }
      logger.debug(`[cursor] refreshModelsMetadata: ${result.models.length} models, current=${result.currentModelId}`);
      session.updateMetadata((m) => {
        const validCodes = new Set(result.models.map((mo) => mo.code));
        const preferred = currentModel ?? m.currentModelCode;
        const patch: { models: typeof result.models; currentModelCode?: string } = {
          models: result.models,
        };
        if (preferred !== undefined) {
          const isValid =
            preferred === 'default' || preferred === 'auto' || validCodes.has(preferred);
          if (isValid) {
            patch.currentModelCode = preferred;
          } else {
            logger.debug(
              `[cursor] refreshModelsMetadata: model "${preferred}" not in list, resetting to "${result.currentModelId}"`,
            );
            patch.currentModelCode = result.currentModelId;
          }
        }
        return { ...m, ...patch };
      }).catch((err) => logger.debug('[cursor] refreshModelsMetadata: failed to update metadata', err));
    }).catch((err) => logger.debug('[cursor] refreshModelsMetadata threw:', err));
  };

  // Initial fetch at session start
  refreshModelsMetadata();

  // Periodic refresh so the App sees model list updates pushed by cursor-agent (every 5 min)
  const MODEL_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
  const modelRefreshInterval = setInterval(refreshModelsMetadata, MODEL_REFRESH_INTERVAL_MS);

  // Report to daemon (once at start; also retry periodically so daemon sees us if it wasn't running at start).
  // 30s interval keeps liveness TTL (90s = 3× interval) well-fed even under transient network hiccups.
  const DAEMON_REPORT_INTERVAL_MS = 30_000;
  const reportToDaemon = () => {
    if (!response) return;
    notifyDaemonSessionStarted(session.sessionId, { ...metadata, hostPid: process.pid, sessionTag }).then((result) => {
      if (result?.error) logger.debug(`[START] Daemon report failed:`, result.error);
    }).catch((err) => logger.debug('[START] Daemon report error:', err));
  };
  reportToDaemon();
  const daemonReportInterval = setInterval(reportToDaemon, DAEMON_REPORT_INTERVAL_MS);

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
  // Restore cursor chat ID from server-side agentState so restarts resume the same chat
  let cursorChatId: string | null = response?.agentState?.cursorChatId ?? null;
  if (cursorChatId) {
    logger.debug(`[cursor] Restored cursor chat ID from agentState: ${cursorChatId}`);
  }

  async function handleAbort() {
    logger.debug('[Cursor] Abort requested');
    try {
      abortController.abort();
      messageQueue.reset();
      a2aTurnQueued = false;
      const activeTurnId = currentTurnIdRef;
      if (activeTurnId) {
        // Active turn: catch/finally will send turn-end; ensure thinking stops immediately.
        thinking = false;
        session.keepAlive(thinking, 'remote');
      } else {
        notifySessionTurnAbortedIdle(session);
        thinking = false;
        session.keepAlive(thinking, 'remote');
        await session.flush();
      }
    } catch (error) {
      logger.debug('[Cursor] Error during abort:', error);
    } finally {
      abortController = new AbortController();
    }
  }

  /**
   * Terminate the session.
   *
   * pause=true  (SIGTERM / SIGHUP / normal completion):
   *   Set lifecycleState='paused' so the App shows the session as resumable.
   *   Do NOT call sendSessionDeath() — the server will mark it inactive when the
   *   WebSocket disconnects, preserving the session record for restart-session.
   *
   * pause=false (App RPC kill / explicit user termination):
   *   Archive the session permanently (current behavior).
   */
  const handleKillSession = async (pause = false) => {
    logger.debug(`[Cursor] Kill session requested (pause=${pause})`);
    removeSessionPidFile();
    await handleAbort();

    const exitReason = exitSignalName ? `signal: ${exitSignalName}` : (pause ? 'paused' : 'killed by app (RPC)');
    try {
      if (session) {
        if (pause) {
          // Pause: mark as paused so App knows it can be resumed, do NOT archive
          await session.updateMetadata((currentMetadata) => ({
            ...currentMetadata,
            lifecycleState: 'paused',
            lifecycleStateSince: Date.now(),
          }));
          // Let the WebSocket disconnect naturally — no sendSessionDeath()
        } else {
          // Kill: archive permanently
          await session.updateMetadata((currentMetadata) => ({
            ...currentMetadata,
            lifecycleState: 'archived',
            lifecycleStateSince: Date.now(),
            archivedBy: 'cli',
            archiveReason: 'User terminated',
          }));
          session.sendSessionDeath();
        }
        await session.flush();
        await session.close();
      }
      stopCaffeinate();
      happyServer.stop();
      await notifyDaemonSessionEnding(session.sessionId, process.pid, exitReason, 0);
      process.exit(0);
    } catch (error) {
      logger.debug('[Cursor] Error during session termination:', error);
      await notifyDaemonSessionEnding(session.sessionId, process.pid, `${exitReason} (cleanup error: ${error instanceof Error ? error.message : String(error)})`, 1);
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
  let inkInstance: ReturnType<typeof render> | null = null;

  if (hasTTY) {
    console.clear();
    inkInstance = render(React.createElement(CursorDisplay, {
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
  const happyServer = await startHappyServer(session, {
    useDaemonA2ARoute: opts.startedBy === 'daemon',
    isA2AInboxTurnActive: () => a2aInboxTurnActive,
    cursorContext: {
      getCurrentTurnId: () => currentTurnIdRef,
      sendSessionEnvelope: (envelope) => session.sendSessionProtocolMessage(envelope),
      workspacePath,
      getAbortSignal: () => abortController.signal,
    },
    onA2aMessage: handleUserMessage,
  });
  ensureCursorMcpHappy(workspacePath, happyServer.url);
  step('mcpServer');
  logger.debug(`[cursor] Happy MCP: url=${happyServer.url}, workspacePath=${workspacePath}, subagentMcp=${enableSubagentMcp}`);

  // Optional: report Cursor IDE quota to server (monitor-only). Wait for socket so ack is possible.
  void (async () => {
    try {
      const { getCursorQuotaInfo, buildCursorUsageReportPayload, hasCursorStateDb } = await import('./cursorQuotaFetcher');
      if (!hasCursorStateDb()) return;
      // Fetch quota info and wait for socket in parallel; socket may take >5s on first connect
      const [result] = await Promise.all([
        getCursorQuotaInfo(),
        // Wait up to 15s for socket so usage-report ack can be received
        (async () => { for (let i = 0; i < 75; i++) { if (session.isSocketConnected()) break; await new Promise((r) => setTimeout(r, 200)); } })(),
      ]);
      if (result?.info && session.isSocketConnected()) {
        const payload = buildCursorUsageReportPayload(result.info);
        session.sendCursorQuotaReport(payload);
      }
    } catch (_) {
      // Ignore: sqlite3 missing, no Cursor auth, or API failure
    }
  })();

  //
  // Main loop
  //

  let first = true;
  let lastTaskCompleteUsage: CursorUsageRecord | undefined;
  let lastTaskCompleteCostUsd: number | undefined;
  let lastTaskCompleteDurationMs: number | undefined;

  // Send "It's ready!" once on startup so mobile can open this session (critical when reusing session after restart)
  emitReadyIfIdle();
  step('ready');

  if (shouldLogStartupTiming() && Object.keys(startupSteps).length > 0) {
    const order = ['entry', 'apiClient', 'sessionApi', 'sessionConnect', 'mcpServer', 'ready'];
    let prev = 0;
    const deltas = order
      .filter((k) => startupSteps[k] != null)
      .map((k) => {
        const v = startupSteps[k]!;
        const d = v - prev;
        prev = v;
        return `${k}=${d}ms`;
      });
    const runCursorTotal = startupSteps['ready'] ?? 0;
    const fullTotal = toRunCursorEntryMs != null ? toRunCursorEntryMs + runCursorTotal : runCursorTotal;
    logger.debug(`[cursor] Startup timing (phase ms): ${deltas.join(' ')} runCursorTotal=${runCursorTotal}ms${toRunCursorEntryMs != null ? ` toRunCursorEntry=${toRunCursorEntryMs}ms fullTotal=${fullTotal}ms` : ''}`);
  }

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
      peekA2AInboxInLoop();

      const waitSignal = abortController.signal;
      const batch = await messageQueue.waitForMessagesAndGetAsString(waitSignal);
      if (!batch) {
        if (waitSignal.aborted && !shouldExit) {
          logger.debug('[cursor] Wait aborted while idle, continuing');
          continue;
        }
        if (!shouldExit) {
          continue;
        }
        break;
      }

      const { message: userMessage, mode, meta } = batch;
      const isA2AInboxTurn = !!(meta && typeof meta === 'object' && (meta as { a2aInboxTurn?: boolean }).a2aInboxTurn === true);
      const isCursorCompactTurn = !!(meta && typeof meta === 'object' && (meta as { cursorCompactTurn?: boolean }).cursorCompactTurn === true);
      if (isA2AInboxTurn) {
        a2aTurnQueued = false;
        if (!hasUnreadA2AInboxMessages(session.getA2AInbox())) {
          logger.debug('[cursor] A2A inbox turn dequeued with no unread messages; skipping');
          continue;
        }
        a2aInboxTurnActive = true;
      }
      if (isCursorCompactTurn) {
        messageBuffer.addMessage('Summarizing...', 'system');
      } else {
        messageBuffer.addMessage(userMessage, isA2AInboxTurn ? 'system' : 'user');
      }
      logger.debug(`[cursor] Processing message (length: ${userMessage.length})${isA2AInboxTurn ? ' [a2a-inbox-turn]' : ''}${isCursorCompactTurn ? ' [compact-turn]' : ''}; spawning cursor-agent`);

      let prompt = userMessage;

      // Accumulated response text for final message to mobile
      let accumulatedResponse = '';
      let hadToolCalls = false;
      const turnId = createId();
      currentTurnIdRef = turnId;

      // For A2A inbox turns we keep the prompt internal; the real Task tool card replaces CLI fake cards.
      if (!isA2AInboxTurn && !isCursorCompactTurn) {
        session.sendSessionProtocolMessage(createEnvelope('user', { t: 'text', text: userMessage }, { turn: turnId }));
      }
      const messageParser = new CursorMessageParser();
      const codexIdByCallId = new Map<string, string>();
      /** Per-tool timeout: when fired we send tool_call_end (running in background) so App stops timer; process keeps running. */
      const toolCallTimeoutHandles = new Map<string, ReturnType<typeof setTimeout>>();
      let turnCompletedNormally = false;
      let turnEndStatus: 'completed' | 'failed' | 'cancelled' = 'completed';
      let turnToolCallCount = 0;
      let inboxTurnUnreadCount = 0;
      lastTaskCompleteUsage = undefined;
      lastTaskCompleteCostUsd = undefined;
      lastTaskCompleteDurationMs = undefined;

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
        // Codex-style durable task_started (no UI bubble) so App turns thinking on promptly.
        notifyCursorTurnThinkingStarted(session, turnId);

        if (isA2AInboxTurn) {
          const inboxSnapshotPath = writeA2AInboxSnapshot(workspacePath, sessionId, turnId, session.getA2AInbox());
          const inbox = session.getA2AInbox();
          const unreadCount = getA2AUnreadCount(inbox);
          inboxTurnUnreadCount = unreadCount;
          const summary = buildA2AInboxNotificationWithPreview(inbox);
          prompt = buildA2ATurnPrompt(summary, inboxSnapshotPath, unreadCount);
          session.sendSessionLifecycleEnvelope(createEnvelope('agent', { t: 'turn-start' }, { turn: turnId }));
          await session.flush();
        } else {
          // Durable lifecycle + flush so App shows thinking before a long headless or PTY /compress turn.
          session.sendSessionLifecycleEnvelope(createEnvelope('agent', { t: 'turn-start' }, { turn: turnId }));
          if (isCursorCompactTurn) {
            session.sendSessionProtocolMessage(createEnvelope('agent', { t: 'service', text: 'Summarizing...' }, { turn: turnId }));
            messageBuffer.addMessage('Summarizing...', 'system');
          } else {
            messageBuffer.addMessage('Thinking...', 'system');
          }
          await session.flush();
        }

        // Spawn cursor-agent process (second+ turn uses --resume so cursor-agent continues same chat)
        // A2A inbox turns use live currentModel (queue mode may be stale from schedule time).
        const cursorModel = (isA2AInboxTurn ? currentModel : mode.model)
          ?? process.env.CURSOR_MODEL
          ?? 'auto';
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
              if (msg.sessionId && msg.sessionId !== cursorChatId) {
                cursorChatId = msg.sessionId;
                logger.debug(`[cursor] Chat ID: ${cursorChatId}`);
                session.updateAgentState((s) => ({ ...s, cursorChatId }));
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
              codexIdByCallId.set(msg.callId, msg.callId);
              turnToolCallCount++;
              // Session protocol only; avoid sending codex/cursor tool-call so App does not show three summary cards (session + codex + cursor).
              let toolTitle = msg.description ?? deriveToolTitle(msg.toolName, msg.args);
              let toolCallArgs = msg.args;
              if (isA2AInboxTurn && msg.toolName === 'Task') {
                toolTitle = buildA2AInboxTaskTitle(inboxTurnUnreadCount);
                toolCallArgs = buildA2AInboxTaskToolArgs(msg.args);
              }
              session.sendSessionProtocolMessage(createEnvelope('agent', {
                t: 'tool-call-start',
                call: msg.callId,
                name: msg.toolName,
                title: toolTitle,
                description: toolTitle,
                args: toolCallArgs,
              }, { turn: turnId }));
              logger.debug(`[cursor] tool-call callId=${msg.callId.slice(0, 8)}... name=${msg.toolName}`);
              // Per-tool timeout (Codex-style: 0 = disabled). When > 0: stop App timer and show "running in background"; process keeps running.
              if (perToolTimeoutMs > 0) {
                const handle = setTimeout(() => {
                  toolCallTimeoutHandles.delete(msg.callId);
                  const bgResult = { runningInBackground: true, message: 'Tool still running; timer stopped. Response will continue when it completes.' };
                  logger.debug(`[cursor] Per-tool timeout for ${msg.callId.slice(0, 8)}... – sending tool_call_end (running in background)`);
                  messageBuffer.addMessage('Still running (timer stopped)', 'result');
                  logger.debug(`[cursor] tool-call-result (timeout) callId=${msg.callId.slice(0, 8)}...`);
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
              codexIdByCallId.delete(msg.callId);
              const lazyResult = session.maybeLazyEncodeResult(msg.toolName, msg.callId, msg.result) as string | Record<string, unknown>;
              logger.debug(`[cursor] tool-call-result callId=${msg.callId.slice(0, 8)}... success=${msg.success}`);
              session.sendSessionProtocolMessage(createEnvelope('agent', { t: 'tool-call-end', call: msg.callId, ...(lazyResult !== undefined ? { result: lazyResult } : {}) }, { turn: turnId }));
              break;

            case 'task_complete':
              turnCompletedNormally = true;
              for (const h of toolCallTimeoutHandles.values()) clearTimeout(h);
              toolCallTimeoutHandles.clear();
              if (msg.sessionId) {
                cursorChatId = msg.sessionId;
              }
              const { usage: _raw, ...normalizedFields } = normalizeCursorUsage(msg.usage, turnToolCallCount + 1);
              lastTaskCompleteUsage = normalizedFields.contextSize !== undefined
                ? { ...normalizedFields, ...msg.usage }
                : msg.usage;
              lastTaskCompleteCostUsd = msg.costUsd;
              lastTaskCompleteDurationMs = msg.durationMs;
              logger.debug(`[cursor] Turn usage ${formatCursorUsageLog({
                sessionId: session.sessionId,
                turnId,
                cursorChatId,
                usage: msg.usage,
                apiCallCount: turnToolCallCount + 1,
                costUsd: msg.costUsd,
                durationMs: msg.durationMs,
              })}`);
              // Close any tool calls that never got tool_call_end (e.g. long-running shell still running when turn ended)
              // so the App stops their timers as soon as we know the turn is complete
              const turnEndedResult = { turnEnded: true, message: 'Turn completed; tool did not report end' };
              for (const [callId] of codexIdByCallId) {
                logger.debug(`[cursor] Closing pending tool call ${callId} (turn completed without tool end)`);
                messageBuffer.addMessage('Ended (turn completed)', 'result');
                session.sendSessionProtocolMessage(createEnvelope('agent', { t: 'tool-call-end', call: callId }, { turn: turnId }));
              }
              codexIdByCallId.clear();
              break;

            case 'error': {
              const userErrorText = formatCursorCliErrorLine(msg.message);
              turnEndStatus = 'failed';
              cancelTextFlushTimer();
              flushAccumulatedText();
              messageBuffer.addMessage(`Error: ${userErrorText}`, 'status');
              notifyUserTurnError(session, turnId, msg.message);
              break;
            }
          }
        }

        // Run the process (blocks until exit)
        if (isCursorCompactTurn) {
          const compactResult = await cursorProc.runInteractiveCommand('/compress', { completionMode: 'compress' });
          if (compactResult.outcome === 'completed') {
            const summarySuccessMessage = 'Summary completed successfully.';
            messageBuffer.addMessage(summarySuccessMessage, 'status');
            session.sendSessionProtocolMessage(createEnvelope('agent', { t: 'service', text: summarySuccessMessage }, { turn: turnId }));
            turnCompletedNormally = true;
          } else {
            const compactDetail = compactResult.detail
              ?? (compactResult.outcome === 'timed_out'
                ? 'Compression timed out'
                : 'Compression did not complete');
            logger.debug(`[cursor] Compact turn ${compactResult.outcome}: ${compactDetail}`);
            messageBuffer.addMessage(compactDetail, 'status');
            session.sendSessionProtocolMessage(createEnvelope('agent', { t: 'service', text: compactDetail }, { turn: turnId }));
            turnEndStatus = 'failed';
          }
        } else {
          await cursorProc.run(prompt);
        }

        first = false;

      } catch (error) {
        const isAbortError = error instanceof Error && error.name === 'AbortError';
        turnEndStatus = isAbortError ? 'cancelled' : 'failed';
        if (isAbortError) {
          messageBuffer.addMessage('Turn stopped by user', 'status');
          notifyUserTurnAborted(session, turnId);
        } else {
          const errorMsg = error instanceof Error ? error.message : 'Process error';
          logger.debug('[cursor] Error:', error);
          messageBuffer.addMessage(errorMsg, 'status');
          session.sendSessionEvent({ type: 'message', message: `Error: ${errorMsg}` });
        }
      } finally {
        cancelTextFlushTimer();
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
          turnEndStatus === 'cancelled'
            ? 'cancelled'
            : (turnEndStatus === 'failed' || !turnCompletedNormally)
              ? 'failed'
              : 'completed';
        // Single turn-end signal: session lifecycle only. Sending codex + cursor task_complete as well caused turn summary to appear three times in the App.
        session.sendSessionLifecycleEnvelope(createEnvelope('agent', {
          t: 'turn-end',
          status,
          ...(lastTaskCompleteUsage ? { usage: lastTaskCompleteUsage } : {}),
          ...(lastTaskCompleteCostUsd !== undefined ? { costUsd: lastTaskCompleteCostUsd } : {}),
          ...(lastTaskCompleteDurationMs !== undefined ? { durationMs: lastTaskCompleteDurationMs } : {}),
        }, { turn: turnId }));

        // 1.5.0 App only stops timer via ephemeral activity (keepAlive), not message content; send before flush so it’s not delayed
        thinking = false;
        session.keepAlive(thinking, 'remote');

        await session.flush();

        // Clear parser state for next turn
        messageParser.clear();
        currentTurnIdRef = null;
        if (isA2AInboxTurn) {
          a2aInboxTurnActive = false;
        }
        const turnSucceeded = turnCompletedNormally && turnEndStatus !== 'cancelled';
        if (isA2AInboxTurn) {
          if (turnSucceeded) {
            clearA2AInboxBackoff();
            logger.debug('[cursor] A2A inbox turn succeeded; backoff reset');
          } else if (turnEndStatus !== 'cancelled') {
            a2aInboxBackoffStreak += 1;
            const delayMs = a2aInboxBackoffDelayMs(
              a2aInboxBackoffStreak,
              a2aInboxBackoffSettings,
            );
            a2aInboxBackoffUntil = Date.now() + delayMs;
            logger.debug(
              `[cursor] A2A inbox turn failed; backing off ${delayMs}ms `
              + `(streak ${a2aInboxBackoffStreak})`,
            );
            scheduleA2AInboxRetryPeek(delayMs);
          }
        } else if (!isCursorCompactTurn && turnSucceeded) {
          clearA2AInboxBackoff();
          logger.debug('[cursor] User turn succeeded; A2A inbox backoff reset');
        }
        // Do not send durable ready after each turn: App maps ready → thinking off and gap
        // fetch can replay stale ready after the next turn-start, leaving thinking stuck off.
        if (!isA2AInboxBackoffActive(a2aInboxBackoffUntil)) {
          peekA2AInboxInLoop(currentCursorMode());
        }

        logger.debug(`[cursor] Turn completed (queue: ${messageQueue.size()})`);

        // Re-fetch models after each turn: cursor-agent may have received upstream model updates.
        // This also validates currentModel and resets it if the key is no longer recognised.
        refreshModelsMetadata();
      }
    }

  } finally {
    // Cleanup
    logger.debug('[cursor]: Final cleanup start');
    if (a2aInboxBackoffTimer !== null) {
      clearTimeout(a2aInboxBackoffTimer);
      a2aInboxBackoffTimer = null;
    }
    removeSessionPidFile();

    if (reconnectionHandle) {
      reconnectionHandle.cancel();
    }

    // Report exit reason to daemon before closing (best-effort, don't block cleanup)
    if (!exitHandled) {
      // Normal completion — the message loop exited naturally; pause so it can be resumed
      notifyDaemonSessionEnding(session.sessionId, process.pid, 'completed normally (exit 0)', 0).catch(() => {});
    }

    try {
      // Pause path (normal / signal exits are handled via handleKillSession(pause=true) above,
      // but for safety also skip sendSessionDeath() here — just flush & close the socket cleanly.
      // The server will mark the session inactive on websocket disconnect.
      await session.updateMetadata((currentMetadata) => ({
        ...currentMetadata,
        lifecycleState: 'paused',
        lifecycleStateSince: Date.now(),
      }));
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
