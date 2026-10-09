/**
 * Durable local log of a session's messages.
 *
 * The CLI previously decrypted each incoming message, routed it to the agent loop and dropped
 * it, so there was no way to answer "what did this session say" without the server. This keeps
 * the *ciphertext* of both directions on disk, byte for byte as it crossed the wire, so a
 * reader gets exactly what the server holds and needs only the session key to read it.
 *
 * This is NOT a source of truth for "what does the server have". The outbox shrinks as flushes
 * succeed while this log only grows; they mean different things -- the outbox is "not yet
 * acknowledged by the server", the log is "everything this CLI has seen". Any reader that
 * treats this as authoritative about server state is wrong.
 *
 * Format is append-only JSONL, segmented by size. That differs from the outbox, which rewrites
 * wholesale, and the difference is structural rather than an inconsistency: the outbox has
 * removals, so it has a "current set" that must be self-consistent at every instant; a log has
 * no removals, and its worst case -- a torn tail -- is recoverable by truncation.
 *
 * The path scheme is a contract between two processes: the session process writes, the daemon
 * reads. It is versioned by `LOG_FORMAT_VERSION` for that reason.
 */

import { chmodSync, existsSync, mkdirSync, openSync, closeSync, readdirSync, readFileSync, readSync, statSync, truncateSync, unlinkSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';

export const LOG_FORMAT_VERSION = 1;

const LOG_DIR = 'session-log';
/** Rotate on bytes: that is what actually matters, and the fd's size is free to check. */
const DEFAULT_SEGMENT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_KEEP_SEGMENTS = 8;
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Read lazily so tests can drive rotation without writing megabytes. */
function positiveEnvInt(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export type SessionLogEntry = {
  /** Server message id, or the localId when the message is not yet acknowledged. */
  id: string;
  localId: string | null;
  dir: 'in' | 'out';
  /** When this CLI wrote the entry. Not an ordering key: NTP jumps and resumptions move it. */
  at: number;
  /** base64 ciphertext, stored verbatim. */
  c: string;
};

function logWarning(message: string, meta: Record<string, unknown>): void {
  try {
    logger.warn(`[session-log] ${message}`, meta);
  } catch {
    /* logging must never break the send path */
  }
}

/**
 * Keyed by tag *and* writer. Without the writer, the same tag resumed on a second machine with
 * a synced home directory would have two processes appending to one file, which corrupts it
 * irrecoverably. Merging across writers belongs at the reader, by message id.
 */
export function sessionLogDir(tag: string, site: string | undefined): string {
  const name = createHash('sha256').update(`${tag}:${site ?? ''}`).digest('hex').slice(0, 32);
  return join(configuration.happyHomeDir, LOG_DIR, name);
}

/** Segment names are zero-padded so lexicographic order is numeric order. */
function segmentPath(dir: string, index: number): string {
  return join(dir, `${String(index).padStart(10, '0')}.jsonl`);
}

function listSegments(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  try {
    return readdirSync(dir).filter((name) => name.endsWith('.jsonl')).sort();
  } catch {
    return [];
  }
}

/**
 * A crash mid-append leaves a partial final line; everything after it would then be
 * unreachable, so trim back to the last newline before appending. Checked on every append
 * rather than memoised: the check is a stat plus a one-byte read, and memoising would make
 * recovery depend on the write path never being shared, which is not worth the coupling.
 */
function truncateTornTail(path: string): void {
  if (!existsSync(path)) {
    return; // the first append creates it; nothing to repair
  }
  try {
    const size = statSync(path).size;
    if (size === 0) {
      return;
    }
    const fd = openSync(path, 'r');
    try {
      const tail = Buffer.alloc(1);
      readSync(fd, tail, 0, 1, size - 1);
      if (tail[0] === 0x0a) {
        return;
      }
    } finally {
      closeSync(fd);
    }
    // Walk back to the last newline and cut there, dropping the partial line.
    const whole = readFileSync(path);
    const lastNewline = whole.lastIndexOf(0x0a);
    truncateSync(path, lastNewline + 1);
    logWarning('dropped a torn trailing line left by a previous run', { path });
  } catch (error) {
    logWarning('failed to check for a torn trailing line', { path, error: String(error) });
  }
}

export function appendSessionLog(tag: string, site: string | undefined, entry: SessionLogEntry): void {
  const dir = sessionLogDir(tag, site);
  try {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      chmodSync(dir, 0o700); // umask can narrow the mkdir mode
    }

    let segments = listSegments(dir);
    if (segments.length === 0) {
      segments = ['0000000000.jsonl'];
    }
    let active = join(dir, segments[segments.length - 1]);
    let rotated = false;

    // Rotate rather than rewrite: a rewrite at the cap would rewrite the whole log on the
    // hottest path in the process, once per appended message.
    if (existsSync(active) && statSync(active).size >= positiveEnvInt('HAPPY_SESSION_LOG_SEGMENT_BYTES', DEFAULT_SEGMENT_MAX_BYTES)) {
      const nextIndex = Number.parseInt(segments[segments.length - 1].slice(0, 10), 10) + 1;
      active = segmentPath(dir, nextIndex);
      rotated = true;
    }

    truncateTornTail(active);

    // One write of one complete line: a partial write is therefore always a partial tail.
    const fd = openSync(active, 'a', 0o600);
    try {
      writeSync(fd, `${JSON.stringify(entry)}\n`);
    } finally {
      closeSync(fd);
    }

    // After the new segment exists, so the keep-count includes it.
    if (rotated) {
      pruneToKeepSegments(dir);
    }
  } catch (error) {
    // Losing a log line must never break sending or routing.
    logWarning('failed to append', { tag, error: String(error) });
  }
}

function pruneToKeepSegments(dir: string): void {
  const segments = listSegments(dir);
  const keep = positiveEnvInt('HAPPY_SESSION_LOG_KEEP_SEGMENTS', DEFAULT_KEEP_SEGMENTS);
  for (const name of segments.slice(0, Math.max(0, segments.length - keep))) {
    try {
      unlinkSync(join(dir, name));
    } catch {
      /* ignore races */
    }
  }
}

export type SessionLogPage = {
  entries: SessionLogEntry[];
  /** Opaque position to hand back as `since` on the next read. */
  cursor: string;
  /**
   * True when `since` could not be honoured — the log was pruned past it, or the cursor was
   * malformed — so `entries` is the whole log rather than a continuation of it.
   */
  reset: boolean;
  /**
   * True when the log continues past this page. The transport cannot carry an arbitrarily long
   * log in one frame, so a read that hits the budget ends early and says so; the caller pages on
   * with `cursor` instead of assuming it now holds everything.
   */
  more: boolean;
};

/** Per read. Well under the relay's frame limit, which is what a LAN reader may be reading over. */
const DEFAULT_PAGE_MAX_BYTES = 2 * 1024 * 1024;

/** `"<segmentIndex>:<lineOffset>"`. Anything else is treated as unusable, not as "no cursor". */
function parseCursor(since: string | undefined): { segment: number; line: number } | null {
  if (since === undefined) {
    return null;
  }
  const match = /^(\d+):(\d+)$/.exec(since);
  return match ? { segment: Number(match[1]), line: Number(match[2]) } : null;
}

/** Segments are named with a zero-padded index, so lexicographic order is numeric order. */
const segmentIndexOf = (name: string): number => Number.parseInt(name.slice(0, 10), 10);

/**
 * Reads the entries written after `since`, oldest first.
 *
 * The cursor is a *position* — segment index and line offset — rather than a timestamp. `at` is a
 * local write time that NTP jumps and session resumptions move around, so it cannot order the
 * log; positions can, because segments are append-only and rotate into new files. Only whole old
 * segments are ever dropped, which is the one case `reset` reports: the caller must then read the
 * entries as the whole log instead of as a continuation.
 *
 * Stops at the first line that does not parse rather than skipping it: a torn tail is benign, but
 * a torn *middle* (delayed allocation losing a page) leaves a gap that skipping would silently
 * paper over. The cursor is left *before* the torn line so the next read picks it up again.
 *
 * Also stops at `maxBytes`, for the same reason in a different direction: the entries leave this
 * process as one frame, and a reader on the far side of the relay is on a transport with a frame
 * limit. `more` says the log continues, and the cursor is left before the entry that did not fit.
 */
export function readSessionLogSince(
  tag: string,
  site: string | undefined,
  since?: string,
  maxBytes: number = DEFAULT_PAGE_MAX_BYTES,
): SessionLogPage {
  const dir = sessionLogDir(tag, site);
  const segments = listSegments(dir);
  const cursor = parseCursor(since);
  const pruned = cursor !== null && !segments.some((name) => segmentIndexOf(name) === cursor.segment);
  const reset = (since !== undefined && cursor === null) || pruned;

  const from = reset || cursor === null ? -1 : cursor.segment;
  const skipLines = reset || cursor === null ? 0 : cursor.line;

  const entries: SessionLogEntry[] = [];
  let bytes = 0;
  let more = false;
  let lastSegment = 0;
  let lastLine = 0;

  for (const name of segments) {
    const index = segmentIndexOf(name);
    if (index < from) {
      continue;
    }
    let contents: string;
    try {
      contents = readFileSync(join(dir, name), 'utf8');
    } catch {
      break;
    }
    const skip = index === from ? skipLines : 0;
    let lineNo = 0;
    let torn = false;
    let stopped = false;
    for (const line of contents.split('\n')) {
      if (line === '') {
        continue;
      }
      lineNo += 1;
      if (lineNo <= skip) {
        continue;
      }
      // A page the transport could not carry has to end here rather than be sent and lose the
      // whole connection: a reader asking for a long session's log from the beginning would
      // otherwise build one frame of tens of megabytes. The cursor stops *before* this entry, so
      // the next read resumes at exactly this line. An entry larger than the budget still goes out
      // alone, because refusing to deliver it would stall the reader forever.
      if (entries.length > 0 && bytes + line.length + 1 > maxBytes) {
        stopped = true;
        break;
      }
      try {
        entries.push(JSON.parse(line) as SessionLogEntry);
      } catch {
        torn = true;
        break;
      }
      bytes += line.length + 1;
    }
    lastSegment = index;
    // A line that was not delivered — torn, or left for the next page — must not be stepped over,
    // so the cursor stops short of it and the next read starts there again.
    lastLine = torn || stopped ? lineNo - 1 : lineNo;
    if (torn) {
      break;
    }
    if (stopped) {
      more = true;
      break;
    }
  }

  return { entries, cursor: `${lastSegment}:${lastLine}`, reset, more };
}

/** Read every entry, oldest segment first. */
export function readSessionLog(tag: string, site: string | undefined): SessionLogEntry[] {
  return readSessionLogSince(tag, site).entries;
}

/**
 * Drops whole log directories older than `maxAgeMs`, so a machine that has run many sessions
 * does not accumulate one directory per abandoned tag forever.
 */
export function pruneSessionLogs(opts: { maxAgeMs?: number; keepDir?: string } = {}): void {
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const root = join(configuration.happyHomeDir, LOG_DIR);
  const cutoff = Date.now() - maxAgeMs;

  try {
    if (!existsSync(root)) {
      return;
    }
    for (const name of readdirSync(root)) {
      const dir = join(root, name);
      if (dir === opts.keepDir) {
        continue;
      }
      try {
        if (statSync(dir).mtimeMs < cutoff) {
          // Only whole directories are removed, so a reader never sees a half-deleted log.
          readdirSync(dir).forEach((file) => {
            try {
              unlinkSync(join(dir, file));
            } catch {
              /* ignore */
            }
          });
          unlinkSync(dir);
        }
      } catch {
        /* ignore per-entry races */
      }
    }
  } catch (error) {
    logWarning('failed to prune log directories', { error: String(error) });
  }
}
