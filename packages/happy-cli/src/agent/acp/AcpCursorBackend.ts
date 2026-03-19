/**
 * AcpCursorBackend - cursor-agent ACP specialization
 *
 * Extends the generic AcpBackend to handle cursor-agent's unique ACP protocol
 * behaviour without polluting the base implementation:
 *
 *  1. Two-step tool_call notifications:
 *     - First notification: rawInput = {}, title = "Terminal"  (buffered, not emitted)
 *     - Second notification: rawInput = {command: "ls"}, real title  (flushed + mapped)
 *
 *  2. Tool kind + title → App tool name mapping:
 *     execute              → CursorBash
 *     read                 → CursorRead
 *     edit                 → CursorEdit
 *     search + pattern     → Grep
 *     search + pattern=*   → Glob  (globToolCall sends glob pattern)
 *     search + searchTerm  → WebSearch
 *     other + "Task: …"   → Task
 *     other + "Update TODOs: …" → TodoWrite
 *     other + "Web Fetch: …"   → WebFetch
 *
 *  3. Transforms rawInput to match the App renderer's expected arg shape.
 */

import type { SessionNotification } from '@agentclientprotocol/sdk';
import { AcpBackend, type AcpBackendOptions } from './AcpBackend';
import type { SessionUpdate } from './sessionUpdateHandlers';
import { logger } from '@/ui/logger';

/** Buffered first tool_call notification waiting for real args. */
interface PendingCursorTool {
  kind: string;
  rawInput: Record<string, unknown>;
  title: string | undefined;
  toolCallId: string;
}

/** Result of mapping a cursor kind to App tool name + args shape. */
interface CursorToolMapping {
  appName: string;
  description: string;
  args: Record<string, unknown>;
}

function mapCursorKind(
  kind: string,
  title: string | undefined,
  rawInput: Record<string, unknown>,
): CursorToolMapping {
  if (kind === 'execute') {
    const cmd = typeof rawInput['command'] === 'string' ? rawInput['command'] : '';
    // cursor-agent may send a human-readable description (e.g. "List directory contents")
    const semanticDesc = typeof rawInput['description'] === 'string' ? rawInput['description'] : null;
    const desc = (semanticDesc && semanticDesc.trim()) || cmd || title || 'Terminal';
    return {
      appName: 'CursorBash',
      description: desc,
      args: { command: cmd },
    };
  }
  if (kind === 'read') {
    const filePath = typeof rawInput['path'] === 'string' ? rawInput['path'] : '';
    return {
      appName: 'CursorRead',
      description: filePath || 'Read File',
      args: { path: filePath },
    };
  }
  if (kind === 'edit') {
    const filePath = typeof rawInput['path'] === 'string' ? rawInput['path'] : '';
    return {
      appName: 'CursorEdit',
      description: filePath || 'Edit File',
      args: { path: filePath },
    };
  }
  if (kind === 'search') {
    // globToolCall → Glob (has `pattern` but no `searchTerm`)
    // grepToolCall / semSearchToolCall → Grep (has `pattern`)
    // webSearchToolCall → WebSearch (has `searchTerm`)
    // lsToolCall → CursorRead-like (has `path`)
    const searchTerm = typeof rawInput['searchTerm'] === 'string' ? rawInput['searchTerm'] : '';
    if (searchTerm) {
      return {
        appName: 'WebSearch',
        description: searchTerm,
        args: { query: searchTerm },
      };
    }
    const pattern = typeof rawInput['pattern'] === 'string' ? rawInput['pattern'] : '';
    const path = typeof rawInput['path'] === 'string' ? rawInput['path'] : '';
    // lsToolCall only has `path`, no `pattern` → treat as directory listing
    if (!pattern && path) {
      return {
        appName: 'CursorRead',
        description: path,
        args: { path },
      };
    }
    // Check if this looks like a glob (pattern has glob chars or title contains "glob")
    const isGlob = pattern.includes('*') || pattern.includes('?') ||
      (typeof title === 'string' && title.toLowerCase().includes('glob'));
    if (isGlob) {
      return {
        appName: 'Glob',
        description: pattern || title || 'Search Files',
        args: { pattern, path },
      };
    }
    return {
      appName: 'Grep',
      description: pattern || title || 'Search',
      args: { pattern, path },
    };
  }
  if (kind === 'other') {
    const t = title ?? '';
    // taskToolCall: title = "Task: {description}"
    if (t.startsWith('Task: ') || rawInput['_toolName'] === 'task') {
      const description = typeof rawInput['description'] === 'string'
        ? rawInput['description']
        : t.replace(/^Task:\s*/, '') || 'Subagent task';
      const prompt = typeof rawInput['prompt'] === 'string' ? rawInput['prompt'] : description;
      const subagentType = typeof rawInput['subagentType'] === 'string' ? rawInput['subagentType'] : undefined;
      return {
        appName: 'Task',
        description,
        args: { description, prompt, ...(subagentType ? { subagent_type: subagentType } : {}) },
      };
    }
    // updateTodosToolCall: title = "Update TODOs: …"
    if (t.startsWith('Update TODOs') || rawInput['_toolName'] === 'updateTodos') {
      const todos = Array.isArray(rawInput['todos']) ? rawInput['todos'] : [];
      return {
        appName: 'TodoWrite',
        description: t || 'Update TODOs',
        args: { todos },
      };
    }
    // webFetchToolCall: title = "Web Fetch: {url}"
    if (t.startsWith('Web Fetch: ') || typeof rawInput['url'] === 'string') {
      const url = typeof rawInput['url'] === 'string' ? rawInput['url'] : t.replace(/^Web Fetch:\s*/, '');
      return {
        appName: 'WebFetch',
        description: url || title || 'Fetch URL',
        args: { url },
      };
    }
  }
  // Fallback: pass through with title as display name
  return {
    appName: title || kind,
    description: title || kind,
    args: rawInput,
  };
}

