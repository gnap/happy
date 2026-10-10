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
import { basename, join } from 'node:path';
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

/**
 * Append one entry, returning the position *after* it — the same kind of boundary a read names, so
 * a reader that is being pushed entries can be told where the log now ends and skip a read it would
 * otherwise make just to find out that it is already up to date.
 */
export function appendSessionLog(tag: string, site: string | undefined, entry: SessionLogEntry): string | null {
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
    const line = `${JSON.stringify(entry)}\n`;
    const fd = openSync(active, 'a', 0o600);
    try {
      writeSync(fd, line);
    } finally {
      closeSync(fd);
    }

    // After the new segment exists, so the keep-count includes it.
    if (rotated) {
      pruneToKeepSegments(dir);
    }

    // The size is read back rather than assumed: a previous run may have left the segment at any
    // length, and this is the number a reader will compare its own position against.
    return `${segmentIndexOf(basename(active))}:${statSync(active).size}`;
  } catch (error) {
    // Losing a log line must never break sending or routing.
    logWarning('failed to append', { tag, error: String(error) });
    return null;
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
 * A boundary in the log: `"<segmentIndex>:<byteOffset>"`, meaning *after* that byte, so 0 is the
 * start of the segment. The same value reads in either direction — `since=S:B` is everything after
 * the boundary, `before=S:B` is everything up to it — which is what lets a page be described by its
 * two edges and nothing else.
 *
 * Bytes rather than lines because the *writer* has to be able to name a position too: it knows how
 * large the segment was when it finished appending, and nothing else. A line number would mean
 * counting the whole file on the append path.
 */
type Anchor = { segment: number; byte: number };

/** Anything that is not a pair of integers is unusable, not "no anchor". */
function parseAnchor(value: string | undefined): Anchor | null {
  if (value === undefined) {
    return null;
  }
  const match = /^(\d+):(\d+)$/.exec(value);
  return match ? { segment: Number(match[1]), byte: Number(match[2]) } : null;
}

const formatAnchor = (anchor: Anchor): string => `${anchor.segment}:${anchor.byte}`;

/** Segments are named with a zero-padded index, so lexicographic order is numeric order. */
const segmentIndexOf = (name: string): number => Number.parseInt(name.slice(0, 10), 10);

/** A segment's bytes, or null when it cannot be read. Bytes, because the anchors count bytes. */
function readSegment(dir: string, name: string): Buffer | null {
  try {
    return readFileSync(join(dir, name));
  } catch {
    return null;
  }
}

/**
 * The segment's lines with the byte range each occupies, `end` being the byte *after* its newline —
 * which is the boundary a cursor names. Empty lines are skipped so a stray newline cannot become an
 * entry.
 */
function segmentLines(buffer: Buffer): { text: string; start: number; end: number }[] {
  const lines: { text: string; start: number; end: number }[] = [];
  let start = 0;
  while (start < buffer.length) {
    const newline = buffer.indexOf(0x0a, start);
    const end = newline === -1 ? buffer.length : newline + 1;
    const text = buffer.subarray(start, newline === -1 ? buffer.length : newline).toString('utf8');
    if (text !== '') {
      lines.push({ text, start, end });
    }
    start = end;
  }
  return lines;
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
 * Either walk also stops at `maxBytes`. A page leaves this process as one frame, and a frame can be
 * too large for the transport to carry at all; `hasNewer`/`hasOlder` say whether that is why it
 * ended, so the caller knows a page was cut rather than the log running out.
 */
export function readSessionLogPage(query: SessionLogQuery): SessionLogPage {
  const maxBytes = query.maxBytes ?? DEFAULT_PAGE_MAX_BYTES;
  const dir = sessionLogDir(query.tag, query.site);
  const names = listSegments(dir);
  if (names.length === 0) {
    return { entries: [], cursor: '0:0', older: '0:0', hasNewer: false, hasOlder: false, reset: false };
  }
  const indices = names.map(segmentIndexOf);

  const since = parseAnchor(query.since);
  const pruned = since !== null && !indices.includes(since.segment);
  const reset = query.since !== undefined && (since === null || pruned);

  const before = parseAnchor(query.before);
  if (before !== null || (query.since === undefined && query.before === undefined)) {
    return readBackwards(dir, names, indices, before, maxBytes);
  }
  return readForwards(dir, names, indices, since, reset, maxBytes);
}

function readForwards(
  dir: string,
  names: string[],
  indices: number[],
  since: Anchor | null,
  reset: boolean,
  maxBytes: number,
): SessionLogPage {
  const firstIndex = indices[0];
  const from = reset || since === null ? firstIndex : since.segment;
  const fromByte = reset || since === null ? 0 : since.byte;

  const entries: SessionLogEntry[] = [];
  let bytes = 0;
  let cut = false;
  let torn = false;
  let firstLine: { segment: number; start: number } | null = null;
  let lastLine: { segment: number; end: number } | null = null;

  for (const name of names) {
    const index = segmentIndexOf(name);
    if (index < from || cut || torn) {
      continue;
    }
    const buffer = readSegment(dir, name);
    if (buffer === null) {
      break;
    }
    for (const line of segmentLines(buffer)) {
      // Only lines that *end* after the boundary: a boundary always names the end of a line, so a
      // line ending at or before it is one the reader already has.
      if (index === from && line.end <= fromByte) {
        continue;
      }
      const size = line.end - line.start;
      if (entries.length > 0 && bytes + size > maxBytes) {
        cut = true;
        break;
      }
      try {
        entries.push(JSON.parse(line.text) as SessionLogEntry);
      } catch {
        torn = true; // Torn middle: stop *before* it so the next read retries this line.
        break;
      }
      bytes += size;
      if (firstLine === null) {
        firstLine = { segment: index, start: line.start };
      }
      lastLine = { segment: index, end: line.end };
    }
  }

  // A page that began at the very start of the log has nothing before it; anything else has the
  // entries the reader already holds, which is all `hasOlder` means here.
  const startedAt = reset || since === null ? { segment: firstIndex, byte: 0 } : since;
  const anchor = lastLine
    ? formatAnchor({ segment: lastLine.segment, byte: lastLine.end })
    : formatAnchor(startedAt);
  const beganAtStart = startedAt.segment === firstIndex && startedAt.byte === 0;
  return {
    entries,
    cursor: anchor,
    older: firstLine ? formatAnchor({ segment: firstLine.segment, byte: firstLine.start }) : anchor,
    hasNewer: cut || torn,
    hasOlder: !beganAtStart && entries.length > 0,
    reset,
  };
}

function readBackwards(
  dir: string,
  names: string[],
  indices: number[],
  before: Anchor | null,
  maxBytes: number,
): SessionLogPage {
  const lastIndex = indices[indices.length - 1];
  // No boundary means the newest page: start at the end of the last segment.
  const from = before ?? { segment: lastIndex, byte: Number.MAX_SAFE_INTEGER };

  const pages: { entry: SessionLogEntry; start: number; end: number; segment: number }[] = [];
  let bytes = 0;
  let cut = false;
  let exhausted = false;

  for (let at = indices.length - 1; at >= 0 && !cut; at -= 1) {
    const index = indices[at];
    if (index > from.segment) {
      continue;
    }
    const buffer = readSegment(dir, names[at]);
    if (buffer === null) {
      break;
    }
    const limit = index === from.segment ? Math.min(from.byte, buffer.length) : buffer.length;
    const lines = segmentLines(buffer).filter((line) => line.end <= limit);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      const size = line.end - line.start;
      if (pages.length > 0 && bytes + size > maxBytes) {
        cut = true;
        break;
      }
      let entry: SessionLogEntry;
      try {
        entry = JSON.parse(line.text) as SessionLogEntry;
      } catch {
        continue; // Stepped over, not stopped at: an older page must stay reachable past it.
      }
      pages.push({ entry, start: line.start, end: line.end, segment: index });
      bytes += size;
    }
    if (!cut && at === 0) {
      exhausted = true;
    }
  }

  pages.reverse(); // Oldest first, like every other page.
  const first = pages[0];
  const last = pages[pages.length - 1];
  const anchor = last
    ? formatAnchor({ segment: last.segment, byte: last.end })
    : formatAnchor({ segment: from.segment, byte: from.byte === Number.MAX_SAFE_INTEGER ? 0 : from.byte });
  return {
    entries: pages.map((page) => page.entry),
    cursor: anchor,
    older: first ? formatAnchor({ segment: first.segment, byte: first.start }) : anchor,
    hasNewer: before !== null && hasNewerThan(dir, names, indices, from),
    hasOlder: cut || !exhausted,
    reset: false,
  };
}

/** Whether the log holds anything at or after `anchor`, for a backwards read's `hasNewer`. */
function hasNewerThan(dir: string, names: string[], indices: number[], anchor: Anchor): boolean {
  if (indices.some((index) => index > anchor.segment)) {
    return true;
  }
  const at = indices.indexOf(anchor.segment);
  if (at === -1) {
    return false;
  }
  const buffer = readSegment(dir, names[at]);
  return buffer !== null && buffer.length > anchor.byte;
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
