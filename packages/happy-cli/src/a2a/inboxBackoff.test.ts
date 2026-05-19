import { describe, expect, it } from 'vitest';
import {
  a2aInboxBackoffDelayMs,
  DEFAULT_A2A_INBOX_BACKOFF_BASE_MS,
  DEFAULT_A2A_INBOX_BACKOFF_MAX_MS,
  isA2AInboxBackoffActive,
} from './inboxBackoff';

describe('a2aInboxBackoff', () => {
  it('computes exponential delay capped at max', () => {
    const settings = { baseMs: 1000, maxMs: 5000 };
    expect(a2aInboxBackoffDelayMs(1, settings)).toBe(1000);
    expect(a2aInboxBackoffDelayMs(2, settings)).toBe(2000);
    expect(a2aInboxBackoffDelayMs(3, settings)).toBe(4000);
    expect(a2aInboxBackoffDelayMs(4, settings)).toBe(5000);
  });

  it('returns zero delay for non-positive streak', () => {
    expect(a2aInboxBackoffDelayMs(0, { baseMs: 1000, maxMs: 5000 })).toBe(0);
  });

  it('detects active backoff window', () => {
    expect(isA2AInboxBackoffActive(2000, 1000)).toBe(true);
    expect(isA2AInboxBackoffActive(2000, 2000)).toBe(false);
    expect(isA2AInboxBackoffActive(0, 1000)).toBe(false);
  });

  it('uses sensible defaults', () => {
    expect(DEFAULT_A2A_INBOX_BACKOFF_BASE_MS).toBe(30_000);
    expect(DEFAULT_A2A_INBOX_BACKOFF_MAX_MS).toBe(1_800_000);
  });
});
