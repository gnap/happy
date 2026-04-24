import axios from 'axios';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { configuration, serverHttpsAgent } from '@/configuration';
import { encrypt, encodeBase64 } from '@/api/encryption';
import { readCredentials, readDaemonState } from '@/persistence';

async function readCursorSessionKey(sessionId: string): Promise<Uint8Array | null> {
  const state = await readDaemonState();
  const tag = state?.lastSessionTagBySessionId?.[sessionId]
    ?? state?.lastSessionTagByDirectory?.[state?.lastDirectoryBySessionId?.[sessionId] ?? '']
    ?? (existsSync(join(configuration.happyHomeDir, 'cursor-session-tag'))
      ? (await readFile(join(configuration.happyHomeDir, 'cursor-session-tag'), 'utf8')).trim()
      : '');

  const keyCandidates = [
    tag ? join(configuration.happyHomeDir, `cursor-session-key-${tag}`) : null,
    join(configuration.happyHomeDir, 'cursor-session-key'),
  ].filter((v): v is string => !!v);

  for (const keyPath of keyCandidates) {
    if (!existsSync(keyPath)) continue;
    const raw = (await readFile(keyPath, 'utf8')).trim();
    if (!raw) continue;
    return new Uint8Array(Buffer.from(raw, 'base64'));
  }

  return null;
}

export async function sendA2aMessage(sessionId: string, text: string): Promise<{ success: boolean; error?: string; messageId?: string; seq?: number }> {
  const credentials = await readCredentials();
  if (!credentials) {
    return { success: false, error: 'No CLI credentials found' };
  }

  const sessionKey = await readCursorSessionKey(sessionId);
  if (!sessionKey) {
    return { success: false, error: `No cursor session key found for ${sessionId}` };
  }

  const record = {
    role: 'user',
    parts: [{ type: 'text', text }],
    meta: {
      sentFrom: 'cli',
      origin: 'a2a',
    },
  };

  const encrypted = encodeBase64(encrypt(sessionKey, credentials.encryption.type, record));
  const response = await axios.post(
    `${configuration.serverUrl}/v3/sessions/${encodeURIComponent(sessionId)}/messages`,
    {
      messages: [
        {
          content: encrypted,
          localId: randomUUID(),
        },
      ],
    },
    {
      headers: {
        Authorization: `Bearer ${credentials.token}`,
        'Content-Type': 'application/json',
      },
      httpsAgent: serverHttpsAgent,
      timeout: 120000,
    },
  );

  const message = Array.isArray(response.data?.messages) ? response.data.messages[0] : null;
  return {
    success: true,
    messageId: message?.id,
    seq: message?.seq,
  };
}
