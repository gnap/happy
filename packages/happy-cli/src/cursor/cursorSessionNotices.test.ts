import { describe, expect, it } from 'vitest';
import {
  CURSOR_SYNTHETIC_TOOL_END,
  cursorSyntheticToolEndResult,
} from './cursorSessionNotices';

describe('cursorSessionNotices', () => {
  it('serializes synthetic tool-end payloads for App hide rules', () => {
    expect(JSON.parse(cursorSyntheticToolEndResult('aborted'))).toEqual(CURSOR_SYNTHETIC_TOOL_END.aborted);
    expect(JSON.parse(cursorSyntheticToolEndResult('turnEnded'))).toEqual(CURSOR_SYNTHETIC_TOOL_END.turnEnded);
    expect(JSON.parse(cursorSyntheticToolEndResult('runningInBackground'))).toEqual(
      CURSOR_SYNTHETIC_TOOL_END.runningInBackground,
    );
  });
});
