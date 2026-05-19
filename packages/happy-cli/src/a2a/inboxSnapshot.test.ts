import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { writeFileSync, existsSync, readdirSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pruneA2AInboxSnapshots } from './inboxSnapshot';

describe('pruneA2AInboxSnapshots', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'happy-a2a-snap-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps only the newest N snapshot files per session', () => {
    const sessionId = 'sess1';
    for (let i = 0; i < 8; i++) {
      const path = join(dir, `${sessionId}-turn-${i}.json`);
      writeFileSync(path, '{}');
      const mtime = new Date(Date.now() - (8 - i) * 1000);
      utimesSync(path, mtime, mtime);
    }
    pruneA2AInboxSnapshots(dir, sessionId, { keepLatest: 3, maxAgeMs: 365 * 24 * 60 * 60 * 1000 });
    const remaining = readdirSync(dir).filter((name) => name.startsWith(`${sessionId}-`));
    expect(remaining).toHaveLength(3);
  });

  it('does not delete other sessions snapshots', () => {
    writeFileSync(join(dir, 'sess1-a.json'), '{}');
    writeFileSync(join(dir, 'sess2-a.json'), '{}');
    pruneA2AInboxSnapshots(dir, 'sess1', { keepLatest: 0, maxAgeMs: 365 * 24 * 60 * 60 * 1000 });
    expect(existsSync(join(dir, 'sess2-a.json'))).toBe(true);
    expect(existsSync(join(dir, 'sess1-a.json'))).toBe(false);
  });
});
