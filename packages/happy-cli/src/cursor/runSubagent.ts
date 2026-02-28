/**
 * runSubagent - Run a child cursor-agent process and emit session protocol events
 *
 * Used by the Happy MCP spawn_subagent tool. Spawns a single cursor-agent
 * process with the given prompt, parses stream-json output, and for each
 * parsed message emits a SessionEvent via onEvent. The caller wraps each
 * event in an envelope with turn + subagent and sends to the session.
 */

import type { SessionEvent } from '@slopus/happy-wire';
import { CursorProcess } from './cursorProcess';
import { CursorMessageParser, type CursorParsedMessage } from './cursorMessageParser';
import type { CursorStreamMessage } from './types';
import { logger } from '@/ui/logger';

/** Same mapping as runCursor so session protocol tool names/titles match. */
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
      return {
        t: 'tool-call-start',
        call: msg.callId,
        name: codexName,
        title,
        description: title,
        args: codexInput,
      };
    }
    case 'tool_call_end':
      return { t: 'tool-call-end', call: msg.callId };
    case 'error':
      return { t: 'text', text: `Error: ${msg.message}` };
    case 'session_init':
    case 'task_started':
    case 'task_complete':
      return null;
    default:
      return null;
  }
}

export interface RunSubagentOptions {
  cwd: string;
  prompt: string;
  model?: string;
  executionMode?: 'default' | 'plan' | 'ask';
  force?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Called for each session event; caller adds turn + subagent and sends. */
  onEvent: (ev: SessionEvent) => void;
}

export interface RunSubagentResult {
  success: boolean;
  summary?: string;
  error?: string;
}

/**
 * Run a child cursor-agent with the given prompt and emit session events via onEvent.
 * Resolves when the process exits. Use getCurrentTurnId + createEnvelope(..., { turn, subagent })
 * in the MCP handler to send envelopes.
 */
export function runSubagent(opts: RunSubagentOptions): Promise<RunSubagentResult> {
  const { cwd, prompt, model, executionMode, force, signal, timeoutMs, onEvent } = opts;
  const parser = new CursorMessageParser();
  let lastText = '';
  let hadError = false;
  let errorMessage = '';

  return new Promise<RunSubagentResult>((resolve) => {
    let settled = false;
    const finish = (result: RunSubagentResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const proc = new CursorProcess({
      cwd,
      model: model ?? process.env.CURSOR_MODEL ?? 'auto',
      executionMode,
      force: force ?? false,
      signal,
      timeoutMs: timeoutMs ?? 600_000, // 10 min default for subagent
    });

    proc.on('message', (rawMsg: CursorStreamMessage) => {
      const parsed = parser.parse(rawMsg);
      for (const msg of parsed) {
        if (msg.type === 'text_delta') lastText = msg.text;
        if (msg.type === 'error') {
          hadError = true;
          errorMessage = msg.message;
        }
        const ev = parsedMessageToSessionEvent(msg);
        if (ev) onEvent(ev);
      }
    });

    proc.on('exit', (code) => {
      if (hadError) {
        finish({ success: false, error: errorMessage, summary: lastText.slice(0, 500) });
      } else if (code !== 0) {
        finish({ success: false, error: `Process exited with code ${code}`, summary: lastText.slice(0, 500) });
      } else {
        finish({ success: true, summary: lastText.trim().slice(0, 1000) || undefined });
      }
    });

    proc.on('error', (err) => {
      logger.debug('[runSubagent] process error:', err);
      finish({ success: false, error: err.message });
    });

    proc.run(prompt).catch((err) => {
      const isAbort = err?.name === 'AbortError';
      finish({
        success: false,
        error: isAbort ? 'Subagent was aborted' : (err?.message ?? String(err)),
        summary: lastText.slice(0, 500),
      });
    });
  });
}
