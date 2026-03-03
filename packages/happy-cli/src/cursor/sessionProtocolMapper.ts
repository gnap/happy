/**
 * CursorSessionProtocolMapper - Maps CursorParsedMessage to session protocol envelopes
 *
 * Follows the same pattern as Codex's sessionProtocolMapper.ts,
 * converting internal cursor messages into the unified session protocol envelope stream.
 */

import { randomUUID } from 'node:crypto';
import { createId } from '@paralleldrive/cuid2';
import { createEnvelope, type CreateEnvelopeOptions, type SessionEnvelope } from '@slopus/happy-wire';
import type { CursorParsedMessage } from './cursorMessageParser';

export type CursorTurnState = {
  currentTurnId: string | null;
};

type CursorMapperResult = {
  currentTurnId: string | null;
  envelopes: SessionEnvelope[];
};

function buildEnvelopeOptions(currentTurnId: string | null): CreateEnvelopeOptions {
  return currentTurnId ? { turn: currentTurnId } : {};
}

/**
 * Map a CursorParsedMessage to session protocol envelopes.
 */
export function mapCursorMessageToSessionEnvelopes(
  message: CursorParsedMessage,
  state: CursorTurnState,
): CursorMapperResult {
  const { type } = message;

  if (type === 'task_started') {
    const turnId = createId();
    return {
      currentTurnId: turnId,
      envelopes: [
        createEnvelope('agent', { t: 'turn-start' }, { turn: turnId }),
      ],
    };
  }

  if (type === 'task_complete') {
    if (!state.currentTurnId) {
      return { currentTurnId: null, envelopes: [] };
    }
    const opts = { turn: state.currentTurnId } satisfies CreateEnvelopeOptions;
    return {
      currentTurnId: null,
      envelopes: [
        createEnvelope('agent', { t: 'turn-end', status: 'completed' }, opts),
      ],
    };
  }

  if (type === 'error') {
    if (!state.currentTurnId) {
      return { currentTurnId: null, envelopes: [] };
    }
    const opts = { turn: state.currentTurnId } satisfies CreateEnvelopeOptions;
    return {
      currentTurnId: null,
      envelopes: [
        createEnvelope('agent', { t: 'turn-end', status: 'failed' }, opts),
      ],
    };
  }

  const opts = buildEnvelopeOptions(state.currentTurnId);

  if (type === 'text_delta') {
    return {
      currentTurnId: state.currentTurnId,
      envelopes: [
        createEnvelope('agent', { t: 'text', text: message.text }, opts),
      ],
    };
  }

  if (type === 'thinking_delta') {
    return {
      currentTurnId: state.currentTurnId,
      envelopes: [
        createEnvelope('agent', { t: 'text', text: message.text, thinking: true }, opts),
      ],
    };
  }

  if (type === 'tool_call_start') {
    const command = typeof message.args?.command === 'string' ? message.args.command : null;
    const title = command
      ? `Run \`${command.length > 80 ? command.slice(0, 77) + '...' : command}\``
      : `${message.toolName} call`;

    return {
      currentTurnId: state.currentTurnId,
      envelopes: [
        createEnvelope('agent', {
          t: 'tool-call-start',
          call: message.callId,
          name: message.toolName,
          title,
          description: title,
          args: message.args,
        }, opts),
      ],
    };
  }

  if (type === 'tool_call_end') {
    return {
      currentTurnId: state.currentTurnId,
      envelopes: [
        createEnvelope('agent', { t: 'tool-call-end', call: message.callId }, opts),
      ],
    };
  }

  // session_init and others don't map to envelopes
  return { currentTurnId: state.currentTurnId, envelopes: [] };
}
