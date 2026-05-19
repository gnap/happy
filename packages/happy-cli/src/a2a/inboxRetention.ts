import type { A2AInboxState } from '@/api/types';
import { cloneA2AInboxState } from './inbox';

export const DEFAULT_A2A_INBOX_MAX_MESSAGES = 64;

export type A2AInboxRetentionSettings = {
  /** Maximum rows kept in agentState (unread + any read not yet dropped). */
  maxMessages: number;
  /** When true, mark-read removes rows instead of only setting readAt. */
  dropReadOnMark: boolean;
};

export function resolveA2AInboxRetentionSettings(): A2AInboxRetentionSettings {
  const maxRaw = process.env.CURSOR_A2A_INBOX_MAX_MESSAGES;
  const parsedMax = maxRaw !== undefined && maxRaw !== '' ? Number.parseInt(maxRaw, 10) : DEFAULT_A2A_INBOX_MAX_MESSAGES;
  const maxMessages = Number.isFinite(parsedMax) && parsedMax > 0 ? parsedMax : DEFAULT_A2A_INBOX_MAX_MESSAGES;
  const keepRead = process.env.CURSOR_A2A_INBOX_KEEP_READ === '1';
  return {
    maxMessages,
    dropReadOnMark: !keepRead,
  };
}

/**
 * Trim inbox size: optionally drop all read rows, then evict oldest (read first) until <= maxMessages.
 */
export function pruneA2AInboxState(
  inbox: A2AInboxState | null | undefined,
  options?: {
    removeAllRead?: boolean;
    maxMessages?: number;
  },
): A2AInboxState {
  const settings = resolveA2AInboxRetentionSettings();
  const maxMessages = options?.maxMessages ?? settings.maxMessages;
  let messages = cloneA2AInboxState(inbox).messages;

  if (options?.removeAllRead === true) {
    messages = messages.filter((message) => !message.readAt);
  }

  while (messages.length > maxMessages) {
    const sorted = [...messages].sort((left, right) => left.createdAt - right.createdAt);
    const readCandidate = sorted.find((message) => message.readAt);
    const drop = readCandidate ?? sorted[0];
    messages = messages.filter((message) => message.id !== drop.id);
  }

  return { messages };
}
