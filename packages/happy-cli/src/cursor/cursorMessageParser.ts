/**
 * CursorMessageParser - Maps cursor-agent stream-json messages to session protocol events
 *
 * cursor-agent emits stream-json messages with types: system, thinking, assistant, tool_call, result.
 * This module converts them into the internal message format used by runCursor to drive the UI
 * and forward to the Happy server/mobile app.
 */

import { randomUUID, createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { createId } from '@paralleldrive/cuid2';
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
  | { type: 'tool_call_start'; toolName: string; args: Record<string, unknown>; callId: string; description?: string; subagentId?: string }
  | { type: 'tool_call_end'; toolName: string; result: unknown; callId: string; success: boolean; subagentId?: string }
  | { type: 'subagent_start'; subagentId: string }
  | { type: 'subagent_stop'; subagentId: string }
  | { type: 'subagent_text'; subagentId: string; text: string; thinking?: boolean }
  | { type: 'task_started' }
  | { type: 'task_complete'; sessionId?: string; usage?: Record<string, unknown>; costUsd?: number; durationMs?: number }
  | { type: 'error'; message: string };

/**
 * Stateful parser to maintain callId pairing between started/completed tool calls.
 * Per-key FIFO: same tool+args can run multiple times; completed order may differ from started,
 * so we use a queue per (toolName, argsHash) so each completed gets the correct callId.
 */
/** Parse a single conversationStep from a native Cursor taskToolCall result into messages. */
function parseConversationStep(step: Record<string, unknown>, subagentId: string): CursorParsedMessage[] {
  const results: CursorParsedMessage[] = [];
  const thinking = step.thinkingMessage as { text?: string } | undefined;
  if (thinking?.text?.trim()) {
    results.push({ type: 'subagent_text', subagentId, text: thinking.text, thinking: true });
  }
  const assistant = step.assistantMessage as { text?: string } | undefined;
  if (assistant?.text?.trim()) {
    results.push({ type: 'subagent_text', subagentId, text: assistant.text });
  }
  const stc = step.toolCall as Record<string, unknown> | undefined;
  if (!stc) return results;

  const stepCallId = randomUUID();
  if (stc.shellToolCall) {
    const tc = stc.shellToolCall as Record<string, unknown>;
    const args = tc.args as Record<string, unknown> | undefined ?? {};
    const command = (args.command as string) || '';
    const shellDesc = (args.description as string) || undefined;
    results.push({ type: 'tool_call_start', toolName: 'CursorBash', args: { command, description: shellDesc }, callId: stepCallId, subagentId, description: shellDesc });
    const r = tc.result as { success?: { stdout?: string; exitCode?: number }; failure?: { stderr?: string; exitCode?: number } } | undefined;
    results.push({ type: 'tool_call_end', toolName: 'CursorBash', result: { stdout: r?.success?.stdout ?? '', stderr: r?.failure?.stderr ?? '', exitCode: r?.success?.exitCode ?? r?.failure?.exitCode }, callId: stepCallId, success: !!r?.success, subagentId });
  } else if (stc.readToolCall) {
    const tc = stc.readToolCall as Record<string, unknown>;
    const args = tc.args as Record<string, unknown> | undefined ?? {};
    results.push({ type: 'tool_call_start', toolName: 'CursorRead', args: { path: args.path ?? '' }, callId: stepCallId, subagentId });
    results.push({ type: 'tool_call_end', toolName: 'CursorRead', result: tc.result, callId: stepCallId, success: true, subagentId });
  } else if (stc.writeToolCall) {
    const tc = stc.writeToolCall as Record<string, unknown>;
    const args = tc.args as Record<string, unknown> | undefined ?? {};
    const content = (args.content ?? args.streamContent ?? '') as string;
    results.push({ type: 'tool_call_start', toolName: 'CursorWrite', args: { path: args.path ?? '', content }, callId: stepCallId, subagentId });
    results.push({ type: 'tool_call_end', toolName: 'CursorWrite', result: tc.result, callId: stepCallId, success: true, subagentId });
  } else if (stc.editToolCall) {
    const tc = stc.editToolCall as Record<string, unknown>;
    const args = tc.args as Record<string, unknown> | undefined ?? {};
    const editPath = (args.path ?? args.file_path ?? args.filePath ?? '') as string;
    const oldString = (args.old_string ?? args.oldString ?? args.oldText ?? '') as string;
    const newString = (args.new_string ?? args.newString ?? args.newText ?? '') as string;
    results.push({ type: 'tool_call_start', toolName: 'CursorEdit', args: { path: editPath, old_string: oldString, new_string: newString }, callId: stepCallId, subagentId });
    results.push({ type: 'tool_call_end', toolName: 'CursorEdit', result: tc.result, callId: stepCallId, success: true, subagentId });
  } else if (stc.mcpToolCall) {
    const tc = stc.mcpToolCall as Record<string, unknown>;
    const toolName = (tc.name as string) || 'McpTool';
    const args = (tc.args as Record<string, unknown>) || {};
    const mcpDesc = (tc.description as string) || undefined;
    results.push({ type: 'tool_call_start', toolName, args, callId: stepCallId, subagentId, description: mcpDesc });
    results.push({ type: 'tool_call_end', toolName, result: tc.result, callId: stepCallId, success: true, subagentId });
  } else if (stc.taskToolCall) {
    const tc = stc.taskToolCall as Record<string, unknown>;
    const args = tc.args as Record<string, unknown> | undefined ?? {};
    const desc = (args.description as string) || 'Task';
    results.push({ type: 'tool_call_start', toolName: 'Task', args: { description: desc, prompt: args.prompt ?? '' }, callId: stepCallId, subagentId });
    results.push({ type: 'tool_call_end', toolName: 'Task', result: null, callId: stepCallId, success: true, subagentId });
  }
  return results;
}

export class CursorMessageParser {
  /** key = toolKey (toolName + args hash), value = queue of callIds for that key */
  private pendingByKey: Map<string, string[]> = new Map();
  /** key = toolKey for Task, value = queue of cuid2 subagent IDs (paired with callIds) */
  private taskSubagentIds: Map<string, string[]> = new Map();

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
        // cursor-agent (--stream-partial-output) sends:
        //   1. Streaming deltas WITH timestamp_ms and WITHOUT model_call_id  → process
        //   2. Intermediate consolidated messages WITH timestamp_ms AND model_call_id → skip (same text as delta, duplicates)
        //   3. Final consolidated message WITHOUT timestamp_ms                → skip (same text as all deltas combined)
        const rawMsg = msg as unknown as Record<string, unknown>;
        if (!rawMsg.timestamp_ms || rawMsg.model_call_id) {
          if (process.env.CURSOR_AGENT_RAW_LOG === '1') {
            const reason = !rawMsg.timestamp_ms ? 'no timestamp_ms' : 'has model_call_id';
            try { appendFileSync(process.env.CURSOR_AGENT_RAW_LOG_FILE ?? '/tmp/cursor-agent-raw.log', `[assistant SKIPPED] ${reason}\n`); } catch { /* ignore */ }
          }
          break;
        }
        const content = msg.message?.content;
        const blocks = Array.isArray(content) ? content : content && typeof content === 'object' ? [content] : [];
        for (const block of blocks) {
          if (!block || typeof block !== 'object') continue;
          const b = block as Record<string, unknown>;
          let text = typeof b.text === 'string' ? b.text : '';
          if (!text && typeof b.content === 'string') text = b.content;
          if (!text && typeof b.message === 'string') text = b.message;
          if (text) {
            if (process.env.CURSOR_AGENT_RAW_LOG === '1') {
              try { appendFileSync(process.env.CURSOR_AGENT_RAW_LOG_FILE ?? '/tmp/cursor-agent-raw.log', `[assistant delta] len=${text.length} text=${JSON.stringify(text.slice(0, 200))}\n`); } catch { /* ignore */ }
            }
            results.push({ type: 'text_delta', text });
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

        if (tc.taskToolCall) {
          const taskArgs = tc.taskToolCall.args as Record<string, unknown> | undefined ?? {};
          const agentId = (taskArgs.agentId as string) || 'unknown';
          const description = (taskArgs.description as string) || '';
          const prompt = (taskArgs.prompt as string) || '';
          const key = this.toolKey('Task', { agentId });
          if (msg.subtype === 'started') {
            // Use a single cuid2 as BOTH callId and subagentId so the reducer tracer can
            // link sidechain events (parentUUID=subagentId) to this tool call via
            // toolCallToMessageId[content.id] = toolCallToMessageId[subagentId].
            const subagentId = createId();
            let q = this.taskSubagentIds.get(key);
            if (!q) { q = []; this.taskSubagentIds.set(key, q); }
            q.push(subagentId);
            results.push({ type: 'tool_call_start', toolName: 'Task', args: { description, prompt }, callId: subagentId, description });
          } else if (msg.subtype === 'completed') {
            const subagentId = this.taskSubagentIds.get(key)?.shift() ?? createId();
            const steps = ((tc.taskToolCall.result as Record<string, unknown> | undefined)?.success as Record<string, unknown> | undefined)?.conversationSteps;
            const stepList = Array.isArray(steps) ? (steps as Record<string, unknown>[]) : [];

            results.push({ type: 'subagent_start', subagentId });
            for (const step of stepList) {
              results.push(...parseConversationStep(step, subagentId));
            }
            results.push({ type: 'subagent_stop', subagentId });

            // Extract summary from last non-empty assistant message in steps
            let summary: string | null = null;
            for (let i = stepList.length - 1; i >= 0; i--) {
              const text = (stepList[i].assistantMessage as { text?: string } | undefined)?.text?.trim();
              if (text) { summary = text; break; }
            }
            results.push({ type: 'tool_call_end', toolName: 'Task', result: summary, callId: subagentId, success: true });
          } else if (msg.subtype) {
            const subagentId2 = this.taskSubagentIds.get(key)?.shift() ?? createId();
            results.push({ type: 'tool_call_end', toolName: 'Task', result: { cancelled: true, subtype: msg.subtype }, callId: subagentId2, success: false });
          }
        }
        break;
      }

      case 'result': {
        const raw = msg as unknown as Record<string, unknown>;
        // Do NOT emit text_delta here: we always use --stream-partial-output so all text
        // was already delivered via streaming 'assistant' messages and accumulated in runCursor.
        // Emitting text_delta from result would cause the complete text to be sent a second time.
        results.push({
          type: 'task_complete',
          sessionId: raw.session_id as string | undefined,
          usage: raw.usage as Record<string, unknown> | undefined,
          costUsd: raw.total_cost_usd as number | undefined,
          durationMs: raw.duration_ms as number | undefined,
        });

        if (raw.is_error && raw.result) {
          results.push({ type: 'error', message: typeof raw.result === 'string' ? raw.result : JSON.stringify(raw.result) });
        }
        break;
      }

      default: {
        const anyMsg = msg as Record<string, unknown>;
        const type = anyMsg.type as string;
        // Fallback: treat message with result-like body as final reply (e.g. alternate stream shape)
        const resultText = typeof anyMsg.result === 'string' ? anyMsg.result : undefined;
        if (resultText && !anyMsg.is_error) {
          results.push({ type: 'text_delta', text: resultText });
          results.push({
            type: 'task_complete',
            sessionId: anyMsg.session_id as string | undefined,
            usage: anyMsg.usage as Record<string, unknown> | undefined,
            costUsd: anyMsg.total_cost_usd as number | undefined,
            durationMs: anyMsg.duration_ms as number | undefined,
          });
          break;
        }
        logger.debug(`[cursor] Unknown message type: ${type}`);
        break;
      }
    }

    return results;
  }

  /**
   * Clear all pending tool call state (e.g., at turn end).
   */
  clear(): void {
    this.pendingByKey.clear();
    this.taskSubagentIds.clear();
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
