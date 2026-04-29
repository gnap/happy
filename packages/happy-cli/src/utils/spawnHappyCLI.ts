/**
 * Cross-platform Happy CLI spawning utility
 * 
 * ## Background
 * 
 * We build a command-line JavaScript program with a runtime-specific entrypoint:
 * `dist/index.mjs` for Node.js and `dist/index.bun.mjs` for Bun.
 *
 * When we use Node, we want to hide deprecation warnings and other noise from
 * end users by passing specific flags: `--no-warnings --no-deprecation`.
 * 
 * Users don't care about these technical details - they just want a clean experience
 * with no warning output when using Happy.
 * 
 * ## The Wrapper Strategy
 * 
 * We created a wrapper script `bin/happy.mjs` with a shebang `#!/usr/bin/env node`.
 * This allows direct execution on Unix systems and NPM automatically generates 
 * Windows-specific wrapper scripts (`happy.cmd` and `happy.ps1`) when it sees 
 * the `bin` field in package.json pointing to a JavaScript file with a shebang.
 * 
 * The wrapper script either directly execs the runtime entrypoint with the flags we want,
 * or imports it directly if the current runtime is already configured correctly.
 * 
 * ## Execution Chains
 * 
 * **Unix/Linux/macOS:**
 * 1. User runs `happy` command
 * 2. Shell directly executes `bin/happy.mjs` (shebang: `#!/usr/bin/env node`)
 * 3. `bin/happy.mjs` either execs `node --no-warnings --no-deprecation dist/index.mjs` or imports `dist/index.mjs` directly
 * 
 * **Windows:**
 * 1. User runs `happy` command  
 * 2. NPM wrapper (`happy.cmd`) calls `node bin/happy.mjs`
 * 3. `bin/happy.mjs` either execs `node --no-warnings --no-deprecation dist/index.mjs` or imports `dist/index.mjs` directly
 * 
 * ## The Spawning Problem
 * 
 * When our code needs to spawn Happy cli as a subprocess (for daemon processes), 
 * we were trying to execute `bin/happy.mjs` directly. This fails on Windows 
 * because Windows doesn't understand shebangs - you get an `EFTYPE` error.
 * 
 * ## The Solution
 * 
 * Since we know exactly what needs to happen (run the correct entrypoint with the
 * correct runtime-specific bootstrap flags), we can bypass all the wrapper layers
 * and do it directly:
 * 
 * Node example:
 * `spawn('node', ['--no-warnings', '--no-deprecation', 'dist/index.mjs', ...args])`
 *
 * Bun example:
 * `spawn('bun', ['dist/index.bun.mjs', ...args])`
 * 
 * This works on all platforms and achieves the same result without any of the 
 * middleman steps that were providing workarounds for Windows vs Linux differences.
 */

import { spawn, execFileSync, SpawnOptions, type ChildProcess } from 'child_process';
import { join } from 'node:path';
import { projectPath } from '@/projectPath';
import { logger } from '@/ui/logger';
import { existsSync } from 'node:fs';
import { isBun } from './runtime';

export type HappyCliRuntime = 'node' | 'bun';

export interface HappyCliLaunchSpec {
  runtime: HappyCliRuntime;
  executable: string;
  argsPrefix: string[];
  entrypoint: string;
}

function resolveBunExecutable(): string {
  if (process.env.HAPPY_BUN_PATH) return process.env.HAPPY_BUN_PATH;
  if (isBun()) return process.execPath;

  try {
    const resolved = process.platform === 'win32'
      ? execFileSync('where', ['bun'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split(/\r?\n/)[0]
      : execFileSync('which', ['bun'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

    if (resolved) return resolved;
  } catch {
    // Fall through to a bare command name; callers may still have bun on PATH.
  }

  return 'bun';
}

export function getConfiguredHappyCliRuntime(): HappyCliRuntime {
  if (process.env.HAPPY_CLI_RUNTIME === 'bun') return 'bun';
  if (process.env.HAPPY_CLI_RUNTIME === 'node') return 'node';
  return isBun() ? 'bun' : 'node';
}

export function getHappyCliLaunchSpec(runtime: HappyCliRuntime = getConfiguredHappyCliRuntime()): HappyCliLaunchSpec {
  const projectRoot = projectPath();
  const nodeEntrypoint = join(projectRoot, 'dist', 'index.mjs');
  const bunEntrypoint = join(projectRoot, 'dist', 'index.bun.mjs');
  const entrypoint = runtime === 'bun'
    ? (existsSync(bunEntrypoint) ? bunEntrypoint : nodeEntrypoint)
    : nodeEntrypoint;

  if (runtime === 'bun') {
    return {
      runtime,
      executable: resolveBunExecutable(),
      argsPrefix: [entrypoint],
      entrypoint,
    };
  }

  return {
    runtime,
    executable: process.execPath,
    argsPrefix: ['--no-warnings', '--no-deprecation', entrypoint],
    entrypoint,
  };
}

/**
 * Spawn the Happy CLI with the given arguments in a cross-platform way.
 * 
 * This function bypasses the wrapper scripts (`bin/happy.mjs` / `bin/happy-bun.mjs`)
 * and spawns the actual CLI entrypoint directly with the configured runtime.
 * 
 * @param args - Arguments to pass to the Happy CLI
 * @param options - Spawn options (same as child_process.spawn)
 * @returns ChildProcess instance
 */
export function spawnHappyCLI(args: string[], options: SpawnOptions = {}): ChildProcess {
  const spec = getHappyCliLaunchSpec();

  let directory: string | URL | undefined;
  if ('cwd' in options) {
    directory = options.cwd
  } else {
    directory = process.cwd()
  }
  // Note: We execute the current Node.js binary directly with the calculated
  // entrypoint path below, bypassing the 'happy' wrapper that would normally be
  // found in the shell's PATH. We still log it as 'happy' because other engineers
  // are typically looking for when "happy" was started and do not care about the
  // underlying runtime binary details and flags we use to achieve the same result.
  const fullCommand = `happy ${args.join(' ')}`;
  logger.debug(`[SPAWN HAPPY CLI] Spawning: ${fullCommand} in ${directory}`);

  // Sanity check of the entrypoint path exists
  if (!existsSync(spec.entrypoint)) {
    const errorMessage = `Entrypoint ${spec.entrypoint} does not exist for runtime ${spec.runtime}`;
    logger.debug(`[SPAWN HAPPY CLI] ${errorMessage}`);
    throw new Error(errorMessage);
  }

  return spawn(spec.executable, [...spec.argsPrefix, ...args], options);
}
