/**
 * CursorBackend - AgentBackend implementation for Cursor agent (cursor-agent CLI).
 *
 * Runs one cursor-agent process per sendPrompt (per turn). Emits AgentMessage so runAcp
 * can use AcpSessionManager to produce session protocol envelopes for the App.
 * No long-lived subprocess; session is logical (sessionId + cursorChatId for --resume).
 *
 * We only emit idle when we get task_complete from the stream or when the process exits (finally).
 * We do NOT use an idle timeout on stream silence: cursor-agent can take a long time (thinking then
 * assistant), and if we ended the turn after N seconds of silence we would send turn-end before
 * the reply arrives; the reply would then be sent with no current turn and the app would not show it.
 */

const CURSOR_IDLE_TIMEOUT_MS = process.env.CURSOR_IDLE_TIMEOUT_MS
  ? parseInt(process.env.CURSOR_IDLE_TIMEOUT_MS, 10)
  : 0;

import { randomUUID } from 'node:crypto';
import { logger } from '@/ui/logger';
import type { AgentBackend, AgentMessage, AgentMessageHandler, SessionId, StartSessionResult } from '@/agent/core';
import { CursorProcess } from './cursorProcess';
import { CursorMessageParser, type CursorParsedMessage } from './cursorMessageParser';
import type { CursorStreamMessage } from './types';
import { parseSpecialCommand } from '@/parsers/specialCommands';

function toAgentToolShape(
  toolName: string,
  args: Record<string, unknown>,
): { name: string; input: Record<string, unknown> } {
  if (toolName === 'CursorBash') {
    const cmd =
      typeof args?.command === 'string'
        ? args.command
        : Array.isArray(args?.command)
          ? (args.command as string[]).join(' ')
          : '';
    return {
      name: 'Bash',
      input: { command: [cmd], parsed_cmd: [{ type: 'bash', cmd }] },
    };
  }
  if (toolName === 'CursorRead') {
    const path = (args?.path ?? args?.file_path) as string | undefined;
    return { name: 'Read', input: { file_path: path ?? '' } };
  }
  if (toolName === 'CursorWrite') {
    const path = (args?.path ?? args?.file_path) as string | undefined;
    const content = (args?.content as string) ?? '';
    return { name: 'Write', input: { file_path: path ?? '', content } };
  }
  if (toolName === 'CursorEdit') {
    const file_path = (args?.path ?? args?.file_path ?? args?.filePath) as string | undefined;
    const old_string = (args?.old_string ?? args?.oldString ?? args?.oldText) as string | undefined;
    const new_string = (args?.new_string ?? args?.newString ?? args?.newText) as string | undefined;
    return {
      name: 'Edit',
      input: { file_path: file_path ?? '', old_string: old_string ?? '', new_string: new_string ?? '' },
    };
  }
  return { name: toolName, input: args };
}

export interface CursorBackendOptions {
  cwd: string;
}

export class CursorBackend implements AgentBackend {
  private listeners: AgentMessageHandler[] = [];
  private disposed = false;
  private sessionId: SessionId | null = null;
  private cursorChatId: string | undefined;
  private abortController: AbortController | null = null;

  constructor(private readonly options: CursorBackendOptions) {}

  onMessage(handler: AgentMessageHandler): void {
    this.listeners.push(handler);
  }

  offMessage(handler: AgentMessageHandler): void {
    const index = this.listeners.indexOf(handler);
    if (index !== -1) this.listeners.splice(index, 1);
  }

  private emit(msg: AgentMessage): void {
    if (this.disposed) return;
    for (const listener of this.listeners) {
      try {
        listener(msg);
      } catch (error) {
        logger.warn('[CursorBackend] Error in message handler:', error);
      }
    }
  }

  async startSession(_initialPrompt?: string): Promise<StartSessionResult> {
    if (this.disposed) throw new Error('Backend has been disposed');
    this.sessionId = randomUUID();
    this.cursorChatId = undefined;
    this.emit({ type: 'status', status: 'starting' });
    logger.debug(`[CursorBackend] Session started: ${this.sessionId}`);
    this.emit({ type: 'status', status: 'idle' });
    return { sessionId: this.sessionId };
  }