function hasRealInput(rawInput: Record<string, unknown>): boolean {
  return (
    Object.keys(rawInput).length > 0 &&
    Object.values(rawInput).some((v) => v !== null && v !== undefined && v !== '')
  );
}

/** Enrichment data delivered via cursor extension RPC calls (e.g. _cursor/update_todos). */
interface CursorExtData {
  todos?: unknown[];
}

/**
 * How long (ms) to wait for _cursor/update_todos after a TodoWrite completed
 * notification before flushing the completion without todos as a fallback.
 */
const PENDING_TODO_FLUSH_TTL_MS = 3000;

export class AcpCursorBackend extends AcpBackend {
  /** Buffer for first tool_call notification (empty rawInput). */
  private pendingCursorTools = new Map<string, PendingCursorTool>();
  /**
   * Execute tool calls buffered while waiting for the command title from requestPermission.
   * Local bin cursor-agent (2026.03+) sends a single tool_call with rawInput={} and never sends
   * a second notification with rawInput.command. The command only arrives in requestPermission's
   * toolCall.title. We defer the tool-call flush until then.
   */
  private pendingCommandEnrich = new Map<string, PendingCursorTool & { inProgressParams: SessionNotification }>();
  /** Extra data for a tool call delivered out-of-band via _cursor/* extension methods. */
  private cursorExtData = new Map<string, CursorExtData>();
  /**
   * Buffered `tool_call_update(completed)` for TodoWrite calls.
   * cursor-agent sends _cursor/update_todos AFTER completed, so we hold
   * the completed notification until the todos arrive, then flush both.
   * Each entry also carries a TTL timer so we never block indefinitely.
   */
  private pendingTodoCompleted = new Map<string, { params: SessionNotification; timer: NodeJS.Timeout }>();
  /** Latest known full todo list — used to merge partial updates (merge: true). */
  private latestTodos: Array<Record<string, unknown>> = [];

  constructor(options: AcpBackendOptions) {
    super(options);
  }

  /**
   * Flush any buffered state left over from a completed turn.
   * Call this after the turn resolves to ensure no stale notifications linger.
   */
  flushPendingOnTurnEnd(): void {
    // Emit any still-buffered TodoWrite completions without todos.
    for (const [, { params, timer }] of this.pendingTodoCompleted) {
      clearTimeout(timer);
      super.handleSessionUpdate(params);
    }
    this.pendingTodoCompleted.clear();

    // Flush any still-buffered tool_call notifications (e.g. last tool with no in_progress).
    for (const [, pending] of this.pendingCursorTools) {
      const fakeUpdate: SessionUpdate = { ...pending, sessionUpdate: 'tool_call', status: 'pending' };
      const fakeParams = { update: fakeUpdate } as unknown as SessionNotification;
      super.handleSessionUpdate(
        this.transformToolCallParams(fakeParams, fakeUpdate, pending.kind, pending.title, pending.rawInput),
      );
    }
    this.pendingCursorTools.clear();
    this.cursorExtData.clear();

    // Reset todo state for the next turn.
    this.latestTodos = [];
  }

