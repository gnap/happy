#!/usr/bin/env bun
/**
 * A/B cursor-agent exit lag: baseline MCP (38087) vs patched startHappyServer on ephemeral port.
 * Temporarily swaps happy/.cursor/mcp.json, restores on exit.
 */

import { spawn } from 'node:child_process';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startHappyServer } from '../src/claude/utils/startHappyServer.ts';

const HAPPY_ROOT = join(import.meta.dir, '../../..');
const MCP_JSON = join(HAPPY_ROOT, '.cursor/mcp.json');
const MCP_BACKUP = join(HAPPY_ROOT, '.cursor/mcp.json.exit-experiment.bak');
const RESUME = 'f2fea9c1-f16a-432b-8213-22f114de47fb';

function mockSession() {
  const inbox = { messages: [] as { id: string }[], unreadCount: 0 };
  return {
    sessionId: 'exit-experiment',
    sendClaudeSessionMessage: () => undefined,
    getA2AInbox: () => inbox,
    markA2AMessageRead: () => undefined,
    markA2AMessagesRead: () => undefined,
    recordA2AMessage: () => undefined,
  };
}

async function swapMcpUrl(url: string): Promise<void> {
  try {
    await copyFile(MCP_JSON, MCP_BACKUP);
  } catch {
    /* no existing file */
  }
  await writeFile(
    MCP_JSON,
    `${JSON.stringify({ mcpServers: { happy: { url } } }, null, 2)}\n`,
    'utf8',
  );
}

async function restoreMcpJson(): Promise<void> {
  try {
    const bak = await readFile(MCP_BACKUP, 'utf8');
    await writeFile(MCP_JSON, bak, 'utf8');
  } catch {
    /* nothing to restore */
  }
}

async function runRepro(label: string): Promise<number | null> {
  const proc = spawn(
    'bun',
    [
      'scripts/debug-cursor-exit-repro.mts',
      '--cwd',
      HAPPY_ROOT,
      '--pipe',
      '--mcp',
      '--resume',
      RESUME,
      '--case',
      'pong',
      '--no-watch',
    ],
    {
      cwd: join(import.meta.dir, '..'),
      stdio: ['ignore', 'pipe', 'inherit'],
      env: process.env,
    },
  );
  let out = '';
  proc.stdout?.on('data', (c) => {
    const s = c.toString();
    out += s;
    process.stdout.write(`[${label}] ${s}`);
  });
  const code = await new Promise<number>((resolve) => proc.on('close', (c) => resolve(c ?? 1)));
  const m = out.match(/"afterResultMs":\s*(\d+)/);
  return m ? Number(m[1]) : null;
}

async function main(): Promise<void> {
  const baselineUrl = (await readFile(MCP_JSON, 'utf8').then(JSON.parse)) as {
    mcpServers?: { happy?: { url?: string } };
  };
  const baselineMcp = baselineUrl.mcpServers?.happy?.url ?? 'http://127.0.0.1:38087/';

  console.log('=== baseline (current .cursor/mcp.json) ===');
  console.log(`mcp: ${baselineMcp}`);
  const baselineMs = await runRepro('baseline');

  console.log('\n=== patched Happy MCP (ephemeral port, aggressive socket close) ===');
  const happy = await startHappyServer(() => mockSession() as never, {
    useDaemonA2ARoute: true,
  });
  console.log(`patched mcp: ${happy.url}`);
  await swapMcpUrl(happy.url);
  let patchedMs: number | null = null;
  try {
    patchedMs = await runRepro('patched');
  } finally {
    await restoreMcpJson();
    happy.stop();
  }

  console.log('\n=== summary (pong, resume, happy workspace) ===');
  console.log(JSON.stringify({ baselineMcp, baselineAfterResultMs: baselineMs, patchedAfterResultMs: patchedMs }, null, 2));
}

main().catch(async (e) => {
  await restoreMcpJson();
  console.error(e);
  process.exit(1);
});
