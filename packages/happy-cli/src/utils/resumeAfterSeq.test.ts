import { describe, expect, it } from 'vitest';
import { parseResumeAfterSeqFromEnv, resolveInitialLastSeq } from './resumeAfterSeq';

describe('resumeAfterSeq', () => {
  it('reads HAPPY_RESUME_AFTER_SEQ from the environment', () => {
    const prev = process.env.HAPPY_RESUME_AFTER_SEQ;
    process.env.HAPPY_RESUME_AFTER_SEQ = '42';
    expect(parseResumeAfterSeqFromEnv()).toBe(42);
    if (prev === undefined) {
      delete process.env.HAPPY_RESUME_AFTER_SEQ;
    } else {
      process.env.HAPPY_RESUME_AFTER_SEQ = prev;
    }
  });

  it('prefers explicit resumeAfterSeq over env', () => {
    expect(resolveInitialLastSeq({ resumeAfterSeq: 7, envResumeAfterSeq: 99 })).toBe(7);
    expect(resolveInitialLastSeq({ envResumeAfterSeq: 99 })).toBe(99);
    expect(resolveInitialLastSeq({})).toBeUndefined();
  });
});
