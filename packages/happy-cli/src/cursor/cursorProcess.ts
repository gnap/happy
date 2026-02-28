/**
 * CursorProcess - Spawns cursor-agent with a PTY wrapper
 *
 * cursor-agent requires a TTY to produce output. We use the `script` command
 * to create a pseudo-TTY (tested on macOS; Linux has `script` but args may differ).
 *
 * Each user message spawns a new cursor-agent process:
 * - First message: cursor-agent --print --output-format stream-json --force "prompt"
 * - Subsequent: cursor-agent --print --output-format stream-json --force --resume <chatId> "prompt"
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { logger } from '@/ui/logger';
import type { CursorStreamMessage } from './types';

const CURSOR_AGENT_BIN = process.env.CURSOR_AGENT_PATH || 'cursor-agent';

/** Execution mode aligned with cursor-agent: --mode plan | ask, or default (no flag) */
export type CursorExecutionMode = 'default' | 'plan' | 'ask';

export interface CursorProcessOptions {
  /** Working directory */
  cwd: string;
  /** Environment variables */
  env?: Record<string, string>;
  /** Resume a previous chat session */
  resumeChatId?: string;
  /** Model to use (e.g., 'auto', 'opus-4.6-thinking', 'gpt-5.3-codex-high') */
  model?: string;
  /** Execution mode: plan (--mode plan), ask (--mode ask), or default (no --mode) */
  executionMode?: CursorExecutionMode;
  /** If true, pass -f/--force to cursor-agent (force allow commands) */
  force?: boolean;
  /**
   * Process-level safety timeout in ms. Only kills the process if it runs longer than this.
   * Long tool calls are handled by per-tool timeout in runCursor (stop timer, continue conversation).
   * Default from CURSOR_AGENT_PROCESS_TIMEOUT_MS env or 3600000 (1 hour). Set to 0 to disable.
   */
  timeoutMs?: number;
  /** Abort signal */
  signal?: AbortSignal;
  /** If true, pass --approve-mcps so cursor-agent loads MCPs from .cursor/mcp.json without prompting */
  approveMcps?: boolean;
}

export interface CursorProcessEvents {
  message: (msg: CursorStreamMessage) => void;
  error: (err: Error) => void;
  exit: (code: number | null) => void;
  subprocessError: (err: Error) => void;
}

/**
 * Manages a single cursor-agent invocation with PTY wrapping.
 */
