#!/usr/bin/env bun
/**
 * Compare cursor-agent --print exit behavior: direct pipe vs Happy's script PTY wrapper.
 *
 * Usage:
 *   bun scripts/debug-cursor-pty-exit.mts [--model ID] [--resume CHAT_ID] [--mcp] [prompt]
 *   bun scripts/debug-cursor-pty-exit.mts --both
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { buildCursorArgs, buildCursorPtySpawn, resolveCursorAgentPath } from '../src/cursor/cursorProcess.ts';

type Mode = 'pipe' | 'pty';

function usage(): never {
  console.error(`Usage: bun scripts/debug-cursor-pty-exit.mts [--both] [--model ID] [--resume ID] [--mcp] [prompt]

  --both     run pipe then pty (default if no mode flag)
  --pipe     spawn cursor-agent directly (CURSOR_AGENT_NO_PTY=1 equivalent)
  --pty      spawn via script wrapper (Happy default)
  --mcp      add --approve-mcps --workspace cwd (like Happy remote sessions)
`);
  process.exit(1);
}

function parseArgs(argv: string[]): {
  modes: Mode[];
  model?: string;
  resume?: string;
  mcp: boolean;
  prompt: string;
} {
  const modes: Mode[] = [];
  let model: string | undefined;
  let resume: string | undefined;
  let mcp = false;
  const promptParts: string[] = [];
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--both') modes.push('pipe', 'pty');
    else if (a === '--pipe') modes.push('pipe');
    else if (a === '--pty') modes.push('pty');
    else if (a === '--model' && argv[i + 1]) model = argv[++i];
    else if (a === '--resume' && argv[i + 1]) resume = argv[++i];
    else if (a === '--mcp') mcp = true;
    else if (a === '-h' || a === '--help') usage();
    else promptParts.push(a);
  }
  if (modes.length === 0) modes.push('pipe', 'pty');
  return {
    modes,
    model,
    resume,
    mcp,
    prompt: promptParts.join(' ').trim() || 'Reply with exactly: pong',
  };
}

async function runOnce(
  mode: Mode,
  opts: { model?: string; resume?: string; mcp: boolean; prompt: string },
): Promise<void> {
  const bin = resolveCursorAgentPath();
  const cursorArgs = buildCursorArgs(
    {
      cwd: process.cwd(),
      model: opts.model,
      resumeChatId: opts.resume,
      force: true,
      approveMcps: opts.mcp,
    },
    false,
  );
  cursorArgs.push(opts.prompt);

  const started = Date.now();
  let resultAt: number | null = null;
  let child: ChildProcess;

  if (mode === 'pipe') {
    console.log(`\n=== PIPE (no PTY): ${bin} ${cursorArgs.slice(0, 8).join(' ')}...`);
    child = spawn(bin, cursorArgs, {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
  } else {
    const pty = buildCursorPtySpawn(bin, cursorArgs, process.platform === 'linux');
    console.log(`\n=== PTY (script): ${pty.command} ${pty.args.slice(0, 6).join(' ')}...`);
    child = spawn(pty.command, pty.args, {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
  }

  const onLine = (line: string) => {
    if (resultAt !== null) return;
    try {
      const msg = JSON.parse(line) as { type?: string; subtype?: string };
      if (msg.type === 'result') {
        resultAt = Date.now();
        console.log(`  [${mode}] result ${msg.subtype ?? ''} at +${resultAt - started}ms`);
      }
    } catch {
      /* ignore */
    }
  };

  const rlOut = createInterface({ input: child.stdout! });
  const rlErr = createInterface({ input: child.stderr! });
  rlOut.on('line', onLine);
  rlErr.on('line', (line) => {
    onLine(line);
    if (/error|required/i.test(line)) console.log(`  [${mode}] stderr: ${line.slice(0, 200)}`);
  });

  const code = await new Promise<number>((resolve) => {
    child.on('close', (c) => resolve(c ?? 1));
  });
  const exitedAt = Date.now();
  const afterResultMs = resultAt !== null ? exitedAt - resultAt : null;
  console.log(
    `  [${mode}] exit=${code} total=${exitedAt - started}ms`
    + (afterResultMs !== null ? ` after_result=${afterResultMs}ms` : ' (no result line parsed)'),
  );
}

const args = parseArgs(process.argv);
for (const mode of args.modes) {
  await runOnce(mode, args);
}
