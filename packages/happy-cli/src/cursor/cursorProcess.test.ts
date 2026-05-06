import { beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';

const mocks = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: mocks.mockExistsSync,
  };
});

import { buildCursorPtySpawn, resolveCursorAgentPath } from './cursorProcess';

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.CURSOR_AGENT_PATH;
  mocks.mockExistsSync.mockReset();
});

describe('buildCursorPtySpawn', () => {
  it('passes the prompt as argv on macOS PTY runs', () => {
    const prompt = "-start\ncontains `backticks` and $(subshell)";
    const spec = buildCursorPtySpawn('/opt/homebrew/bin/cursor-agent', ['--print', '--', prompt], false);

    expect(spec.command).toBe('script');
    expect(spec.args).toEqual([
      '-q',
      '/dev/null',
      '/bin/bash',
      '-l',
      '-c',
      'exec "$0" "$@"',
      '/opt/homebrew/bin/cursor-agent',
      '--print',
      '--',
      prompt,
    ]);
  });

  it('shell-escapes each argv part on Linux PTY runs', () => {
    const prompt = "-start\ncontains `backticks` and 'quotes'";
    const spec = buildCursorPtySpawn('/usr/local/bin/cursor-agent', ['--print', '--', prompt], true);

    expect(spec.command).toBe('stdbuf');
    expect(spec.args.slice(0, 5)).toEqual(['-o0', 'script', '-q', '-e', '-c']);
    expect(spec.args[5]).toContain(`'/usr/local/bin/cursor-agent' '--print' '--' '-start
contains \`backticks\` and '\\''quotes'\\'''`);
    expect(spec.args[5]).toContain(`'/bin/bash' '-l' '-c' 'exec "$0" "$@"'`);
    expect(spec.args[6]).toBe('/dev/null');
  });
});

describe('resolveCursorAgentPath', () => {
  it('prefers CURSOR_AGENT_PATH when provided', () => {
    process.env.CURSOR_AGENT_PATH = '/custom/bin/cursor-agent';

    expect(resolveCursorAgentPath()).toBe('/custom/bin/cursor-agent');
  });

  it('prefers ~/.local/bin/cursor-agent before PATH lookup', () => {
    const localBin = `${os.homedir()}/.local/bin/cursor-agent`;
    mocks.mockExistsSync.mockImplementation((candidate) => candidate === localBin);

    expect(resolveCursorAgentPath()).toBe(localBin);
  });
});
