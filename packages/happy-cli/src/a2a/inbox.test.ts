import { describe, expect, it } from 'vitest';
import {
  buildA2AInboxNotification,
  buildA2AInboxNotificationWithPreview,
  buildA2ATurnPrompt,
  cloneA2AInboxState,
  getA2AUnreadCount,
  hasUnreadA2AInboxMessages,
  listA2AInboxMessages,
  mergeA2AInboxState,
  markA2AInboxMessageRead,
  markA2AInboxMessagesRead,
  upsertA2AInboxMessage,
} from './inbox';

describe('A2A inbox helpers', () => {
  it('sorts messages newest-first and preserves read state', () => {
    const inbox = upsertA2AInboxMessage(undefined, {
      id: 'one',
      text: 'first',
      createdAt: 1000,
    });
    const nextInbox = upsertA2AInboxMessage(inbox, {
      id: 'two',
      text: 'second',
      createdAt: 2000,
    });

    expect(listA2AInboxMessages(nextInbox)).toEqual([
      expect.objectContaining({ id: 'two', readAt: null }),
      expect.objectContaining({ id: 'one', readAt: null }),
    ]);
  });

  it('marks messages read in batch without mutating the original inbox', () => {
    const inbox = upsertA2AInboxMessage(undefined, {
      id: 'one',
      text: 'first',
      createdAt: 1000,
    });
    const snapshot = cloneA2AInboxState(inbox);

    const readInbox = markA2AInboxMessagesRead(inbox, ['one', 'missing'], 4242);
    expect(getA2AUnreadCount(readInbox)).toBe(0);
    expect(readInbox.messages).toEqual([]);
    expect(inbox).toEqual(snapshot);
  });

  it('keeps the notification terse but actionable', () => {
    expect(buildA2AInboxNotification(3)).toContain('3 unread');
    expect(buildA2AInboxNotification(1)).toContain('1 unread');
    expect(buildA2AInboxNotification(1)).not.toContain('list_a2a_messages');
  });

  it('can include a compact inbox preview', () => {
    const inbox = upsertA2AInboxMessage(undefined, {
      id: 'one',
      text: 'first message with a long body that should be truncated for display',
      createdAt: 1000,
      title: 'Reminder',
    });
    expect(buildA2AInboxNotificationWithPreview(inbox)).toContain('Reminder: first message');
  });

  it('builds a hidden prompt that requires MCP inbox consumption in this turn', () => {
    const prompt = buildA2ATurnPrompt(buildA2AInboxNotification(1));
    expect(prompt).toContain('A2A inbox (1 unread)');
    expect(prompt).toContain('list_a2a_messages');
    expect(prompt).toContain('mark_a2a_messages_read');
    expect(prompt).toContain('in this turn');
    expect(prompt).toContain('do not leave unread messages for a later turn');
  });

  it('encourages one-turn batch handling when multiple messages are stacked', () => {
    const prompt = buildA2ATurnPrompt(buildA2AInboxNotification(4), '/tmp/inbox.json', 4);
    expect(prompt).toContain('4 unread inbox messages stacked');
    expect(prompt).toContain('one combined summary');
  });

  it('marks a single message as read', () => {
    const inbox = upsertA2AInboxMessage(undefined, {
      id: 'one',
      text: 'first',
      createdAt: 1000,
    });
    const readInbox = markA2AInboxMessageRead(inbox, 'one', 9000);
    expect(readInbox.messages).toEqual([]);
  });

  it('merge can re-introduce a row that was dropped locally after mark-read prune', () => {
    const local = markA2AInboxMessageRead(
      upsertA2AInboxMessage(undefined, {
        id: 'one',
        text: 'first',
        createdAt: 1000,
      }),
      'one',
      9000,
    );
    expect(local.messages).toEqual([]);
    const remote = upsertA2AInboxMessage(undefined, {
      id: 'one',
      text: 'first',
      createdAt: 1000,
    });

    const merged = mergeA2AInboxState(local, remote);
    expect(merged.messages[0]).toEqual(expect.objectContaining({ id: 'one', readAt: null }));
  });

  it('peeks unread inbox work for turn scheduling', () => {
    const inbox = upsertA2AInboxMessage(undefined, {
      id: 'one',
      text: 'pending',
      createdAt: 1000,
    });
    expect(hasUnreadA2AInboxMessages(inbox)).toBe(true);
    expect(hasUnreadA2AInboxMessages(markA2AInboxMessageRead(inbox, 'one', 9000))).toBe(false);
  });

  it('merges remote read markers without marking local unread rows as read', () => {
    const local = upsertA2AInboxMessage(undefined, {
      id: 'one',
      text: 'still unread locally',
      createdAt: 1000,
    });
    const remote = upsertA2AInboxMessage(undefined, {
      id: 'one',
      text: 'still unread locally',
      createdAt: 1000,
      readAt: 9000,
    });

    const merged = mergeA2AInboxState(local, remote);
    expect(merged.messages[0]).toEqual(expect.objectContaining({ id: 'one', readAt: null }));
  });

});
