import type { A2AInboxServerState, A2AInboxState } from '@/api/types';
import { getA2AUnreadCount, pruneA2AInboxState } from './inbox';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Legacy agentState.a2aInbox stored full messages on the server. */
export function isFullA2AInboxState(value: unknown): value is A2AInboxState {
  return isRecord(value) && Array.isArray(value.messages);
}

export function isServerA2AInboxSnapshot(value: unknown): value is A2AInboxServerState {
  return isRecord(value)
    && typeof value.unreadCount === 'number'
    && !Array.isArray(value.messages);
}

export function toServerA2AInboxSnapshot(inbox: A2AInboxState): A2AInboxServerState {
  return { unreadCount: getA2AUnreadCount(inbox) };
}

/** One-time import of legacy server blob into local inbox shape. */
export function extractLegacyInboxFromAgentState(
  agentState: { a2aInbox?: unknown } | null | undefined,
): A2AInboxState | null {
  const raw = agentState?.a2aInbox;
  if (!isFullA2AInboxState(raw)) {
    return null;
  }
  return pruneA2AInboxState(raw);
}
