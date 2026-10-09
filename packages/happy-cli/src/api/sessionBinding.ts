/**
 * Persistence for what the server told us about a session the last time it answered.
 *
 * A session's identity is split in two. The tag, writer site and content key are the CLI's own and
 * exist from the first instant. The server-assigned `id` (and the stored metadata / agentState with
 * their versions) are the server's, and only reach us by asking it. Starting every session by
 * waiting on that answer makes one slow server stall channels that never needed it: the daemon
 * cannot map the id to the tag, so the LAN reports 404, and nothing runs.
 *
 * Remembering the last answer breaks the dependency for every restart after the first. The id is
 * stable for a tag, and the versions are optimistic-concurrency tokens that heal themselves (a stale
 * one gets `version-mismatch` back with the current value), so a stale copy is safe to start from.
 * What is NOT safe to start from is the seq cursor: "resume from now" is a fact only the server
 * knows, so it is deliberately not stored here -- the caller holds server ingest until it has it.
 *
 * Metadata and agentState are stored as the ciphertext the server returned, never decrypted, so
 * this file is no more revealing than the key file beside it. Every filesystem call is wrapped:
 * a cache that cannot be read or written must degrade to "start the old way", never to a crash.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';

export type SessionBinding = {
  /** Server-assigned id. Stable for a (server, account, tag). */
  id: string;
  /** Ciphertext as returned by the server, base64. */
  metadata: string;
  metadataVersion: number;
  agentState: string | null;
  agentStateVersion: number;
};

/**
 * Keyed by server as well as tag: the same tag against another server is a different session with
 * a different id, and serving the first one's id there would address a session that does not exist.
 */
export function sessionBindingPath(tag: string): string {
  const name = createHash('sha256').update(`${configuration.serverUrl}\n${tag}`).digest('hex').slice(0, 32);
  return join(configuration.happyHomeDir, `session-binding-${name}.json`);
}

export function saveSessionBinding(tag: string, binding: SessionBinding): void {
  const path = sessionBindingPath(tag);
  const tmp = join(configuration.happyHomeDir, `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  try {
    if (!existsSync(configuration.happyHomeDir)) {
      mkdirSync(configuration.happyHomeDir, { recursive: true });
    }
    writeFileSync(tmp, JSON.stringify(binding), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, path);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    logger.warn('[session-binding] failed to persist', { tag, error: String(error) });
  }
}

export function loadSessionBinding(tag: string): SessionBinding | null {
  const path = sessionBindingPath(tag);
  if (!existsSync(path)) {
    return null;
  }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<SessionBinding>;
    const valid = typeof raw.id === 'string' && raw.id.length > 0
      && typeof raw.metadata === 'string'
      && typeof raw.metadataVersion === 'number'
      && (raw.agentState === null || typeof raw.agentState === 'string')
      && typeof raw.agentStateVersion === 'number';
    return valid ? (raw as SessionBinding) : null;
  } catch (error) {
    logger.warn('[session-binding] failed to read', { tag, error: String(error) });
    return null;
  }
}
