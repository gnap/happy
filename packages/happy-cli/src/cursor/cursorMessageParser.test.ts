import { describe, expect, it } from 'vitest';
import { parseCursorMessage } from './cursorMessageParser';

describe('cursorMessageParser', () => {
  it('ignores user stream messages', () => {
    const result = parseCursorMessage({ type: 'user' } as never);
    expect(result).toEqual([]);
  });

  it('skips final consolidated assistant messages without timestamp_ms', () => {
    const result = parseCursorMessage({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'duplicate text' }],
      },
    } as never);

    expect(result).toEqual([]);
  });

  it('skips consolidated assistant messages with model_call_id', () => {
    const result = parseCursorMessage({
      type: 'assistant',
      model_call_id: 'call-1',
      timestamp_ms: 123,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'duplicate text' }],
      },
    } as never);

    expect(result).toEqual([]);
  });
});
