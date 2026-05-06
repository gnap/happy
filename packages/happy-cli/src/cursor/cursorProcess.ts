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

import { execFile, execSync, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { logger } from '@/ui/logger';
import type { CursorStreamMessage } from './types';

const CURSOR_AGENT_NAME = 'cursor-agent';
const PTY_BASH_EXEC_COMMAND = 'exec "$0" "$@"';

function shellEscapePosix(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function buildCursorPtySpawn(
  cursorAgentPath: string,
  cursorArgs: string[],
  isLinux: boolean,
): { command: string; args: string[] } {
  if (isLinux) {
    const linuxCommand = [
      '/bin/bash',
      '-l',
      '-c',
      PTY_BASH_EXEC_COMMAND,
      cursorAgentPath,
      ...cursorArgs,
    ].map(shellEscapePosix).join(' ');

    return {
      command: 'stdbuf',
      args: ['-o0', 'script', '-q', '-e', '-c', linuxCommand, '/dev/null'],
    };
  }

  return {
    command: 'script',
    args: ['-q', '/dev/null', '/bin/bash', '-l', '-c', PTY_BASH_EXEC_COMMAND, cursorAgentPath, ...cursorArgs],
  };
}

export type CursorExecutionMode = 'default' | 'plan' | 'ask';

/** Resolve cursor-agent to an absolute path for use inside script's bash (so it works with minimal PATH). */
export function resolveCursorAgentPath(): string {
  const envPath = process.env.CURSOR_AGENT_PATH;
  if (envPath && envPath.length > 0) {
    return envPath;
  }
  const home = homedir();
  const preferred = [
    join(home, '.local/bin/cursor-agent'),
    '/opt/homebrew/bin/cursor-agent',
    '/usr/local/bin/cursor-agent',
    '/usr/bin/cursor-agent',
  ];
  for (const candidate of preferred) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  try {
    const fromWhich = execSync(`which ${CURSOR_AGENT_NAME}`, {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: [
          join(home, '.local/bin'),
          process.env.PATH || '/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin',
        ].filter(Boolean).join(':'),
      },
    }).trim();
    if (fromWhich) return fromWhich;
  } catch {
    /* which failed */
  }
  const fallbacks = ['/opt/homebrew/bin/cursor-agent', '/usr/local/bin/cursor-agent', '/usr/bin/cursor-agent'];
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
  /** If true, pass --approve-mcps and --workspace so cursor-agent loads MCPs from .cursor/mcp.json */
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
      '--stream-partial-output', // stream assistant/result deltas instead of only at end
      '--trust', // Non-interactive: avoid "Workspace Trust Required" prompt
    ];

    if (this.options.executionMode === 'plan') {
      cursorArgs.push('--mode', 'plan');
    } else if (this.options.executionMode === 'ask') {
      cursorArgs.push('--mode', 'ask');
    }
    // Default force to true when unspecified so ACP path (CursorBackend) keeps --force
    if (this.options.force !== false) {
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
      cursorArgs.push('--workspace', this.options.cwd);
      logger.debug('[cursor] MCP: --approve-mcps enabled so Happy loads from .cursor/mcp.json');
    }

    cursorArgs.push('--', prompt);

    const cursorAgentPath = resolveCursorAgentPath();
    logger.debug(`[cursor] Spawning: ${[cursorAgentPath, ...cursorArgs].join(' ').slice(0, 200)}...`);

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
        const ptySpawn = buildCursorPtySpawn(cursorAgentPath, cursorArgs, isLinux);
        child = spawn(ptySpawn.command, ptySpawn.args, spawnOptions);
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
      // Some provider errors or other messages are printed as plain text on stdout/stderr.
      // Convert obvious provider error lines into a synthetic result message so the parser
      // maps them into a session-level error event that will be sent to the App.
      const providerErrorRegex = /provider error|We're having trouble connecting to the model provider|Provider Error/i;
      if (providerErrorRegex.test(trimmed)) {
        const synthetic: CursorStreamMessage = {
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          result: trimmed.slice(0, 1000),
        } as unknown as CursorStreamMessage;
        this.emit('message', synthetic);
        return;
      }
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

export interface CursorModelInfo {
  code: string;
  value: string;
}

export interface CursorModelsResult {
  models: CursorModelInfo[];
  /** The currently selected model ID ('current' marker), falls back to 'default' marker, then 'auto' */
  currentModelId: string;
}

/**
 * Query available models from cursor-agent by running `cursor-agent models`.
 * Returns null on failure (e.g. cursor-agent not installed, network error).
 */
export function fetchCursorModels(timeoutMs = 10_000): Promise<CursorModelsResult | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      logger.debug('[cursor] fetchCursorModels: timed out');
      resolve(null);
    }, timeoutMs);

    const bin = resolveCursorAgentPath();
    execFile(bin, ['models'], { timeout: timeoutMs }, (err, stdout) => {
      clearTimeout(timer);
      if (err) {
        logger.debug(`[cursor] fetchCursorModels error: ${err.message}`);
        resolve(null);
        return;
      }
      resolve(parseCursorModelsOutput(String(stdout ?? '')));
    });
  });
}

/**
 * Parse plain-text output of `cursor-agent models`.
 * Lines format: `<id> - <name>` optionally followed by `  (default)` or `  (current)`.
 */
export function parseCursorModelsOutput(output: string): CursorModelsResult {
  const models: CursorModelInfo[] = [];
  let currentModelId: string | null = null;
  let defaultModelId: string | null = null;

  const clean = output.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');

  for (const rawLine of clean.split('\n')) {
    const line = rawLine.trim();
    const match = line.match(/^([a-zA-Z0-9][a-zA-Z0-9._-]*)\s+-\s+(.+?)(\s+\((default|current)\))?$/);
    if (!match) continue;

    const [, code, rawName, , marker] = match;
    const value = (rawName as string).trim();
    models.push({ code, value });

    if (marker === 'current') currentModelId = code as string;
    if (marker === 'default') defaultModelId = code as string;
  }

  return {
    models,
    currentModelId: currentModelId ?? defaultModelId ?? 'auto',
  };
}
