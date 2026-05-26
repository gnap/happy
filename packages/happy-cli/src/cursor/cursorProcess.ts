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
import {
  defaultCompactPostCommandIdleMs,
  defaultCompactPostCommandMaxMs,
  isInteractiveCompressComplete,
  isInteractiveCompressFailed,
  isInteractiveInputReady,
  type InteractiveCommandOutcome,
  type InteractiveCommandResult,
} from './interactiveCompletion';

export type { InteractiveCommandOutcome, InteractiveCommandResult } from './interactiveCompletion';

const CURSOR_AGENT_NAME = 'cursor-agent';
const PTY_BASH_EXEC_COMMAND = 'exec "$0" "$@"';
const INTERACTIVE_INPUT_FALLBACK_MS = 15000;
const INTERACTIVE_EXIT_COMMAND = '/exit\n';

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

export function buildCursorArgs(
  options: CursorProcessOptions,
  interactive: boolean,
): string[] {
  const cursorArgs: string[] = [];
  if (!interactive) {
    cursorArgs.push('--print');
    cursorArgs.push('--output-format', 'stream-json');
    cursorArgs.push('--stream-partial-output'); // stream assistant/result deltas instead of only at end
    cursorArgs.push('--trust'); // Non-interactive: avoid "Workspace Trust Required" prompt
  }

  if (options.executionMode === 'plan') {
    cursorArgs.push('--mode', 'plan');
  } else if (options.executionMode === 'ask') {
    cursorArgs.push('--mode', 'ask');
  }
  // Default force to true when unspecified so ACP path (CursorBackend) keeps --force
  if (options.force !== false) {
    cursorArgs.push('--force');
  }

  if (options.model) {
    cursorArgs.push('--model', options.model);
  }

  if (options.resumeChatId) {
    cursorArgs.push('--resume', options.resumeChatId);
  }
  if (options.approveMcps) {
    cursorArgs.push('--approve-mcps');
    cursorArgs.push('--workspace', options.cwd);
    logger.debug('[cursor] MCP: --approve-mcps enabled so Happy loads from .cursor/mcp.json');
  }

  return cursorArgs;
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
  async run(prompt: string): Promise<InteractiveCommandResult> {
    const cursorArgs = buildCursorArgs(this.options, false);
    cursorArgs.push('--', prompt);
    return this.spawnAndRun(cursorArgs, { interactive: false });
  }

  /**
   * Spawn cursor-agent interactively and send a slash command such as /compress.
   * Serial sessions should await this before dequeuing the next message.
   */
  async runInteractiveCommand(
    command: string,
    runOptions?: {
      /** Use two-phase ready detection and timeouts tuned for /compress. */
      completionMode?: 'generic' | 'compress';
      postCommandIdleMs?: number;
      postCommandMaxMs?: number;
    },
  ): Promise<InteractiveCommandResult> {
    const completionMode = runOptions?.completionMode ?? 'generic';
    const cursorArgs = buildCursorArgs(this.options, true);
    return this.spawnAndRun(cursorArgs, {
      interactive: true,
      stdinInput: `${command}\n`,
      completionMode,
      postCommandIdleMs: runOptions?.postCommandIdleMs
        ?? (completionMode === 'compress' ? defaultCompactPostCommandIdleMs() : undefined),
      postCommandMaxMs: runOptions?.postCommandMaxMs
        ?? (completionMode === 'compress' ? defaultCompactPostCommandMaxMs() : undefined),
    });
  }

  private spawnAndRun(
    cursorArgs: string[],
    options: {
      interactive: boolean;
      stdinInput?: string;
      interactiveIdleMs?: number;
      completionMode?: 'generic' | 'compress';
      postCommandIdleMs?: number;
      postCommandMaxMs?: number;
    },
  ): Promise<InteractiveCommandResult> {
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
      stdio: options.interactive ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
      cwd: this.options.cwd,
      env: env as Record<string, string>,
    };

    return new Promise<InteractiveCommandResult>((resolve, reject) => {
      let settled = false;
      let subprocessError: Error | null = null;
      let interactiveIdleTimer: ReturnType<typeof setTimeout> | null = null;
      let interactiveInputTimer: ReturnType<typeof setTimeout> | null = null;
      let postCommandMaxTimer: ReturnType<typeof setTimeout> | null = null;
      let interactiveInputSent = false;
      let interactiveCompletionSent = false;
      let interactiveOutcome: InteractiveCommandOutcome = 'failed';
      let interactiveDetail: string | undefined;
      let interactiveScreenBuffer = '';
      const isCompressMode = options.completionMode === 'compress';
      const resolveOnce = (result: InteractiveCommandResult): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      const rejectOnce = (error: Error): void => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      const clearPostCommandMaxTimer = () => {
        if (postCommandMaxTimer) {
          clearTimeout(postCommandMaxTimer);
          postCommandMaxTimer = null;
        }
      };
      const clearInteractiveIdleTimer = () => {
        if (interactiveIdleTimer) {
          clearTimeout(interactiveIdleTimer);
          interactiveIdleTimer = null;
        }
      };
      const clearInteractiveInputTimer = () => {
        if (interactiveInputTimer) {
          clearTimeout(interactiveInputTimer);
          interactiveInputTimer = null;
        }
      };
      const sendInteractiveInput = (reason: string) => {
        if (!options.interactive || !options.stdinInput || interactiveInputSent) return;
        interactiveInputSent = true;
        clearInteractiveInputTimer();
        interactiveScreenBuffer = '';
        try {
          child.stdin?.write(options.stdinInput);
          logger.debug(`[cursor] Interactive command sent (${reason})`);
          armInteractiveIdleTimer();
          armPostCommandMaxTimer();
        } catch (error) {
          logger.debug('[cursor] Failed to write interactive command:', error);
        }
      };
      const interactiveCommandComplete = (): boolean => {
        if (!interactiveInputSent) {
          return false;
        }
        if (isCompressMode) {
          return isInteractiveCompressComplete(interactiveScreenBuffer);
        }
        return isInteractiveInputReady(interactiveScreenBuffer);
      };
      const finishInteractiveSuccess = (reason: string) => {
        if (!options.interactive || interactiveCompletionSent) return;
        if (!interactiveCommandComplete()) return;
        interactiveCompletionSent = true;
        interactiveOutcome = 'completed';
        clearInteractiveIdleTimer();
        clearPostCommandMaxTimer();
        logger.debug(`[cursor] Interactive command completed (${reason})`);
        try {
          child.stdin?.write(INTERACTIVE_EXIT_COMMAND);
        } catch {
          /* best-effort exit so the serial turn can dequeue quickly */
        }
        resolveOnce({ outcome: 'completed' });
      };
      const finishInteractiveFailure = (outcome: InteractiveCommandOutcome, detail: string, reason: string) => {
        if (interactiveCompletionSent) return;
        interactiveCompletionSent = true;
        interactiveOutcome = outcome;
        interactiveDetail = detail;
        clearInteractiveIdleTimer();
        clearPostCommandMaxTimer();
        logger.debug(`[cursor] Interactive command ${outcome} (${reason}): ${detail}`);
        this.kill();
        resolveOnce({ outcome, detail });
      };
      const maybeResolveInteractiveCompletion = (reason: string) => {
        if (!options.interactive || interactiveCompletionSent) return;
        if (isCompressMode && interactiveInputSent && isInteractiveCompressFailed(interactiveScreenBuffer)) {
          finishInteractiveFailure('failed', 'Compression failed in cursor-agent TUI', reason);
          return;
        }
        finishInteractiveSuccess(reason);
      };
      const maybeSendInteractiveInput = (reason: string) => {
        if (!options.interactive) return;
        if (!interactiveInputSent && options.stdinInput && isInteractiveInputReady(interactiveScreenBuffer)) {
          sendInteractiveInput(reason);
          return;
        }
      };
      const armPostCommandMaxTimer = () => {
        if (!isCompressMode || !options.postCommandMaxMs || options.postCommandMaxMs <= 0) return;
        clearPostCommandMaxTimer();
        postCommandMaxTimer = setTimeout(() => {
          if (interactiveCompletionSent) return;
          finishInteractiveFailure(
            'timed_out',
            `Compression exceeded ${options.postCommandMaxMs}ms`,
            'post-command max',
          );
        }, options.postCommandMaxMs);
      };

      const onExit = (code: number | null) => {
        clearInteractiveIdleTimer();
        clearInteractiveInputTimer();
        clearPostCommandMaxTimer();
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
          rejectOnce(subprocessError);
          return;
        }
        if (interactiveCompletionSent) {
          return;
        }
        if (options.interactive && interactiveInputSent) {
          if (interactiveCommandComplete()) {
            resolveOnce({ outcome: 'completed' });
            return;
          }
          if (isCompressMode && isInteractiveCompressFailed(interactiveScreenBuffer)) {
            resolveOnce({ outcome: 'failed', detail: interactiveDetail ?? 'Compression failed in cursor-agent TUI' });
            return;
          }
          const detail = code !== 0 && code !== null
            ? `cursor-agent exited with code ${code}`
            : interactiveDetail ?? 'Interactive command ended before compression completed';
          resolveOnce({
            outcome: code !== 0 && code !== null ? 'failed' : interactiveOutcome,
            detail,
          });
          return;
        }
        resolveOnce({ outcome: 'completed' });
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
        logger.debug(`[cursor] Spawning cursor-agent directly (no PTY${options.interactive ? ', interactive' : ''})`);
      } else {
        const ptySpawn = buildCursorPtySpawn(cursorAgentPath, cursorArgs, isLinux);
        child = spawn(ptySpawn.command, ptySpawn.args, spawnOptions);
        logger.debug(`[cursor] Spawning cursor-agent with script (PTY${options.interactive ? ', interactive' : ''})`);
      }

      this.child = child;

      if (options.interactive && options.stdinInput) {
        interactiveInputTimer = setTimeout(() => {
          sendInteractiveInput(`fallback after ${INTERACTIVE_INPUT_FALLBACK_MS}ms`);
        }, INTERACTIVE_INPUT_FALLBACK_MS);
      }

      const armInteractiveIdleTimer = () => {
        const idleMs = options.postCommandIdleMs ?? options.interactiveIdleMs;
        if (!options.interactive || !interactiveInputSent || !idleMs || idleMs <= 0) return;
        clearInteractiveIdleTimer();
        interactiveIdleTimer = setTimeout(() => {
          if (interactiveCompletionSent) return;
          if (interactiveCommandComplete()) {
            finishInteractiveSuccess(`idle ${idleMs}ms with post-command ready`);
            return;
          }
          if (isCompressMode) {
            finishInteractiveFailure(
              'timed_out',
              `No compression completion signal after ${idleMs}ms idle`,
              'post-command idle',
            );
            return;
          }
          logger.debug(`[cursor] Interactive command idle for ${idleMs}ms, stopping cursor-agent`);
          this.kill();
        }, idleMs);
      };

      child.stdout?.on('data', (data: Buffer) => {
        const text = data.toString();
        if (options.interactive) {
          interactiveScreenBuffer += text;
          if (interactiveScreenBuffer.length > 12000) {
            interactiveScreenBuffer = interactiveScreenBuffer.slice(-12000);
          }
        }
        this.processChunk(text);
        maybeSendInteractiveInput('stdout ready');
        maybeResolveInteractiveCompletion('stdout ready');
        armInteractiveIdleTimer();
      });
      child.stderr?.on('data', (data: Buffer) => {
        // Some cursor-agent failures only surface on stderr. Reuse the same line parser so
        // provider/model errors can be promoted into synthetic stream messages.
        const text = data.toString();
        if (options.interactive) {
          interactiveScreenBuffer += text;
          if (interactiveScreenBuffer.length > 12000) {
            interactiveScreenBuffer = interactiveScreenBuffer.slice(-12000);
          }
        }
        this.processChunk(text);
        maybeSendInteractiveInput('stderr ready');
        maybeResolveInteractiveCompletion('stderr ready');
        armInteractiveIdleTimer();
      });
      child.on('close', (code) => {
        if (this.options.signal) {
          this.options.signal.removeEventListener('abort', onAbort);
        }
        onExit(code);
      });
      child.on('error', (err) => {
        clearInteractiveIdleTimer();
        clearInteractiveInputTimer();
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
      if (isCursorCliErrorLine(trimmed)) {
        const synthetic: CursorStreamMessage = {
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          result: formatCursorCliErrorLine(trimmed),
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

function isCursorProviderErrorLine(line: string): boolean {
  return /provider error|we're having trouble connecting to the model provider|invalid model|unknown model|unsupported model|model .{0,60}not available|model .{0,60}not found/i.test(line);
}

/** Plain-text cursor-agent / TTY errors (billing, auth, provider) promoted to stream-json result errors. */
export function isCursorCliErrorLine(line: string): boolean {
  return isCursorProviderErrorLine(line)
    || /unpaid invoice|pay your invoice|billing|subscription.*(expired|required|inactive)|account.*(suspended|disabled|locked)/i.test(line);
}

/** User-visible text for CLI errors (strip TUI noise, dedupe repeated sentences). */
export function formatCursorCliErrorLine(line: string): string {
  let text = line.replace(/^\s*S:\s*/i, '').replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').trim();
  const normalized = text.replace(/\s+/g, ' ');
  const half = Math.floor(normalized.length / 2);
  if (half > 20) {
    const first = normalized.slice(0, half).trim();
    const second = normalized.slice(half).trim();
    if (first === second) {
      text = first;
    }
  }
  return text.slice(0, 1000);
}

export interface CursorModelInfo {
  code: string;
  value: string;
  /** Approximate max context window in tokens, inferred from the model name. */
  contextTokens?: number;
}

/**
 * Rough heuristic: if the human-readable name contains "1M" the model has a 1M-token
 * context window; otherwise default to 200K. cursor-agent itself does not expose
 * per-model context limits, so this is the best we can do without a hard-coded table.
 */
function inferContextTokens(name: string): number {
  if (/\b1\s*m\b/i.test(name)) return 1_000_000;
  return 200_000;
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
    models.push({ code, value, contextTokens: inferContextTokens(value) });

    if (marker === 'current') currentModelId = code as string;
    if (marker === 'default') defaultModelId = code as string;
  }

  return {
    models,
    currentModelId: currentModelId ?? defaultModelId ?? 'auto',
  };
}
