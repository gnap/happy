#!/usr/bin/env node
/**
 * MCP Tasks research: run a minimal MCP server with one task-augmented tool,
 * then cursor-agent in a temp dir, to see if cursor-agent supports task
 * params (tools/call with task) and polling (tasks/get, tasks/result).
 *
 * Run from packages/happy-cli:
 *   node scripts/mcp-task-research.mjs
 *
 * Requires: cursor-agent on PATH (or CURSOR_AGENT_PATH).
 */

import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { InMemoryTaskStore } = await import('@modelcontextprotocol/sdk/experimental/tasks/index.js');
const { z } = await import('zod');

const taskStore = new InMemoryTaskStore();
const mcp = new McpServer(
  { name: 'MCP Tasks Research', version: '1.0.0' },
  {
    taskStore,
    capabilities: {
      tools: { listChanged: true },
      tasks: {
        list: {},
        cancel: {},
        requests: { tools: { call: {} } },
      },
    },
  }
);

// One task-augmented tool: returns CreateTaskResult immediately, completes after 5s in background.
mcp.experimental.tasks.registerToolTask(
  'long_running',
  {
    title: 'Long running task',
    description: 'Starts a task that completes after about 5 seconds. Use to test task polling.',
    inputSchema: z.object({
      label: z.string().optional().describe('Optional label for logs'),
    }),
    execution: { taskSupport: 'optional' }, // optional = client may send task or not; server can auto-poll
  },
  {
    createTask: async (args, extra) => {
      const task = await extra.taskStore.createTask(
        extra.taskRequestedTtl ? { ttl: extra.taskRequestedTtl } : {}
      );
      const label = args?.label ?? 'default';
      console.log(`[MCP Tasks] long_running createTask taskId=${task.taskId.slice(0, 8)}... label=${label}`);
      setImmediate(async () => {
        await new Promise((r) => setTimeout(r, 5000));
        try {
          await extra.taskStore.storeTaskResult(
            task.taskId,
            'completed',
            {
              content: [{ type: 'text', text: `Long run finished (label: ${label}).` }],
              isError: false,
            }
          );
          console.log(`[MCP Tasks] long_running completed taskId=${task.taskId.slice(0, 8)}...`);
        } catch (e) {
          console.error('[MCP Tasks] storeTaskResult error', e);
        }
      });
      return { task };
    },
  }
);

const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
await mcp.connect(transport);

const server = createServer(async (req, res) => {
  try {
    await transport.handleRequest(req, res);
  } catch (e) {
    console.error('[MCP Tasks] request error', e);
    if (!res.headersSent) res.writeHead(500).end();
  }
});

await new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve());
});
const port = server.address().port;
const mcpUrl = `http://127.0.0.1:${port}`;
console.log(`[MCP Tasks] Server listening at ${mcpUrl}`);

// Temp dir and .cursor/mcp.json
const tempDir = mkdtempSync(join(tmpdir(), 'cursor-mcp-task-research-'));
const cursorDir = join(tempDir, '.cursor');
mkdirSync(cursorDir, { recursive: true });
const mcpJson = {
  mcpServers: {
    task_research: { url: mcpUrl },
  },
};
writeFileSync(join(cursorDir, 'mcp.json'), JSON.stringify(mcpJson, null, 2), 'utf8');
console.log(`[MCP Tasks] Wrote ${join(cursorDir, 'mcp.json')}`);

const cursorAgentBin = process.env.CURSOR_AGENT_PATH || 'cursor-agent';
const prompt =
  'Call the tool named long_running (with no arguments or label "test") and wait for the result. Then reply with one sentence saying what the result was.';

console.log('');
console.log('--- Run cursor-agent in the temp workspace (copy-paste or use the command below) ---');
console.log(`  cd ${tempDir}`);
console.log(`  ${cursorAgentBin} --workspace ${tempDir} --approve-mcps --print --output-format stream-json "${prompt}"`);
console.log('');
console.log('Watch this terminal for:');
console.log('  - "[MCP Tasks] long_running createTask" = tools/call received');
console.log('  - If client sends task param: we return CreateTaskResult; then client should call tasks/get or tasks/result');
console.log('  - "[MCP Tasks] long_running completed" = storeTaskResult called after 5s');
console.log('  - If you see tasks/get or tasks/result in logs (if we add request logging), cursor-agent supports polling.');
console.log('');
console.log('Temp dir (keep for inspection):', tempDir);
console.log('Press Ctrl+C to stop the MCP server.');
console.log('');

// Optional: spawn cursor-agent automatically
const autoSpawn = process.argv.includes('--spawn');
if (autoSpawn) {
  const child = spawn(cursorAgentBin, ['--workspace', tempDir, '--approve-mcps', '--trust', '--print', '--output-format', 'stream-json', prompt], {
    cwd: tempDir,
    stdio: 'inherit',
    env: { ...process.env, CURSOR_AGENT_PATH: cursorAgentBin },
  });
  child.on('exit', (code) => {
    console.log(`[MCP Tasks] cursor-agent exited with code ${code}`);
  });
}

process.on('SIGINT', () => {
  taskStore.cleanup?.();
  mcp.close();
  server.close();
  process.exit(0);
});
