/**
 * CursorMessageParser - Maps cursor-agent stream-json messages to session protocol events
 *
 * cursor-agent emits stream-json messages with types: system, thinking, assistant, tool_call, result.
 * This module converts them into the internal message format used by runCursor to drive the UI
 * and forward to the Happy server/mobile app.
 */

import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { logger } from '@/ui/logger';
import type { CursorStreamMessage } from './types';

/** Map cursor-agent todo status to app TodoWrite status */
function mapCursorTodoStatus(cursorStatus: string | undefined): 'pending' | 'in_progress' | 'completed' {
  if (cursorStatus === 'TODO_STATUS_IN_PROGRESS') return 'in_progress';
  if (cursorStatus === 'TODO_STATUS_COMPLETED') return 'completed';
  return 'pending';
}

/** Normalize cursor-agent todo item to app TodoWrite shape */
function normalizeTodoItem(t: { id?: string; content?: string; status?: string; [k: string]: unknown }): { id: string; content: string; status: 'pending' | 'in_progress' | 'completed' } {
  return {
    id: typeof t.id === 'string' ? t.id : '',
    content: typeof t.content === 'string' ? t.content : '',
    status: mapCursorTodoStatus(t.status),
  };
}

/**
 * Internal message types emitted by the parser.
 * These are consumed by runCursor.ts to update the session and UI.
 */
