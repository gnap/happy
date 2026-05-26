#!/usr/bin/env bun
/**
 * Standalone repro for Happy's cursor maxMode file guard.
 *
 * cursor-agent has no --max-mode flag; it snapshots ~/.cursor/cli-config.json at startup.
 * Happy acquires a lock, writes maxMode, spawns, releases lock on first stream-json `system`.
 *
 * Usage:
 *   bun scripts/debug-cursor-maxmode.mts --no-max-mode --model claude-opus-4-7-medium "hi"
 *   bun scripts/debug-cursor-maxmode.mts --max-mode --model claude-opus-4-7-medium "hi"
 *   bun scripts/debug-cursor-maxmode.mts --no-guard --model claude-opus-4-7-medium "hi"
 */

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import {
  acquireCursorMaxModeGuard,
  atomicSetCursorMaxMode,
  cursorCliConfigPath,
  isCursorStreamInitMessage,
} from '../src/cursor/cursorMaxMode.ts';
import { buildCursorArgs, resolveCursorAgentPath } from '../src/cursor/cursorProcess.ts';

function usage(): never {
  console.error(`Usage: bun scripts/debug-cursor-maxmode.mts [--max-mode|--no-max-mode|--no-guard] [--model ID] [prompt]

  --max-mode     guard: write true before spawn (default)
  --no-max-mode  guard: write false before spawn
  --no-guard     skip lock/write; use whatever is already in cli-config.json
`);
  process.exit(1);
}

async function readMaxModeSnapshot(): Promise<{ root: boolean; model: boolean | undefined }> {
  const raw = await readFile(cursorCliConfigPath(), 'utf8');
  const cfg = JSON.parse(raw) as { maxMode?: boolean; model?: { maxMode?: boolean } };
  return { root: cfg.maxMode === true, model: cfg.model?.maxMode };
}

function parseArgs(argv: string[]): {
  guard: boolean | null;
  model?: string;
  prompt: string;
} {
  let guard: boolean | null = true;
  let model: string | undefined;
  const promptParts: string[] = [];
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--max-mode') guard = true;
    else if (a === '--no-max-mode') guard = false;
    else if (a === '--no-guard') guard = null;
    else if (a === '--model' && argv[i + 1]) model = argv[++i];
    else if (a === '-h' || a === '--help') usage();
    else promptParts.push(a);
  }
  const prompt = promptParts.join(' ').trim() || 'Reply with exactly: pong';
  return { guard, model, prompt };
}

async function main(): Promise<void> {
  const { guard, model, prompt } = parseArgs(process.argv);
  const cfgPath = cursorCliConfigPath();
  const before = await readMaxModeSnapshot();
  console.log(`cli-config: ${cfgPath}`);
  console.log(`on disk before: maxMode=${before.root} model.maxMode=${String(before.model)}`);
  console.log(`guard: ${guard === null ? 'off' : String(guard)}  model: ${model ?? '(default)'}  prompt: ${JSON.stringify(prompt)}`);

  let releaseGuard: (() => Promise<void>) | null = null;
  if (guard !== null) {
    const g = await acquireCursorMaxModeGuard(guard);
    releaseGuard = () => g.release();
    const after = await readMaxModeSnapshot();
    console.log(`after guard write: maxMode=${after.root} model.maxMode=${String(after.model)}`);
  }

  const cursorArgs = buildCursorArgs(
    { cwd: process.cwd(), model, force: true, approveMcps: false },
    false,
  );
  cursorArgs.push(prompt);
  const bin = resolveCursorAgentPath();
  console.log(`spawn: ${bin} ${cursorArgs.join(' ').slice(0, 240)}`);

  const child = spawn(bin, cursorArgs, {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, TERM: 'xterm-256color' },
  });

  let guardReleased = false;
  const maybeRelease = async (line: string): Promise<void> => {
    if (!releaseGuard || guardReleased) return;
    try {
      const msg = JSON.parse(line) as { type?: string };
      if (!isCursorStreamInitMessage(msg)) return;
      guardReleased = true;
      await releaseGuard();
      releaseGuard = null;
      const snap = await readMaxModeSnapshot();
      console.log(`\n[guard] released on stream-json system; disk now maxMode=${snap.root}`);
    } catch {
      /* not json */
    }
  };

  const rlOut = createInterface({ input: child.stdout! });
  const rlErr = createInterface({ input: child.stderr! });
  rlOut.on('line', (line) => {
    void maybeRelease(line);
    if (/max mode required|requires max mode/i.test(line)) {
      console.log(`\n>>> MAX MODE ERROR (stdout): ${line}`);
    }
    console.log(`OUT ${line.slice(0, 500)}`);
  });
  rlErr.on('line', (line) => {
    if (/max mode required|requires max mode/i.test(line)) {
      console.log(`\n>>> MAX MODE ERROR (stderr): ${line}`);
    }
    console.log(`ERR ${line.slice(0, 500)}`);
  });

  const code = await new Promise<number>((resolve) => {
    child.on('close', (c) => resolve(c ?? 1));
  });
  if (releaseGuard) {
    await releaseGuard();
    console.log('[guard] released in finally (no system line seen)');
  }
  console.log(`exit: ${code}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
