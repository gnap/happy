import { describe, expect, it } from 'vitest';
import {
  buildA2AInboxNotification,
  buildA2AInboxNotificationWithPreview,
  buildA2AInboxTaskTitle,
  buildA2AInboxTaskToolArgs,
  buildA2ATurnPrompt,
  buildA2ATurnPromptForClaude,
  DEFAULT_A2A_INBOX_TASK_MODEL,
  resolveA2AInboxTaskModel,
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

  it('builds a Task card title with unread count', () => {
    expect(buildA2AInboxTaskTitle(0)).toBe('A2A inbox');
    expect(buildA2AInboxTaskTitle(1)).toBe('A2A inbox (1 unread)');
    expect(buildA2AInboxTaskTitle(4)).toBe('A2A inbox (4 unread)');
  });

  it('defaults inbox Task model to composer-2.5-fast with env override', () => {
    expect(resolveA2AInboxTaskModel()).toBe(DEFAULT_A2A_INBOX_TASK_MODEL);
    const prev = process.env.CURSOR_A2A_INBOX_TASK_MODEL;
    process.env.CURSOR_A2A_INBOX_TASK_MODEL = 'composer-2.5-fast';
    expect(resolveA2AInboxTaskModel()).toBe('composer-2.5-fast');
    if (prev === undefined) {
      delete process.env.CURSOR_A2A_INBOX_TASK_MODEL;
    } else {
      process.env.CURSOR_A2A_INBOX_TASK_MODEL = prev;
    }
  });

  it('wraps inbox Task tool args with the resolved model slug', () => {
    expect(buildA2AInboxTaskToolArgs({ description: 'A2A inbox (1 unread)', prompt: 'x' })).toEqual({
      description: 'A2A inbox (1 unread)',
      prompt: 'x',
      model: 'composer-2.5-fast',
    });
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

  it('builds a hidden prompt that delegates inbox work to built-in Task with auto', () => {
    const prompt = buildA2ATurnPrompt(buildA2AInboxNotification(1));
    expect(prompt).toContain('A2A inbox (1 unread)');
    expect(prompt).toContain('built-in Task');
    expect(prompt).toContain('model exactly "composer-2.5-fast"');
    expect(prompt).toContain('Task description (card title) exactly to: A2A inbox (1 unread)');
    expect(prompt).toContain('list_a2a_messages');
    expect(prompt).toContain('mark_a2a_messages_read');
    expect(prompt).toContain('Do not read or mark inbox messages yourself');
    expect(prompt).toContain('not Happy spawn_subagent');
    expect(prompt).toContain('before the Task tool call, send no user-visible text');
    expect(prompt).toContain('only user-visible reply is a short introduction of the Task result');
    expect(prompt).toContain('Do not mention inbox turns');
    expect(prompt).toContain('Do not leave unread inbox messages for a later turn');
  });

  it('encourages one-turn batch handling when multiple messages are stacked', () => {
    const prompt = buildA2ATurnPrompt(buildA2AInboxNotification(4), '/tmp/inbox.json', 4);
    expect(prompt).toContain('4 unread A2A inbox messages');
    expect(prompt).toContain('A2A inbox (4 unread)');
    expect(prompt).toContain('short introduction of the Task result');
    expect(prompt).toContain('Task prompt:');
  });

  it('builds Claude inbox prompt via Happy MCP without Task model slug', () => {
    const prompt = buildA2ATurnPromptForClaude(buildA2AInboxNotification(2), '/tmp/inbox.json', 2);
    expect(prompt).toContain('mcp__happy__list_a2a_messages');
    expect(prompt).toContain('mcp__happy__mark_a2a_message_read');
    expect(prompt).toContain('2 unread A2A inbox messages');
    expect(prompt).not.toContain('composer-2.5');
    expect(prompt).not.toContain('Task tool model');
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
