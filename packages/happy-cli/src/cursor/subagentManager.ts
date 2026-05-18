/**
 * SubagentManager - Non-blocking lifecycle manager for sub-agents.
 *
 * Each sub-agent is a cursor-agent process that runs in the background.
 * The manager tracks state, supports multi-turn conversation (via --resume),
 * and streams events to the session protocol.
 *
 * State machine:
 *   spawn → running → idle (turn done, awaiting next message or auto-complete)
 *                        ↓ message_subagent
 *                     running → idle → … → completed | error | stopped
 */

import type { SessionEvent } from '@slopus/happy-wire';
import { CursorProcess } from './cursorProcess';
import { CursorMessageParser, type CursorParsedMessage } from './cursorMessageParser';
import type { CursorStreamMessage } from './types';
import { logger } from '@/ui/logger';

export type SubagentStatus = 'running' | 'idle' | 'completed' | 'error' | 'stopped';

export interface SubagentInfo {
  id: string;
  title: string;
  status: SubagentStatus;
  summary: string | null;
  error: string | null;
  turnCount: number;
  createdAt: number;
  updatedAt: number;
}

interface SubagentInternal extends SubagentInfo {
  chatId: string | null;
  cwd: string;
  lastText: string;
  abortController: AbortController;
}

/** Same mapping used by runSubagent / runCursor. */
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
      codexInput: { command: [cmd], parsed_cmd: [{ type: 'bash', cmd }] },
    };
  }
  if (toolName === 'CursorRead') {
    const path = (args?.path ?? args?.file_path) as string | undefined;
    return { codexName: 'Read', codexInput: { file_path: path ?? '' } };
  }
  if (toolName === 'CursorWrite') {
    const path = (args?.path ?? args?.file_path) as string | undefined;
    const content = (args?.content as string) ?? '';
    return { codexName: 'Write', codexInput: { file_path: path ?? '', content } };
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

function parsedMessageToSessionEvent(msg: CursorParsedMessage): SessionEvent | null {
  switch (msg.type) {
    case 'text_delta':
      return { t: 'text', text: msg.text };
    case 'thinking_delta':
      return { t: 'text', text: msg.text, thinking: true };
    case 'tool_call_start': {
      const { codexName, codexInput } = toCodexToolShape(msg.toolName, msg.args);
      const cmd = Array.isArray(codexInput?.command)
        ? (codexInput.command as string[]).join(' ')
        : (codexInput?.command as string) ?? '';
      const title = cmd ? `Run \`${cmd.length > 80 ? cmd.slice(0, 77) + '...' : cmd}\`` : `${codexName} call`;
      return { t: 'tool-call-start', call: msg.callId, name: codexName, title, description: title, args: codexInput };
    }
    case 'tool_call_end':
      return { t: 'tool-call-end', call: msg.callId };
    case 'error':
      return { t: 'service', text: `Error: ${msg.message}` };
    case 'session_init':
    case 'task_started':
    case 'task_complete':
      return null;
    default:
      return null;
  }
}

export interface SubagentManagerOptions {
  cwd: string;
  onChildEvent: (agentId: string, ev: SessionEvent) => void;
  /** Called when a sub-agent turn completes (status transitions to idle/completed/error). */
  onTurnDone?: (agent: SubagentInfo) => void;
}

export class SubagentManager {
  private agents = new Map<string, SubagentInternal>();
  private readonly cwd: string;
  private readonly onChildEvent: (agentId: string, ev: SessionEvent) => void;
  private readonly onTurnDone?: (agent: SubagentInfo) => void;

  constructor(opts: SubagentManagerOptions) {
    this.cwd = opts.cwd;
    this.onChildEvent = opts.onChildEvent;
    this.onTurnDone = opts.onTurnDone;
  }

  /** Spawn a new sub-agent. Returns immediately; agent runs in background. */
  spawn(id: string, prompt: string, title: string): SubagentInfo {
    const now = Date.now();
    const ac = new AbortController();
    const agent: SubagentInternal = {
      id,
      title,
      status: 'running',
      summary: null,
      error: null,
      turnCount: 1,
      createdAt: now,
      updatedAt: now,
      chatId: null,
      cwd: this.cwd,
      lastText: '',
      abortController: ac,
    };
    this.agents.set(id, agent);

    this.runTurn(agent, prompt);
    return this.toInfo(agent);
  }

  /** Send a follow-up message to an existing sub-agent (multi-turn). */
  message(id: string, message: string): { ok: true; info: SubagentInfo } | { ok: false; error: string } {
    const agent = this.agents.get(id);
    if (!agent) return { ok: false, error: `Sub-agent ${id} not found.` };
    if (agent.status === 'running') return { ok: false, error: `Sub-agent ${id} is still running. Wait for it to finish or check status.` };
    if (agent.status === 'stopped') return { ok: false, error: `Sub-agent ${id} was stopped.` };

    agent.status = 'running';
      agent.turnCount++;
      agent.updatedAt = Date.now();
      agent.lastText = '';  // reset for new turn

    this.runTurn(agent, message);
    return { ok: true, info: this.toInfo(agent) };
  }

  /** Get info about one or all sub-agents. */
  get(id?: string): SubagentInfo[] {
    if (id) {
      const agent = this.agents.get(id);
      return agent ? [this.toInfo(agent)] : [];
    }
    return Array.from(this.agents.values()).map(a => this.toInfo(a));
  }

  /** Stop a running sub-agent. */
  stop(id: string): { ok: true; info: SubagentInfo } | { ok: false; error: string } {
    const agent = this.agents.get(id);
    if (!agent) return { ok: false, error: `Sub-agent ${id} not found.` };
    agent.abortController.abort();
    agent.status = 'stopped';
    agent.updatedAt = Date.now();
    return { ok: true, info: this.toInfo(agent) };
  }

  /** Clean up all agents (e.g. on session end). */
  dispose(): void {
    for (const agent of this.agents.values()) {
      if (agent.status === 'running') {
        agent.abortController.abort();
        agent.status = 'stopped';
      }
    }
    this.agents.clear();
  }

  private runTurn(agent: SubagentInternal, prompt: string): void {
    const parser = new CursorMessageParser();

    const proc = new CursorProcess({
      cwd: agent.cwd,
      model: process.env.CURSOR_MODEL ?? 'auto',
      force: true,
      signal: agent.abortController.signal,
      timeoutMs: 600_000,
      resumeChatId: agent.chatId ?? undefined,
    });

    proc.on('message', (rawMsg: CursorStreamMessage) => {
      const parsed = parser.parse(rawMsg);
      for (const msg of parsed) {
        if (msg.type === 'session_init' && 'sessionId' in msg && msg.sessionId) {
          agent.chatId = msg.sessionId as string;
          logger.debug(`[subagentMgr] agent=${agent.id.slice(0, 8)} chatId=${agent.chatId}`);
        }
        if (msg.type === 'text_delta') agent.lastText += msg.text;
        if (msg.type === 'error') {
          agent.error = msg.message;
        }
        const ev = parsedMessageToSessionEvent(msg);
        if (ev) {
          this.onChildEvent(agent.id, ev);
        }
      }
    });

    proc.on('exit', (code) => {
      agent.updatedAt = Date.now();
      const summary = agent.lastText.trim().slice(0, 1000) || null;
      agent.summary = summary;

      if (agent.error) {
        agent.status = 'error';
      } else if (code !== 0 && code !== null) {
        agent.status = 'error';
        agent.error = `Process exited with code ${code}`;
      } else {
        // Turn completed successfully; agent is idle and can receive more messages.
        agent.status = 'idle';
      }

      logger.debug(`[subagentMgr] agent=${agent.id.slice(0, 8)} turn done status=${agent.status} summary=${(summary ?? '').length}chars`);

      // Do not send summary again as child – streamed text_delta already sent it; parent will get summary via get_subagent and reply once.
      this.onTurnDone?.(this.toInfo(agent));
    });

    proc.on('error', (err) => {
      agent.status = 'error';
      agent.error = err.message;
      agent.updatedAt = Date.now();
      logger.debug(`[subagentMgr] agent=${agent.id.slice(0, 8)} process error: ${err.message}`);
      this.onTurnDone?.(this.toInfo(agent));
    });

    proc.run(prompt).catch((err) => {
      if (agent.status === 'stopped') return;
      agent.status = 'error';
      agent.error = err?.name === 'AbortError' ? 'Aborted' : (err?.message ?? String(err));
      agent.updatedAt = Date.now();
      this.onTurnDone?.(this.toInfo(agent));
    });
  }

  private toInfo(a: SubagentInternal): SubagentInfo {
    return {
      id: a.id,
      title: a.title,
      status: a.status,
      summary: a.summary,
      error: a.error,
      turnCount: a.turnCount,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
    };
  }
}
