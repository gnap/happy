import { randomUUID } from 'node:crypto';
import { createEnvelope } from '@slopus/happy-wire';
import type { ApiSessionClient } from '@/api/apiSession';
import { formatCursorCliErrorLine } from './cursorProcess';

/** Shown in the App when the user stops the current turn (abort RPC / Escape). */
export const TURN_ABORTED_USER_MESSAGE = 'Turn stopped by user.';

/**
 * Deliver a user-visible abort notice for the active turn (session envelope + cursor lifecycle).
 * Do not dual-send legacy agent events — App renders those as duplicate status lines alongside envelope text.
 */
export function notifyUserTurnAborted(
  session: ApiSessionClient,
  turnId: string,
  message: string = TURN_ABORTED_USER_MESSAGE,
): void {
  session.sendSessionProtocolMessage(createEnvelope('agent', { t: 'service', text: message }, { turn: turnId }));
  session.sendCursorMessage({ type: 'turn_aborted', id: randomUUID() });
}

/**
 * Deliver a user-visible error for the active turn (CLI/provider failures, billing, etc.).
 * Session envelope only; avoid sendSessionEvent so errors are not shown twice (event + assistant text).
 */
export function notifyUserTurnError(
  session: ApiSessionClient,
  turnId: string,
  errorText: string,
): void {
  const message = formatCursorCliErrorLine(errorText);
  session.sendSessionProtocolMessage(createEnvelope('agent', { t: 'service', text: message }, { turn: turnId }));
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
