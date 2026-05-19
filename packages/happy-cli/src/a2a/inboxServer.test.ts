import { describe, expect, it } from 'vitest';
import { upsertA2AInboxMessage } from './inbox';
import {
  extractLegacyInboxFromAgentState,
  isFullA2AInboxState,
  isServerA2AInboxSnapshot,
  toServerA2AInboxSnapshot,
} from './inboxServer';

describe('inboxServer', () => {
  it('detects legacy full inbox on agentState', () => {
    const legacy = { messages: [{ id: 'a', text: 'hi', createdAt: 1 }] };
    expect(isFullA2AInboxState(legacy)).toBe(true);
    expect(isServerA2AInboxSnapshot(legacy)).toBe(false);
  });

  it('detects server unread snapshot', () => {
    expect(isServerA2AInboxSnapshot({ unreadCount: 2 })).toBe(true);
    expect(isFullA2AInboxState({ unreadCount: 2 })).toBe(false);
  });

  it('extracts legacy inbox for one-time migration', () => {
    const inbox = extractLegacyInboxFromAgentState({
      a2aInbox: {
        messages: [{ id: 'a', text: 'x', createdAt: 10 }],
      },
    });
    expect(inbox?.messages).toHaveLength(1);
  });

  it('toServerA2AInboxSnapshot only exposes unreadCount', () => {
    let local = upsertA2AInboxMessage(undefined, { id: 'a', text: 'long body', createdAt: 1 });
    local = upsertA2AInboxMessage(local, { id: 'b', text: 'another', createdAt: 2 });
    expect(toServerA2AInboxSnapshot(local)).toEqual({ unreadCount: 2 });
    expect(toServerA2AInboxSnapshot(local)).not.toHaveProperty('messages');
  });
});
