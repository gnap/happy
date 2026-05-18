import { describe, expect, it } from 'vitest';
import { isCuid } from '@paralleldrive/cuid2';
import { buildA2ASubagentCardEnvelopes, wrapA2ASessionEnvelope } from './subagentCard';

describe('buildA2ASubagentCardEnvelopes', () => {
  it('builds a task-style subagent card lifecycle for A2A text', () => {
    const envelopes = buildA2ASubagentCardEnvelopes('hello from another agent', {
      title: 'Remote Agent',
    });

    expect(envelopes).toHaveLength(7);
    expect(envelopes[0].ev).toEqual({ t: 'turn-start' });
    expect(envelopes[0].turn).toBeDefined();

    expect(envelopes[1].ev.t).toBe('tool-call-start');
    if (envelopes[1].ev.t !== 'tool-call-start') {
      throw new Error('expected tool-call-start');
    }
    expect(envelopes[1].ev.name).toBe('Task');
    expect(envelopes[1].ev.title).toBe('Remote Agent');
    expect(envelopes[1].ev.args).toMatchObject({
      title: 'Remote Agent',
      description: 'Remote Agent',
      prompt: 'hello from another agent',
      origin: 'a2a',
    });

    expect(envelopes[2].ev).toEqual({ t: 'start', title: 'Remote Agent' });
    expect(envelopes[3].ev).toEqual({ t: 'text', text: 'hello from another agent' });
    expect(envelopes[4].ev).toEqual({ t: 'stop' });

    expect(envelopes[5].ev.t).toBe('tool-call-end');
    if (envelopes[5].ev.t !== 'tool-call-end') {
      throw new Error('expected tool-call-end');
    }
    expect(envelopes[6].ev).toEqual({ t: 'turn-end', status: 'completed' });

    const turnId = envelopes[0].turn;
    const subagentId = envelopes[2].subagent;
    expect(typeof turnId).toBe('string');
    expect(typeof subagentId).toBe('string');
    expect(isCuid(subagentId!)).toBe(true);

    for (const envelope of envelopes) {
      expect(envelope.turn).toBe(turnId);
    }
    expect(envelopes[1].ev.call).toBe(subagentId);
    expect(envelopes[2].subagent).toBe(subagentId);
    expect(envelopes[3].subagent).toBe(subagentId);
    expect(envelopes[4].subagent).toBe(subagentId);
    expect(envelopes[5].ev.call).toBe(subagentId);
  });

  it('wraps envelopes in session records with A2A metadata', () => {
    const [envelope] = buildA2ASubagentCardEnvelopes('hello');
    const wrapped = wrapA2ASessionEnvelope(envelope);

    expect(wrapped).toEqual({
      role: 'session',
      content: envelope,
      meta: {
        sentFrom: 'cli',
        origin: 'a2a',
      },
    });
  });
});
