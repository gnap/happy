/**
 * Ephemeral resume cursor passed as CLI args from daemon (in-memory poll counters only).
 */

export function parseResumeAfterSeqValue(raw: string | undefined): number | undefined {
  if (!raw?.trim()) {
    return undefined;
  }
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return undefined;
  }
  return parsed;
}

export function appendResumeAfterSeqCliArgs(args: string[], resumeAfterSeq?: number): void {
  if (typeof resumeAfterSeq === 'number' && resumeAfterSeq >= 0) {
    args.push('--resume-after-seq', String(resumeAfterSeq));
  }
}
