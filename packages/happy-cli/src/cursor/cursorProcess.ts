/**
 * CursorProcess - Spawns cursor-agent with PTY wrapper
 *
 * By default we use the `script` command (macOS/Linux) to give cursor-agent a PTY so it
 * streams output line-by-line. We spawn script (a system binary), not cursor-agent directly,
 * so this works even when the process has a minimal PATH. Set CURSOR_AGENT_NO_PTY=1 to
 * spawn cursor-agent with a plain pipe (no PTY) for debugging.
 *
 * Each user message spawns a new cursor-agent process:
 * - First message: cursor-agent --print --output-format stream-json --force "prompt"
 * - Subsequent: cursor-agent --print --output-format stream-json --force --resume <chatId> "prompt"
 */

import { execSync, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { logger } from '@/ui/logger';
import type { CursorStreamMessage } from './types';

const CURSOR_AGENT_NAME = 'cursor-agent';

export type CursorExecutionMode = 'default' | 'plan' | 'ask';

/** Resolve cursor-agent to an absolute path for use inside script's bash (so it works with minimal PATH). */
function resolveCursorAgentPath(): string {
  const envPath = process.env.CURSOR_AGENT_PATH;
  if (envPath && envPath.length > 0) {
    return envPath;
  }
  try {
    const fromWhich = execSync(`which ${CURSOR_AGENT_NAME}`, {
      encoding: 'utf8',
      env: { ...process.env, PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin' },
    }).trim();
    if (fromWhich) return fromWhich;
  } catch {
    /* which failed */
  }
  const fallbacks = ['/opt/homebrew/bin/cursor-agent', '/usr/local/bin/cursor-agent'];
  for (const p of fallbacks) {
    if (existsSync(p)) return p;
  }
  return CURSOR_AGENT_NAME;
}

export interface CursorProcessOptions {
  /** Working directory */
  cwd: string;
  /** Environment variables */
  env?: Record<string, string>;
  /** Resume a previous chat session */
  resumeChatId?: string;
  /** Model to use (e.g., 'auto', 'sonnet-4.5', 'opus-4.6-thinking') */
  model?: string;
  /** Execution mode: plan, ask, or default */
  executionMode?: CursorExecutionMode;
  /** If true, pass --force to cursor-agent */
  force?: boolean;
  /**
   * Process-level safety timeout in ms. Only kills the process if it runs longer than this.
   * Long tool calls are handled by per-tool timeout in runCursor (stop timer, continue conversation).
   * Default from CURSOR_AGENT_PROCESS_TIMEOUT_MS env or 3600000 (1 hour). Set to 0 to disable.
   */
  timeoutMs?: number;
  /** Abort signal */
  signal?: AbortSignal;
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
      '--stream-partial-output', // stream assistant/result deltas instead of only at end
      '--force',
    ];

    if (this.options.model) {
      cursorArgs.push('--model', this.options.model);
    }

    if (this.options.resumeChatId) {
      cursorArgs.push('--resume', this.options.resumeChatId);
    }

    cursorArgs.push(prompt);

    const cursorAgentPath = resolveCursorAgentPath();
    const escapedArgs = cursorArgs.map((a) => `"${a.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
    const fullCommand = `${cursorAgentPath} ${escapedArgs.join(' ')}`;

    logger.debug(`[cursor] Spawning: ${fullCommand.slice(0, 200)}...`);

    const noPty = process.env.CURSOR_AGENT_NO_PTY === '1';
    const isLinux = process.platform === 'linux';
    const env = {
      ...process.env,
      ...this.options.env,
      TERM: 'xterm-256color',
      PYTHONUNBUFFERED: '1',
      LC_ALL: 'en_US.UTF-8',
      LANG: 'en_US.UTF-8',
    };

    const spawnOptions: SpawnOptions = {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: this.options.cwd,
      env: env as Record<string, string>,
    };

    return new Promise<void>((resolve, reject) => {
      let subprocessError: Error | null = null;
      const onExit = (code: number | null) => {
        this.cleanup();
        if (this.buffer.trim()) {
          const lines = this.buffer.split('\n').map((l) => l.trim()).filter(Boolean);
          logger.debug(`[cursor] Process close: processing ${lines.length} buffered line(s), total ${this.buffer.length} chars`);
          for (const line of lines) {
            this.parseLine(line);
          }
          this.buffer = '';
        }
        logger.debug(`[cursor] Process exited with code: ${code}`);
        this.emit('exit', code);
        if (subprocessError) {
          reject(subprocessError);
        } else {
          resolve();
        }
      };

      const onAbort = (): void => {
        this.kill();
        reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
      };
      if (this.options.signal) {
        if (this.options.signal.aborted) {
          reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
          return;
        }
        this.options.signal.addEventListener('abort', onAbort, { once: true });
      }

      this.once('subprocessError', (err: Error) => {
        subprocessError = err;
      });

      const timeoutMs = this.options.timeoutMs ?? 3600000;
      if (timeoutMs > 0) {
        this.timeoutHandle = setTimeout(() => {
          logger.debug(`[cursor] Process safety timeout after ${timeoutMs}ms`);
          this.kill();
        }, timeoutMs);
      }

      let child: ChildProcess;
      if (noPty) {
        child = spawn(cursorAgentPath, cursorArgs, spawnOptions);
        logger.debug('[cursor] Spawning cursor-agent directly (no PTY)');
      } else {
        // PTY via script (same as pre-ACP): spawn script so cursor-agent runs inside a PTY; script is a system binary so spawn always works
        const scriptArgs = isLinux
          ? ['-q', '/dev/null', '-c', `/bin/bash -l -c ${JSON.stringify(fullCommand)}`]
          : ['-q', '/dev/null', '/bin/bash', '-l', '-c', fullCommand];
        const spawnCmd = isLinux ? 'stdbuf' : 'script';
        const spawnArgs = isLinux ? ['-o0', 'script', ...scriptArgs] : scriptArgs;
        child = spawn(spawnCmd, spawnArgs, spawnOptions);
        logger.debug('[cursor] Spawning cursor-agent with script (PTY)');
      }

      this.child = child;
      child.stdout?.on('data', (data: Buffer) => {
        this.processChunk(data.toString());
      });
      child.stderr?.on('data', (data: Buffer) => {
        const text = data.toString();
        if (process.env.CURSOR_AGENT_VERBOSE === '1') {
          logger.debug(`[cursor-agent stderr] ${text.trim()}`);
        } else if (!text.includes('tcgetattr') && !text.includes('ioctl')) {
          logger.debug(`[cursor] stderr: ${text.trim()}`);
        }
      });
      child.on('close', (code) => {
        if (this.options.signal) {
          this.options.signal.removeEventListener('abort', onAbort);
        }
        onExit(code);
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
        try {
          this.child?.kill('SIGKILL');
        } catch {
          /* ignore */
        }
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
      const jsonStart = trimmed.indexOf('{');
      if (jsonStart >= 0) {
        try {
          const msg = JSON.parse(trimmed.slice(jsonStart)) as CursorStreamMessage;
          this.emit('message', msg);
          return;
        } catch {
          /* fall through to log */
        }
      }
      logger.debug(`[cursor] Non-JSON line (first 200): ${trimmed.slice(0, 200)}`);
      if (/command not found|cursor-agent.*not found|not found/i.test(trimmed)) {
        this.emit('subprocessError', new Error(
          'cursor-agent not found. Install Cursor CLI on this machine (see https://docs.cursor.com) or set CURSOR_AGENT_PATH to the binary path.'
        ));
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
