import { beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import { EventEmitter } from 'node:events';

const mocks = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
  mockSpawn: vi.fn(),
  mockExecFile: vi.fn(),
  mockExecSync: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: mocks.mockExistsSync,
  };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: mocks.mockSpawn,
    execFile: mocks.mockExecFile,
    execSync: mocks.mockExecSync,
  };
});

import {
  buildCursorArgs,
  buildCursorPtySpawn,
  CursorProcess,
  formatCursorCliErrorLine,
  isCursorCliErrorLine,
  resolveCursorAgentPath,
} from './cursorProcess';

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

describe('buildCursorArgs', () => {
  it('omits --print and --trust for interactive slash commands', () => {
    const args = buildCursorArgs({
      cwd: '/workspace',
      resumeChatId: 'chat-123',
      model: 'auto',
      force: true,
      approveMcps: true,
    }, true);

    expect(args).toEqual(expect.arrayContaining([
      '--force',
      '--model',
      'auto',
      '--resume',
      'chat-123',
      '--approve-mcps',
      '--workspace',
      '/workspace',
    ]));
    expect(args).not.toContain('--output-format');
    expect(args).not.toContain('--stream-partial-output');
    expect(args).not.toContain('--print');
    expect(args).not.toContain('--trust');
  });

  it('keeps --print and --trust for normal headless turns', () => {
    const args = buildCursorArgs({
      cwd: '/workspace',
      force: true,
    }, false);

    expect(args).toEqual(expect.arrayContaining([
      '--print',
      '--output-format',
      'stream-json',
      '--stream-partial-output',
      '--trust',
      '--force',
    ]));
  });
});

describe('cursor CLI error lines', () => {
  it('detects unpaid invoice billing errors', () => {
    const line = 'S: You have an unpaid invoice Your team has an unpaid invoice. Please contact your team administrator to pay your invoice and continue using Cursor.';
    expect(isCursorCliErrorLine(line)).toBe(true);
    const formatted = formatCursorCliErrorLine(line);
    expect(formatted).toContain('unpaid invoice');
    expect(formatted).toContain('pay your invoice');
    expect(formatted.startsWith('S:')).toBe(false);
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

describe('CursorProcess interactive command', () => {
  it('waits for interactive readiness before sending /compress and resolves on ready', async () => {
    vi.useFakeTimers();
    try {
      const child = new EventEmitter() as EventEmitter & {
        stdin: { write: ReturnType<typeof vi.fn> };
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: ReturnType<typeof vi.fn>;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = {
        write: vi.fn(() => {
          const callIndex = (child.stdin.write as ReturnType<typeof vi.fn>).mock.calls.length;
          if (callIndex === 1) {
            queueMicrotask(() => child.stdout.emit('data', Buffer.from('Add a follow-up\n')));
          } else if (callIndex === 2) {
            queueMicrotask(() => child.emit('close', 0));
          }
          return true;
        }),
      };
      child.kill = vi.fn(() => true);

      mocks.mockSpawn.mockReturnValue(child);
      mocks.mockExistsSync.mockImplementation((candidate) => candidate === '/usr/bin/cursor-agent');

      const proc = new CursorProcess({ cwd: '/workspace' });
      const runPromise = proc.runInteractiveCommand('/compress', {
        completionMode: 'compress',
        postCommandIdleMs: 60_000,
        postCommandMaxMs: 0,
      });

      child.stdout.emit('data', Buffer.from('Loading conversation...\n'));
      await vi.advanceTimersByTimeAsync(0);
      expect(child.stdin.write).not.toHaveBeenCalled();

      child.stdout.emit('data', Buffer.from('Rendering latest messages. Use /full-conversation to render everything\n'));
      await vi.advanceTimersByTimeAsync(0);
      expect(child.stdin.write).toHaveBeenNthCalledWith(1, '/compress\n');

      child.stdout.emit('data', Buffer.from('Context compressed successfully.\nAdd a follow-up\n'));
      await vi.advanceTimersByTimeAsync(0);
      await expect(runPromise).resolves.toEqual({ outcome: 'completed' });
      expect(child.stdin.write).toHaveBeenCalledWith('/exit\n');

      expect(mocks.mockSpawn).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails compress turn on post-command idle without completion signal', async () => {
    vi.useFakeTimers();
    try {
      const child = new EventEmitter() as EventEmitter & {
        stdin: { write: ReturnType<typeof vi.fn> };
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: ReturnType<typeof vi.fn>;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { write: vi.fn(() => true) };
      child.kill = vi.fn(() => {
        queueMicrotask(() => child.emit('close', 0));
        return true;
      });

      mocks.mockSpawn.mockReturnValue(child);
      mocks.mockExistsSync.mockImplementation((candidate) => candidate === '/usr/bin/cursor-agent');

      const proc = new CursorProcess({ cwd: '/workspace' });
      const runPromise = proc.runInteractiveCommand('/compress', {
        completionMode: 'compress',
        postCommandIdleMs: 5_000,
        postCommandMaxMs: 0,
      });

      child.stdout.emit('data', Buffer.from('Rendering latest messages\n'));
      await vi.advanceTimersByTimeAsync(0);
      expect(child.stdin.write).toHaveBeenCalledWith('/compress\n');

      await vi.advanceTimersByTimeAsync(5_000);
      await expect(runPromise).resolves.toEqual({
        outcome: 'timed_out',
        detail: 'No compression completion signal after 5000ms idle',
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
