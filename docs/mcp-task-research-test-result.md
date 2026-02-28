# MCP Task 调研测试结果

## 0. 确认结论（最新）

- **cursor-agent 会调用我们的 MCP 工具**：在 stream-json 里能看到 `tool_call`，`providerIdentifier: "task_research"`，`toolName: "long_running"`，说明从临时目录的 `.cursor/mcp.json` 正确加载了 MCP 并发起调用。
- **工具调用在到达 MCP 前被拒绝**：返回 `"rejected":{"reason":"User rejected MCP: task_research-long_running"}`，即 cursor-agent（或宿主）在**执行 MCP 工具前**做了一次「用户确认」，非交互/脚本下无人点击通过，因此请求**从未到达**我们的 MCP 服务，服务端不会出现 `[MCP Tasks] long_running createTask`。
- **`--approve-mcps`**：只负责「批准加载 MCP 服务器」，不负责「批准单次工具调用」；工具调用仍需要单独放行。
- **`--force` 已确认有效**：在 `--approve-mcps --trust --force` 下再次运行，服务端出现 `[MCP Tasks] long_running createTask` 与约 5s 后的 `[MCP Tasks] long_running completed`；cursor-agent 的 stream-json 中 `tool_call`/completed 为 `result.success`，内容为 `"Long run finished (label: test)."`，并最终回复用户。**结论：加 `--force` 可自动放行 MCP 工具调用，请求会到达 MCP 并拿到结果。**

---

## 1. 服务端与 task 工具（已通过）

用 **curl** 对 `scripts/mcp-task-research.mjs` 启动的 MCP 服务做了验证：

- **请求**：`POST tools/call`，`params`: `{ "name": "long_running", "arguments": {}, "task": { "ttl": 60000 } }`
- **请求头**：`Accept: application/json, text/event-stream`（必须同时支持二者）
- **响应**：返回 **CreateTaskResult**（SSE 格式）：
  ```json
  {"result":{"task":{"taskId":"a230945b8f1cd1d673bf78b0199f07ea","status":"working","ttl":60000,"createdAt":"...","lastUpdatedAt":"...","pollInterval":1000}},"jsonrpc":"2.0","id":2}
  ```
- **服务端日志**：出现 `[MCP Tasks] long_running createTask taskId=a230945b...`，约 5 秒后出现 `[MCP Tasks] long_running completed taskId=a230945b...`。

结论：**MCP 服务与 task-augmented 工具行为符合预期**；客户端带 `task` 调用会立即拿到 CreateTaskResult，后台约 5s 后写入结果。

---

## 2. cursor-agent 联调情况（已确认）

在自动化测试中：

- 已用 **临时目录** + **.cursor/mcp.json** 指向上述 MCP 服务，并执行：
  - `cursor-agent --workspace <tempDir> --approve-mcps --trust --print --output-format stream-json "<prompt>"`
- **cursor-agent 的 stream-json 输出**中可看到：
  - `tool_call` / `started`：`"name":"task_research-long_running"`，`"providerIdentifier":"task_research"`，`"toolName":"long_running"` → 说明已加载 MCP 并决定调用该工具。
  - `tool_call` / `completed`：`"rejected":{"reason":"User rejected MCP: task_research-long_running",...}` → 说明在**发起到 MCP 的 HTTP 请求之前**，工具调用已被本地「用户确认」层拒绝。
- 因此 **MCP 服务端始终未收到本次 tools/call**，日志中不会出现 `[MCP Tasks] long_running createTask`。

结论：**原因已明确**——非交互下缺少「批准此次 MCP 工具调用」的步骤；`--approve-mcps` 只批准加载 MCP，不批准单次工具执行。

---

## 3. 建议的手动验证步骤

1. **终端 1**：启动 MCP 服务并保留在前台，便于看日志  
   ```bash
   cd packages/happy-cli && node scripts/mcp-task-research.mjs
   ```
2. 记下打印出的 **临时目录** 和 **cursor-agent 命令**（含 `--workspace`、`--approve-mcps`、`--trust`）。
3. **终端 2**：在**同一机器**执行打印出的 cursor-agent 命令（可先不改动）。
4. 观察：
   - **终端 1**：是否出现 `[MCP Tasks] long_running createTask` 和约 5s 后的 `[MCP Tasks] long_running completed`。
   - **终端 2**：cursor-agent 是否调用了 `long_running`、是否等待约 5s 后拿到结果并回复一句总结。

若终端 1 出现 createTask/completed，且终端 2 有对应工具调用与回复，即可确认 **cursor-agent 在本环境下会调用该 MCP 的 task 工具**。  
若希望进一步区分「是否带 `task` 参数、是否轮询 tasks/get 或 tasks/result」，需对 MCP 的 HTTP 请求做抓包或服务端请求日志（例如记录每条请求的 `method` 与 `params.task`）。

---

## 4. `--force` 确认（脚本/非交互下打通）

命令：`cursor-agent --workspace <tempDir> --approve-mcps --trust --force --print --output-format stream-json "Call the tool long_running with label test. ..."`

- **MCP 服务端**：出现 `[MCP Tasks] long_running createTask taskId=... label=test`，约 5s 后 `[MCP Tasks] long_running completed taskId=...`。
- **cursor-agent**：`tool_call`/completed 为 `result.success`，`content[].text.text` 为 `"Long run finished (label: test)."`，并回复用户一句总结。
- **结论**：非交互下加 **`--force`** 即可让 MCP 工具调用被放行，请求到达 MCP、拿到结果并完成对话。

---

## 5. 复现 curl 验证（可选）

```bash
# 终端 1
cd packages/happy-cli && node scripts/mcp-task-research.mjs
# 记下端口，例如 51376

# 终端 2（替换 PORT）
curl -s -X POST "http://127.0.0.1:PORT" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"long_running","arguments":{},"task":{"ttl":60000}}}'
# 应返回 SSE 形式的 CreateTaskResult；约 5s 后终端 1 出现 completed
```
