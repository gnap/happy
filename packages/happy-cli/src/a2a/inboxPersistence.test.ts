import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const mockHappyHome = vi.hoisted(() => ({ path: '/tmp/happy-test-home' }));

vi.mock('@/configuration', () => ({
  configuration: {
    get happyHomeDir() {
      return mockHappyHome.path;
    },
  },
}));

import { upsertA2AInboxMessage } from './inbox';
import { loadLocalA2AInbox, saveLocalA2AInbox } from './inboxPersistence';

describe('inboxPersistence', () => {
  let happyHome: string;

  beforeEach(() => {
    happyHome = mkdtempSync(join(tmpdir(), 'happy-home-'));
    mockHappyHome.path = happyHome;
  });

  afterEach(() => {
    rmSync(happyHome, { recursive: true, force: true });
  });

  it('round-trips inbox rows on disk', () => {
    const sessionId = 'sess-persist';
    let inbox = upsertA2AInboxMessage(undefined, { id: 'm1', text: 'hello', createdAt: 42 });
    saveLocalA2AInbox(sessionId, inbox);

    const loaded = loadLocalA2AInbox(sessionId);
    expect(loaded.messages).toEqual([
      expect.objectContaining({ id: 'm1', text: 'hello', createdAt: 42 }),
    ]);
    expect(existsSync(join(happyHome, 'a2a-inbox-state', `${sessionId}.json`))).toBe(true);
  });
});
