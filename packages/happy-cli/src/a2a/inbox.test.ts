import { describe, expect, it } from 'vitest';
import {
  buildA2AInboxNotification,
  buildA2AInboxNotificationWithPreview,
  buildA2ATurnPrompt,
  cloneA2AInboxState,
  getA2AUnreadCount,
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
    expect(readInbox.messages[0]).toEqual(expect.objectContaining({ id: 'one', readAt: 4242 }));
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

  it('builds a hidden prompt that instructs the model to consume inbox items', () => {
    const prompt = buildA2ATurnPrompt(buildA2AInboxNotification(1));
    expect(prompt).toContain('A2A inbox (1 unread)');
    expect(prompt).toContain('Read the inbox first');
    expect(prompt).not.toContain('mark consumed ids read');
  });

  it('marks a single message as read', () => {
    const inbox = upsertA2AInboxMessage(undefined, {
      id: 'one',
      text: 'first',
      createdAt: 1000,
    });
    const readInbox = markA2AInboxMessageRead(inbox, 'one', 9000);
    expect(readInbox.messages[0]).toEqual(expect.objectContaining({ id: 'one', readAt: 9000 }));
  });

  it('merges remote inbox updates without losing local read markers', () => {
    const local = markA2AInboxMessageRead(
      upsertA2AInboxMessage(undefined, {
        id: 'one',
        text: 'first',
        createdAt: 1000,
      }),
      'one',
      9000,
    );
    const remote = upsertA2AInboxMessage(undefined, {
      id: 'one',
      text: 'first',
      createdAt: 1000,
    });

    const merged = mergeA2AInboxState(local, remote);
    expect(merged.messages[0]).toEqual(expect.objectContaining({ id: 'one', readAt: 9000 }));
  });
});
