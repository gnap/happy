import { randomUUID } from 'node:crypto';
import type { ApiSessionClient } from '@/api/apiSession';
import { formatCursorCliErrorLine } from './cursorProcess';

/** Shown in the App when the user stops the current turn (abort RPC / Escape). */
export const TURN_ABORTED_USER_MESSAGE = 'Turn stopped by user.';

/**
 * User-visible status for abort (Claude-style agent event, not session service text).
 * Lifecycle still uses cursor turn_aborted so thinking clears in the App.
 */
export function notifyUserTurnAborted(
  session: ApiSessionClient,
  turnId: string,
  message: string = TURN_ABORTED_USER_MESSAGE,
): void {
  void turnId;
  session.sendSessionEvent({ type: 'message', message });
  session.sendCursorMessage({ type: 'turn_aborted', id: randomUUID() });
}

/**
 * User-visible turn error (Claude-style agent event).
 * Do not use session service envelopes for errors — App routes those through text heuristics.
 */
export function notifyUserTurnError(
  session: ApiSessionClient,
  turnId: string,
  errorText: string,
): void {
  void turnId;
  const message = formatCursorCliErrorLine(errorText);
  session.sendSessionEvent({
    type: 'message',
    message: message.startsWith('Error:') ? message : `Error: ${message}`,
  });
}

/**
 * Abort RPC while idle (no active turn): still notify App so thinking clears via cursor turn_aborted.
 */
export function notifySessionTurnAbortedIdle(session: ApiSessionClient): void {
  session.sendCursorMessage({ type: 'turn_aborted', id: randomUUID() });
}

/**
 * Durable thinking-on signal (Codex-style task_started). No chat bubble; App uses this for
 * session.thinking before assistant text arrives. Complements ephemeral keepAlive + turn-start.
 */
export function notifyCursorTurnThinkingStarted(session: ApiSessionClient, turnId: string): void {
  session.sendCursorMessage({ type: 'task_started', id: turnId });
}
