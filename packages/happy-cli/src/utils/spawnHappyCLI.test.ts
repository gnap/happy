import { describe, expect, it, vi, beforeEach } from 'vitest';

const { mockSpawn, mockExistsSync } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockExistsSync: vi.fn(() => true),
}));

vi.mock('child_process', () => ({
  spawn: mockSpawn,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: mockExistsSync,
  };
});

import { spawnHappyCLI } from './spawnHappyCLI';

describe('spawnHappyCLI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('spawns the current node executable instead of a bare node command', () => {
    const child = { pid: 1234 } as any;
    mockSpawn.mockReturnValue(child);

    const result = spawnHappyCLI(['daemon', 'start'], { cwd: '/tmp' });

    expect(result).toBe(child);
    expect(mockSpawn).toHaveBeenCalledWith(
      process.execPath,
      ['--no-warnings', '--no-deprecation', expect.stringContaining('/dist/index.mjs'), 'daemon', 'start'],
      { cwd: '/tmp' },
    );
  });
});
