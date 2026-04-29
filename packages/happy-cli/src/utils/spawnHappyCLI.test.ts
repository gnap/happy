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

import { getHappyCliLaunchSpec, spawnHappyCLI } from './spawnHappyCLI';

describe('spawnHappyCLI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.HAPPY_CLI_RUNTIME;
    delete process.env.HAPPY_BUN_PATH;
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

  it('returns a bun launch spec when HAPPY_CLI_RUNTIME=bun', () => {
    process.env.HAPPY_CLI_RUNTIME = 'bun';
    process.env.HAPPY_BUN_PATH = '/opt/homebrew/bin/bun';

    const spec = getHappyCliLaunchSpec();

    expect(spec).toEqual({
      runtime: 'bun',
      executable: '/opt/homebrew/bin/bun',
      argsPrefix: [expect.stringContaining('/dist/index.bun.mjs')],
      entrypoint: expect.stringContaining('/dist/index.bun.mjs'),
    });
  });

  it('spawns bun when configured via HAPPY_CLI_RUNTIME', () => {
    process.env.HAPPY_CLI_RUNTIME = 'bun';
    process.env.HAPPY_BUN_PATH = '/opt/homebrew/bin/bun';
    const child = { pid: 5678 } as any;
    mockSpawn.mockReturnValue(child);

    const result = spawnHappyCLI(['cursor', '--started-by', 'daemon'], { cwd: '/tmp/project' });

    expect(result).toBe(child);
    expect(mockSpawn).toHaveBeenCalledWith(
      '/opt/homebrew/bin/bun',
      [expect.stringContaining('/dist/index.bun.mjs'), 'cursor', '--started-by', 'daemon'],
      { cwd: '/tmp/project' },
    );
  });
});
