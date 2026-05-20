/**
 * Daemon passes HAPPY_RESUME_AFTER_SEQ when waking a CLI so the session client
 * starts below the server head and HTTP-syncs messages received while offline.
 */
export function parseResumeAfterSeqFromEnv(): number | undefined {
  const raw = process.env.HAPPY_RESUME_AFTER_SEQ?.trim();
  if (!raw) {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return undefined;
  }
  return parsed;
}

export function parseResumeAfterSeqArg(value: string | undefined): number | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return undefined;
  }
  return parsed;
}

export function resolveInitialLastSeq(options?: {
  resumeAfterSeq?: number;
  envResumeAfterSeq?: number;
}): number | undefined {
  if (typeof options?.resumeAfterSeq === 'number' && options.resumeAfterSeq >= 0) {
    return options.resumeAfterSeq;
  }
  if (typeof options?.envResumeAfterSeq === 'number' && options.envResumeAfterSeq >= 0) {
    return options.envResumeAfterSeq;
  }
  return undefined;
}
