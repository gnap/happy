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
  /** Oldest first, always — whichever direction the page was read in. */
  entries: SessionLogEntry[];
  /** Boundary after the last entry. Hand back as `since` to continue forward. */
  cursor: string;
  /** Boundary before the first entry. Hand back as `before` to read older. */
  older: string;
  /** There are entries after this page. */
  hasNewer: boolean;
  /** There are entries before this page. */
  hasOlder: boolean;
  /**
   * True when `since` could not be honoured — the log was pruned past it, or it was malformed —
   * so `entries` is the log from its start rather than a continuation. Only a forward read can
   * report it: a reader walking backwards is at the log's beginning, which `hasOlder` says.
   */
  reset: boolean;
};

/**
 * How much one page may weigh. Sized for the *reader*, not for the log: a page travels over the
 * LAN or, worse, over the relay to a phone on cellular, and a reader that cannot finish a page
 * re-reads it forever. Small enough that one page is a short transfer, large enough that a long
 * log is not thousands of round trips.
 */
const DEFAULT_PAGE_MAX_BYTES = 1024 * 1024;

/**
 * A boundary in the log: `"<segmentIndex>:<lineOffset>"` means *after* that line, so line 0 is the
 * start of the segment. The same value reads in either direction — `since=S:L` is everything after
 * that boundary, `before=S:L` is everything up to it — which is what lets a page be described by
 * its two edges and nothing else.
 */
type Anchor = { segment: number; line: number };

/** Anything that is not a pair of integers is unusable, not "no anchor". */
function parseAnchor(value: string | undefined): Anchor | null {
  if (value === undefined) {
    return null;
  }
  const match = /^(\d+):(\d+)$/.exec(value);
  return match ? { segment: Number(match[1]), line: Number(match[2]) } : null;
}

const formatAnchor = (anchor: Anchor): string => `${anchor.segment}:${anchor.line}`;

/** Segments are named with a zero-padded index, so lexicographic order is numeric order. */
const segmentIndexOf = (name: string): number => Number.parseInt(name.slice(0, 10), 10);

/** The non-empty lines of a segment, in order — index 0 is line 1 of the anchor encoding. */
function readSegmentLines(dir: string, name: string): string[] | null {
  let contents: string;
  try {
    contents = readFileSync(join(dir, name), 'utf8');
  } catch {
    return null;
  }
  return contents.split('\n').filter((line) => line !== '');
}

export type SessionLogQuery = {
  tag: string;
  site: string | undefined;
  /** Read the entries after this boundary. */
  since?: string;
  /** Read the entries up to this boundary. Omit both to read the newest page. */
  before?: string;
  maxBytes?: number;
};

/**
 * Reads one page of a session's log.
 *
 * The anchor is a *position* — segment index and line offset — rather than a timestamp. `at` is a
 * local write time that NTP jumps and session resumptions move around, so it cannot order the
 * log; positions can, because segments are append-only and rotate into new files. Only whole old
 * segments are ever dropped, which is what `reset` reports to a forward reader: it must then treat
 * the page as the whole log instead of a continuation.
 *
 * Three reads, and they are the same walk in different directions:
 *
 * - `since` — everything after a boundary. This is following a session that is already open.
 * - `before` — everything up to a boundary. This is scrolling back.
 * - neither — the newest page, which is what a reader that has just opened a session wants: a
 *   reader that starts from its last position instead has to carry every entry written while it
 *   was away before it can show anything recent, and on a long session that never finishes.
 *
 * Going forward, reading stops at the first line that does not parse rather than skipping it: a
 * torn tail is benign, but a torn *middle* (delayed allocation losing a page) leaves a gap that
 * skipping would silently paper over, and the cursor is left before it so the next read retries.
 * Going backwards the same line has to be stepped over instead — stopping there would make every
 * older page unreachable — and the page simply does not contain it.
 *
 * Either walk also stops at `maxBytes`. A page leaves this process as one frame, and a frame can
 * be too large for the transport to carry at all; `hasNewer`/`hasOlder` say whether that is why it
 * ended, so the caller knows a page was cut rather than the log running out.
 */
export function readSessionLogPage(query: SessionLogQuery): SessionLogPage {
  const maxBytes = query.maxBytes ?? DEFAULT_PAGE_MAX_BYTES;
  const dir = sessionLogDir(query.tag, query.site);
  const names = listSegments(dir);
  if (names.length === 0) {
    return { entries: [], cursor: '0:0', older: '0:0', hasNewer: false, hasOlder: false, reset: false };
  }

  const since = parseAnchor(query.since);
  const pruned = since !== null && !names.some((name) => segmentIndexOf(name) === since.segment);
  const reset = query.since !== undefined && (since === null || pruned);

  const before = parseAnchor(query.before);
  if (before !== null || (query.since === undefined && query.before === undefined)) {
    return readPage(dir, names, { backwards: true, before, reset, maxBytes });
  }
  return readPage(dir, names, { backwards: false, since, reset, maxBytes });
}

