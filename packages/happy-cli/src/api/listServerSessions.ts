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
 *     keys (typically a few hundred at most). The scan does not stop at the
 *     first hit: if the same dataKey is cached under more than one tag filename
 *     (a corruption mode), several distinct tags decrypt the same row and the
 *     recovered tag is ambiguous — we then flag the row `tagReliable: false`
 *     and withhold the guessed tag so callers won't resume the wrong session.
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
  /**
   * Whether `tag` reliably identifies this session. True when the server
   * returned the tag directly, or exactly one cached dataKey could decrypt the
   * row. False when the recovered tag was ambiguous — the same dataKey lives
   * under more than one tag filename, so we cannot tell which session it is.
   * Callers that resume by tag (e.g. restart-session fallback) MUST refuse to
   * act on an unreliable tag to avoid attaching to the wrong session.
   */
  tagReliable: boolean;
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
  /**
   * Whether `recoveredTag` can be trusted to identify the session. True for
   * legacy rows and for dataKey rows where exactly one distinct tag could
   * decrypt the bundle. False when two or more different tags decrypt it
   * (a dataKey duplicated across tag files): the recovered tag is then a guess
   * and `recoveredTag` is left undefined.
   */
  tagReliable: boolean;
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
      return meta ? { metadata: meta, tagReliable: true } : null;
    }

    // dataKey: prefer the per-tag file when the server told us the tag.
    if (tag) {
      const keyed = loadByTag(tag);
      if (keyed) {
        const meta = tryDecrypt(bundle, keyed, 'dataKey');
        if (meta) return { metadata: meta, recoveredTag: tag, tagReliable: true };
      }
    }

    // Fallback: server omitted the tag (or its named key file is missing).
    // Brute-force every locally cached per-session key. AES-GCM rejects wrong
    // keys cleanly, so any key that decrypts genuinely holds the right dataKey.
    // We must NOT return on first hit: if a dataKey is duplicated across several
    // tag files (a known corruption mode), more than one *distinct* tag will
    // decrypt this row and the recovered tag is then ambiguous — picking one
    // would attach a caller to the wrong session. Scan all, collect distinct
    // tags, and only trust the result when exactly one tag matched.
    const matchingTags = new Set<string | null>();
    let firstMeta: Metadata | null = null;
    for (const candidate of loadAllDataKeys()) {
      const meta = tryDecrypt(bundle, candidate.key, 'dataKey');
      if (meta) {
        if (!firstMeta) firstMeta = meta;
        matchingTags.add(candidate.tag);
      }
    }
    if (!firstMeta) return null;
    if (matchingTags.size === 1) {
      const only = [...matchingTags][0];
      return { metadata: firstMeta, recoveredTag: only ?? undefined, tagReliable: true };
    }
    return { metadata: firstMeta, recoveredTag: undefined, tagReliable: false };
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
    const tagReliable = serverTag ? true : (decoded?.tagReliable ?? false);
    const path = typeof decoded?.metadata.path === 'string' ? decoded.metadata.path : undefined;
    const flavor = typeof decoded?.metadata.flavor === 'string' ? decoded.metadata.flavor : undefined;
    return { id, tag, active, activeAt, createdAt, updatedAt, path, flavor, tagReliable };
  });
}
