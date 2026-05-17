import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { SessionEvent } from '@slopus/happy-wire';
import type { CursorStreamMessage } from './types';

let lastProc: any = null;

vi.mock('./cursorProcess', () => {
  const { EventEmitter } = require('node:events');
  class MockCursorProcess extends EventEmitter {
    opts: any;
    _resolve: (() => void) | null = null;
    constructor(opts: any) {
      super();
      this.opts = opts;
      lastProc = this;
    }
    async run(_prompt: string) {
      return new Promise<void>((resolve) => {
        this._resolve = resolve;
      });
    }
    kill() {}
  }
  return { CursorProcess: MockCursorProcess };
});

vi.mock('@/ui/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { runSubagent } from './runSubagent';

function feedMessages(proc: any, msgs: CursorStreamMessage[]) {
  for (const m of msgs) {
    proc.emit('message', m.type === 'assistant' && !('timestamp_ms' in m)
      ? { ...m, timestamp_ms: Date.now() }
      : m);
  }
}

function finishProcess(proc: any, code: number | null = 0) {
  proc.emit('exit', code);
  proc._resolve?.();
}

describe('runSubagent', () => {
  beforeEach(() => {
    lastProc = null;
  });

  it('emits text session events for assistant text messages', async () => {
    const events: SessionEvent[] = [];
    const promise = runSubagent({
      cwd: '/tmp/test',
      prompt: 'hello',
      onEvent: (ev) => events.push(ev),
    });

    await vi.waitFor(() => expect(lastProc).not.toBeNull());

    feedMessages(lastProc, [
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello back!' }],
        },
      },
    ]);
    finishProcess(lastProc);

    const result = await promise;
    expect(result.success).toBe(true);
    expect(result.summary).toBe('Hello back!');
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ t: 'text', text: 'Hello back!' }),
      ]),
    );
  });

  it('emits tool-call-start and tool-call-end for shell tool calls', async () => {
    const events: SessionEvent[] = [];
    const promise = runSubagent({
      cwd: '/tmp/test',
      prompt: 'run ls',
      onEvent: (ev) => events.push(ev),
    });

    await vi.waitFor(() => expect(lastProc).not.toBeNull());

    feedMessages(lastProc, [
      {
        type: 'tool_call',
        subtype: 'started',
        tool_call: {
          shellToolCall: { args: { command: 'ls -la' } },
        },
      },
      {
        type: 'tool_call',
        subtype: 'completed',
        tool_call: {
          shellToolCall: {
            args: { command: 'ls -la' },
            result: { success: { stdout: 'file1\nfile2', exitCode: 0 } },
          },
        },
      },
    ]);
    finishProcess(lastProc);

    const result = await promise;
    expect(result.success).toBe(true);

    const starts = events.filter((e) => e.t === 'tool-call-start');
    const ends = events.filter((e) => e.t === 'tool-call-end');
    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    if (starts[0].t === 'tool-call-start') {
      expect(starts[0].name).toBe('CodexBash');
      expect(starts[0].title).toContain('ls -la');
    }
  });

  it('returns failure when process exits with non-zero code', async () => {
    const events: SessionEvent[] = [];
    const promise = runSubagent({
      cwd: '/tmp/test',
      prompt: 'fail please',
      onEvent: (ev) => events.push(ev),
    });

    await vi.waitFor(() => expect(lastProc).not.toBeNull());

    feedMessages(lastProc, [
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'partial output' }],
        },
      },
    ]);
    finishProcess(lastProc, 1);

    const result = await promise;
    expect(result.success).toBe(false);
    expect(result.error).toContain('exited with code 1');
    expect(result.summary).toBe('partial output');
  });

  it('returns failure on error message from cursor-agent', async () => {
    const events: SessionEvent[] = [];
    const promise = runSubagent({
      cwd: '/tmp/test',
      prompt: 'trigger error',
      onEvent: (ev) => events.push(ev),
    });

    await vi.waitFor(() => expect(lastProc).not.toBeNull());

    feedMessages(lastProc, [
      {
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        result: 'Something went wrong',
      },
    ]);
    finishProcess(lastProc);

    const result = await promise;
    expect(result.success).toBe(false);
    expect(result.error).toBe('Something went wrong');

    const errorEvents = events.filter(
      (e) => e.t === 'service' && 'text' in e && e.text.startsWith('Error:'),
    );
    expect(errorEvents).toHaveLength(1);
  });

  it('emits thinking events with thinking flag', async () => {
    const events: SessionEvent[] = [];
    const promise = runSubagent({
      cwd: '/tmp/test',
      prompt: 'think about it',
      onEvent: (ev) => events.push(ev),
    });

    await vi.waitFor(() => expect(lastProc).not.toBeNull());

    feedMessages(lastProc, [
      { type: 'thinking', subtype: 'delta', text: 'Let me think...' },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Done thinking.' }],
        },
      },
    ]);
    finishProcess(lastProc);

    const result = await promise;
    expect(result.success).toBe(true);

    const thinkingEvents = events.filter(
      (e) => e.t === 'text' && 'thinking' in e && e.thinking,
    );
    expect(thinkingEvents).toHaveLength(1);
    if (thinkingEvents[0].t === 'text') {
      expect(thinkingEvents[0].text).toBe('Let me think...');
    }
  });

  it('maps CursorRead tool calls correctly', async () => {
    const events: SessionEvent[] = [];
    const promise = runSubagent({
      cwd: '/tmp/test',
      prompt: 'read a file',
      onEvent: (ev) => events.push(ev),
    });

    await vi.waitFor(() => expect(lastProc).not.toBeNull());

    feedMessages(lastProc, [
      {
        type: 'tool_call',
        subtype: 'started',
        tool_call: {
          readToolCall: { args: { path: '/tmp/test/foo.ts' } },
        },
      },
      {
        type: 'tool_call',
        subtype: 'completed',
        tool_call: {
          readToolCall: {
            args: { path: '/tmp/test/foo.ts' },
            result: 'file contents',
          },
        },
      },
    ]);
    finishProcess(lastProc);

    const result = await promise;
    expect(result.success).toBe(true);

    const starts = events.filter((e) => e.t === 'tool-call-start');
    expect(starts).toHaveLength(1);
    if (starts[0].t === 'tool-call-start') {
      expect(starts[0].name).toBe('Read');
      expect(starts[0].title).toBe('Read call');
    }
  });

  it('maps CursorEdit tool calls correctly', async () => {
    const events: SessionEvent[] = [];
    const promise = runSubagent({
      cwd: '/tmp/test',
      prompt: 'edit a file',
      onEvent: (ev) => events.push(ev),
    });

    await vi.waitFor(() => expect(lastProc).not.toBeNull());

    feedMessages(lastProc, [
      {
        type: 'tool_call',
        subtype: 'started',
        tool_call: {
          editToolCall: {
            args: { path: '/tmp/foo.ts', old_string: 'a', new_string: 'b' },
          },
        },
      },
      {
        type: 'tool_call',
        subtype: 'completed',
        tool_call: {
          editToolCall: {
            args: { path: '/tmp/foo.ts', old_string: 'a', new_string: 'b' },
            result: { success: true },
          },
        },
      },
    ]);
    finishProcess(lastProc);

    const result = await promise;
    expect(result.success).toBe(true);

    const starts = events.filter((e) => e.t === 'tool-call-start');
    expect(starts).toHaveLength(1);
    if (starts[0].t === 'tool-call-start') {
      expect(starts[0].name).toBe('Edit');
    }
  });

  it('maps CursorWrite tool calls correctly', async () => {
    const events: SessionEvent[] = [];
    const promise = runSubagent({
      cwd: '/tmp/test',
      prompt: 'write a file',
      onEvent: (ev) => events.push(ev),
    });

    await vi.waitFor(() => expect(lastProc).not.toBeNull());

    feedMessages(lastProc, [
      {
        type: 'tool_call',
        subtype: 'started',
        tool_call: {
          writeToolCall: { args: { path: '/tmp/foo.ts', content: 'hello' } },
        },
      },
      {
        type: 'tool_call',
        subtype: 'completed',
        tool_call: {
          writeToolCall: {
            args: { path: '/tmp/foo.ts', content: 'hello' },
            result: { success: true },
          },
        },
      },
    ]);
    finishProcess(lastProc);

    const result = await promise;
    expect(result.success).toBe(true);

    const starts = events.filter((e) => e.t === 'tool-call-start');
    expect(starts).toHaveLength(1);
    if (starts[0].t === 'tool-call-start') {
      expect(starts[0].name).toBe('Write');
    }
  });

  it('passes correct options to CursorProcess', async () => {
    const events: SessionEvent[] = [];
    const promise = runSubagent({
      cwd: '/workspace',
      prompt: 'do stuff',
      model: 'opus-4.6-thinking',
      executionMode: 'plan',
      force: true,
      timeoutMs: 120_000,
      onEvent: (ev) => events.push(ev),
    });

    await vi.waitFor(() => expect(lastProc).not.toBeNull());

    expect(lastProc.opts).toMatchObject({
      cwd: '/workspace',
      model: 'opus-4.6-thinking',
      executionMode: 'plan',
      force: true,
      timeoutMs: 120_000,
    });

    finishProcess(lastProc);
    await promise;
  });

  it('returns summary truncated to 1000 chars on success', async () => {
    const events: SessionEvent[] = [];
    const longText = 'x'.repeat(2000);
    const promise = runSubagent({
      cwd: '/tmp/test',
      prompt: 'long output',
      onEvent: (ev) => events.push(ev),
    });

    await vi.waitFor(() => expect(lastProc).not.toBeNull());

    feedMessages(lastProc, [
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: longText }],
        },
      },
    ]);
    finishProcess(lastProc);

    const result = await promise;
    expect(result.success).toBe(true);
    expect(result.summary).toHaveLength(1000);
  });

  it('handles process error event gracefully', async () => {
    const events: SessionEvent[] = [];
    const promise = runSubagent({
      cwd: '/tmp/test',
      prompt: 'crash',
      onEvent: (ev) => events.push(ev),
    });

    await vi.waitFor(() => expect(lastProc).not.toBeNull());

    lastProc.emit('error', new Error('ENOENT: cursor-agent not found'));

    const result = await promise;
    expect(result.success).toBe(false);
    expect(result.error).toContain('cursor-agent not found');
  });

  it('ignores session_init, task_started, task_complete in session events', async () => {
    const events: SessionEvent[] = [];
    const promise = runSubagent({
      cwd: '/tmp/test',
      prompt: 'lifecycle',
      onEvent: (ev) => events.push(ev),
    });

    await vi.waitFor(() => expect(lastProc).not.toBeNull());

    feedMessages(lastProc, [
      { type: 'system', subtype: 'init', session_id: 'sess-123', model: 'auto' },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Done.' }],
        },
      },
      { type: 'result', subtype: 'success', session_id: 'sess-123' },
    ]);
    finishProcess(lastProc);

    const result = await promise;
    expect(result.success).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ t: 'text', text: 'Done.' });
  });
});
