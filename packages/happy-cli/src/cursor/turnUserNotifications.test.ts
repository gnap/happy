import { describe, expect, it, vi } from 'vitest';
import {
  notifyCursorTurnThinkingStarted,
  notifySessionTurnAbortedIdle,
  notifyUserTurnAborted,
  notifyUserTurnError,
  TURN_ABORTED_USER_MESSAGE,
} from './turnUserNotifications';

describe('turnUserNotifications', () => {
  it('notifyUserTurnAborted sends agent event and cursor turn_aborted only', () => {
    const session = {
      sendSessionProtocolMessage: vi.fn(),
      sendSessionEvent: vi.fn(),
      sendCursorMessage: vi.fn(),
    };

    notifyUserTurnAborted(session as never, 'turn-1');

    expect(session.sendSessionProtocolMessage).not.toHaveBeenCalled();
    expect(session.sendSessionEvent).toHaveBeenCalledWith({
      type: 'message',
      message: TURN_ABORTED_USER_MESSAGE,
    });
    expect(session.sendCursorMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'turn_aborted', id: expect.any(String) }),
    );
  });

  it('notifyUserTurnError sends agent event only (Claude-style, no service envelope)', () => {
    const session = {
      sendSessionProtocolMessage: vi.fn(),
      sendSessionEvent: vi.fn(),
      sendCursorMessage: vi.fn(),
    };

    notifyUserTurnError(session as never, 'turn-2', 'S: provider error: timeout');

    expect(session.sendSessionProtocolMessage).not.toHaveBeenCalled();
    expect(session.sendSessionEvent).toHaveBeenCalledWith({
      type: 'message',
      message: 'Error: provider error: timeout',
    });
  });

  it('notifyCursorTurnThinkingStarted sends cursor task_started', () => {
    const session = { sendCursorMessage: vi.fn() };

    notifyCursorTurnThinkingStarted(session as never, 'turn-3');

    expect(session.sendCursorMessage).toHaveBeenCalledWith({
      type: 'task_started',
      id: 'turn-3',
    });
  });

  it('notifySessionTurnAbortedIdle sends cursor turn_aborted only', () => {
    const session = {
      sendSessionProtocolMessage: vi.fn(),
      sendSessionEvent: vi.fn(),
      sendCursorMessage: vi.fn(),
    };

    notifySessionTurnAbortedIdle(session as never);

    expect(session.sendCursorMessage).toHaveBeenCalledTimes(1);
    expect(session.sendSessionProtocolMessage).not.toHaveBeenCalled();
    expect(session.sendSessionEvent).not.toHaveBeenCalled();
  });
});
