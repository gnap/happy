/**
 * PTY / interactive cursor-agent TUI completion heuristics.
 *
 * Input-ready patterns fire before sending a slash command (e.g. /compress).
 * Post-command patterns fire only after stdin was written, so we do not treat the
 * initial "Rendering latest messages" banner as compress completion.
 */

/** Shown before the TUI accepts stdin (initial load). */
export const INTERACTIVE_INPUT_READY_PATTERNS = [
  /Add a follow-up/i,
  /Add a message/i,
  /No active session\./i,
  /Rendering latest messages/i,
  /\bAuto-run\b/i,
  /Use \/full-conversation to render everything/i,
] as const;

/** Prompt returned after a slash command finishes (post-command phase only). */
export const INTERACTIVE_POST_COMMAND_READY_PATTERNS = [
  /Add a follow-up/i,
  /Add a message/i,
  /No active session\./i,
] as const;

/** Explicit compress success lines in TUI output (post-command). */
export const INTERACTIVE_COMPRESS_SUCCESS_PATTERNS = [
  /compression complete/i,
  /compressed (?:the )?context/i,
  /context (?:was )?compressed/i,
  /chat compressed/i,
  /summary (?:was )?created/i,
  /finished compressing/i,
  /\/compress\b.*\b(?:done|complete|finished)\b/i,
] as const;

export const INTERACTIVE_COMPRESS_FAILURE_PATTERNS = [
  /failed to compress/i,
  /compression failed/i,
  /error.*\bcompress/i,
  /Max Mode Required/i,
] as const;

export type InteractiveCommandOutcome = 'completed' | 'failed' | 'aborted' | 'timed_out';

export type InteractiveCommandResult = {
  outcome: InteractiveCommandOutcome;
  detail?: string;
};

export function matchesAnyPattern(buffer: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(buffer));
}

export function isInteractiveInputReady(buffer: string): boolean {
  return matchesAnyPattern(buffer, INTERACTIVE_INPUT_READY_PATTERNS);
}

export function isInteractiveCompressFailed(buffer: string): boolean {
  return matchesAnyPattern(buffer, INTERACTIVE_COMPRESS_FAILURE_PATTERNS);
}

/**
 * True when /compress likely finished: explicit success text or input prompt after command.
 */
export function isInteractiveCompressComplete(buffer: string): boolean {
  if (isInteractiveCompressFailed(buffer)) {
    return false;
  }
  if (matchesAnyPattern(buffer, INTERACTIVE_COMPRESS_SUCCESS_PATTERNS)) {
    return true;
  }
  return matchesAnyPattern(buffer, INTERACTIVE_POST_COMMAND_READY_PATTERNS);
}

export function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

/** Idle after /compress (0 = disabled; rely on abort + completion heuristics). */
export function defaultCompactPostCommandIdleMs(): number {
  return parsePositiveIntEnv('CURSOR_COMPACT_POST_IDLE_MS', 0);
}

/** Wall-clock cap after /compress (0 = disabled). */
export function defaultCompactPostCommandMaxMs(): number {
  return parsePositiveIntEnv('CURSOR_COMPACT_MAX_MS', 0);
}