function readPage(
  dir: string,
  names: string[],
  options:
    | { backwards: true; before: Anchor | null; reset: boolean; maxBytes: number }
    | { backwards: false; since: Anchor | null; reset: boolean; maxBytes: number },
): SessionLogPage {
  const indices = names.map(segmentIndexOf);
  const firstIndex = indices[0];
  const lastIndex = indices[indices.length - 1];

  // Collected newest-last either way, so the page is ordered the same whichever way it was read.
  const pages: { entry: SessionLogEntry; segment: number; line: number }[] = [];
  let bytes = 0;
  let cut = false;

  if (!options.backwards) {
    const from = options.reset || options.since === null ? firstIndex : options.since.segment;
    const skip = options.reset || options.since === null ? 0 : options.since.line;
    let started = false;
    let torn = false;
    for (let i = 0; i < names.length && !cut && !torn; i += 1) {
      const index = indices[i];
      if (index < from) {
        continue;
      }
      const lines = readSegmentLines(dir, names[i]);
      if (lines === null) {
        break;
      }
      const skipHere = index === from ? skip : 0;
      for (let line = skipHere; line < lines.length; line += 1) {
        const size = lines[line].length + 1;
        if (pages.length > 0 && bytes + size > options.maxBytes) {
          cut = true;
          break;
        }
        let entry: SessionLogEntry;
        try {
          entry = JSON.parse(lines[line]) as SessionLogEntry;
        } catch {
          torn = true; // Torn middle: stop *before* it so the next read retries this line.
          break;
        }
        pages.push({ entry, segment: index, line: line + 1 });
        bytes += size;
        started = true;
      }
    }
    const first = pages[0];
    const last = pages[pages.length - 1];
    // A page that began at the very start of the log has nothing before it; anything else has the
    // entries the reader already holds, which is all `hasOlder` means here.
    const beganAtStart = (options.reset || options.since === null) ||
      (options.since.segment === firstIndex && options.since.line === 0);
    return {
      entries: pages.map((p) => p.entry),
      cursor: last ? formatAnchor({ segment: last.segment, line: last.line }) : formatAnchor(options.reset || options.since === null ? { segment: firstIndex, line: 0 } : options.since),
      older: first ? formatAnchor({ segment: first.segment, line: first.line - 1 }) : formatAnchor(options.reset || options.since === null ? { segment: firstIndex, line: 0 } : options.since),
      hasNewer: cut || torn,
      hasOlder: !beganAtStart && started,
      reset: options.reset,
    };
  }

  // Backwards: from the boundary down to the start of the log, newest lines first.
  const from = options.before ?? { segment: lastIndex, line: Number.MAX_SAFE_INTEGER };
  const newest = options.before === null;
  let exhausted = true;
  for (let i = indices.length - 1; i >= 0 && !cut; i -= 1) {
    const index = indices[i];
    if (index > from.segment) {
      continue;
    }
    const lines = readSegmentLines(dir, names[i]);
    if (lines === null) {
      exhausted = false;
      break;
    }
    const limit = index === from.segment ? Math.min(from.line, lines.length) : lines.length;
    for (let line = limit; line >= 1; line -= 1) {
      const size = lines[line - 1].length + 1;
      if (pages.length > 0 && bytes + size > options.maxBytes) {
        cut = true;
        break;
      }
      let entry: SessionLogEntry;
      try {
        entry = JSON.parse(lines[line - 1]) as SessionLogEntry;
      } catch {
        continue; // Stepped over, not stopped at: an older page must stay reachable past it.
      }
      pages.push({ entry, segment: index, line });
      bytes += size;
    }
    if (!cut && i === 0) {
      exhausted = true;
    }
  }

  pages.reverse(); // Oldest first, like every other page.
  const first = pages[0];
  const last = pages[pages.length - 1];
  // Anything at or after the boundary is newer than this page. The segment we were pointed into
  // tells us for free whether it has lines past it; if it ends there, a later segment would.
  const newerInAnchorSegment = !newest && linesPastBoundary(dir, names, indices, from);
  return {
    entries: pages.map((p) => p.entry),
    cursor: last ? formatAnchor({ segment: last.segment, line: last.line }) : formatAnchor(from),
    older: first ? formatAnchor({ segment: first.segment, line: first.line - 1 }) : formatAnchor(from),
    hasNewer: newest ? false : newerInAnchorSegment,
    hasOlder: cut || !exhausted,
    reset: false,
  };
}

/** Whether the log has a line at or after `anchor`, without reading past the segment it names. */
function linesPastBoundary(dir: string, names: string[], indices: number[], anchor: Anchor): boolean {
  if (indices.some((index) => index > anchor.segment)) {
    return true;
  }
  const at = names.findIndex((name) => segmentIndexOf(name) === anchor.segment);
  if (at === -1) {
    return false;
  }
  const lines = readSegmentLines(dir, names[at]);
  return lines !== null && lines.length > anchor.line;
}

/**
 * Read every entry, oldest segment first. Unbounded on purpose: this is the whole-log form, used
 * by tests and by callers that want the file rather than a view of it — a reader that is talking to
 * a client over a transport must page instead, which is what `readSessionLogPage` is for.
 */
export function readSessionLog(tag: string, site: string | undefined): SessionLogEntry[] {
  return readSessionLogPage({ tag, site, since: '0:0', maxBytes: Number.MAX_SAFE_INTEGER }).entries;
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
