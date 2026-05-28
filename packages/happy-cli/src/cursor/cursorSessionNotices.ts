/**
 * Cursor turn-level service notices and synthetic tool-call-end payloads.
 * Matches compress-failure / turn-end cleanup encapsulation (session `service` + structured tool result).
 */

import type { ApiSessionClient } from '@/api/apiSession';
import { createEnvelope, type CreateEnvelopeOptions } from '@slopus/happy-wire';

export const CURSOR_SYNTHETIC_TOOL_END = {
  turnEnded: { turnEnded: true, message: 'Turn completed; tool did not report end' },
  aborted: { aborted: true, message: 'Tool call ended without result (agent aborted or exited)' },
  runningInBackground: {
    runningInBackground: true,
    message: 'Tool still running; timer stopped. Response will continue when it completes.',
  },
} as const;

export type CursorSyntheticToolEndKind = keyof typeof CURSOR_SYNTHETIC_TOOL_END;

export function cursorSyntheticToolEndResult(kind: CursorSyntheticToolEndKind): string {
  return JSON.stringify(CURSOR_SYNTHETIC_TOOL_END[kind]);
}

/** Turn status (summarize, abort, compress failure) — same envelope as other cursor service notices. */
export function sendCursorTurnServiceNotice(
  session: ApiSessionClient,
  turnId: string,
  text: string,
): void {
  session.sendSessionProtocolMessage(createEnvelope('agent', { t: 'service', text }, { turn: turnId }));
}

export function sendCursorSyntheticToolCallEnd(
  session: ApiSessionClient,
  turnId: string,
  callId: string,
  kind: CursorSyntheticToolEndKind,
  options?: Pick<CreateEnvelopeOptions, 'subagent'>,
): void {
  const envelopeOpts: CreateEnvelopeOptions = {
    turn: turnId,
    ...(options?.subagent ? { subagent: options.subagent } : {}),
  };
  session.sendSessionProtocolMessage(
    createEnvelope('agent', {
      t: 'tool-call-end',
      call: callId,
      result: cursorSyntheticToolEndResult(kind),
    }, envelopeOpts),
  );
}
