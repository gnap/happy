import { describe, it, expect } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { delay } from '@/utils/time'
import { nextRetryDelayMs, startFileWatcher } from './startFileWatcher'

describe('nextRetryDelayMs', () => {
  it('backs off from a second to a half-minute ceiling', () => {
    expect(nextRetryDelayMs(0)).toBe(1_000);
    expect(nextRetryDelayMs(1)).toBe(2_000);
    expect(nextRetryDelayMs(4)).toBe(16_000);
    expect(nextRetryDelayMs(5)).toBe(30_000);
    // And stays there however long the file stays missing.
    expect(nextRetryDelayMs(50)).toBe(30_000);
  });

  it('never decreases as failures accumulate', () => {
    for (let failures = 0; failures < 20; failures += 1) {
      expect(nextRetryDelayMs(failures + 1)).toBeGreaterThanOrEqual(nextRetryDelayMs(failures));
    }
  });
});

describe('startFileWatcher', () => {
  it('attaches to a file that appears after the watcher started', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'file-watcher-'));
    const file = join(dir, 'session.jsonl');
    let changes = 0;
    const stop = startFileWatcher(file, () => { changes += 1; });

    try {
      // The first attempt fails because there is nothing to watch yet, so the retry is what
      // attaches. Keep writing until the watch is in place and reports one of the writes --
      // events from before it attached are not delivered.
      const deadline = Date.now() + 10_000;
      while (changes === 0 && Date.now() < deadline) {
        await writeFile(file, 'x');
        await delay(250);
      }
      expect(changes).toBeGreaterThan(0);
    } finally {
      stop();
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
