# MCP Tasks 调研：用临时目录 + cursor-agent 验证轮询支持

用临时目录起一个仅带 **MCP Tasks**（task-augmented tool）的 MCP 服务，再在该目录下跑 **cursor-agent**，观察其是否带 `task` 参数调用工具、是否轮询 `tasks/get` / `tasks/result`，以判断能否更好支持我们的「子 agent 轮询」场景。

---

## 1. 运行方式

在 **packages/happy-cli** 下执行：

```bash
cd packages/happy-cli
node scripts/mcp-task-research.mjs
```

脚本会：

1. 启动一个 HTTP MCP 服务（端口随机），提供**一个** task-augmented 工具：`long_running`。
2. 在系统临时目录下创建 `.../cursor-mcp-task-research-XXXX/.cursor/mcp.json`，指向该 MCP 的 URL。
3. 在终端打印：**如何在临时目录下运行 cursor-agent** 的完整命令。

可选：自动拉起 cursor-agent：

```bash
node scripts/mcp-task-research.mjs --spawn
```

（需已安装 `cursor-agent` 且在 PATH，或设置 `CURSOR_AGENT_PATH`。）

---

## 2. MCP 服务行为

- **工具**：`long_running`（`taskSupport: 'optional'`）。
  - 若客户端在 `tools/call` 里带 `task: { ttl }`：服务端立即返回 **CreateTaskResult**（taskId、status、pollInterval），约 5 秒后在后台写入结果，客户端应通过 **tasks/get** 或 **tasks/result** 取结果。
  - 若客户端不带 `task`：SDK 会走 **handleAutomaticTaskPolling**，服务端内建轮询直到任务结束，再把最终 **CallToolResult** 一次返回（等价于「同步等 5 秒」）。
- **能力**：声明 `tasks.requests.tools.call`，以便支持 task-augmented 的 `tools/call`。

---

## 3. 观察要点（是否更好支持轮询）

在运行脚本的终端可看到：

| 日志 | 含义 |
|------|------|
| `[MCP Tasks] long_running createTask taskId=...` | cursor-agent 调用了 `long_running`；若此时**没有**长时间阻塞就继续有输出，说明很可能带了 `task`，我们返回了 CreateTaskResult。 |
| 约 5 秒后 `[MCP Tasks] long_running completed taskId=...` | 服务端已写入任务结果。若 cursor-agent 支持轮询，应在此前后去调 `tasks/get` 或 `tasks/result` 并拿到结果。 |

若 cursor-agent **支持 MCP Tasks**：

- 会发送 `tools/call` 且 **params 里带 `task`**；
- 收到 CreateTaskResult 后，会再发 **tasks/get** 或 **tasks/result** 取结果；
- 用户最终会看到模型用「Long run finished」之类的话回复。

若 **不支持**：

- 可能仍会发 `tools/call` 但**不带** `task`，则服务端走自动轮询，约 5 秒后一次返回结果（用户仍能收到回复，但无法据此判断是否「先返回 task 再轮询」）；
- 或根本不识别该工具 / 报错。

如需确认是否发了 **tasks/get** / **tasks/result**，可对 MCP 的 HTTP 请求抓包（例如用代理记录请求 path/body），或临时在 SDK 的 request 入口打日志看 `method`。

---

## 4. 与 Happy 子 agent 的关系

若本次调研得到「cursor-agent 会带 `task` 调用并轮询 tasks/get、tasks/result」，则我们可以在 Happy MCP 上把 **spawn_subagent** 做成 **task-augmented** 工具：

- 客户端带 `task` 调用 → 我们立即返回 CreateTaskResult；
- 子 agent 在后台跑，结束时我们往 taskStore 写入结果；
- cursor-agent（或宿主）负责轮询并取结果、注入给主 agent，从而**减少或替代**当前「主 agent 必须主动轮询 get_subagent」的约束，更好支持轮询体验。

若 cursor-agent 当前**不支持** Tasks，则继续沿用现有「spawn_subagent + get_subagent 轮询」方案，本次脚本仍可作为后续 MCP Tasks 客户端支持时的回归验证环境。

---

## 5. 依赖与路径

- **Node**：>= 18（与 MCP SDK 一致）。
- **运行目录**：必须在 **packages/happy-cli**，以便 `node_modules` 能解析 `@modelcontextprotocol/sdk` 和 `zod`。
- **cursor-agent**：用于 `--spawn` 或按打印命令手动执行；需已安装或设置 `CURSOR_AGENT_PATH`。
