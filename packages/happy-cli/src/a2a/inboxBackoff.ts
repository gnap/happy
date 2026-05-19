export const DEFAULT_A2A_INBOX_BACKOFF_BASE_MS = 30_000;
export const DEFAULT_A2A_INBOX_BACKOFF_MAX_MS = 1_800_000;

export function resolveA2AInboxBackoffSettings(): { baseMs: number; maxMs: number } {
  const baseRaw = process.env.CURSOR_A2A_INBOX_BACKOFF_BASE_S;
  const maxRaw = process.env.CURSOR_A2A_INBOX_BACKOFF_MAX_S;
  const baseMs = baseRaw !== undefined && baseRaw !== ''
    ? Math.max(0, Number.parseFloat(baseRaw) * 1000)
    : DEFAULT_A2A_INBOX_BACKOFF_BASE_MS;
  const maxMs = maxRaw !== undefined && maxRaw !== ''
    ? Math.max(baseMs, Number.parseFloat(maxRaw) * 1000)
    : DEFAULT_A2A_INBOX_BACKOFF_MAX_MS;
  return {
    baseMs: Number.isFinite(baseMs) ? baseMs : DEFAULT_A2A_INBOX_BACKOFF_BASE_MS,
    maxMs: Number.isFinite(maxMs) ? maxMs : DEFAULT_A2A_INBOX_BACKOFF_MAX_MS,
  };
}

export function a2aInboxBackoffDelayMs(
  streak: number,
  settings: { baseMs: number; maxMs: number },
): number {
  if (streak <= 0) {
    return 0;
  }
  return Math.min(settings.maxMs, settings.baseMs * (2 ** (streak - 1)));
}

export function isA2AInboxBackoffActive(backoffUntilMs: number, nowMs: number = Date.now()): boolean {
  return backoffUntilMs > nowMs;
}