  /**
   * Handle cursor-specific extension RPC methods.
   *
   * _cursor/update_todos arrives with { toolCallId, todos, merge }.
   * Two cases:
   *  A) tool_call arrived first → toolCallId is in pendingCursorTools → flush immediately with todos.
   *  B) _cursor/update_todos arrives first → store in cursorExtData, tool_call handler picks it up later.
   */
  protected override handleExtMethod(method: string, params: unknown): unknown {
    if (method === '_cursor/update_todos') {
      const p = params as { toolCallId?: string; todos?: unknown[]; merge?: boolean };
      logger.info(`[AcpCursorBackend] _cursor/update_todos: ${JSON.stringify(p).slice(0, 300)}`);
      if (p?.toolCallId && Array.isArray(p.todos)) {
        const toolCallId = p.toolCallId;
        // Merge partial updates into the known todo list.
        const incomingTodos = p.todos as Array<Record<string, unknown>>;
        let resolvedTodos: Array<Record<string, unknown>>;
        if (p.merge && this.latestTodos.length > 0) {
          const merged = new Map(this.latestTodos.map(t => [t['id'], t]));
          for (const todo of incomingTodos) {
            merged.set(todo['id'], todo);
          }
          resolvedTodos = Array.from(merged.values());
        } else {
          resolvedTodos = incomingTodos;
        }
        this.latestTodos = resolvedTodos;
        const pending = this.pendingCursorTools.get(toolCallId);
        if (pending) {
          // Case A: tool_call already buffered — inject todos and flush now.
          this.pendingCursorTools.delete(toolCallId);
          const enrichedInput = { ...pending.rawInput, todos: resolvedTodos };
          // We need the original params to reconstruct a SessionNotification.
          // Re-use the stored pending data to build a synthetic notification.
          const fakeUpdate: SessionUpdate = {
            ...pending,
            sessionUpdate: 'tool_call',
            status: 'pending',
            rawInput: enrichedInput,
          };
          const fakeParams = {
            update: fakeUpdate,
          } as unknown as SessionNotification;
          super.handleSessionUpdate(
            this.transformToolCallParams(fakeParams, fakeUpdate, pending.kind, pending.title, enrichedInput),
          );
        } else {
          // Check if completed notification is already buffered (most common case).
          const pendingCompleted = this.pendingTodoCompleted.get(toolCallId);
          if (pendingCompleted) {
            clearTimeout(pendingCompleted.timer);
            this.pendingTodoCompleted.delete(toolCallId);
            const completedUpdate = (pendingCompleted.params as { update?: SessionUpdate }).update;
            if (completedUpdate) {
              const enrichedUpdate: SessionUpdate = {
                ...completedUpdate,
                rawOutput: { ...(completedUpdate.rawOutput ?? {}), newTodos: resolvedTodos },
              };
              super.handleSessionUpdate(
                { ...pendingCompleted.params, update: enrichedUpdate } as unknown as SessionNotification,
              );
            }
          } else {
            // Case B: tool_call hasn't been flushed yet — store for later.
            const existing = this.cursorExtData.get(toolCallId) ?? {};
            this.cursorExtData.set(toolCallId, { ...existing, todos: resolvedTodos });
          }
        }
      }
      return {};
    }
    return super.handleExtMethod(method, params);
  }

