import { createId } from '@paralleldrive/cuid2';
import { createEnvelope, type SessionEnvelope } from '@slopus/happy-wire';

export type A2ASubagentCardOptions = {
  title?: string;
  description?: string;
  args?: Record<string, unknown>;
  turnId?: string;
  cardId?: string;
};

export type SessionEnvelopeRecord = {
  role: 'session';
  content: SessionEnvelope;
  meta: {
    sentFrom: 'cli';
    origin: 'a2a';
  };
};

const DEFAULT_A2A_CARD_TITLE = 'A2A Message';

function summarizeDescription(text: string, explicitDescription?: string): string {
  const source = explicitDescription?.trim() || text.trim() || DEFAULT_A2A_CARD_TITLE;
  return source.length > 200 ? `${source.slice(0, 197)}...` : source;
}

export function buildA2ASubagentCardEnvelopes(
  text: string,
  options: A2ASubagentCardOptions = {},
): SessionEnvelope[] {
  const turnId = options.turnId ?? createId();
  const cardId = options.cardId ?? createId();
  const title = options.title?.trim() || DEFAULT_A2A_CARD_TITLE;
  const description = summarizeDescription(text, options.description);
  const args = {
    title,
    description: title,
    prompt: text,
    origin: 'a2a',
    ...(options.args ?? {}),
  };

  return [
    createEnvelope('agent', { t: 'turn-start' }, { turn: turnId }),
    createEnvelope('agent', {
      t: 'tool-call-start',
      call: cardId,
      name: 'Task',
      title,
      description,
      args,
    }, { turn: turnId }),
    createEnvelope('agent', { t: 'start', title }, { turn: turnId, subagent: cardId }),
    createEnvelope('agent', { t: 'text', text }, { turn: turnId, subagent: cardId }),
    createEnvelope('agent', { t: 'stop' }, { turn: turnId, subagent: cardId }),
    createEnvelope('agent', { t: 'tool-call-end', call: cardId }, { turn: turnId }),
    createEnvelope('agent', { t: 'turn-end', status: 'completed' }, { turn: turnId }),
  ];
}

export function wrapA2ASessionEnvelope(envelope: SessionEnvelope): SessionEnvelopeRecord {
  return {
    role: 'session',
    content: envelope,
    meta: {
      sentFrom: 'cli',
      origin: 'a2a',
    },
  };
}
