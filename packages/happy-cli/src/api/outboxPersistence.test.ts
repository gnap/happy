import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const state = vi.hoisted(() => ({ happyHome: '/tmp/happy-test-home', failTmpWrite: false }));

vi.mock('@/configuration', () => ({
  configuration: {
    get happyHomeDir() {
      return state.happyHome;
    },
  },
}));

vi.mock('@/ui/logger', () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

// Fail only writes to the temp file, so the initial state of a real file is preserved
// and we can assert the caller never observes a partially written outbox.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeFileSync: (path: Parameters<typeof actual.writeFileSync>[0], data: Parameters<typeof actual.writeFileSync>[1], opts?: Parameters<typeof actual.writeFileSync>[2]) => {
      if (state.failTmpWrite && String(path).endsWith('.tmp')) {
        throw new Error('ENOSPC: no space left on device');
      }
      return actual.writeFileSync(path, data, opts as never);
    },
  };
});

import { loadOutbox, outboxPath, pruneOutboxes, saveOutbox } from './outboxPersistence';

const TAG = 'tag-round-trip';
const dirFor = (home: string) => join(home, 'session-outbox');

describe('outboxPersistence', () => {
  let happyHome: string;

  beforeEach(() => {
    happyHome = mkdtempSync(join(tmpdir(), 'happy-outbox-'));
    state.happyHome = happyHome;
    state.failTmpWrite = false;
  });

  afterEach(() => {
    rmSync(happyHome, { recursive: true, force: true });
  });

  it('loads an empty queue when no file exists', () => {
    expect(loadOutbox(TAG)).toEqual({ entries: [], nextN: 0 });
  });

  it('round-trips entries byte-identically', () => {
    const entries = [
      { localId: 'local-1', content: 'BASE64+/=one' },
      { localId: 'local-2', content: 'BASE64+/=two' },
    ];
    saveOutbox(TAG, { entries, nextN: 0 });

    const loaded = loadOutbox(TAG);
    expect(loaded.entries).toEqual(entries);
    expect(loaded.entries[0].content).toBe('BASE64+/=one');
  });

  it('tolerates a corrupt file without throwing', () => {
    const path = outboxPath(TAG);
    saveOutbox(TAG, { entries: [{ localId: 'x', content: 'y' }], nextN: 0 });
    writeFileSync(path, '{not json', 'utf8');

    expect(() => loadOutbox(TAG)).not.toThrow();
    expect(loadOutbox(TAG)).toEqual({ entries: [], nextN: 0 });
  });

  it('ignores unknown fields and malformed entries, preserving the reserved n slot', () => {
    const path = outboxPath(TAG);
    saveOutbox(TAG, { entries: [], nextN: 0 });
    writeFileSync(
      path,
      JSON.stringify({
        v: 1,
        tag: TAG,
        nextN: 7,
        futureField: 'ignored',
        entries: [
          { localId: 'keep', content: 'c', n: 3 },
          { localId: 'no-content' },
          'not-an-object',
        ],
      }),
      'utf8'
    );

    const loaded = loadOutbox(TAG);
    expect(loaded.entries).toEqual([{ localId: 'keep', content: 'c', n: 3 }]);
    expect(loaded.nextN).toBe(7);
  });

  it('keeps the previous file intact and leaves no temp file when the write fails', () => {
    saveOutbox(TAG, { entries: [{ localId: 'original', content: 'keep-me' }], nextN: 0 });

    state.failTmpWrite = true;
    saveOutbox(TAG, { entries: [{ localId: 'replacement', content: 'should-not-land' }], nextN: 0 });

    expect(loadOutbox(TAG).entries).toEqual([{ localId: 'original', content: 'keep-me' }]);
    expect(readdirSync(dirFor(happyHome)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('hashes the tag so path separators cannot escape the directory', () => {
    saveOutbox('../../etc/evil', { entries: [{ localId: 'a', content: 'b' }], nextN: 0 });

    const files = readdirSync(dirFor(happyHome));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[0-9a-f]{32}\.json$/);
    expect(existsSync(join(happyHome, '..', 'etc'))).toBe(false);
  });

  it('prunes stale files while protecting the one being loaded', () => {
    const stale = 'tag-stale';
    saveOutbox(stale, { entries: [{ localId: 'a', content: 'b' }], nextN: 0 });
    saveOutbox(TAG, { entries: [{ localId: 'c', content: 'd' }], nextN: 0 });

    const old = Date.now() / 1000 - 8 * 24 * 60 * 60;
    utimesSync(outboxPath(stale), old, old);

    pruneOutboxes({ maxAgeMs: 7 * 24 * 60 * 60 * 1000, keepPath: outboxPath(TAG) });

    expect(existsSync(outboxPath(stale))).toBe(false);
    expect(existsSync(outboxPath(TAG))).toBe(true);
    expect(loadOutbox(TAG).entries).toEqual([{ localId: 'c', content: 'd' }]);
  });
});
