import { describe, expect, it } from 'vitest';
import { appendResumeAfterSeqCliArgs, parseResumeAfterSeqValue } from './resumeAfterSeq';

describe('resumeAfterSeq', () => {
  it('parses non-negative seq values', () => {
    expect(parseResumeAfterSeqValue('42')).toBe(42);
    expect(parseResumeAfterSeqValue('-1')).toBeUndefined();
    expect(parseResumeAfterSeqValue('')).toBeUndefined();
  });

  it('appends --resume-after-seq to spawn args', () => {
    const args = ['cursor', '--started-by', 'daemon'];
    appendResumeAfterSeqCliArgs(args, 10);
    expect(args).toEqual(['cursor', '--started-by', 'daemon', '--resume-after-seq', '10']);
  });
});
