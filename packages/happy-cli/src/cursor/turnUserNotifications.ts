import { randomUUID } from 'node:crypto';
import { createEnvelope } from '@slopus/happy-wire';
import type { ApiSessionClient } from '@/api/apiSession';
import { formatCursorCliErrorLine } from './cursorProcess';

/** Shown in the App when the user stops the current turn (abort RPC / Escape). */
export const TURN_ABORTED_USER_MESSAGE = 'Turn stopped by user.';

/**
 * Deliver a user-visible abort notice for the active turn (session protocol + legacy event + cursor lifecycle).
 */
export function notifyUserTurnAborted(
  session: ApiSessionClient,
  turnId: string,
  message: string = TURN_ABORTED_USER_MESSAGE,
): void {
  session.sendSessionProtocolMessage(createEnvelope('agent', { t: 'text', text: message }, { turn: turnId }));
  session.sendSessionEvent({ type: 'message', message });
  session.sendCursorMessage({ type: 'turn_aborted', id: randomUUID() });
}

/**
 * Deliver a user-visible error for the active turn (CLI/provider failures, billing, etc.).
 */
export function notifyUserTurnError(
  session: ApiSessionClient,
  turnId: string,
  errorText: string,
): void {
  const message = formatCursorCliErrorLine(errorText);
  session.sendSessionProtocolMessage(createEnvelope('agent', { t: 'text', text: message }, { turn: turnId }));
  session.sendSessionEvent({ type: 'message', message });
}

/**
 * Abort RPC while idle (no active turn): still notify App so thinking clears via cursor turn_aborted.
 */
export function notifySessionTurnAbortedIdle(session: ApiSessionClient): void {
  session.sendCursorMessage({ type: 'turn_aborted', id: randomUUID() });
}