export class CursorProcess extends EventEmitter {
  private child: ChildProcess | null = null;
  private buffer = '';
  private killed = false;
  private timeoutHandle: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: CursorProcessOptions) {
    super();
  }

  /**
   * Spawn cursor-agent and send a prompt. Returns when the process exits.
   */
  async run(prompt: string): Promise<void> {
    const cursorArgs = [
      '--print',
      '--output-format', 'stream-json',
      '--trust',  // Non-interactive: avoid "Workspace Trust Required" prompt (user already chose this dir in Happy)
    ];

    if (this.options.executionMode === 'plan') {
      cursorArgs.push('--mode', 'plan');
    } else if (this.options.executionMode === 'ask') {
      cursorArgs.push('--mode', 'ask');
    }
    if (this.options.force) {
      cursorArgs.push('--force');
    }

    if (this.options.model) {
      cursorArgs.push('--model', this.options.model);
    }

    if (this.options.resumeChatId) {
      cursorArgs.push('--resume', this.options.resumeChatId);
    }
    if (this.options.approveMcps) {
      cursorArgs.push('--approve-mcps');
    }
    // Ensure cursor-agent reads .cursor/mcp.json from our workspace (where we wrote Happy MCP URL)
    cursorArgs.push('--workspace', this.options.cwd);

    cursorArgs.push(prompt);

    // Build the full command string for script wrapper
    const escapedArgs = cursorArgs.map(a => `"${a.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
    const fullCommand = `${CURSOR_AGENT_BIN} ${escapedArgs.join(' ')}`;

    logger.debug(`[cursor] Spawning: ${fullCommand.slice(0, 200)}...`);

    // Use script + bash for PTY. Use login shell (-l) so .profile/.bash_profile
    // is sourced and PATH includes ~/.local/bin (where cursor-agent is often installed).
    // macOS script: script -q /dev/null command [args]
    // Linux script: script -q /dev/null -c command
    // On Linux when stdout is a pipe, script buffers output; wrap with stdbuf -o0 so we get stream-json lines promptly.
    const isLinux = process.platform === 'linux';
    const scriptArgs = isLinux
      ? ['-q', '/dev/null', '-c', `${'/bin/bash'} -l -c ${JSON.stringify(fullCommand)}`]
      : ['-q', '/dev/null', '/bin/bash', '-l', '-c', fullCommand];

    const spawnCmd = isLinux ? 'stdbuf' : 'script';
    const spawnArgs = isLinux ? ['-o0', 'script', ...scriptArgs] : scriptArgs;

    return new Promise<void>((resolve, reject) => {
      let subprocessError: Error | null = null;
      const child = spawn(spawnCmd, spawnArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: this.options.cwd,
        env: {
          ...process.env,
          ...this.options.env,
          TERM: 'xterm-256color',
        },
      });
      this.child = child;

      // Handle abort signal
      if (this.options.signal) {
        const onAbort = () => {
          this.kill();
          reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
        };
        if (this.options.signal.aborted) {
          child.kill('SIGTERM');
          reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
          return;
        }
        this.options.signal.addEventListener('abort', onAbort, { once: true });
        child.on('close', () => {
          this.options.signal!.removeEventListener('abort', onAbort);
        });
      }

      // Safety-only process timeout (default 1h); per-tool timeout in runCursor stops UI timer without killing process
      const timeoutMs = this.options.timeoutMs ?? 3600000;
      if (timeoutMs > 0) {
        this.timeoutHandle = setTimeout(() => {
          logger.debug(`[cursor] Process safety timeout after ${timeoutMs}ms`);
          this.kill();
        }, timeoutMs);
      }

      child.stdout?.on('data', (data: Buffer) => {
        this.processChunk(data.toString());
      });

      child.stderr?.on('data', (data: Buffer) => {
        const text = data.toString();
        // Filter out script command noise
        if (!text.includes('tcgetattr') && !text.includes('ioctl')) {
          logger.debug(`[cursor] stderr: ${text.trim()}`);
        }
      });

      this.once('subprocessError', (err: Error) => {
        subprocessError = err;
      });

      child.on('close', (code) => {
        this.cleanup();
        // Process remaining buffer
        if (this.buffer.trim()) {
          this.parseLine(this.buffer);
          this.buffer = '';
        }
        logger.debug(`[cursor] cursor-agent process exited with code: ${code}`);
        this.emit('exit', code);
        if (subprocessError) {
          reject(subprocessError);
        } else {
          resolve();
        }
      });

      child.on('error', (err) => {
        this.cleanup();
        this.emit('error', err);
        reject(err);
      });
    });
  }

  /**
   * Kill the running process.
   */
  kill(): void {
    if (this.killed || !this.child) return;
    this.killed = true;
    this.cleanup();
    try {
      this.child.kill('SIGTERM');
      setTimeout(() => {
        try { this.child?.kill('SIGKILL'); } catch { /* ignore */ }
      }, 3000);
    } catch {
      /* ignore */
    }
  }

  private cleanup(): void {
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
  }

  private processChunk(text: string): void {
    this.buffer += text;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      this.parseLine(line);
    }
  }

  private parseLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    // Filter out shell/script noise
    if (isShellNoise(trimmed)) return;

    try {
      const msg = JSON.parse(trimmed) as CursorStreamMessage;
      this.emit('message', msg);
    } catch {
      // Not JSON - could be shell error (e.g. command not found)
      logger.debug(`[cursor] Non-JSON stdout line: ${trimmed.slice(0, 150)}`);
      if (/command not found|cursor-agent.*not found|not found/i.test(trimmed)) {
        const err = new Error(
          'cursor-agent not found. Install Cursor CLI on this machine (see https://docs.cursor.com) or set CURSOR_AGENT_PATH to the binary path.'
        );
        logger.debug(`[cursor] ${err.message}`);
        this.emit('subprocessError', err);
      }
    }
  }
}

/**
 * Filter out shell prompt and script command artifacts.
 */
function isShellNoise(line: string): boolean {
  return /^\s*\$\s+/.test(line)
    || /^\s*>>?\s*/.test(line)
    || /^Script /.test(line)
    || /^Welcome to /.test(line)
    || /^Type help /.test(line)
    || /^\w+@\w+/.test(line)
    || /^\(process \d+\)/.test(line);
}
