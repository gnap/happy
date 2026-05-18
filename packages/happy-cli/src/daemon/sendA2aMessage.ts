import axios from 'axios';
import { existsSync } from 'node:fs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configuration, serverHttpsAgent } from '@/configuration';
import { encrypt, encodeBase64 } from '@/api/encryption';
import { readCredentials, readDaemonState } from '@/persistence';

type SendA2AOptions = {
  title?: string;
};

function getSessionKeyPrefix(agent?: string): 'cursor' | 'claude' | null {
  if (!agent) return null;
  if (agent === 'claude') return 'claude';
  if (agent === 'cursor' || agent === 'cursor-acp' || agent === 'acp-cursor') return 'cursor';
  return null;
}

async function readSessionKey(sessionId: string): Promise<Uint8Array | null> {
  const state = await readDaemonState();
  const agent = state?.lastAgentBySessionId?.[sessionId];
  const knownPrefix = getSessionKeyPrefix(agent);
  const cursorTagFallback = existsSync(join(configuration.happyHomeDir, 'cursor-session-tag'))
    ? readFileSync(join(configuration.happyHomeDir, 'cursor-session-tag'), 'utf8').trim()
    : '';
  const tag = state?.lastSessionTagBySessionId?.[sessionId]
    ?? state?.lastSessionTagByDirectory?.[state?.lastDirectoryBySessionId?.[sessionId] ?? '']
    ?? (knownPrefix !== 'claude' ? cursorTagFallback : '');
  const keyPrefixes = (() => {
    if (knownPrefix) return [knownPrefix];
    // Fall back to both known agent key families for older daemon state.
    return ['cursor', 'claude'] as const;
  })();

  const keyCandidates = keyPrefixes.flatMap((prefix) => [
    tag ? join(configuration.happyHomeDir, `${prefix}-session-key-${tag}`) : null,
    join(configuration.happyHomeDir, `${prefix}-session-key`),
  ]).filter((v): v is string => !!v);

  for (const keyPath of keyCandidates) {
    if (!existsSync(keyPath)) continue;
    const raw = readFileSync(keyPath, 'utf8').trim();
    if (!raw) continue;
    return new Uint8Array(Buffer.from(raw, 'base64'));
  }

  return null;
}

function normalizeA2AText(text: string, maxLength: number = 120): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function buildA2ATriggerText(title: string | undefined, text: string): string {
  const heading = 'A2A inbox (1 unread).';
  const summaryTitle = title?.trim() || 'message';
  const summary = normalizeA2AText(text);
  return `${heading} 1. ${summaryTitle}: ${summary}`;
}

export async function sendA2aMessage(sessionId: string, text: string, options: SendA2AOptions = {}): Promise<{ success: boolean; error?: string; messageId?: string; seq?: number }> {
  const credentials = await readCredentials();
  if (!credentials) {
    return { success: false, error: 'No CLI credentials found' };
  }

  const sessionKey = await readSessionKey(sessionId);
  if (!sessionKey) {
    const state = await readDaemonState();
    const agent = state?.lastAgentBySessionId?.[sessionId];
    return {
      success: false,
      error: `No session key found for ${sessionId}${agent ? ` (agent=${agent})` : ''}`,
    };
  }

  const inboxDir = join(configuration.happyHomeDir, 'a2a-inbox');
  mkdirSync(inboxDir, { recursive: true });
  const snapshotPath = join(inboxDir, `${sessionId}-${Date.now()}.json`);
  const snapshot = {
    sessionId,
    title: options.title?.trim() || 'A2A inbox (1 unread)',
    unreadCount: 1,
    messages: [{
      title: options.title?.trim() || null,
      text,
      preview: normalizeA2AText(text),
      createdAt: Date.now(),
    }],
  };
  writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2), 'utf8');

  const triggerText = `${buildA2ATriggerText(options.title, text)} Snapshot: ${snapshotPath}`;
  const localId = `${sessionId}-${Date.now()}`;
  const triggerMessage = {
    role: 'user' as const,
    localKey: localId,
    content: { type: 'text' as const, text: triggerText },
    meta: {
      sentFrom: 'cli',
      origin: 'a2a' as const,
      a2aTrigger: true,
    },
    a2aInboxMessage: {
      title: options.title?.trim() || null,
      text,
      createdAt: Date.now(),
    },
  };
  const response = await axios.post(
    `${configuration.serverUrl}/v3/sessions/${encodeURIComponent(sessionId)}/messages`,
    {
      messages: [
        {
          content: encodeBase64(encrypt(sessionKey, credentials.encryption.type, triggerMessage)),
          localId,
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

  const messages = Array.isArray(response.data?.messages) ? response.data.messages : [];
  const message = messages[messages.length - 1] ?? null;
  return {
    success: true,
    messageId: message?.id,
    seq: message?.seq,
  };
}