  protected override handleSessionUpdate(params: SessionNotification): void {
    const update = (params as { update?: SessionUpdate }).update;
    if (!update) {
      super.handleSessionUpdate(params);
      return;
    }

    const type = update.sessionUpdate;

    // cursor-agent can send thinking chunks; suppress them (not useful to surface)
    if (type === 'agent_thought_chunk') {
      return;
    }

    if (type === 'tool_call') {
      this.handleCursorToolCall(params, update);
      return;
    }

    if (type === 'tool_call_update') {
      const status = update.status;
      if (status === 'in_progress' || status === 'pending') {
        this.handleCursorToolCallUpdateInProgress(params, update);
        return;
      }
      if (status === 'completed') {
        const toolCallId = typeof update.toolCallId === 'string' ? update.toolCallId : '';

        // Flush any deferred execute tool call (local bin, allowlisted command — no permission fired).
        const enrichPending = toolCallId ? this.pendingCommandEnrich.get(toolCallId) : undefined;
        if (enrichPending) {
          this.pendingCommandEnrich.delete(toolCallId);
          // Emit tool-call first, then the deferred in_progress, so AcpBackend's startToolCall
          // sees the tool already active and won't emit a duplicate tool-call.
          this.flushCommandEnrich(enrichPending);
          super.handleSessionUpdate(enrichPending.inProgressParams);
        }

        // Check if this is a TodoWrite tool (tracked via toolCallIdToKindMap or name map).
        const toolName = toolCallId ? this.createHandlerContext().toolCallIdToNameMap.get(toolCallId) : undefined;
        if (toolName === 'TodoWrite') {
          const ext = this.cursorExtData.get(toolCallId);
          if (ext?.todos) {
            // Todos already arrived — inject and emit immediately.
            this.cursorExtData.delete(toolCallId);
            const enrichedUpdate: SessionUpdate = {
              ...update,
              rawOutput: { ...(update.rawOutput ?? {}), newTodos: ext.todos },
            };
            super.handleSessionUpdate({ ...params, update: enrichedUpdate } as unknown as typeof params);
          } else {
            // Todos not yet arrived — buffer completed notification, flush when _cursor/update_todos comes.
            // TTL: if todos never arrive, emit the completion as-is after PENDING_TODO_FLUSH_TTL_MS.
            const timer = setTimeout(() => {
              if (this.pendingTodoCompleted.delete(toolCallId)) {
                logger.info(`[AcpCursorBackend] TodoWrite TTL flush (no _cursor/update_todos) for ${toolCallId}`);
                super.handleSessionUpdate(params);
              }
            }, PENDING_TODO_FLUSH_TTL_MS);
            this.pendingTodoCompleted.set(toolCallId, { params, timer });
          }
          return;
        }
      }
    }

    super.handleSessionUpdate(params);
  }

  private handleCursorToolCall(params: SessionNotification, update: SessionUpdate): void {
    const toolCallId = update.toolCallId;
    if (!toolCallId) {
      super.handleSessionUpdate(params);
      return;
    }

    const kind = typeof update.kind === 'string' ? update.kind : '';
    const rawInput = update.rawInput ?? {};
    const title = typeof update.title === 'string' ? update.title : undefined;

    // TodoWrite: always buffer — we need todos from _cursor/update_todos which may arrive later.
    const isTodoWrite =
      rawInput['_toolName'] === 'updateTodos' ||
      (typeof title === 'string' && title.startsWith('Update TODOs'));

    if (!hasRealInput(rawInput) || isTodoWrite) {
      // Check if ext data (todos) already arrived before this tool_call notification.
      const ext = this.cursorExtData.get(toolCallId);
      if (isTodoWrite && ext?.todos) {
        // Ext data already available — enrich and emit immediately.
        this.cursorExtData.delete(toolCallId);
        const enriched = { ...rawInput, todos: ext.todos };
        super.handleSessionUpdate(this.transformToolCallParams(params, update, kind, title, enriched));
      } else {
        // Buffer and wait (for ext data or in_progress fallback).
        this.pendingCursorTools.set(toolCallId, { kind, rawInput, title, toolCallId });
      }
      return;
    }

    // Second notification with real args: transform and pass to base.
    this.pendingCursorTools.delete(toolCallId);
    super.handleSessionUpdate(this.transformToolCallParams(params, update, kind, title, rawInput));
  }

