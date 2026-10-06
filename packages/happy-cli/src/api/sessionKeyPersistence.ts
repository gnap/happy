/**
 * Persistence for the per-session content key.
 *
 * A `dataKey` session's content key is a random 32 bytes chosen by the client. The server
 * only ever sees it wrapped, so the CLI is the sole owner of the plaintext -- and if it is
 * only kept in memory, a process that never reaches the server (or dies before the create
 * round trip completes) loses it, taking every message it encrypted with it.
 *
 * Writing it before the network call is what lets a session that starts offline still
 * encrypt its output, and lets a later run with the same tag decrypt what it wrote.
 *
 * `legacy` sessions are deliberately NOT persisted here: their key is the account secret,
 * already stored in `access.key`, and a second copy would widen its exposure for nothing.
 *
 * Every filesystem call is wrapped, and logging is non-throwing: these functions run on the
 * synchronous send path, where an exception would drop a message rather than merely lose
 * its durability.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';

function logKeyWarning(message: string, meta: Record<string, unknown>): void {
  try {
    logger.warn(`[session-key] ${message}`, meta);
  } catch {
    /* logging must never break the send path */
  }
}

/**
 * The tag is caller-supplied and never validated (`api.ts` takes it from
 * `--resume-session-tag`), so it is hashed rather than used as a filename directly.
 * Matches the scheme used by the outbox, so a tag maps to one file in each store.
 */
export function sessionKeyPath(tag: string): string {
  const name = createHash('sha256').update(tag).digest('hex').slice(0, 32);
  return join(configuration.happyHomeDir, `session-key-${name}`);
}

export function persistSessionKey(tag: string, key: Uint8Array): void {
  const path = sessionKeyPath(tag);
  const tmp = join(configuration.happyHomeDir, `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);

  try {
    const dir = configuration.happyHomeDir;
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(tmp, Buffer.from(key).toString('base64'), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, path);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    logKeyWarning('failed to persist session key', { tag, error: String(error) });
  }
}

export function readSessionKey(tag: string): Uint8Array | null {
  const path = sessionKeyPath(tag);
  if (!existsSync(path)) {
    return null;
  }
  try {
    const key = new Uint8Array(Buffer.from(readFileSync(path, 'utf8').trim(), 'base64'));
    return key.length > 0 ? key : null;
  } catch (error) {
    logKeyWarning('failed to read session key', { tag, error: String(error) });
    return null;
  }
}
