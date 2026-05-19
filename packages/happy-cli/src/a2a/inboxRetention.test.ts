import { describe, expect, it } from 'vitest';
import { upsertA2AInboxMessage } from './inbox';
import { pruneA2AInboxState } from './inboxRetention';

describe('pruneA2AInboxState', () => {
  it('drops read messages when removeAllRead is set', () => {
    let inbox = upsertA2AInboxMessage(undefined, { id: 'a', text: 'one', createdAt: 1 });
    inbox = upsertA2AInboxMessage(inbox, { id: 'b', text: 'two', createdAt: 2, readAt: 99 });
    const pruned = pruneA2AInboxState(inbox, { removeAllRead: true, maxMessages: 64 });
    expect(pruned.messages.map((m) => m.id)).toEqual(['a']);
  });

  it('caps total messages by evicting oldest read then oldest', () => {
    let inbox = upsertA2AInboxMessage(undefined, { id: 'old-read', text: 'r', createdAt: 1, readAt: 10 });
    inbox = upsertA2AInboxMessage(inbox, { id: 'new-unread', text: 'u', createdAt: 3 });
    inbox = upsertA2AInboxMessage(inbox, { id: 'mid-unread', text: 'u2', createdAt: 2 });
    const pruned = pruneA2AInboxState(inbox, { maxMessages: 2 });
    expect(pruned.messages.map((m) => m.id).sort()).toEqual(['mid-unread', 'new-unread']);
  });
});
