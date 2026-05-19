import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { A2AInboxMessage, A2AInboxState } from '@/api/types';
import { configuration } from '@/configuration';
import { cloneA2AInboxState, pruneA2AInboxState } from './inbox';

export function localA2AInboxPath(sessionId: string): string {
  return join(configuration.happyHomeDir, 'a2a-inbox-state', `${sessionId}.json`);
}

export function loadLocalA2AInbox(sessionId: string): A2AInboxState {
  const path = localA2AInboxPath(sessionId);
  if (!existsSync(path)) {
    return { messages: [] };
  }

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { messages?: A2AInboxMessage[] };
    if (!Array.isArray(parsed.messages)) {
      return { messages: [] };
    }
    return pruneA2AInboxState({ messages: parsed.messages });
  } catch {
    return { messages: [] };
  }
}

export function saveLocalA2AInbox(sessionId: string, inbox: A2AInboxState): void {
  const dir = join(configuration.happyHomeDir, 'a2a-inbox-state');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const pruned = pruneA2AInboxState(inbox);
  writeFileSync(localA2AInboxPath(sessionId), JSON.stringify(pruned), 'utf8');
}
