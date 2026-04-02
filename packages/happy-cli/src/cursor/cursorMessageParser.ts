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

/**
 * Internal message types emitted by the parser.
 * These are consumed by runCursor.ts to update the session and UI.
 */
export type CursorParsedMessage =
  | { type: 'session_init'; sessionId: string; model?: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call_start'; toolName: string; args: Record<string, unknown>; callId: string }
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

      case 'user': {
        // cursor-agent may emit a startup/user placeholder event; it carries no actionable content.
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
            });
          } else if (msg.subtype === 'completed') {
            const callId = this.shiftCallId(key);
            const r = tc.shellToolCall.result;
            const success = !!r?.success;
            const stdout = r?.success?.stdout || r?.failure?.stderr || '';
            results.push({
              type: 'tool_call_end',
              toolName: 'CursorBash',
              result: { stdout, exitCode: r?.success?.exitCode ?? r?.failure?.exitCode },
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
          const key = this.toolKey('CursorWrite', { path: filePath });
          if (msg.subtype === 'started') {
            const callId = this.pushCallId(key);
            results.push({
              type: 'tool_call_start',
              toolName: 'CursorWrite',
              args: { path: filePath },
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
          const args = tc.editToolCall.args || {};
          const key = this.toolKey('CursorEdit', args);
          if (msg.subtype === 'started') {
            const callId = this.pushCallId(key);
            results.push({
              type: 'tool_call_start',
              toolName: 'CursorEdit',
              args,
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
