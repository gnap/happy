/**
 * Durable storage for the outgoing session message queue.
 *
 * `ApiSessionClient.pendingOutbox` lives in memory, so a process death loses every
 * message that has not reached the server yet. This module mirrors that queue to
 * disk so a restarted CLI can resend it. Entries hold the already-encrypted payload
 * plus the `localId` the server dedupes on, so a resend is idempotent: the server's
 * `@@unique([sessionId, localId])` collapses the duplicate.
 *
 * Crash safety rests on one invariant -- the file must never hold FEWER entries than
 * memory. Extra entries on disk are harmless (they get resent and deduped); missing
 * ones are lost messages. Callers must therefore persist synchronously on enqueue,
 * and only ever persist again after the queue has shrunk.
 *
 * Every filesystem call is wrapped: a failure downgrades to in-memory-only operation
 * with a warning rather than breaking the session.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';

/**
 * These functions sit on the synchronous send path, so they must never throw -- a throw
 * would drop the message instead of merely losing its durability. That contract extends
 * to the logging in the failure handlers: this module is also loaded in test
 * environments whose logger stub implements only a subset of the interface.
 */
function logOutboxWarning(message: string, meta: Record<string, unknown>): void {
  try {
    logger.warn(`[outbox] ${message}`, meta);
  } catch {
    /* logging must never break the send path */
  }
}

export type OutboxEntry = {
  localId: string;
  /** Already-encrypted payload, as sent. Directly resendable after a restart. */
  content: string;
  /** Reserved for the per-writer counter. Not written yet -- see `OutboxState.nextN`. */
  n?: number;
};

export type OutboxState = {
  entries: OutboxEntry[];
  /**
   * Reserved high-water mark for the per-writer `n` counter. Persisted separately from
   * the entries because the counter must keep advancing even when the queue drains to
   * empty -- otherwise a restart would reissue `n` values and read as message loss.
   */
  nextN: number;
};

const OUTBOX_DIR = 'session-outbox';
const OUTBOX_FORMAT_VERSION = 1;
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The tag is caller-supplied and never validated (`api.ts` takes it straight from
 * `--resume-session-tag`), so it is hashed rather than used directly as a filename:
 * a tag containing `/` or `..` would otherwise escape the directory.
 */
export function outboxPath(tag: string): string {
  const name = createHash('sha256').update(tag).digest('hex').slice(0, 32);
  return join(configuration.happyHomeDir, OUTBOX_DIR, `${name}.json`);
}

export function loadOutbox(tag: string): OutboxState {
  const path = outboxPath(tag);
  if (!existsSync(path)) {
    return { entries: [], nextN: 0 };
  }

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { entries?: unknown };
    if (!Array.isArray(parsed.entries)) {
      return { entries: [], nextN: 0 };
    }
    const entries = parsed.entries.filter(isOutboxEntry);
    const nextN = typeof (parsed as { nextN?: unknown }).nextN === 'number' ? (parsed as { nextN: number }).nextN : 0;
    return { entries, nextN };
  } catch (error) {
    // A corrupt or partially-written file must not break session startup; the queue
    // simply starts empty. Unknown fields are ignored, which is what lets a newer
    // writer add fields (e.g. `n`) without a format migration.
    logOutboxWarning('failed to read outbox, starting empty', { tag, error: String(error) });
    return { entries: [], nextN: 0 };
  }
}

export function saveOutbox(tag: string, state: OutboxState): void {
  const path = outboxPath(tag);
  const dir = join(configuration.happyHomeDir, OUTBOX_DIR);
  const payload = JSON.stringify({
    v: OUTBOX_FORMAT_VERSION,
    tag,
    nextN: state.nextN,
    entries: state.entries,
  });
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);

  try {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(tmp, payload, 'utf8');
    renameSync(tmp, path);
  } catch (error) {
    // Losing durability is preferable to breaking the session, but it must be loud:
    // this is the failure mode where the queue silently becomes memory-only again.
    try {
      unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    logOutboxWarning('failed to persist outbox, continuing in memory', { tag, error: String(error) });
  }
}

export function deleteOutbox(tag: string): void {
  const path = outboxPath(tag);
  try {
    if (existsSync(path)) {
      unlinkSync(path);
    }
  } catch (error) {
    logOutboxWarning('failed to delete outbox', { tag, error: String(error) });
  }
}

/**
 * Drops outbox files older than `maxAgeMs`. Crashed sessions never reach `deleteOutbox`,
 * so without this they would accumulate one small file per abandoned session tag.
 * `keepPath` protects the file the caller is about to load.
 */
export function pruneOutboxes(opts: { maxAgeMs?: number; keepPath?: string } = {}): void {
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const dir = join(configuration.happyHomeDir, OUTBOX_DIR);
  const cutoff = Date.now() - maxAgeMs;

  try {
    if (!existsSync(dir)) {
      return;
    }
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) {
        continue;
      }
      const path = join(dir, name);
      if (path === opts.keepPath) {
        continue;
      }
      try {
        if (statSync(path).mtimeMs < cutoff) {
          unlinkSync(path);
        }
      } catch {
        /* ignore per-file races */
      }
    }
  } catch (error) {
    logOutboxWarning('failed to prune outbox directory', { error: String(error) });
  }
}

function isOutboxEntry(value: unknown): value is OutboxEntry {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as { localId?: unknown; content?: unknown };
  return typeof candidate.localId === 'string' && typeof candidate.content === 'string';
}
