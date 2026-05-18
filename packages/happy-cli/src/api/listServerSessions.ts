/**
 * Fetch session list from server and decrypt metadata to expose path/flavor.
 * Used for `happy sessions list` and the restart-session fallback when the
 * daemon has lost the session in its in-memory map.
 *
 * Encryption families:
 *
 *   - **legacy**: a single shared symmetric key in `credentials.encryption.secret`
 *     decrypts every session's metadata directly.
 *
 *   - **dataKey**: per-session keys cached on disk as
 *     `~/.happy/{cursor,claude}-session-key-<tag>`. We need the right key per
 *     session to decrypt. The server's `/v1/sessions` response often does not
 *     include the session `tag`, so we can't always look the key up by name —
 *     in that case we brute-force every locally-cached per-session key. AES-GCM
 *     auth tags make wrong-key decryption return null cleanly, so there are no
 *     false positives, and the work scales with the number of locally cached
 *     keys (typically a few hundred at most).
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import axios from 'axios';
import { Credentials } from '@/persistence';
import { configuration, serverHttpsAgent } from '@/configuration';
import { decrypt } from './encryption';
import type { Metadata } from './types';

export interface ServerSessionRow {
  id: string;
  tag: string;
  active: boolean;
  activeAt: number;
  createdAt: number;
  updatedAt: number;
  /** Path from decrypted metadata; undefined if no key could decrypt this row. */
  path?: string;
  /** Flavor from decrypted metadata (cursor/claude/etc). */
  flavor?: string;
}

const SESSION_KEY_PREFIXES = ['cursor', 'claude'] as const;
const SESSION_KEY_FILENAME_RE = /^(cursor|claude)-session-key-(.+)$/;

function readKeyFile(path: string): Uint8Array | null {
  try {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, 'utf8').trim();
    if (!raw) return null;
    const key = new Uint8Array(Buffer.from(raw, 'base64'));
    return key.length > 0 ? key : null;
  } catch {
    return null;
  }
}

function tryDecrypt(bundle: Uint8Array, key: Uint8Array, variant: 'legacy' | 'dataKey'): Metadata | null {
  try {
    const out = decrypt(key, variant, bundle);
    if (!out || typeof out !== 'object') return null;
    return out as Metadata;
  } catch {
    return null;
  }
}

interface DecryptedRow {
  metadata: Metadata;
  /**
   * Tag recovered alongside the metadata. For dataKey rows we may have learned
   * the tag from the per-session key filename even when the server omitted it,
   * so callers can use it to re-attach to the same session on resume.
   */
  recoveredTag?: string;
}

/** Per-session key with the tag recovered from its filename (null for the un-suffixed file). */
interface CachedSessionKey {
  key: Uint8Array;
  tag: string | null;
}

/**
 * Build a decryption helper closing over the credentials. Lazily loads
 * per-session keys from disk and memoizes them across the whole listing call,
 * so a brute-force scan happens at most once per `listServerSessions()` invocation.
 */
function makeMetadataDecryptor(credentials: Credentials) {
  const home = configuration.happyHomeDir;
  const byTag = new Map<string, Uint8Array>();
  let allDataKeys: CachedSessionKey[] | null = null;

  function loadByTag(tag: string): Uint8Array | null {
    const cached = byTag.get(tag);
    if (cached) return cached;
    for (const prefix of SESSION_KEY_PREFIXES) {
      const key = readKeyFile(join(home, `${prefix}-session-key-${tag}`));
      if (key) {
        byTag.set(tag, key);
        return key;
      }
    }
    return null;
  }

  function loadAllDataKeys(): CachedSessionKey[] {
    if (allDataKeys) return allDataKeys;
    const out: CachedSessionKey[] = [];
    try {
      if (existsSync(home)) {
        for (const file of readdirSync(home)) {
          const match = SESSION_KEY_FILENAME_RE.exec(file);
          if (!match) continue;
          const key = readKeyFile(join(home, file));
          if (!key) continue;
          // match[2] is the tag captured from `(cursor|claude)-session-key-(.+)`.
          out.push({ key, tag: match[2] || null });
        }
      }
    } catch {
      // Best-effort scan; missing/unreadable home dir means no fallback keys.
    }
    allDataKeys = out;
    return out;
  }

  return function decryptMetadata(tag: string, metadataB64: string): DecryptedRow | null {
    if (!metadataB64) return null;
    let bundle: Uint8Array;
    try {
      bundle = new Uint8Array(Buffer.from(metadataB64, 'base64'));
    } catch {
      return null;
    }

    if (credentials.encryption.type === 'legacy') {
      const meta = tryDecrypt(bundle, credentials.encryption.secret, 'legacy');
      return meta ? { metadata: meta } : null;
    }

    // dataKey: prefer the per-tag file when the server told us the tag.
    if (tag) {
      const keyed = loadByTag(tag);
      if (keyed) {
        const meta = tryDecrypt(bundle, keyed, 'dataKey');
        if (meta) return { metadata: meta, recoveredTag: tag };
      }
    }

    // Fallback: server omitted the tag (or its named key file is missing).
    // Brute-force every locally cached per-session key. AES-GCM rejects wrong
    // keys cleanly, so there are no false positives. When a key matches we
    // recover the original tag from the file name so the caller can resume the
    // session under its real tag instead of minting a new one.
    for (const candidate of loadAllDataKeys()) {
      const meta = tryDecrypt(bundle, candidate.key, 'dataKey');
      if (meta) {
        return {
          metadata: meta,
          recoveredTag: candidate.tag ?? undefined,
        };
      }
    }
    return null;
  };
}

/**
 * Fetch sessions from server and decrypt metadata where possible.
 */
export async function listServerSessions(credentials: Credentials): Promise<ServerSessionRow[]> {
  const { data } = await axios.get<{ sessions: Array<Record<string, unknown>> }>(
    `${configuration.serverUrl}/v1/sessions`,
    {
      headers: { Authorization: `Bearer ${credentials.token}` },
      httpsAgent: serverHttpsAgent,
    }
  );
  const sessions = data.sessions ?? [];
  const decryptMetadata = makeMetadataDecryptor(credentials);

  return sessions.map((s: Record<string, unknown>) => {
    const id = String(s.id ?? '');
    const serverTag = typeof s.tag === 'string' ? s.tag : '';
    const active = Boolean(s.active);
    const activeAt = Number(s.activeAt ?? 0);
    const createdAt = Number(s.createdAt ?? 0);
    const updatedAt = Number(s.updatedAt ?? 0);
    const metadataB64 = typeof s.metadata === 'string' ? s.metadata : '';
    const decoded = decryptMetadata(serverTag, metadataB64);
    // Prefer the tag the server already returned. If absent (server omits it
    // for dataKey list responses), surface the tag we recovered from the
    // matching per-session key file — callers (e.g. restart-session fallback)
    // need it to resume the same session instead of forging a new one.
    const tag = serverTag || decoded?.recoveredTag || '';
    const path = typeof decoded?.metadata.path === 'string' ? decoded.metadata.path : undefined;
    const flavor = typeof decoded?.metadata.flavor === 'string' ? decoded.metadata.flavor : undefined;
    return { id, tag, active, activeAt, createdAt, updatedAt, path, flavor };
  });
}
