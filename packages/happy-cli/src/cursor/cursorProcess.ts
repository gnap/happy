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

export interface CursorProcessOptions {
  /** Working directory */
  cwd: string;
  /** Environment variables */
  env?: Record<string, string>;
  /** Resume a previous chat session */
  resumeChatId?: string;
  /** Model to use (e.g., 'auto', 'sonnet-4.5', 'opus-4.6-thinking') */
  model?: string;
  /** Timeout in ms (default: 300000 = 5 min) */
  timeoutMs?: number;
  /** Abort signal */
  signal?: AbortSignal;
}

export interface CursorProcessEvents {
  message: (msg: CursorStreamMessage) => void;
  error: (err: Error) => void;
  exit: (code: number | null) => void;
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
      '--force',
    ];

    if (this.options.model) {
      cursorArgs.push('--model', this.options.model);
    }

    if (this.options.resumeChatId) {
      cursorArgs.push('--resume', this.options.resumeChatId);
    }

    cursorArgs.push(prompt);

    // Build the full command string for script wrapper
    const escapedArgs = cursorArgs.map(a => `"${a.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
    const fullCommand = `${CURSOR_AGENT_BIN} ${escapedArgs.join(' ')}`;

    logger.debug(`[cursor] Spawning: ${fullCommand.slice(0, 200)}...`);

    // Use macOS `script` command to provide a PTY
    const scriptArgs = ['-q', '/dev/null', '/bin/bash', '-c', fullCommand];

    return new Promise<void>((resolve, reject) => {
      const child = spawn('script', scriptArgs, {
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

      // Timeout
      const timeoutMs = this.options.timeoutMs ?? 300000;
      this.timeoutHandle = setTimeout(() => {
        logger.debug(`[cursor] Timeout after ${timeoutMs}ms`);
        this.kill();
      }, timeoutMs);

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

      child.on('close', (code) => {
        this.cleanup();
        // Process remaining buffer
        if (this.buffer.trim()) {
          this.parseLine(this.buffer);
          this.buffer = '';
        }
        logger.debug(`[cursor] Process exited with code: ${code}`);
        this.emit('exit', code);
        resolve();
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
      // Not JSON - could be ANSI escape sequences or other noise from PTY
      logger.debug(`[cursor] Non-JSON line: ${trimmed.slice(0, 100)}`);
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