  async sendPrompt(sessionId: SessionId, prompt: string): Promise<void> {
    if (this.disposed) throw new Error('Backend has been disposed');
    if (this.sessionId !== sessionId) throw new Error('Session mismatch');

    this.emit({ type: 'status', status: 'running' });
    this.abortController = new AbortController();

    const workspacePath = this.options.cwd;
    const messageParser = new CursorMessageParser();
    const toolCallTimeoutHandles = new Map<string, ReturnType<typeof setTimeout>>();
    let idleEmitted = false;
    let idleTimeoutHandle: ReturnType<typeof setTimeout> | null = null;

    const emitIdleOnce = (): void => {
      if (idleEmitted) return;
      idleEmitted = true;
      if (idleTimeoutHandle) {
        clearTimeout(idleTimeoutHandle);
        idleTimeoutHandle = null;
      }
      logger.debug('[CursorBackend] Emitting status idle (turn can end)');
      this.emit({ type: 'status', status: 'idle' });
    };

    const scheduleIdleTimeout = (): void => {
      if (CURSOR_IDLE_TIMEOUT_MS <= 0) return;
      if (idleTimeoutHandle) clearTimeout(idleTimeoutHandle);
      idleTimeoutHandle = setTimeout(() => {
        idleTimeoutHandle = null;
        logger.debug('[CursorBackend] Idle timeout (no stream activity), emitting idle');
        emitIdleOnce();
      }, CURSOR_IDLE_TIMEOUT_MS);
    };

    const processTimeoutMs = process.env.CURSOR_AGENT_PROCESS_TIMEOUT_MS
      ? parseInt(process.env.CURSOR_AGENT_PROCESS_TIMEOUT_MS, 10)
      : 3600000;
    const perToolTimeoutMs = process.env.CURSOR_TOOL_CALL_TIMEOUT_MS
      ? parseInt(process.env.CURSOR_TOOL_CALL_TIMEOUT_MS, 10)
      : 600000;

    const cursorModel = process.env.CURSOR_MODEL || 'auto';
    const cursorProc = new CursorProcess({
      cwd: workspacePath,
      resumeChatId: this.cursorChatId,
      model: cursorModel,
      signal: this.abortController.signal,
      timeoutMs: processTimeoutMs,
    });

    const flushText = (): void => { /* no accumulation for ACP path; we emit text deltas */ };
    const specialCommand = parseSpecialCommand(prompt);

    /* Idle timeout is only scheduled after we receive at least one stream message (thinking/assistant/result).
       This avoids ending the turn during cursor-agent startup delay (e.g. first line broken, "user" type only). */

    cursorProc.on('message', (rawMsg: CursorStreamMessage) => {
      if (process.env.CURSOR_AGENT_VERBOSE === '1') {
        logger.debug(`[cursor-agent] type=${rawMsg.type}`, typeof (rawMsg as { text?: string }).text === 'string' ? { textLen: (rawMsg as { text: string }).text.length } : {});
      } else {
        logger.debug(`[CursorBackend] stream msg type: ${rawMsg.type}`);
      }
      scheduleIdleTimeout();
      const parsed = messageParser.parse(rawMsg);
      for (const msg of parsed) {
        scheduleIdleTimeout();
        switch (msg.type) {
          case 'session_init':
            if (msg.sessionId) {
              this.cursorChatId = msg.sessionId;
              logger.debug(`[CursorBackend] Chat ID: ${this.cursorChatId}`);
            }
            break;
          case 'text_delta':
            if (msg.text && process.env.CURSOR_AGENT_VERBOSE === '1') {
              logger.debug(`[CursorBackend] model-output len=${msg.text.length} preview=${msg.text.slice(0, 80).replace(/\n/g, ' ')}`);
            }
            this.emit({ type: 'model-output', textDelta: msg.text });
            break;
          case 'thinking_delta':
            this.emit({ type: 'event', name: 'thinking', payload: { text: msg.text, streaming: true } });
            break;
          case 'tool_call_start': {
            flushText();
            const { name, input } = toAgentToolShape(msg.toolName, msg.args);
            this.emit({ type: 'tool-call', toolName: name, args: input, callId: msg.callId });
            const handle = setTimeout(() => {
              toolCallTimeoutHandles.delete(msg.callId);
              this.emit({
                type: 'tool-result',
                toolName: name,
                result: { runningInBackground: true, message: 'Tool still running; timer stopped.' },
                callId: msg.callId,
              });
            }, perToolTimeoutMs);
            toolCallTimeoutHandles.set(msg.callId, handle);
            break;
          }
          case 'tool_call_end': {
            const existingHandle = toolCallTimeoutHandles.get(msg.callId);
            if (existingHandle) {
              clearTimeout(existingHandle);
              toolCallTimeoutHandles.delete(msg.callId);
            }
            const { name } = toAgentToolShape(msg.toolName, {});
            this.emit({ type: 'tool-result', toolName: name, result: msg.result, callId: msg.callId });
            break;
          }
          case 'task_complete':
            for (const h of toolCallTimeoutHandles.values()) clearTimeout(h);
            toolCallTimeoutHandles.clear();
            if (msg.sessionId) this.cursorChatId = msg.sessionId;
            emitIdleOnce();
            break;
          case 'error':
            this.emit({ type: 'status', status: 'error', detail: msg.message });
            break;
          default:
            break;
        }
      }
    });

    try {
      if (specialCommand.type === 'compact') {
        logger.debug('[CursorBackend] /compact command detected - running interactive compression turn');
        await cursorProc.runInteractiveCommand('/compress');
      } else {
        await cursorProc.run(prompt);
      }
    } catch (error) {
      const isAbort = error instanceof Error && error.name === 'AbortError';
      for (const h of toolCallTimeoutHandles.values()) clearTimeout(h);
      toolCallTimeoutHandles.clear();
      if (!isAbort) {
        logger.debug('[CursorBackend] Process error:', error);
        this.emit({ type: 'status', status: 'error', detail: error instanceof Error ? error.message : String(error) });
      }
      emitIdleOnce();
      throw error;
    } finally {
      this.abortController = null;
      emitIdleOnce();
    }
  }

  async cancel(_sessionId: SessionId): Promise<void> {
    if (this.abortController) this.abortController.abort();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.abortController) this.abortController.abort();
    this.listeners.length = 0;
    this.sessionId = null;
    this.cursorChatId = undefined;
  }
}
