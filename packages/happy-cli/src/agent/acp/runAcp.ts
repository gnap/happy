import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ApiClient } from '@/api/api';
import type { ApiSessionClient } from '@/api/apiSession';
import type { UserMessage, Metadata } from '@/api/types';
import type { AgentMessage } from '@/agent/core';
import { AcpBackend, type AcpPermissionHandler } from './AcpBackend';
import { AcpCursorBackend } from './AcpCursorBackend';
import { DefaultTransport } from '@/agent/transport';
import { AcpSessionManager } from './AcpSessionManager';
import type { SessionEnvelope } from '@slopus/happy-wire';
import { logger } from '@/ui/logger';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import { Credentials, readSettings, writeSessionPidFile, removeSessionPidFile } from '@/persistence';
import { initialMachineMetadata } from '@/daemon/run';
import { createSessionMetadata } from '@/utils/createSessionMetadata';
import { setupOfflineReconnection } from '@/utils/setupOfflineReconnection';
import { notifyDaemonSessionStarted } from '@/daemon/controlClient';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import { startHappyServer } from '@/claude/utils/startHappyServer';
import { projectPath } from '@/projectPath';
import { BasePermissionHandler, type PermissionResult } from '@/utils/BasePermissionHandler';
import { connectionState } from '@/utils/serverConnectionErrors';
import {
  extractConfigOptionsFromPayload,
  extractCurrentModeIdFromPayload,
  extractModeStateFromPayload,
  extractModelStateFromPayload,
  mergeAcpSessionConfigIntoMetadata,
} from './sessionConfigMetadata';
import type { SessionConfigOption, SessionModeState, SessionModelState } from '@agentclientprotocol/sdk';

/** Turn timeout must exceed the per-tool-call timeout (CursorTransport uses 10 min). */
const TURN_TIMEOUT_MS = 30 * 60 * 1000;
const ACP_EVENT_PREVIEW_CHARS = 240;
const ACP_RAW_PREVIEW_CHARS = 2000;
const ACP_COLOR_RESET = '\u001b[0m';
const ACP_LOG_COLORS = {
  muted: '\u001b[90m',
  error: '\u001b[31m',
  incoming: '\u001b[32m',
  outgoing: '\u001b[34m',
  tool: '\u001b[38;5;208m',
} as const;

type AcpLogKind = keyof typeof ACP_LOG_COLORS;
type AcpFormattedLog = {
  kind: AcpLogKind;
  text: string;
};

function shouldUseColoredAcpLogs(): boolean {
  if (process.env.FORCE_COLOR === '0') {
    return false;
  }
  if (process.env.FORCE_COLOR !== undefined) {
    return true;
  }
  return process.stdout.isTTY === true || process.stderr.isTTY === true;
}

