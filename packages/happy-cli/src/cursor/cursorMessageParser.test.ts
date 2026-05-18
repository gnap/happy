import { describe, expect, it } from 'vitest';
import { parseCursorMessage } from './cursorMessageParser';

describe('cursorMessageParser', () => {
  it('ignores user stream messages', () => {
    const result = parseCursorMessage({ type: 'user' } as never);
    expect(result).toEqual([]);
  });

  it('preserves usage and duration from result messages', () => {
    const result = parseCursorMessage({
      type: 'result',
      subtype: 'success',
      session_id: 'session-1',
      usage: {
        input_tokens: 12,
        output_tokens: 34,
        cache_read_input_tokens: 5,
        cache_creation_input_tokens: 6,
      },
      total_cost_usd: 0.42,
      duration_ms: 1234,
    } as never);

    expect(result).toEqual([
      {
        type: 'task_complete',
        sessionId: 'session-1',
        usage: {
          input_tokens: 12,
          output_tokens: 34,
          cache_read_input_tokens: 5,
          cache_creation_input_tokens: 6,
        },
        costUsd: 0.42,
        durationMs: 1234,
      },
    ]);
  });
});
