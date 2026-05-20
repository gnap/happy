import { describe, expect, it, vi } from 'vitest';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { createA2AInboxTurnController, isA2AInboxTurnMeta } from './inboxTurnController';

describe('inboxTurnController', () => {
  it('detects inbox turn meta', () => {
    expect(isA2AInboxTurnMeta({ a2aInboxTurn: true })).toBe(true);
    expect(isA2AInboxTurnMeta({})).toBe(false);
  });

  it('schedules an isolated inbox turn when unread messages exist', () => {
    const messageQueue = new MessageQueue2<{ permissionMode: string }>((mode) => mode.permissionMode);
    const pushIsolated = vi.spyOn(messageQueue, 'pushIsolated');
    const session = {
      getA2AInbox: () => ({
        messages: [{ id: 'm1', text: 'hello', createdAt: 1, readAt: null }],
      }),
      markA2AMessageRead: vi.fn(),
    } as any;

    const controller = createA2AInboxTurnController({
      logTag: 'test',
      messageQueue,
      session,
      getMode: () => ({ permissionMode: 'default' }),
      isAgentTurnActive: () => false,
      workspacePath: '/tmp/ws',
      sessionId: 'sess-1',
      buildTurnPrompt: () => 'inbox prompt',
    });

    controller.peekInbox();
    expect(pushIsolated).toHaveBeenCalledWith('', { permissionMode: 'default' }, { a2aInboxTurn: true });
  });
});
