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
 *  2. Tool kind → App tool name mapping:
 *     execute → CursorBash  |  read → CursorRead  |  edit → CursorEdit  |  search → Grep
 *
 *  3. Transforms rawInput to match the App renderer's expected arg shape.
 */

import type { SessionNotification } from '@agentclientprotocol/sdk';
import { AcpBackend, type AcpBackendOptions } from './AcpBackend';
import type { SessionUpdate } from './sessionUpdateHandlers';

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
    return {
      appName: 'CursorBash',
      description: cmd || title || 'Terminal',
      args: { command: cmd },
    };
  }
  if (kind === 'read') {
    const filePath = typeof rawInput['path'] === 'string' ? rawInput['path'] : '';
    return {
      appName: 'CursorRead',
      description: filePath || title || 'Read File',
      args: { path: filePath },
    };
  }
  if (kind === 'edit') {
    const filePath = typeof rawInput['path'] === 'string' ? rawInput['path'] : '';
    return {
      appName: 'CursorEdit',
      description: filePath || title || 'Edit File',
      args: { path: filePath },
    };
  }
  if (kind === 'search') {
    const pattern = typeof rawInput['pattern'] === 'string' ? rawInput['pattern'] : '';
    const path = typeof rawInput['path'] === 'string' ? rawInput['path'] : '';
    return {
      appName: 'Grep',
      description: pattern || title || 'Search',
      args: { pattern, path },
    };
  }
  // Unknown kind: pass through using the title or kind as display name
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

export class AcpCursorBackend extends AcpBackend {
  /** Buffer for first tool_call notification (empty rawInput). */
  private pendingCursorTools = new Map<string, PendingCursorTool>();

  constructor(options: AcpBackendOptions) {
    super(options);
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

    if (!hasRealInput(rawInput)) {
      // First notification: buffer it, don't pass to base yet.
      this.pendingCursorTools.set(toolCallId, { kind, rawInput, title, toolCallId });
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
      // Never received a second tool_call with real args; flush now with whatever we have.
      this.pendingCursorTools.delete(toolCallId);
      const fakeParams = this.transformToolCallParams(
        // Build a minimal tool_call notification from the buffered data
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

  /** Build a transformed SessionNotification with mapped appName/description/args. */
  private transformToolCallParams(
    params: SessionNotification,
    update: SessionUpdate,
    kind: string,
    title: string | undefined,
    rawInput: Record<string, unknown>,
  ): SessionNotification {
    const { appName, description, args } = mapCursorKind(kind, title, rawInput);
    return {
      ...params,
      update: {
        ...update,
        // kind becomes the App tool name so startToolCall uses it as displayName fallback
        kind: appName,
        // title is cleared; startToolCall will use kind (appName) as displayName
        title: undefined,
        // description is picked up by startToolCall and forwarded in the tool-call message
        description,
        rawInput: args,
      },
    } as unknown as SessionNotification;
  }

  override async dispose(): Promise<void> {
    this.pendingCursorTools.clear();
    await super.dispose();
  }
}