export type CursorParsedMessage =
  | { type: 'session_init'; sessionId: string; model?: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call_start'; toolName: string; args: Record<string, unknown>; callId: string; description?: string }
  | { type: 'tool_call_end'; toolName: string; result: unknown; callId: string; success: boolean }
  | { type: 'task_started' }
  | { type: 'task_complete'; sessionId?: string; usage?: Record<string, unknown>; costUsd?: number; durationMs?: number }
  | { type: 'error'; message: string };

/**
 * Stateful parser to maintain callId pairing between started/completed tool calls.
 * Per-key FIFO: same tool+args can run multiple times; completed order may differ from started,
 * so we use a queue per (toolName, argsHash) so each completed gets the correct callId.
 */
export class CursorMessageParser {
  /** key = toolKey (toolName + args hash), value = queue of callIds for that key */
  private pendingByKey: Map<string, string[]> = new Map();

  private toolKey(toolName: string, args: Record<string, unknown>): string {
    const canonical = JSON.stringify(args, Object.keys(args).sort());
    return createHash('sha256').update(toolName + canonical).digest('hex').slice(0, 24);
  }

  private pushCallId(key: string): string {
    const callId = randomUUID();
    let q = this.pendingByKey.get(key);
    if (!q) {
      q = [];
      this.pendingByKey.set(key, q);
    }
    q.push(callId);
    return callId;
  }

  private shiftCallId(key: string): string {
    const q = this.pendingByKey.get(key);
    const callId = q?.shift() ?? randomUUID();
    if (q?.length === 0) this.pendingByKey.delete(key);
    return callId;
  }

  /**
   * Parse a cursor-agent stream-json message into internal format.
   */
  parse(msg: CursorStreamMessage): CursorParsedMessage[] {
    const results: CursorParsedMessage[] = [];

    switch (msg.type) {
      case 'system': {
        if (msg.session_id) {
          results.push({
            type: 'session_init',
            sessionId: msg.session_id,
            model: msg.model,
          });
        }
        break;
      }

      case 'thinking': {
        if (msg.text) {
          results.push({ type: 'thinking_delta', text: msg.text });
        }
        break;
      }

      case 'assistant': {
        const content = msg.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text' && block.text) {
              results.push({ type: 'text_delta', text: block.text });
            }
            // Do NOT emit tool_call_start for tool_use here - we only emit from tool_call started/completed
            // so that each start has exactly one end and the mobile timer stops correctly.
          }
        }
        break;
      }

      case 'tool_call': {
        const tc = msg.tool_call;
        if (!tc) break;

        if (tc.shellToolCall) {
          const command = tc.shellToolCall.args?.command || '';
          const key = this.toolKey('CursorBash', { command });
          if (msg.subtype === 'started') {
            const callId = this.pushCallId(key);
            results.push({
              type: 'tool_call_start',
              toolName: 'CursorBash',
              args: { command },
              callId,
              description: tc.shellToolCall.args?.description,
            });
          } else if (msg.subtype === 'completed') {
            const callId = this.shiftCallId(key);
            const r = tc.shellToolCall.result;
            const success = !!r?.success;
            const stdout = r?.success?.stdout ?? '';
            const stderr = r?.failure?.stderr ?? '';
            const exitCode = r?.success?.exitCode ?? r?.failure?.exitCode;
            results.push({
              type: 'tool_call_end',
              toolName: 'CursorBash',
              result: { stdout, stderr, exitCode },
              callId,
              success,
            });
          } else if (msg.subtype) {
            // cancelled, failed, timeout, or any other non-started non-completed: treat as ended without success
            const callId = this.shiftCallId(key);
            results.push({
              type: 'tool_call_end',
              toolName: 'CursorBash',
              result: { cancelled: true, subtype: msg.subtype },
              callId,
              success: false,
            });
          }
        }

        if (tc.readToolCall) {
          const filePath = tc.readToolCall.args?.path || '';
          const key = this.toolKey('CursorRead', { path: filePath });
          if (msg.subtype === 'started') {
            const callId = this.pushCallId(key);
            results.push({
              type: 'tool_call_start',
              toolName: 'CursorRead',
              args: { path: filePath },
              callId,
            });
          } else if (msg.subtype === 'completed') {
            const callId = this.shiftCallId(key);
            results.push({
              type: 'tool_call_end',
              toolName: 'CursorRead',
              result: tc.readToolCall.result,
              callId,
              success: true,
            });
          } else if (msg.subtype) {
            const callId = this.shiftCallId(key);
            results.push({
              type: 'tool_call_end',
              toolName: 'CursorRead',
              result: { cancelled: true, subtype: msg.subtype },
              callId,
              success: false,
            });
          }
        }

        if (tc.writeToolCall) {
          const filePath = tc.writeToolCall.args?.path || '';
          const rawWriteArgs = tc.writeToolCall.args as Record<string, unknown> | undefined ?? {};
          const content = (rawWriteArgs.content ?? rawWriteArgs.streamContent ?? '') as string;
          const key = this.toolKey('CursorWrite', { path: filePath });
          if (msg.subtype === 'started') {
            const callId = this.pushCallId(key);
            results.push({
              type: 'tool_call_start',
              toolName: 'CursorWrite',
              args: { path: filePath, content },
              callId,
            });
          } else if (msg.subtype === 'completed') {
            const callId = this.shiftCallId(key);
            results.push({
              type: 'tool_call_end',
              toolName: 'CursorWrite',
              result: tc.writeToolCall.result,
              callId,
              success: true,
            });
          } else if (msg.subtype) {
            const callId = this.shiftCallId(key);
            results.push({
              type: 'tool_call_end',
              toolName: 'CursorWrite',
              result: { cancelled: true, subtype: msg.subtype },
              callId,
              success: false,
            });
          }
        }

        if (tc.editToolCall) {
          const rawArgs = tc.editToolCall.args || {};
          const editPath = (rawArgs.path ?? rawArgs.file_path ?? rawArgs.filePath ?? '') as string;
          const oldString = (rawArgs.old_string ?? rawArgs.oldString ?? rawArgs.oldText ?? '') as string;
          const newString = (rawArgs.new_string ?? rawArgs.newString ?? rawArgs.newText ?? '') as string;
          const streamContent = (rawArgs.streamContent ?? rawArgs.content ?? '') as string;
          const normalizedEditArgs = { path: editPath, old_string: oldString, new_string: newString, streamContent };
          const key = this.toolKey('CursorEdit', normalizedEditArgs);
          if (msg.subtype === 'started') {
            const callId = this.pushCallId(key);
            results.push({
              type: 'tool_call_start',
              toolName: 'CursorEdit',
              args: normalizedEditArgs,
              callId,
            });
          } else if (msg.subtype === 'completed') {
            const callId = this.shiftCallId(key);
            results.push({
              type: 'tool_call_end',
              toolName: 'CursorEdit',
              result: tc.editToolCall.result,
              callId,
              success: true,
            });
          } else if (msg.subtype) {
            const callId = this.shiftCallId(key);
            results.push({
              type: 'tool_call_end',
              toolName: 'CursorEdit',
              result: { cancelled: true, subtype: msg.subtype },
              callId,
              success: false,
            });
          }
        }

        if (tc.updateTodosToolCall) {
          const rawTodos = tc.updateTodosToolCall.args?.todos ?? [];
          const todos = rawTodos.map((t) => normalizeTodoItem(t as Parameters<typeof normalizeTodoItem>[0]));
          const key = this.toolKey('TodoWrite', { todos });
          if (msg.subtype === 'started') {
            const callId = this.pushCallId(key);
            results.push({
              type: 'tool_call_start',
              toolName: 'TodoWrite',
              args: { todos },
              callId,
            });
          } else if (msg.subtype === 'completed') {
            const callId = this.shiftCallId(key);
            const res = tc.updateTodosToolCall.result?.success;
            const resultTodos = Array.isArray(res?.todos)
              ? res.todos.map((t) => normalizeTodoItem(t as Parameters<typeof normalizeTodoItem>[0]))
              : todos;
            results.push({
              type: 'tool_call_end',
              toolName: 'TodoWrite',
              result: { newTodos: resultTodos },
              callId,
              success: true,
            });
          } else if (msg.subtype) {
            const callId = this.shiftCallId(key);
            results.push({
              type: 'tool_call_end',
              toolName: 'TodoWrite',
              result: { cancelled: true, subtype: msg.subtype },
              callId,
              success: false,
            });
          }
        }
        break;
      }

      case 'result': {
        results.push({
          type: 'task_complete',
          sessionId: msg.session_id,
          usage: msg.usage as Record<string, unknown> | undefined,
          costUsd: msg.total_cost_usd,
          durationMs: msg.duration_ms,
        });

        if (msg.is_error && msg.result) {
          results.push({ type: 'error', message: msg.result });
        }
        break;
      }

      default:
        logger.debug(`[cursor] Unknown message type: ${(msg as any).type}`);
        break;
    }

    return results;
  }

  /**
   * Clear all pending tool call state (e.g., at turn end).
   */
  clear(): void {
    this.pendingByKey.clear();
  }
}

/**
 * Legacy stateless function for backward compatibility.
 * Use CursorMessageParser class for stateful parsing.
 */
export function parseCursorMessage(msg: CursorStreamMessage): CursorParsedMessage[] {
  const parser = new CursorMessageParser();
  return parser.parse(msg);
}
