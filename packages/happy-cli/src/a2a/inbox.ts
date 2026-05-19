import type { A2AInboxMessage, A2AInboxState } from '@/api/types';
import { pruneA2AInboxState, resolveA2AInboxRetentionSettings } from './inboxRetention';

export { pruneA2AInboxState, resolveA2AInboxRetentionSettings } from './inboxRetention';
export { pruneA2AInboxSnapshots, resolveA2AInboxSnapshotRetention } from './inboxSnapshot';
export { loadLocalA2AInbox, localA2AInboxPath, saveLocalA2AInbox } from './inboxPersistence';
export {
  extractLegacyInboxFromAgentState,
  isFullA2AInboxState,
  isServerA2AInboxSnapshot,
  toServerA2AInboxSnapshot,
} from './inboxServer';

function cloneMessage(message: A2AInboxMessage): A2AInboxMessage {
  return { ...message };
}

export function cloneA2AInboxState(inbox: A2AInboxState | null | undefined): A2AInboxState {
  return {
    messages: Array.isArray(inbox?.messages) ? inbox!.messages.map(cloneMessage) : [],
  };
}

export function upsertA2AInboxMessage(
  inbox: A2AInboxState | null | undefined,
  message: A2AInboxMessage,
): A2AInboxState {
  const next = cloneA2AInboxState(inbox);
  const existingIndex = next.messages.findIndex((item) => item.id === message.id);
  if (existingIndex === -1) {
    next.messages.push({
      ...cloneMessage(message),
      readAt: message.readAt ?? null,
    });
    return pruneA2AInboxState(next);
  }

  const existing = next.messages[existingIndex];
  next.messages[existingIndex] = {
    ...existing,
    ...message,
    readAt: existing.readAt != null ? existing.readAt : (message.readAt ?? null),
  };
  return pruneA2AInboxState(next);
}

export function mergeA2AInboxState(
  current: A2AInboxState | null | undefined,
  incoming: A2AInboxState | null | undefined,
): A2AInboxState {
  const next = cloneA2AInboxState(current);
  for (const message of cloneA2AInboxState(incoming).messages) {
    const existingIndex = next.messages.findIndex((item) => item.id === message.id);
    if (existingIndex === -1) {
      next.messages.push({
        ...cloneMessage(message),
        readAt: message.readAt ?? null,
      });
      continue;
    }

    const existing = next.messages[existingIndex];
    next.messages[existingIndex] = {
      ...existing,
      ...message,
      // Keep local unread rows unread even if server agentState has readAt set.
      readAt: existing.readAt != null ? existing.readAt : null,
    };
  }
  return next;
}

export function markA2AInboxMessageRead(
  inbox: A2AInboxState | null | undefined,
  id: string,
  readAt: number = Date.now(),
): A2AInboxState {
  const next = cloneA2AInboxState(inbox);
  const existing = next.messages.find((item) => item.id === id);
  if (!existing) {
    return next;
  }

  existing.readAt = existing.readAt ?? readAt;
  const settings = resolveA2AInboxRetentionSettings();
  return pruneA2AInboxState(next, settings.dropReadOnMark ? { removeAllRead: true } : undefined);
}

export function markA2AInboxMessagesRead(
  inbox: A2AInboxState | null | undefined,
  ids: string[],
  readAt: number = Date.now(),
): A2AInboxState {
  const next = cloneA2AInboxState(inbox);
  const idsSet = new Set(ids);
  for (const message of next.messages) {
    if (idsSet.has(message.id)) {
      message.readAt = message.readAt ?? readAt;
    }
  }
  const settings = resolveA2AInboxRetentionSettings();
  return pruneA2AInboxState(next, settings.dropReadOnMark ? { removeAllRead: true } : undefined);
}

export function getA2AUnreadCount(inbox: A2AInboxState | null | undefined): number {
  return cloneA2AInboxState(inbox).messages.filter((message) => !message.readAt).length;
}

/** Peek whether the inbox still has messages the model has not consumed via MCP. */
export function hasUnreadA2AInboxMessages(inbox: A2AInboxState | null | undefined): boolean {
  return getA2AUnreadCount(inbox) > 0;
}

export function listA2AInboxMessages(
  inbox: A2AInboxState | null | undefined,
  options?: { unreadOnly?: boolean; limit?: number },
): A2AInboxMessage[] {
  const unreadOnly = options?.unreadOnly === true;
  const limit = typeof options?.limit === 'number' && options.limit > 0 ? Math.floor(options.limit) : undefined;
  const items = cloneA2AInboxState(inbox).messages
    .filter((message) => (unreadOnly ? !message.readAt : true))
    .sort((left, right) => right.createdAt - left.createdAt);
  return limit === undefined ? items : items.slice(0, limit);
}

export function buildA2AInboxNotification(unreadCount: number): string {
  const suffix = unreadCount > 1 ? ` (${unreadCount} unread)` : unreadCount === 1 ? ' (1 unread)' : '';
  return `A2A inbox${suffix}.`;
}

function normalizeInboxPreviewText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 120);
}

export function buildA2AInboxNotificationWithPreview(
  inbox: A2AInboxState | null | undefined,
  maxItems: number = 3,
): string {
  const unreadCount = getA2AUnreadCount(inbox);
  const messages = listA2AInboxMessages(inbox, { unreadOnly: true, limit: maxItems });
  const suffix = unreadCount > 1 ? ` (${unreadCount} unread)` : unreadCount === 1 ? ' (1 unread)' : '';
  const summary = messages.length === 0
    ? ''
    : ` ${messages.map((message, index) => {
        const label = message.title?.trim() || `message ${index + 1}`;
        return `${index + 1}. ${normalizeInboxPreviewText(`${label}: ${message.text}`)}`;
      }).join(' | ')}`;
  return `A2A inbox${suffix}.${summary}`;
}

export function buildA2ATurnPrompt(notification: string, snapshotPath?: string, unreadCount?: number): string {
  const stacked = typeof unreadCount === 'number' && unreadCount > 1;
  return [
    notification,
    snapshotPath ? `Snapshot: ${snapshotPath}` : null,
    'This is an A2A inbox turn: you must list, read, and mark inbox messages with MCP in this turn before you finish.',
    'Use list_a2a_messages(unreadOnly=true), read_a2a_message for each id you handle, then mark_a2a_messages_read for every consumed id — all in this turn.',
    stacked
      ? `There are ${unreadCount} unread inbox messages stacked; read and mark them all in this turn, then reply with one combined summary.`
      : 'Read the unread inbox message in this turn, mark it read via MCP, then reply.',
    'Inbox mark tools only work during this turn; do not leave unread messages for a later turn.',
  ].filter((line): line is string => line !== null && line.length > 0).join(' ');
}
