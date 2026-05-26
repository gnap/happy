#!/usr/bin/env bun
/**
 * Reproduce cursor-agent --print lag between stream-json `result` and process exit.
 * Isolated from Happy/daemon. Workspace is --cwd (default: process.cwd()); does not touch other repos.
 *
 * Happy-only examples (resume chat must belong to the same --cwd workspace):
 *   cd packages/happy-cli
 *   bun scripts/debug-cursor-exit-repro.mts --cwd ../.. --case pong --mcp --trace
 *   bun scripts/debug-cursor-exit-repro.mts --cwd ../.. --mcp --resume <chat-id> --case multitool --trace
 *
 * Usage:
 *   bun scripts/debug-cursor-exit-repro.mts --case pong
 *   bun scripts/debug-cursor-exit-repro.mts --cwd /path/to/workspace --case tools --mcp
 *   bun scripts/debug-cursor-exit-repro.mts --case tools --mcp --trace
 *   bun scripts/debug-cursor-exit-repro.mts --pipe --mcp "custom prompt"
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { buildCursorArgs, buildCursorPtySpawn, resolveCursorAgentPath } from '../src/cursor/cursorProcess.ts';

type Mode = 'pipe' | 'pty';

const CASES: Record<string, { prompt: string; label: string }> = {
  pong: {
    label: 'no tools',
    prompt: 'Reply with exactly: pong',
  },
  tools: {
    label: 'one read tool',
    prompt:
      'Use the Read tool on package.json in the workspace (first 5 lines only), then reply with exactly: pong',
  },
  multitool: {
    label: 'read + shell',
    prompt:
      '1) Read README.md if it exists (first 3 lines). 2) Run: pwd. Then reply with exactly: pong',
  },
};

function usage(): never {
  console.error(`Usage: bun scripts/debug-cursor-exit-repro.mts [options]

  --case pong|tools|multitool   preset prompt (default: pong)
  --cwd DIR                     workspace (default: process.cwd(); .cursor/mcp.json from here)
  --pipe | --pty                spawn mode (default: pipe)
  --mcp                         --approve-mcps --workspace <cwd>
  --model ID
  --resume CHAT_ID              optional; omit for fresh chat
  --trace                       strace -f child (writes trace.log under --out)
  --watch                       poll process tree every 2s after result until exit
  --out DIR                     artifact dir (default: /tmp/cursor-exit-repro-<ts>)
  [prompt]                      overrides --case
`);
  process.exit(1);
}

function parseArgs(argv: string[]) {
  let mode: Mode = 'pipe';
  let caseName = 'pong';
  let model: string | undefined = 'composer-2.5';
  let resume: string | undefined;
  let mcp = false;
  let trace = false;
  let watch = true;
  let outDir: string | undefined;
  let cwd: string | undefined;
  const promptParts: string[] = [];
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pipe') mode = 'pipe';
    else if (a === '--pty') mode = 'pty';
    else if (a === '--cwd' && argv[i + 1]) cwd = argv[++i];
    else if (a === '--case' && argv[i + 1]) caseName = argv[++i];
    else if (a === '--model' && argv[i + 1]) model = argv[++i];
    else if (a === '--resume' && argv[i + 1]) resume = argv[++i];
    else if (a === '--mcp') mcp = true;
    else if (a === '--trace') trace = true;
    else if (a === '--watch') watch = true;
    else if (a === '--no-watch') watch = false;
    else if (a === '--out' && argv[i + 1]) outDir = argv[++i];
    else if (a === '-h' || a === '--help') usage();
    else promptParts.push(a);
  }
  const preset = CASES[caseName];
  if (!preset && promptParts.length === 0) {
    console.error(`Unknown --case ${caseName}`);
    usage();
  }
  const prompt = promptParts.join(' ').trim() || preset?.prompt || 'pong';
  const label = promptParts.length > 0 ? 'custom' : (preset?.label ?? caseName);
  return {
    mode,
    caseName,
    model,
    resume,
    mcp,
    trace,
    watch,
    outDir,
    cwd: cwd ?? process.cwd(),
    prompt,
    label,
  };
}

async function listDescendants(rootPid: number): Promise<string> {
  const proc = spawn('ps', ['-o', 'pid=,etime=,cmd=', '--forest', `-g${rootPid}`], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const out = await new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    proc.stdout?.on('data', (c) => chunks.push(c));
    proc.on('close', () => resolve(Buffer.concat(chunks).toString('utf8').trim()));
  });
  return out || `(no processes for pgid ${rootPid})`;
}

async function watchUntilExit(rootPid: number, logPath: string, startedAt: number, resultAt: number): Promise<void> {
  const lines: string[] = [];
  const append = async (msg: string) => {
    const line = `[+${((Date.now() - startedAt) / 1000).toFixed(1)}s post-result +${((Date.now() - resultAt) / 1000).toFixed(1)}s] ${msg}`;
    lines.push(line);
    console.log(`  ${line}`);
    await writeFile(logPath, `${lines.join('\n')}\n`, 'utf8');
  };
  await append('--- process watch after result ---');
  while (true) {
    try {
      process.kill(rootPid, 0);
    } catch {
      await append('root process gone');
      break;
    }
    const tree = await listDescendants(rootPid);
    await append(tree.split('\n').join(' | '));
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv);
  const cwd = opts.cwd;
  const out =
    opts.outDir ?? join('/tmp', `cursor-exit-repro-${Date.now()}`);
  await mkdir(out, { recursive: true });

  const bin = resolveCursorAgentPath();
  const cursorArgs = buildCursorArgs(
    {
      cwd,
      model: opts.model,
      resumeChatId: opts.resume,
      force: true,
      approveMcps: opts.mcp,
    },
    false,
  );
  cursorArgs.push(opts.prompt);

  const meta = {
    at: new Date().toISOString(),
    mode: opts.mode,
    case: opts.caseName,
    label: opts.label,
    mcp: opts.mcp,
    model: opts.model,
    resume: opts.resume ?? null,
    cwd,
    prompt: opts.prompt,
    cmd: [bin, ...cursorArgs],
  };
  await writeFile(join(out, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
  console.log(`artifacts: ${out}`);
  console.log(JSON.stringify(meta, null, 2));

  const started = Date.now();
  let resultAt: number | null = null;
  let toolCalls = 0;

  const spawnTarget = (): { cmd: string; args: string[] } => {
    if (opts.mode === 'pipe') {
      return { cmd: bin, args: cursorArgs };
    }
    const pty = buildCursorPtySpawn(bin, cursorArgs, process.platform === 'linux');
    return { cmd: pty.command, args: pty.args };
  };

  const { cmd, args } = spawnTarget();
  const tracePath = join(out, 'strace.log');
  const child: ChildProcess = opts.trace
    ? spawn(
      'strace',
      [
        '-f',
        '-tt',
        '-o',
        tracePath,
        '-e',
        'trace=process,exit_group,exit,clone,close,poll,ppoll,wait4,waitid,futex,connect,sendto,recvfrom,shutdown',
        cmd,
        ...args,
      ],
      { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: process.env },
    )
    : spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });

  const watchLog = join(out, 'proc-watch.log');
  const streamLog = join(out, 'stream.jsonl');

  const handleLine = async (line: string, stream: 'stdout' | 'stderr') => {
    if (stream === 'stdout') {
      await writeFile(streamLog, `${line}\n`, { flag: 'a' });
    }
    try {
      const msg = JSON.parse(line) as { type?: string; subtype?: string };
      if (msg.type === 'tool_call') toolCalls += 1;
      if (msg.type === 'system' && msg.subtype === 'init') {
        const sid = (msg as { session_id?: string }).session_id;
        if (sid) {
          await writeFile(join(out, 'session_id.txt'), `${sid}\n`);
          console.log(`session_id: ${sid} (use --resume ${sid} for same workspace)`);
        }
      }
      if (msg.type === 'result' && resultAt === null) {
        resultAt = Date.now();
        console.log(`\n>>> result ${msg.subtype ?? ''} at +${resultAt - started}ms (tool_call events seen: ${toolCalls})`);
        if (opts.watch && child.pid) {
          void watchUntilExit(child.pid, watchLog, started, resultAt);
        }
      }
    } catch {
      if (/error|required/i.test(line)) {
        console.log(`stderr: ${line.slice(0, 300)}`);
      }
    }
  };

  const rlOut = createInterface({ input: child.stdout! });
  const rlErr = createInterface({ input: child.stderr! });
  rlOut.on('line', (l) => void handleLine(l, 'stdout'));
  rlErr.on('line', (l) => void handleLine(l, 'stderr'));

  const code = await new Promise<number>((resolve) => {
    child.on('close', (c) => resolve(c ?? 1));
  });
  const exitedAt = Date.now();
  const summary = {
    exitCode: code,
    totalMs: exitedAt - started,
    resultMs: resultAt !== null ? resultAt - started : null,
    afterResultMs: resultAt !== null ? exitedAt - resultAt : null,
    toolCallEvents: toolCalls,
    trace: opts.trace ? tracePath : null,
  };
  console.log('\n=== summary ===');
  console.log(JSON.stringify(summary, null, 2));
  await writeFile(join(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);

  if (resultAt !== null) {
    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileAsync = promisify(execFile);
      const analyzePy = `
import re, sys
path, result_ms = sys.argv[1], int(sys.argv[2])
# stream tools
tools=[]
for line in open(path.replace('strace.log','stream.jsonl'), errors='ignore'):
    if 'tool_call' not in line: continue
    for kind in ['readToolCall','shellToolCall','mcpToolCall','grepToolCall','taskToolCall','webToolCall']:
        if kind in line: tools.append(kind)
from collections import Counter
print('stream_tool_kinds', dict(Counter(tools)))
`.trim();
      const streamPath = join(out, 'stream.jsonl');
      const { stdout: toolSummary } = await execFileAsync('python3', ['-c', analyzePy, join(out, 'strace.log'), String(resultAt - started)], { maxBuffer: 10 * 1024 * 1024 });
      await writeFile(join(out, 'tool-summary.txt'), toolSummary);
      console.log(toolSummary.trim());
    } catch {
      /* optional */
    }
  }

  if (opts.trace && resultAt !== null) {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    try {
      const { stdout } = await execFileAsync('sh', [
        '-c',
        `awk '/result/ {r=NR} NR>r && /exit_group|exit\\(/ {print}' "${tracePath}" | tail -40`,
      ]);
      const tailPath = join(out, 'strace-after-result.tail');
      await writeFile(tailPath, stdout);
      console.log(`strace tail after result: ${tailPath}`);
    } catch {
      /* optional */
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
