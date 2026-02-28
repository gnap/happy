# MCP 协议的流式设计

基于 [MCP 规范 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/)，协议**有**流式相关设计，主要体现在以下几部分。

---

## 1. 传输层：Streamable HTTP + SSE

- **Streamable HTTP** 是标准传输之一（另一为 stdio）。
- 支持 **Server-Sent Events (SSE)**：
  - 客户端发 **POST**（例如 `tools/call`）时，服务端可以返回 `Content-Type: text/event-stream`，**不**立即返回一个 JSON，而是打开一条 **SSE 流**。
  - 在该流上，服务端可以：
    - 先发送多条 SSE 事件（例如 JSON-RPC 的 **requests**、**notifications**）；
    - 最后再发送对该 POST 的 **JSON-RPC response**。
  - 因此**同一次请求**可以对应「多条流式消息 + 一条最终响应」。
- 客户端还可以发 **GET** 到同一 MCP endpoint，建立一条**独立的 SSE 连接**，用于接收服务端**主动推送**的 requests 和 notifications（与某次 POST 无关）。
- 规范还允许服务端在发送完部分事件后**关闭连接**，由客户端带 `Last-Event-ID` **重连**继续拉取（resumability），并建议用 `retry` 字段指导重连间隔。

**结论**：传输层支持「一次调用、多条 SSE 消息、最后一条为 response」，以及「服务端主动推送」。

---

## 2. Progress 进度通知

- 请求的 `params` 里可带 `_meta.progressToken`。
- 接收方在执行过程中可发送 **`notifications/progress`**，携带：
  - `progressToken`（与请求一致）
  - `progress` / `total` / `message`
- 用于长耗时操作的**增量进度**，属于流式/渐进式信息。

规范见：[Progress](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/progress.md)。

---

## 3. 工具调用 (tools/call) 与「流式结果」

- **工具结果形态**：规范中 `tools/call` 的 **Response** 是单次 `result: { content[], isError }`，没有定义「tool result 内容分块流式返回」的格式。
- **与 SSE 结合**：若服务端对 `tools/call` 的 POST 使用 SSE 响应，则可以在流里：
  - 先发若干条 `notifications/progress` 或其它 notifications；
  - 最后发该 `tools/call` 的 JSON-RPC response。
- 因此：**流式进度**有规范支持；**流式 tool result 内容**（例如一段段 text）没有在规范里单独定义，实现上可依赖 SSE 通道自行约定。

---

## 4. Tasks（异步任务，2025-11-25 实验性）

- 支持 **task-augmented** 请求：例如 `tools/call` 时在 params 里加 `task: { ttl }`。
- 服务端**立即**返回 **CreateTaskResult**（含 `taskId`、`status`、`pollInterval` 等），**不**返回实际工具结果。
- 客户端通过：
  - **tasks/get**：轮询任务状态；
  - **tasks/result**：在任务终态后拉取最终结果（与普通 `tools/call` 的 result 结构一致）。
- 服务端**可**发送 **notifications/tasks/status** 通知状态变化（可选，客户端不得依赖）。
- 可与 **Progress** 结合：同一请求的 `progressToken` 在整个 task 生命周期内有效。

这是协议内标准的「异步执行 + 轮询/通知取结果」机制，不是「流式内容」，但属于「延迟返回」的官方设计。

规范见：[Tasks](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks.md)。

---

## 5. 小结

| 能力 | 是否有流式/相关设计 | 说明 |
|------|---------------------|------|
| 传输 | ✅ | Streamable HTTP + SSE：一次请求可对应多条 SSE 消息 + 最终 response；支持服务端主动推送（GET SSE）。 |
| 进度 | ✅ | `notifications/progress`：增量进度通知。 |
| 工具结果内容 | ⚠️ | 规范只定义单次 `result`；流式内容可借 SSE 自行约定。 |
| 异步/延迟返回 | ✅ | Tasks：task-augmented 请求立即返回 task，结果通过 tasks/get、tasks/result 及可选 status 通知获取。 |

**直接回答「MCP 协议有流式的设计吗」**：**有**。流式主要体现在 **传输层（SSE）** 和 **Progress**；工具调用的**结果内容**在规范里仍是单次返回，但可通过 SSE 和 Tasks 实现「先返回 task/进度，再取最终结果」或自定义流式内容。

---

## 6. 能否解决我们的问题？（子 agent 不等轮询、不丢回复）

**我们的问题**：`spawn_subagent` 立即返回，主 agent 必须**主动轮询** `get_subagent(id)` 才能拿到结果；若主 agent 不轮询，用户就收不到子 agent 的总结（“no reply”）。

| 机制 | 能否解决 | 条件 / 说明 |
|------|----------|-------------|
| **MCP Tasks** | **有可能** | 若 **cursor-agent（或 Cursor 宿主）支持** task-augmented `tools/call`，并实现：对带 `task` 的调用先返回 CreateTaskResult，由**系统**轮询 `tasks/get`、`tasks/result`，在任务完成后把结果注入为本次工具调用的结果，则主 agent **不需要**自己轮询，相当于「异步等待再唤醒」。**当前我们不知道 cursor-agent 是否支持 Tasks**，需查文档或实测。 |
| **SSE 长连不关** | 理论可行、风险大 | 对 `spawn_subagent` 的 POST 不立即返回，在 handler 里 `await` 子 agent 结束再返回完整 result。这样一次调用就拿到结果、无需轮询。但 HTTP 连接会保持到子 agent 跑完（可能几分钟），容易遇超时、连接限制；且 cursor-agent 的 HTTP 客户端未必支持「长连等单次响应」。 |
| **SSE 服务端推送** | 取决于客户端 | 我们立即返回 pending，子 agent 完成后通过 GET SSE 通道推送「工具结果」。需要 cursor-agent 能接收这条推送并把它关联到之前的 `spawn_subagent` 调用、作为该次工具调用的结果交给主 agent。目前不清楚 cursor-agent 是否支持这种「服务端推送的 tool result」。 |
| **当前轮询 (get_subagent)** | 已在使用 | 不依赖 cursor-agent 新能力，主 agent 必须按提示轮询；通过工具描述强约束「MUST call get_subagent(id)…」降低漏调概率。 |

**结论**：  
- **若 cursor-agent 支持 MCP Tasks 且宿主会替 agent 轮询并注入结果**：可以改用 task-augmented 的 spawn 工具，**能解决**「主 agent 不轮询就无回复」的问题。  
- **若不支持**：MCP 的流式/Tasks 设计**不能直接解决**我们的问题，仍需依赖当前「轮询 get_subagent + 强描述」方案；可选尝试「长连不关」或「服务端推送」，但都依赖客户端行为，需验证。