  private handleCursorToolCallUpdateInProgress(
    params: SessionNotification,
    update: SessionUpdate,
  ): void {
    const toolCallId = update.toolCallId;
    if (!toolCallId) {
      super.handleSessionUpdate(params);
      return;
    }

    const pending = this.pendingCursorTools.get(toolCallId);
    if (pending) {
      this.pendingCursorTools.delete(toolCallId);

      if (pending.kind === 'execute' && !hasRealInput(pending.rawInput)) {
        // Local bin cursor-agent: no second tool_call with rawInput.command will arrive.
        // Defer both the tool-call flush AND the in_progress pass-through until requestPermission
        // fires with toolCall.title containing the command. We must not call super here because
        // AcpBackend.handleToolCallUpdate would emit tool-call("unknown") before we have the command.
        this.pendingCommandEnrich.set(toolCallId, { ...pending, inProgressParams: params });
        return;
      }

      // Never received a second tool_call with real args; flush now with whatever we have.
      const fakeParams = this.transformToolCallParams(
        { ...params, update: { ...pending, sessionUpdate: 'tool_call', status: 'pending' } } as unknown as SessionNotification,
        { ...pending, sessionUpdate: 'tool_call', status: 'pending' },
        pending.kind,
        pending.title,
        pending.rawInput,
      );
      super.handleSessionUpdate(fakeParams);
    }

    super.handleSessionUpdate(params);
  }

  /**
   * Called by AcpBackend when a requestPermission RPC arrives.
   * For execute tool calls deferred in pendingCommandEnrich, extracts the command
   * from the permission's toolCall.title and flushes the tool-call with the real command.
   */
  protected override onPermissionRequest(toolCallId: string, commandTitle: string): void {
    const pending = this.pendingCommandEnrich.get(toolCallId);
    if (!pending) return;
    this.pendingCommandEnrich.delete(toolCallId);

    // Strip surrounding backticks from title (e.g. "`ls /tmp`" → "ls /tmp")
    const command = commandTitle.replace(/^`|`$/g, '').trim();
    const enrichedRawInput = command ? { command } : pending.rawInput;
    const enrichedTitle = commandTitle || pending.title;

    // Emit tool-call with the real command first, then pass the deferred in_progress so that
    // AcpBackend sees activeToolCalls already populated and won't emit a second tool-call.
    this.flushCommandEnrich({ ...pending, rawInput: enrichedRawInput, title: enrichedTitle });
    super.handleSessionUpdate(pending.inProgressParams);
  }

  private flushCommandEnrich(
    pending: PendingCursorTool & { inProgressParams: SessionNotification },
  ): void {
    const { inProgressParams, kind, title, rawInput } = pending;
    // Build a synthetic tool_call notification so AcpBackend emits the tool-call event.
    const fakeUpdate = { ...pending, sessionUpdate: 'tool_call' as const, status: 'pending' as const };
    const fakeParams = this.transformToolCallParams(
      { ...inProgressParams, update: fakeUpdate } as unknown as SessionNotification,
      fakeUpdate,
      kind,
      title,
      rawInput,
    );
    super.handleSessionUpdate(fakeParams);
  }

  /**
   * Merge any out-of-band data received via cursor extension RPCs (_cursor/update_todos etc.)
   * into the rawInput before mapping. Also clears the stored ext data.
   */
  private enrichRawInput(toolCallId: string, rawInput: Record<string, unknown>): Record<string, unknown> {
    const ext = this.cursorExtData.get(toolCallId);
    if (!ext) return rawInput;
    this.cursorExtData.delete(toolCallId);
    return { ...rawInput, ...ext };
  }

  /** Build a transformed SessionNotification with mapped appName/description/args. */
  protected transformToolCallParams(
    params: SessionNotification,
    update: SessionUpdate,
    kind: string,
    title: string | undefined,
    rawInput: Record<string, unknown>,
  ): SessionNotification {
    const toolCallId = typeof update.toolCallId === 'string' ? update.toolCallId : '';
    const enriched = toolCallId ? this.enrichRawInput(toolCallId, rawInput) : rawInput;
    const { appName, description, args } = mapCursorKind(kind, title, enriched);
    return {
      ...params,
      update: {
        ...update,
        // kind becomes the canonical tool name (CursorBash, etc.) for knownTools lookup
        kind: appName,
        // title = human-readable description so startToolCall emits it as toolName → App display title
        title: description,
        description,
        rawInput: args,
      },
    } as unknown as SessionNotification;
  }

  override async dispose(): Promise<void> {
    this.pendingCursorTools.clear();
    this.cursorExtData.clear();
    for (const { timer } of this.pendingTodoCompleted.values()) {
      clearTimeout(timer);
    }
    this.pendingTodoCompleted.clear();
    this.latestTodos = [];
    await super.dispose();
  }
}
