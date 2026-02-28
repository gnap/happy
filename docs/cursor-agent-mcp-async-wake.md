# Cursor-Agent MCP：是否有「异步等待再唤醒」机制？

## 结论：**当前没有**

- **MCP 协议**：工具调用是**单次请求-响应**，没有标准意义上的「先返回 pending，稍后由服务端推送唤醒」。
- **cursor-agent** 作为 MCP 客户端：行为上是对每次 `tools/call` 发 HTTP 请求并等待响应；未发现其支持「挂起当前调用、由服务端主动推送结果再唤醒」的机制。
- **Happy 当前做法**：用 **轮询** 模拟「异步等结果」——`spawn_subagent` 立即返回 `{id, status}`，由主 agent 主动多次调用 `get_subagent(id)` 直到 `status` 为 idle/completed/error，再基于 summary 回复用户。

---

## 1. MCP 协议侧

### 1.1 标准工具调用流程

- 客户端（cursor-agent）发：`tools/call_tool`（含 `name`, `arguments`）。
- 服务端（Happy MCP）执行 `registerTool` 注册的 handler，**等待** handler 返回后，回传：`CallToolResult`（`content[]`, `isError`）。
- 一次调用 = 一个请求、一个响应；连接在 handler 执行期间保持（HTTP 请求未结束），直到返回结果。

### 1.2 是否有「异步等待再唤醒」？

- **规范层面**：我们使用的 [Model Context Protocol](https://spec.modelcontextprotocol.io/) 标准里，工具调用是**同步**的——没有「返回 pending + 后续 server 推送结果」的官方定义。
- **SDK 使用**：`@modelcontextprotocol/sdk` 的 `mcp.registerTool(name, schema, async (args) => {...})` 要求 handler 最终 **return** 一个 `CallToolResult`；没有「先返回 pending，再通过别的方式把结果推给客户端」的 API。
- **流式 / 增量结果**：MCP 规范后续版本或扩展是否支持「流式 tool result」或「server 发起 notification」需查最新 spec；当前 Happy 使用的实现是**单次完整响应**。

因此：**在现有 MCP 协议与 SDK 下，没有内置的「异步等待再唤醒」机制**。

---

## 2. Cursor-Agent 侧

### 2.1 可见行为

- cursor-agent 通过 `mcp.json` 配置 Happy MCP（HTTP URL），在需要时向该 URL 发工具调用请求。
- 从 Happy 侧看：每次工具调用都是一次 HTTP 请求，cursor-agent 会等我们返回 HTTP 响应后才继续（没有看到「请求挂起、等我们主动 push 再恢复」的行为）。
- 我们**没有** cursor-agent 的源码或官方文档说明「支持 MCP 服务端主动唤醒」；仅能根据当前集成方式推断：**没有使用此类机制**。

### 2.2 若存在「唤醒」会怎样？

若存在「异步等待再唤醒」：

- 理想流程可以是：`spawn_subagent` 返回「pending」，主 agent 被挂起；子 agent 结束后，MCP 服务端通过某通道「唤醒」主 agent 并注入结果，主 agent 再继续。
- 当前 MCP + cursor-agent 的用法下**没有**这一通道；因此我们采用「主 agent 轮询 `get_subagent(id)`」来等价实现「等子 agent 完成再继续」。

---

## 3. Happy 当前实现（轮询模式）

| 步骤 | 行为 |
|------|------|
| 1 | 主 agent 调用 `spawn_subagent(prompt, title)` |
| 2 | Happy 立即创建子进程、发 session 协议 `tool-call-start`，并**立即**返回 `{id, status: "running"}` + 提示「请调用 get_subagent(id) 取结果」 |
| 3 | 主 agent 在后续轮次中多次调用 `get_subagent(id)`（可间隔几秒），直到 `status` 为 `idle`/`completed`/`error` |
| 4 | 主 agent 用返回的 `summary` 等字段回复用户 |

没有「挂起-唤醒」：主 agent 必须**主动轮询**才能拿到结果；若主 agent 不调用 `get_subagent`，用户就会看不到子 agent 的总结（因此我们在工具描述里强约束了「MUST call get_subagent(id)…」）。

---

## 4. 若未来要支持「唤醒」的可行方向

- **MCP 扩展**：若 MCP 规范或 Cursor 支持「流式 tool result」或「server → client 的 notification」（例如结果就绪时推送），Happy 可在子 agent 完成时向客户端推送结果，从而减少或替代轮询。
- **非 MCP 通道**：例如通过 session 协议或其它已建立的连接，在子 agent 完成时向「当前 turn 的主 agent」推送一条合成消息或事件；这需要 cursor-agent 能消费该通道并继续当前推理，目前不清楚是否支持。
- **长轮询**：在 `spawn_subagent` 的 HTTP 请求上不立即返回，而是**长轮询**（例如在 handler 内 await 子 agent 结束再返回）。这样主 agent 会「阻塞」直到子 agent 完成，等价于「同步等待」，而不是「先返回再唤醒」；且会长时间占用一个 HTTP 连接，可能有超时或资源问题。

---

## 5. MCP 协议的流式设计（补充）

MCP **有**流式相关设计，主要在这些层面：

- **传输层 (Streamable HTTP)**：支持 **SSE (Server-Sent Events)**。对一次 POST（例如 `tools/call`），服务端可返回 `Content-Type: text/event-stream`，在 SSE 流里先发多条消息（如 progress、notifications），最后再发该请求的 JSON-RPC response。客户端也可用 GET 建立 SSE，接收服务端主动推送的 requests/notifications。
- **Progress**：请求可带 `progressToken`，接收方通过 `notifications/progress` 发送进度（progress, total, message），属于增量进度通知。
- **Tools 结果**：规范里 `tools/call` 的 result 仍是**单次** `{ content, isError }`，没有定义「流式返回 tool result 内容」；但配合 SSE 可先发 progress 再发最终 response。
- **Tasks (2025-11-25, experimental)**：支持 **task-augmented** `tools/call`——客户端带 `task` 调用，服务端立即返回 `CreateTaskResult`（taskId、status、pollInterval），不返回实际结果；客户端用 `tasks/get` 轮询、`tasks/result` 取结果；服务端可发 `notifications/tasks/status`。这是协议内的「异步任务 + 轮询/通知」标准方式。

因此：**协议有流式（SSE + Progress），也有异步任务（Tasks）**；但「工具调用的流式结果内容」未在规范中定义，当前仍是一次性 result。

---

## 6. 参考

- MCP 规范：https://modelcontextprotocol.io/specification/2025-11-25/（Transports、Tools、Progress、Tasks）。
- Happy MCP 实现：`packages/happy-cli/src/claude/utils/startHappyServer.ts`（`registerTool`、spawn_subagent / get_subagent 的返回形状）。
- 子 agent 设计文档：`docs/plans/cursor-subagent-mcp-design.md`（流式结果 / server push 的提及）。
- Cursor agent MCP 配置与能力：`docs/cursor-agent-mcp.md`。