function formatAcpTime(date: Date = new Date()): string {
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

function colorizeAcpLine(kind: AcpLogKind, line: string): string {
  if (!shouldUseColoredAcpLogs()) {
    return line;
  }
  return `${ACP_LOG_COLORS[kind]}${line}${ACP_COLOR_RESET}`;
}

function logAcp(kind: AcpLogKind, message: string): void {
  const line = `[${formatAcpTime()}] ${message}`;
  console.log(colorizeAcpLine(kind, line));
}

function toSingleLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function truncateForConsole(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}...`;
}

function formatUnknownForConsole(value: unknown, limit: number): string {
  let serialized = '';
  if (typeof value === 'string') {
    serialized = value;
  } else {
    try {
      serialized = JSON.stringify(value);
    } catch {
      serialized = String(value);
    }
  }
  return truncateForConsole(toSingleLine(serialized), limit);
}

function formatTextForConsole(text: string): string {
  return JSON.stringify(truncateForConsole(toSingleLine(text), ACP_EVENT_PREVIEW_CHARS));
}

function formatOptionalDetail(text: string | null | undefined, limit = ACP_EVENT_PREVIEW_CHARS): string {
  if (!text) {
    return '';
  }
  return ` - ${truncateForConsole(toSingleLine(text), limit)}`;
}

function extractThinkingText(payload: unknown): string {
  if (typeof payload === 'string') {
    return payload;
  }
  if (payload && typeof payload === 'object' && typeof (payload as { text?: unknown }).text === 'string') {
    return (payload as { text: string }).text;
  }
  return '';
}

function formatAcpMessageForFrontend(agentName: string, msg: AgentMessage, detailed: boolean): AcpFormattedLog | null {
  switch (msg.type) {
    case 'status':
      return null;
    case 'model-output': {
      const text = msg.textDelta ?? msg.fullText ?? '';
      return {
        kind: 'outgoing',
        text: `Outgoing message: ${formatTextForConsole(text)}`,
      };
    }
    case 'tool-call': {
      const desc = (msg as { description?: string }).description;
      const titleLine = typeof desc === 'string' && desc ? ` title="${desc}"` : '';
      return {
        kind: 'tool',
        text: `Tool: ${msg.toolName} started (callId=${msg.callId})${titleLine}`,
      };
    }
    case 'tool-result':
      return {
        kind: 'tool',
        text: `Tool: ${msg.toolName} completed (callId=${msg.callId})`,
      };
    case 'permission-request':
      if (!detailed) {
        return null;
      }
      return {
        kind: 'muted',
        text: `Outgoing permission request from ${agentName}: id=${msg.id} reason=${msg.reason}`,
      };
    case 'permission-response':
      if (!detailed) {
        return null;
      }
      return {
        kind: 'muted',
        text: `Outgoing permission response from ${agentName}: id=${msg.id} approved=${msg.approved}`,
      };
    case 'fs-edit':
      if (!detailed) {
        return null;
      }
      return {
        kind: 'muted',
        text: `Outgoing fs edit from ${agentName}: description=${formatTextForConsole(msg.description)}`,
      };
    case 'terminal-output':
      if (!detailed) {
        return null;
      }
      return {
        kind: 'muted',
        text: `Outgoing terminal output from ${agentName}: text=${formatTextForConsole(msg.data)}`,
      };
    case 'event': {
      if (msg.name === 'thinking') {
        const thinkingText = extractThinkingText(msg.payload);
        return {
          kind: 'muted',
          text: `Thinking: ${formatTextForConsole(thinkingText)}`,
        };
      }
      if (!detailed) {
        return null;
      }
      return {
        kind: 'muted',
        text: `Outgoing event from ${agentName}: name=${msg.name} payload=${formatUnknownForConsole(msg.payload, ACP_EVENT_PREVIEW_CHARS)}`,
      };
    }
    case 'token-count':
      if (!detailed) {
        return null;
      }
      return {
        kind: 'muted',
        text: `Outgoing token count from ${agentName}: data=${formatUnknownForConsole(msg, ACP_EVENT_PREVIEW_CHARS)}`,
      };
    case 'exec-approval-request':
      if (!detailed) {
        return null;
      }
      return {
        kind: 'muted',
        text: `Outgoing exec approval request from ${agentName}: callId=${msg.call_id}`,
      };
    case 'patch-apply-begin':
      if (!detailed) {
        return null;
      }
      return {
        kind: 'muted',
        text: `Outgoing patch apply begin from ${agentName}: callId=${msg.call_id} autoApproved=${msg.auto_approved === true}`,
      };
    case 'patch-apply-end':
      if (!detailed) {
        return null;
      }
      return {
        kind: 'muted',
        text: `Outgoing patch apply end from ${agentName}: callId=${msg.call_id} success=${msg.success}`,
      };
    default:
      return null;
  }
}

function formatEnvelopeForServerLog(agentName: string, envelope: SessionEnvelope): AcpFormattedLog {
  if (envelope.ev.t === 'text') {
    const thinkingPrefix = envelope.ev.thinking ? 'thinking' : 'text';
    return {
      kind: 'incoming',
      text: `Incoming ${thinkingPrefix} prompt for ${agentName}: ${formatUnknownForConsole(envelope.ev.text, ACP_EVENT_PREVIEW_CHARS)}`,
    };
  }
  if (envelope.ev.t === 'tool-call-start') {
    const title = (envelope.ev as { title?: string }).title ?? '';
    const description = (envelope.ev as { description?: string }).description ?? '';
    const titleDesc = title || description ? ` title="${title || description}"` : '';
    return {
      kind: 'tool',
      text: `Tool start sent to server from ${agentName}: tool=${envelope.ev.name} callId=${envelope.ev.call}${titleDesc} args=${formatUnknownForConsole(envelope.ev.args, ACP_EVENT_PREVIEW_CHARS)}`,
    };
  }
  if (envelope.ev.t === 'tool-call-end') {
    return {
      kind: 'tool',
      text: `Tool end sent to server from ${agentName}: callId=${envelope.ev.call}`,
    };
  }
  if (envelope.ev.t === 'turn-start') {
    return {
      kind: 'incoming',
      text: `Incoming turn start for ${agentName}`,
    };
  }
  if (envelope.ev.t === 'turn-end') {
    return {
      kind: 'incoming',
      text: `Incoming turn end for ${agentName}: status=${envelope.ev.status}`,
    };
  }
  return {
    kind: 'incoming',
    text: `Incoming ${envelope.ev.t} for ${agentName}: ${formatUnknownForConsole(envelope.ev, ACP_EVENT_PREVIEW_CHARS)}`,
  };
}

type AcpSwitchMode = {
  permissionMode?: string;
  model?: string | null;
};

type AcpSelectableOption = {
  code: string;
  value: string;
};

type AcpConfigSelector = {
  configId: string;
  currentCode: string;
  options: AcpSelectableOption[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function isSelectValue(value: unknown): value is { value: string; name: string } {
  return isRecord(value) && typeof value.value === 'string' && typeof value.name === 'string';
}

function isSelectGroup(value: unknown): value is { options: unknown[] } {
  return isRecord(value) && Array.isArray(value.options);
}

function flattenSelectOptions(options: unknown): AcpSelectableOption[] {
  if (!Array.isArray(options)) {
    return [];
  }

  const flattened: AcpSelectableOption[] = [];

  for (const entry of options) {
    if (isSelectValue(entry)) {
      flattened.push({ code: entry.value, value: entry.name });
      continue;
    }
    if (isSelectGroup(entry)) {
      for (const grouped of entry.options) {
        if (!isSelectValue(grouped)) {
          continue;
        }
        flattened.push({ code: grouped.value, value: grouped.name });
      }
    }
  }

  return flattened;
}

function extractConfigSelector(
  configOptions: SessionConfigOption[],
  category: 'mode' | 'model',
): AcpConfigSelector | null {
  const optionMatchesCategory = (option: SessionConfigOption): boolean => {
    if (option.category === category) {
      return true;
    }
    // Some ACP providers omit category; fallback to id/name heuristics.
    const id = normalizeComparable(option.id);
    const name = normalizeComparable(option.name);
    if (category === 'model') {
      return id.includes('model') || name.includes('model');
    }
    return id.includes('mode') || id.includes('permission') || name.includes('mode') || name.includes('permission');
  };

  for (const option of configOptions) {
    if (option.type !== 'select' || !optionMatchesCategory(option)) {
      continue;
    }
    return {
      configId: option.id,
      currentCode: option.currentValue,
      options: flattenSelectOptions(option.options),
    };
  }
  return null;
}

function normalizeComparable(value: string): string {
  return value.trim().toLowerCase();
}

function resolveRequestedCode(options: AcpSelectableOption[], requested: string): string | null {
  for (const option of options) {
    if (option.code === requested || option.value === requested) {
      return option.code;
    }
  }

  const normalizedRequested = normalizeComparable(requested);
  for (const option of options) {
    if (normalizeComparable(option.code) === normalizedRequested || normalizeComparable(option.value) === normalizedRequested) {
      return option.code;
    }
  }

  return null;
}

function buildPermissionModeCandidates(agentName: string, requestedMode: string): string[] {
  const trimmed = requestedMode.trim();
  if (!trimmed) {
    return [];
  }

  const unique = new Set<string>([trimmed]);
  const normalized = normalizeComparable(trimmed);

  // Cursor ACP often advertises mode IDs that differ from App keys:
  // App sends `default | plan | ask | force` while ACP mode options are commonly
  // `agent | plan | ask` (or `code` as an "agent/code" equivalent).
  if (agentName === 'cursor') {
    if (normalized === 'default') {
      unique.add('agent');
      unique.add('code');
    } else if (
      normalized === 'force' ||
      normalized === 'bypasspermissions' ||
      normalized === 'yolo' ||
      normalized === 'safe-yolo'
    ) {
      unique.add('agent');
      unique.add('code');
      unique.add('default');
    } else if (normalized === 'acceptedits') {
      unique.add('code');
      unique.add('agent');
      unique.add('default');
    } else if (normalized === 'read-only') {
      unique.add('ask');
      unique.add('plan');
    }
  }

  return Array.from(unique);
}

function resolveRequestedCodeWithCandidates(
  options: AcpSelectableOption[],
  candidates: string[],
): string | null {
  for (const candidate of candidates) {
    const resolved = resolveRequestedCode(options, candidate);
    if (resolved) {
      return resolved;
    }
  }
  return null;
}

function resolveRequestedLegacyModeCode(modes: SessionModeState, requested: string): string | null {
  for (const mode of modes.availableModes) {
    if (mode.id === requested || mode.name === requested) {
      return mode.id;
    }
  }

  const normalizedRequested = normalizeComparable(requested);
  for (const mode of modes.availableModes) {
    if (normalizeComparable(mode.id) === normalizedRequested || normalizeComparable(mode.name) === normalizedRequested) {
      return mode.id;
    }
  }

  return null;
}

function resolveRequestedLegacyModelCode(models: SessionModelState, requested: string): string | null {
  for (const model of models.availableModels) {
    if (model.modelId === requested || model.name === requested) {
      return model.modelId;
    }
  }

  const normalizedRequested = normalizeComparable(requested);
  for (const model of models.availableModels) {
    if (normalizeComparable(model.modelId) === normalizedRequested || normalizeComparable(model.name) === normalizedRequested) {
      return model.modelId;
    }
  }

  return null;
}

class GenericAcpPermissionHandler extends BasePermissionHandler implements AcpPermissionHandler {
  private readonly logPrefix: string;
  private readonly getCurrentPermissionMode: (() => string | undefined) | undefined;

  constructor(
    session: ApiSessionClient,
    agentName: string,
    getCurrentPermissionMode?: () => string | undefined,
  ) {
    super(session);
    this.logPrefix = `[${agentName}]`;
    this.getCurrentPermissionMode = getCurrentPermissionMode;
  }

  protected getLogPrefix(): string {
    return this.logPrefix;
  }

  async handleToolCall(toolCallId: string, toolName: string, input: unknown): Promise<PermissionResult> {
    const mode = this.getCurrentPermissionMode?.();
    if (mode === 'force') {
      logger.debug(`${this.logPrefix} Auto-approving tool (force mode): ${toolName} (${toolCallId})`);
      return { decision: 'approved_for_session' };
    }

    return new Promise<PermissionResult>((resolve, reject) => {
      this.pendingRequests.set(toolCallId, {
        resolve,
        reject,
        toolName,
        input,
      });
      this.addPendingRequestToState(toolCallId, toolName, input);
      logger.debug(`${this.logPrefix} Permission request sent for tool: ${toolName} (${toolCallId})`);
    });
  }
}

type PendingTurn = {
  resolve: () => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
};

function resolveSessionFlavor(agentName: string): 'gemini' | 'opencode' | 'acp-cursor' | 'acp' {
  if (agentName === 'gemini') {
    return 'gemini';
  }
  if (agentName === 'opencode') {
    return 'opencode';
  }
  if (agentName === 'cursor') {
    return 'acp-cursor';
  }
  return 'acp';
}

export interface RunAcpOptions {
  credentials: Credentials;
  agentName: string;
  command?: string;
  args?: string[];
  startedBy?: 'daemon' | 'terminal';
  verbose?: boolean;
  /** Explicit session tag to resume when daemon respawns this ACP process. */
  resumeSessionTag?: string;
  /** When set, use this backend instead of spawning AcpBackend from command/args. */
  backend?: import('@/agent/core').AgentBackend;
  /** Custom transport handler; used when backend is not provided. Defaults to DefaultTransport. */
  transportHandler?: import('@/agent/transport').TransportHandler;
}

export async function runAcp(opts: RunAcpOptions): Promise<void> {
  const verbose = opts.verbose === true;
  // When daemon restarts an acp-cursor session, it passes --resume-session-tag so we
  // reconnect to the same server session instead of creating a new one.
  const sessionTag = opts.resumeSessionTag?.trim() || randomUUID();
  connectionState.setBackend(opts.agentName);

  const api = await ApiClient.create(opts.credentials);
  const settings = await readSettings();
  if (!settings?.machineId) {
    throw new Error('No machine ID found in settings');
  }

  const { state, metadata: baseMetadata } = createSessionMetadata({
    flavor: resolveSessionFlavor(opts.agentName),
    machineId: settings.machineId,
    startedBy: opts.startedBy,
    sandbox: settings.sandboxConfig,
  });

  // Initial permission/model from App (daemon passes via env when spawning cursor-acp)
  const initialPermissionMode = opts.agentName === 'cursor' ? process.env.HAPPY_CURSOR_INITIAL_PERMISSION_MODE?.trim() || undefined : undefined;
  const initialModel = opts.agentName === 'cursor' ? (process.env.HAPPY_CURSOR_INITIAL_MODEL?.trim() || undefined) : undefined;
  const metadata: Metadata = {
    ...baseMetadata,
    ...(initialPermissionMode ? { currentOperatingModeCode: initialPermissionMode } : {}),
    ...(initialModel ? { currentModelCode: initialModel } : {}),
  };
  const daemonMetadata: Metadata = {
    ...metadata,
    hostPid: process.pid,
    sessionTag,
  };
  let reportToDaemonInterval: ReturnType<typeof setInterval> | null = null;
  const reportSessionToDaemon = (sessionId: string) => {
    notifyDaemonSessionStarted(sessionId, daemonMetadata).catch((err) =>
      logger.debug('[acp] Failed to report session to daemon:', err)
    );
  };

  // When started by the daemon, the machine is already registered — skip the redundant call.
  // Otherwise, parallelize machine registration and session creation since they are independent.
  const [, response] = await Promise.all([
    opts.startedBy === 'daemon'
      ? Promise.resolve(null)
      : api.getOrCreateMachine({ machineId: settings.machineId, metadata: initialMachineMetadata }),
    api.getOrCreateSession({ tag: sessionTag, metadata, state }),
  ]);
  if (response) {
    logAcp('muted', `Happy Session ID: ${response.id}`);
  }

  let session: ApiSessionClient;
  let permissionHandler: GenericAcpPermissionHandler;
  // Forward reference so onSessionSwap can re-register the callback on the new session.
  let userMessageHandler: ((message: UserMessage) => void) | null = null;
  const { session: initialSession, reconnectionHandle } = setupOfflineReconnection({
    api,
    sessionTag,
    metadata,
    state,
    response,
    onSessionSwap: (newSession) => {
      session = newSession;
      if (permissionHandler) {
        permissionHandler.updateSession(newSession);
      }
      if (userMessageHandler) {
        newSession.onUserMessage(userMessageHandler);
      }
      // Re-register run-specific RPC handlers so kill/abort work after reconnect.
      newSession.rpcHandlerManager.registerHandler('abort', handleAbort);
      registerKillSessionHandler(newSession.rpcHandlerManager, async () => {
        shouldExit = true;
        messageQueue.close();
        clearPendingTurn(new Error('Session terminated'));
        await handleAbort();
      });
      reportSessionToDaemon(newSession.sessionId);
      if (reportToDaemonInterval === null) {
        reportToDaemonInterval = setInterval(() => reportSessionToDaemon(session.sessionId), 60_000);
      }
    },
  });
  session = initialSession;

  if (response) {
    reportSessionToDaemon(response.id);
    reportToDaemonInterval = setInterval(() => reportSessionToDaemon(session.sessionId), 60_000);
  }

  permissionHandler = new GenericAcpPermissionHandler(session, opts.agentName, () => currentPermissionMode);
  const sessionManager = new AcpSessionManager();
  const messageQueue = new MessageQueue2<AcpSwitchMode>((mode) => hashObject(mode));
  let currentPermissionMode: string | undefined = initialPermissionMode;
  let currentModel: string | null | undefined = initialModel ?? undefined;
  let modeSelector: AcpConfigSelector | null = null;
  let modelSelector: AcpConfigSelector | null = null;
  let legacyModes: SessionModeState | null = null;
  let legacyModels: SessionModelState | null = null;
  let appliedInitialPermissionMode = false;
  let appliedInitialModel = false;
  let sawSlashCommands = false;
  let sawModes = false;
  let sawModels = false;

  const happyServer = await startHappyServer(session, {
    onA2aMessage: (message) => userMessageHandler?.(message),
  });
  const mcpServers = {
    happy: {
      command: join(projectPath(), 'bin', 'happy-mcp.mjs'),
      args: ['--url', happyServer.url],
    },
  };

  let defaultTransport = opts.transportHandler;
  if (!defaultTransport) {
    if (opts.agentName === 'cursor') {
      const { cursorTransport } = await import('@/agent/transport');
      defaultTransport = cursorTransport;
    } else {
      defaultTransport = new DefaultTransport(opts.agentName);
    }
  }

  const backendOptions = {
    agentName: opts.agentName,
    cwd: process.cwd(),
    command: opts.command!,
    args: opts.args ?? [],
    mcpServers,
    permissionHandler,
    transportHandler: defaultTransport,
    verbose,
  };
  const backendFactory = () => opts.agentName === 'cursor'
    ? new AcpCursorBackend(backendOptions)
    : new AcpBackend(backendOptions);

  let backend = opts.backend ?? backendFactory();

  let thinking = false;
  let acpSessionId: string | null = null;
  let shouldExit = false;
  let backendStopped = false;
  let abortController = new AbortController();
  let pendingTurn: PendingTurn | null = null;

  const clearPendingTurn = (error?: Error) => {
    if (!pendingTurn) {
      return;
    }
    clearTimeout(pendingTurn.timeout);
    const current = pendingTurn;
    pendingTurn = null;
    if (error) {
      current.reject(error);
      return;
    }
    logger.debug(`[${opts.agentName}] Turn ended, resolving waitForTurnEnd`);
    current.resolve();
  };

  const waitForTurnEnd = () => new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingTurn = null;
      reject(new Error(`Timed out waiting for ${opts.agentName} to finish the turn`));
    }, TURN_TIMEOUT_MS);
    pendingTurn = { resolve, reject, timeout };
  });

  /**
   * Extend the turn deadline by TURN_TIMEOUT_MS from now.
   * Called on any meaningful activity (tool call, model output) so a long-running
   * sub-task that keeps producing output never hits the static deadline.
   */
  const extendTurnTimeout = () => {
    if (!pendingTurn) return;
    clearTimeout(pendingTurn.timeout);
    const current = pendingTurn;
    current.timeout = setTimeout(() => {
      pendingTurn = null;
      current.reject(new Error(`Timed out waiting for ${opts.agentName} to finish the turn`));
    }, TURN_TIMEOUT_MS);
  };

  const stopRunnerFromBackendStatus = (status: 'error' | 'stopped', detail?: string) => {
    const reason = detail
      ? `${opts.agentName} backend ${status}: ${detail}`
      : `${opts.agentName} backend ${status}`;
    if (status === 'stopped') {
      // stopped = current operation cancelled; backend will be restarted for next message
      logger.debug(`[${opts.agentName}] ${reason}; will restart backend for next message`);
      backendStopped = true;
    } else {
      logger.debug(`[${opts.agentName}] ${reason}; stopping ACP runner`);
      shouldExit = true;
      messageQueue.close();
    }
    clearPendingTurn(new Error(reason));
  };

  const sendEnvelopes = (envelopes: SessionEnvelope[]) => {
    for (const envelope of envelopes) {
      if (verbose) {
        const formatted = formatEnvelopeForServerLog(opts.agentName, envelope);
        logAcp('muted', formatted.text);
      }
      session.sendSessionProtocolMessage(envelope);
      if (verbose) {
        logAcp('muted', `Incoming raw envelope for ${opts.agentName}: ${formatUnknownForConsole(envelope, ACP_RAW_PREVIEW_CHARS)}`);
      }
    }
    if (envelopes.length > 0) {
      session.flush().catch((err) => logger.debug(`[${opts.agentName}] flush after sendEnvelopes failed`, err));
    }
  };

  const switchPermissionModeIfRequested = async (requestedMode: string): Promise<void> => {
    if (!requestedMode) {
      return;
    }

    const requestedCandidates = buildPermissionModeCandidates(opts.agentName, requestedMode);
    if (requestedCandidates.length === 0) {
      return;
    }

    if (modeSelector) {
      const resolved = resolveRequestedCodeWithCandidates(modeSelector.options, requestedCandidates);
      if (!resolved) {
        logger.debug(
          `[${opts.agentName}] Ignoring unknown ACP permission mode request: ${requestedMode} (candidates: ${requestedCandidates.join(', ')})`,
        );
        return;
      }
      if (resolved === modeSelector.currentCode) {
        return;
      }
      const switched =
        'setSessionConfigOption' in backend && typeof (backend as { setSessionConfigOption?: (id: string, value: string) => Promise<boolean> }).setSessionConfigOption === 'function'
          ? await (backend as { setSessionConfigOption: (id: string, value: string) => Promise<boolean> }).setSessionConfigOption(modeSelector.configId, resolved)
          : false;
      if (switched) {
        modeSelector.currentCode = resolved;
        return;
      }
    }

    if (!legacyModes) {
      return;
    }

    let resolvedLegacyMode: string | null = null;
    for (const candidate of requestedCandidates) {
      resolvedLegacyMode = resolveRequestedLegacyModeCode(legacyModes, candidate);
      if (resolvedLegacyMode) {
        break;
      }
    }
    if (!resolvedLegacyMode) {
      logger.debug(
        `[${opts.agentName}] Ignoring unknown ACP legacy mode request: ${requestedMode} (candidates: ${requestedCandidates.join(', ')})`,
      );
      return;
    }
    if (resolvedLegacyMode === legacyModes.currentModeId) {
      return;
    }

    const switched =
      'setSessionMode' in backend && typeof (backend as { setSessionMode?: (mode: string) => Promise<boolean> }).setSessionMode === 'function'
        ? await (backend as { setSessionMode: (mode: string) => Promise<boolean> }).setSessionMode(resolvedLegacyMode)
        : false;
    if (switched) {
      legacyModes = {
        ...legacyModes,
        currentModeId: resolvedLegacyMode,
      };
    }
  };

  const switchModelIfRequested = async (requestedModel: string): Promise<void> => {
    if (!requestedModel) {
      return;
    }

    if (modelSelector) {
      const resolved = resolveRequestedCode(modelSelector.options, requestedModel);
      if (!resolved) {
        logger.debug(`[${opts.agentName}] Ignoring unknown ACP model request: ${requestedModel}`);
        return;
      }
      if (resolved === modelSelector.currentCode) {
        return;
      }
      const switched =
        'setSessionConfigOption' in backend && typeof (backend as { setSessionConfigOption?: (id: string, value: string) => Promise<boolean> }).setSessionConfigOption === 'function'
          ? await (backend as { setSessionConfigOption: (id: string, value: string) => Promise<boolean> }).setSessionConfigOption(modelSelector.configId, resolved)
          : false;
      if (switched) {
        modelSelector.currentCode = resolved;
        return;
      }
    }

    if (!legacyModels) {
      return;
    }

    const resolvedLegacyModel = resolveRequestedLegacyModelCode(legacyModels, requestedModel);
    if (!resolvedLegacyModel) {
      logger.debug(`[${opts.agentName}] Ignoring unknown ACP legacy model request: ${requestedModel}`);
      return;
    }
    if (resolvedLegacyModel === legacyModels.currentModelId) {
      return;
    }

    const switched =
      'setSessionModel' in backend && typeof (backend as { setSessionModel?: (model: string) => Promise<boolean> }).setSessionModel === 'function'
        ? await (backend as { setSessionModel: (model: string) => Promise<boolean> }).setSessionModel(resolvedLegacyModel)
        : false;
    if (switched) {
      legacyModels = {
        ...legacyModels,
        currentModelId: resolvedLegacyModel,
      };
    }
  };

  const onBackendMessage = (msg: AgentMessage) => {
    if (verbose) {
      logAcp('muted', `Outgoing raw backend message from ${opts.agentName}: ${formatUnknownForConsole(msg, ACP_RAW_PREVIEW_CHARS)}`);
    }

    if (msg.type === 'event' && msg.name === 'available_commands') {
      const commands = msg.payload as { name: string; description?: string }[];
      const commandNames = commands.map((c) => c.name);
      sawSlashCommands = commands.length > 0;
      if (verbose) {
        logAcp('muted', `Outgoing slash commands from ${opts.agentName} (${commands.length}):`);
        for (const command of commands) {
          logAcp('muted', `  /${command.name}${formatOptionalDetail(command.description, 160)}`);
        }
      }
      session.updateMetadata((currentMetadata) => ({
        ...currentMetadata,
        slashCommands: commandNames,
      }));
    }

    if (msg.type === 'event' && msg.name === 'config_options_update') {
      const configOptions = extractConfigOptionsFromPayload(msg.payload);
      if (configOptions) {
        if (verbose) {
          logAcp('muted', `Outgoing config options from ${opts.agentName} (${configOptions.length}):`);
          for (const option of configOptions) {
            if (option.type === 'select') {
              const optionValues = flattenSelectOptions(option.options);
              logAcp('muted', `  config=${option.id} category=${option.category ?? 'unknown'} current=${option.currentValue} options=${optionValues.length}`);
            } else {
              logAcp('muted', `  config=${option.id} type=${option.type} category=${option.category ?? 'unknown'}`);
            }
          }
        }

        modeSelector = extractConfigSelector(configOptions, 'mode');
        modelSelector = extractConfigSelector(configOptions, 'model');
        if (verbose) {
          if (modeSelector) {
            sawModes = true;
            logAcp('muted', `Outgoing mode options from ${opts.agentName} (${modeSelector.options.length}), current=${modeSelector.currentCode}:`);
            for (const option of modeSelector.options) {
              logAcp('muted', `  mode=${option.code} label=${option.value}`);
            }
          } else {
            logAcp('muted', `Outgoing mode options from ${opts.agentName}: not reported in config options`);
          }
          if (modelSelector) {
            sawModels = true;
            logAcp('muted', `Outgoing model options from ${opts.agentName} (${modelSelector.options.length}), current=${modelSelector.currentCode}:`);
            for (const option of modelSelector.options) {
              logAcp('muted', `  model=${option.code} label=${option.value}`);
            }
          } else {
            logAcp('muted', `Outgoing model options from ${opts.agentName}: not reported in config options`);
          }
        }
        session.updateMetadata((currentMetadata) =>
          mergeAcpSessionConfigIntoMetadata(currentMetadata, { configOptions }),
        );
        if (opts.agentName === 'cursor' && currentPermissionMode && !appliedInitialPermissionMode) {
          appliedInitialPermissionMode = true;
          void switchPermissionModeIfRequested(currentPermissionMode);
        }
        if (opts.agentName === 'cursor' && currentModel && !appliedInitialModel) {
          appliedInitialModel = true;
          void switchModelIfRequested(currentModel);
        }
      }
    }

    if (msg.type === 'event' && msg.name === 'modes_update') {
      const modes = extractModeStateFromPayload(msg.payload);
      if (modes) {
        legacyModes = modes;
        sawModes = true;
        if (verbose) {
          logAcp('muted', `Outgoing modes from ${opts.agentName} (${modes.availableModes.length}), current=${modes.currentModeId}:`);
          for (const mode of modes.availableModes) {
            logAcp('muted', `  mode=${mode.id} name=${mode.name}${formatOptionalDetail(mode.description, 160)}`);
          }
        }
        session.updateMetadata((currentMetadata) =>
          mergeAcpSessionConfigIntoMetadata(currentMetadata, { modes }),
        );
        if (opts.agentName === 'cursor' && currentPermissionMode && !appliedInitialPermissionMode) {
          appliedInitialPermissionMode = true;
          void switchPermissionModeIfRequested(currentPermissionMode);
        }
      }
    }

    if (msg.type === 'event' && msg.name === 'models_update') {
      const models = extractModelStateFromPayload(msg.payload);
      if (models) {
        legacyModels = models;
        sawModels = true;
        if (verbose) {
          logAcp('muted', `Outgoing models from ${opts.agentName} (${models.availableModels.length}), current=${models.currentModelId}:`);
          for (const model of models.availableModels) {
            logAcp('muted', `  model=${model.modelId} name=${model.name}`);
          }
        }
        session.updateMetadata((currentMetadata) =>
          mergeAcpSessionConfigIntoMetadata(currentMetadata, { models }),
        );
        if (opts.agentName === 'cursor' && currentModel && !appliedInitialModel) {
          appliedInitialModel = true;
          void switchModelIfRequested(currentModel);
        }
      }
    }

    if (msg.type === 'event' && msg.name === 'current_mode_update') {
      const currentModeId = extractCurrentModeIdFromPayload(msg.payload);
      if (currentModeId) {
        if (modeSelector) {
          modeSelector = {
            ...modeSelector,
            currentCode: currentModeId,
          };
        }
        if (legacyModes) {
          legacyModes = {
            ...legacyModes,
            currentModeId,
          };
        }
        session.updateMetadata((currentMetadata) =>
          mergeAcpSessionConfigIntoMetadata(currentMetadata, { currentModeId }),
        );
      }
    }

    if (msg.type === 'tool-call' || msg.type === 'model-output') {
      // Any activity from the agent extends the turn deadline so long-running
      // sub-tasks (e.g. Task sub-agents) don't hit the static TURN_TIMEOUT_MS.
      extendTurnTimeout();
    }

    if (msg.type === 'status') {
      const suffix = msg.detail ? `: ${msg.detail}` : '';
      const statusLine = `Status: ${msg.status}${suffix}`;
      logAcp('muted', statusLine);
      const nextThinking = msg.status === 'running';
      if (thinking !== nextThinking) {
        thinking = nextThinking;
        session.keepAlive(thinking, 'remote');
      }
      if (msg.status === 'idle') {
        clearPendingTurn();
      }
      if (msg.status === 'error' || msg.status === 'stopped') {
        stopRunnerFromBackendStatus(msg.status, msg.detail);
      }
    }

    const frontendMessage = formatAcpMessageForFrontend(opts.agentName, msg, verbose);
    if (frontendMessage) {
      logAcp(frontendMessage.kind, frontendMessage.text);
    }

    // Apply lazy encoding for CursorEdit/CursorWrite in the ACP path (same as direct cursor path).
    let mappableMsg = msg;
    if (msg.type === 'tool-result' && (msg.toolName === 'CursorEdit' || msg.toolName === 'CursorWrite')) {
      const encoded = session.maybeLazyEncodeResult(msg.toolName, msg.callId, msg.result);
      mappableMsg = { ...msg, result: encoded };
    }
    sendEnvelopes(sessionManager.mapMessage(mappableMsg));
  };

  backend.onMessage(onBackendMessage);

  userMessageHandler = (message) => {
    if (!message.content.text) {
      const keys = message?.content && typeof message.content === 'object' ? Object.keys(message.content).join(',') : 'n/a';
      logger.debug(`[${opts.agentName}] onUserMessage skipped: no text (keys: ${keys})`);
      return;
    }

    logger.debug(`[${opts.agentName}] User message received from app, pushing to queue (len=${message.content.text.length})`);
    if (typeof message.meta?.permissionMode === 'string') {
      currentPermissionMode = message.meta.permissionMode;
      logger.debug(`[${opts.agentName}] Requested ACP permission mode: ${currentPermissionMode}`);
    }

    if (message.meta && Object.prototype.hasOwnProperty.call(message.meta, 'model')) {
      currentModel = message.meta.model ?? null;
      logger.debug(`[${opts.agentName}] Requested ACP model: ${currentModel ?? 'null'}`);
    }

    const mode = {
      permissionMode: currentPermissionMode,
      model: currentModel,
    };
    const isA2A = (message.meta as { origin?: string } | undefined)?.origin === 'a2a';
    if (isA2A) {
      messageQueue.pushIsolated(message.content.text, mode);
    } else {
      messageQueue.push(message.content.text, mode);
    }
  };
  session.onUserMessage(userMessageHandler);
  session.keepAlive(thinking, 'remote');
  writeSessionPidFile(session.sessionId);

  const keepAliveInterval = setInterval(() => {
    session.keepAlive(thinking, 'remote');
  }, 2000);

  // Flush accumulated text chunks every 80ms so App receives batched envelopes
  // instead of one per token (avoids each token rendering as a separate bubble).
  const textFlushInterval = setInterval(() => {
    const envelopes = sessionManager.flushText();
    if (envelopes.length > 0) {
      sendEnvelopes(envelopes);
    }
  }, 80);

  async function handleAbort() {
    try {
      if (acpSessionId) {
        await backend.cancel(acpSessionId);
      }
      permissionHandler.reset();
      abortController.abort();
    } catch (error) {
      logger.debug(`[${opts.agentName}] Abort failed:`, error);
    } finally {
      abortController = new AbortController();
    }
  }

  session.rpcHandlerManager.registerHandler('abort', handleAbort);
  registerKillSessionHandler(session.rpcHandlerManager, async () => {
    shouldExit = true;
    messageQueue.close();
    clearPendingTurn(new Error('Session terminated'));
    await handleAbort();
  });

  // Exit signals: exit loop so finally runs (session-end 反注册)
  const triggerExit = () => {
    shouldExit = true;
    messageQueue.close();
    clearPendingTurn(new Error('Exit signal'));
  };
  process.on('SIGTERM', triggerExit);
  process.on('SIGINT', triggerExit);
  process.on('SIGHUP', triggerExit);

  try {
    const started = await backend.startSession();
    acpSessionId = started.sessionId;

    if (opts.agentName === 'cursor') {
      // Modes come from session/new response (agent/plan/ask); no need to hardcode here.
      session.sendSessionEvent({ type: 'ready' });
      try {
        api.push().sendToAllDevices("It's ready!", "Cursor is waiting for your command", { sessionId: session.sessionId });
      } catch (pushError) {
        logger.debug('[cursor] Failed to send ready push', pushError);
      }
    }

    if (verbose) {
      if (!sawSlashCommands) {
        logAcp('muted', `Outgoing slash commands from ${opts.agentName}: not reported yet`);
      }
      if (!sawModes) {
        logAcp('muted', `Outgoing modes from ${opts.agentName}: not reported yet`);
      }
      if (!sawModels) {
        logAcp('muted', `Outgoing models from ${opts.agentName}: not reported yet`);
      }
    }

    while (!shouldExit) {
      const waitSignal = abortController.signal;
      const batch = await messageQueue.waitForMessagesAndGetAsString(waitSignal);
      if (!batch) {
        if (shouldExit) {
          break;
        }
        if (waitSignal.aborted) {
          continue;
        }
        break;
      }

      if (!acpSessionId) {
        throw new Error('ACP session is not started');
      }

      logAcp('incoming', `Incoming prompt: ${formatUnknownForConsole(batch.message, ACP_EVENT_PREVIEW_CHARS)}`);
      logger.debug(`[${opts.agentName}] Sending turn-start and starting backend`);
      sendEnvelopes(sessionManager.startTurn());
      const turnEnded = waitForTurnEnd();
      try {
        if (typeof batch.mode.permissionMode === 'string' && batch.mode.permissionMode.length > 0) {
          currentPermissionMode = batch.mode.permissionMode;
          await switchPermissionModeIfRequested(batch.mode.permissionMode);
        }
        if (typeof batch.mode.model === 'string' && batch.mode.model.length > 0) {
          await switchModelIfRequested(batch.mode.model);
        }
        await backend.sendPrompt(acpSessionId, batch.message);
        await turnEnded;
        if (backend instanceof AcpCursorBackend) {
          backend.flushPendingOnTurnEnd();
        }
        sendEnvelopes(sessionManager.endTurn('completed'));
        await session.flush();
        session.sendSessionEvent({ type: 'ready' });
        if (verbose) {
          logAcp('muted', `Outgoing prompt completion from ${opts.agentName}`);
        }
      } catch (error) {
        if (backendStopped && !opts.backend) {
          // agent stopped due to cancellation; dispose old backend and restart for next message
          backendStopped = false;
          sendEnvelopes(sessionManager.endTurn('failed'));
          await session.flush().catch(() => {});
          try {
            backend.offMessage?.(onBackendMessage);
            await backend.dispose();
          } catch { /* ignore dispose errors */ }
          backend = backendFactory();
          backend.onMessage(onBackendMessage);
          const restarted = await backend.startSession();
          acpSessionId = restarted.sessionId;
          session.sendSessionEvent({ type: 'ready' });
          logAcp('muted', `Backend restarted after cancellation (new session: ${acpSessionId})`);
          continue;
        }
        sendEnvelopes(sessionManager.endTurn('failed'));
        await session.flush();
        session.sendSessionEvent({ type: 'ready' });
        logAcp('error', `Prompt error from ${opts.agentName}: ${error instanceof Error ? error.message : String(error)}`);
        clearPendingTurn(error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
    }
  } finally {
    removeSessionPidFile();
    if (reportToDaemonInterval !== null) {
      clearInterval(reportToDaemonInterval);
    }
    clearInterval(keepAliveInterval);
    clearInterval(textFlushInterval);
    reconnectionHandle?.cancel();
    clearPendingTurn(new Error('ACP runner shutting down'));

    try {
      permissionHandler.reset();
    } catch (error) {
      logger.debug(`[${opts.agentName}] Failed to reset permission handler:`, error);
    }

    backend.offMessage?.(onBackendMessage);
    await backend.dispose();

    try {
      happyServer.stop();
    } catch (error) {
      logger.debug(`[${opts.agentName}] Failed to stop Happy MCP server:`, error);
    }

    try {
      await session.updateMetadata((currentMetadata) => ({
        ...currentMetadata,
        lifecycleState: 'archived',
        lifecycleStateSince: Date.now(),
        archivedBy: 'cli',
        archiveReason: 'Session ended',
      }));
      session.sendSessionDeath();
      await session.flush();
      await session.close();
    } catch (error) {
      logger.debug(`[${opts.agentName}] Session close failed:`, error);
    }
  }
}
