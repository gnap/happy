/**
 * Fetch session list from server and optionally decrypt metadata to get path.
 * Used for "sessions list" and for restart-session --from-server (session not in daemon).
 */

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
  /** Path from decrypted metadata (legacy encryption only); undefined if decrypt failed or dataKey */
  path?: string;
  /** flavor from metadata (cursor/claude/etc) */
  flavor?: string;
}

function tryDecryptPath(credentials: Credentials, metadataB64: string): string | undefined {
  if (!metadataB64) return undefined;
  if (credentials.encryption.type !== 'legacy') return undefined; // dataKey would need per-session key
  try {
    const raw = Buffer.from(metadataB64, 'base64');
    const decrypted = decrypt(credentials.encryption.secret, 'legacy', new Uint8Array(raw));
    if (!decrypted || typeof decrypted !== 'object') return undefined;
    const meta = decrypted as Metadata;
    return typeof meta.path === 'string' ? meta.path : undefined;
  } catch {
    return undefined;
  }
}

function tryDecryptFlavor(credentials: Credentials, metadataB64: string): string | undefined {
  if (!metadataB64) return undefined;
  if (credentials.encryption.type !== 'legacy') return undefined;
  try {
    const raw = Buffer.from(metadataB64, 'base64');
    const decrypted = decrypt(credentials.encryption.secret, 'legacy', new Uint8Array(raw));
    if (!decrypted || typeof decrypted !== 'object') return undefined;
    const meta = decrypted as Metadata;
    return typeof meta.flavor === 'string' ? meta.flavor : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Fetch sessions from server and attach path/flavor when decryptable (legacy creds).
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
  return sessions.map((s: Record<string, unknown>) => {
    const id = String(s.id ?? '');
    const tag = String(s.tag ?? '');
    const active = Boolean(s.active);
    const activeAt = Number(s.activeAt ?? 0);
    const createdAt = Number(s.createdAt ?? 0);
    const updatedAt = Number(s.updatedAt ?? 0);
    const metadataB64 = typeof s.metadata === 'string' ? s.metadata : '';
    const path = tryDecryptPath(credentials, metadataB64);
    const flavor = tryDecryptFlavor(credentials, metadataB64);
    return { id, tag, active, activeAt, createdAt, updatedAt, path, flavor };
  });
}
