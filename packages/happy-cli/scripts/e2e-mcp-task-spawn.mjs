#!/usr/bin/env node
/**
 * E2E test: verify spawn_subagent with MCP Tasks blocks until completion.
 *
 * Simulates the refactored spawn_subagent flow:
 * 1. Register a task-augmented tool (taskSupport: 'optional')
 * 2. createTask fires, background timer stores result after 3s
 * 3. SDK's handleAutomaticTaskPolling polls taskStore server-side
 * 4. HTTP response only returns when the task completes
 *
 * Expected: tools/call blocks ~3s and returns the result directly.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { InMemoryTaskStore, InMemoryTaskMessageQueue } from '@modelcontextprotocol/sdk/experimental/tasks';
import { createServer } from 'node:http';
import { z } from 'zod';

const SIMULATED_DELAY_MS = 3000;

const taskStore = new InMemoryTaskStore();
const taskMessageQueue = new InMemoryTaskMessageQueue();

const mcp = new McpServer(
  { name: 'E2E Task Test', version: '1.0.0' },
  {
    taskStore,
    taskMessageQueue,
    capabilities: {
      tasks: { requests: { tools: { call: {} } } },
    },
  },
);

mcp.experimental.tasks.registerToolTask(
  'spawn_subagent',
  {
    title: 'Spawn Sub-agent',
    description: 'Simulated task-augmented spawn_subagent',
    inputSchema: { prompt: z.string() },
    execution: { taskSupport: 'optional' },
  },
  {
    createTask: async (args, extra) => {
      const task = await extra.taskStore.createTask({});
      console.log(`[server] createTask taskId=${task.taskId} prompt="${args.prompt}"`);

      const isFail = args.prompt === 'FAIL';
      setTimeout(async () => {
        if (isFail) {
          console.log(`[server] sub-agent error → storeTaskResult (failed) taskId=${task.taskId}`);
          await taskStore.storeTaskResult(task.taskId, 'failed', {
            content: [{ type: 'text', text: 'Simulated error' }],
            isError: true,
          });
        } else {
          console.log(`[server] sub-agent done → storeTaskResult taskId=${task.taskId}`);
          await taskStore.storeTaskResult(task.taskId, 'completed', {
            content: [{ type: 'text', text: `Result for: "${args.prompt}"` }],
            isError: false,
          });
        }
      }, SIMULATED_DELAY_MS);

      return { task };
    },
    getTask: async (_args, extra) => await extra.taskStore.getTask(extra.taskId),
    getTaskResult: async (_args, extra) => await extra.taskStore.getTaskResult(extra.taskId),
  },
);

const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
await mcp.connect(transport);

const server = createServer(async (req, res) => {
  try {
    await transport.handleRequest(req, res);
  } catch {
    if (!res.headersSent) res.writeHead(500).end();
  }
});

const port = await new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});
const baseUrl = `http://127.0.0.1:${port}/mcp`;
console.log(`[test] MCP server at ${baseUrl}`);

const headers = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
};
const rpc = (id, method, params) =>
  fetch(baseUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', ...(id != null ? { id } : {}), method, params }),
  });

// 1. Initialize
const initRes = await rpc(1, 'initialize', {
  protocolVersion: '2025-03-26',
  capabilities: {},
  clientInfo: { name: 'e2e-test', version: '1.0.0' },
});
console.log(`[test] initialize → ${initRes.status}`);
await rpc(null, 'notifications/initialized');

// 2. Test success: spawn_subagent — should block ~3s
console.log(`\n=== Test 1: success path ===`);
console.log(`[test] calling spawn_subagent (expect ~${SIMULATED_DELAY_MS}ms block)…`);
const t0 = Date.now();
const callRes = await rpc(2, 'tools/call', {
  name: 'spawn_subagent',
  arguments: { prompt: 'hello world' },
});
const body = await callRes.text();
const elapsed = Date.now() - t0;

console.log(`[test] returned in ${elapsed}ms`);
console.log(`[test] body: ${body.trim()}`);

const blocked = elapsed >= SIMULATED_DELAY_MS * 0.8;
const hasResult = body.includes('Result for:');

console.log(`Blocked until completion : ${blocked ? 'YES ✓' : 'NO ✗'} (${elapsed}ms)`);
console.log(`Got direct result        : ${hasResult ? 'YES ✓' : 'NO ✗'}`);

// 3. Test failure path
console.log(`\n=== Test 2: error path ===`);
console.log(`[test] calling spawn_subagent with fail prompt…`);
const t1 = Date.now();
const failRes = await rpc(3, 'tools/call', {
  name: 'spawn_subagent',
  arguments: { prompt: 'FAIL' },
});
const failBody = await failRes.text();
const failElapsed = Date.now() - t1;

console.log(`[test] returned in ${failElapsed}ms`);
console.log(`[test] body: ${failBody.trim()}`);

const failBlocked = failElapsed >= SIMULATED_DELAY_MS * 0.8;
const hasError = failBody.includes('Simulated error');

console.log(`Blocked until completion : ${failBlocked ? 'YES ✓' : 'NO ✗'} (${failElapsed}ms)`);
console.log(`Got error result         : ${hasError ? 'YES ✓' : 'NO ✗'}`);

// Summary
const allPass = blocked && hasResult && failBlocked && hasError;
console.log(`\nE2E: ${allPass ? 'ALL PASSED ✓' : 'FAILED ✗'}`);

server.close();
process.exit(allPass ? 0 : 1);
