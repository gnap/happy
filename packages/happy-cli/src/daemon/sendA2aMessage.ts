import axios from 'axios';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { configuration, serverHttpsAgent } from '@/configuration';
import { encrypt, encodeBase64 } from '@/api/encryption';
import { readCredentials, readDaemonState } from '@/persistence';
import { buildA2ASubagentCardEnvelopes, wrapA2ASessionEnvelope } from '@/a2a/subagentCard';

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
    ? (await readFile(join(configuration.happyHomeDir, 'cursor-session-tag'), 'utf8')).trim()
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
    const raw = (await readFile(keyPath, 'utf8')).trim();
    if (!raw) continue;
    return new Uint8Array(Buffer.from(raw, 'base64'));
  }

  return null;
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

  const a2aCardMessages = buildA2ASubagentCardEnvelopes(text, { title: options.title }).map((envelope) => ({
    content: encodeBase64(encrypt(sessionKey, credentials.encryption.type, wrapA2ASessionEnvelope(envelope))),
    localId: envelope.id,
  }));
  const response = await axios.post(
    `${configuration.serverUrl}/v3/sessions/${encodeURIComponent(sessionId)}/messages`,
    {
      messages: [
        ...a2aCardMessages,
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
