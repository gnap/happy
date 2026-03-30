import { describe, expect, it } from 'vitest';
import { parseCursorMessage } from './cursorMessageParser';

describe('cursorMessageParser', () => {
  it('ignores user stream messages', () => {
    const result = parseCursorMessage({ type: 'user' } as never);
    expect(result).toEqual([]);
  });
});
