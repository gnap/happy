# Tool call / MCP 超时处理参考

本文档汇总 Happy CLI 中各路径对 tool call、MCP 的超时处理，以及可借鉴的做法。  
「Claude CLI」指调用我们 MCP 的客户端（如 Claude Code / cursor-agent），其超时行为不在本仓库内，仅就已知与可配置项说明。

---

## 1. Cursor 路径（Happy 完全控制）

我们 spawn cursor-agent，解析 stream-json，并**自己**把每次 tool_call_start 映射为「工具开始」、tool_call_end 为「工具结束」。因此超时策略在 `runCursor.ts` 和 `cursorProcess.ts` 里实现。

### 1.1 两层超时

| 层级 | 环境变量 | 默认值 | 行为 |
|------|----------|--------|------|
| **进程级** | `CURSOR_AGENT_PROCESS_TIMEOUT_MS` | `3600000`（1 小时） | 整个 cursor-agent 进程运行超过此时长则被 kill。设为 `0` 可禁用。在 `CursorProcess` 里用 `setTimeout` 到期调用 `this.kill()`。 |
| **单次工具调用** | `CURSOR_TOOL_CALL_TIMEOUT_MS` | `600000`（10 分钟） | 从 `tool_call_start` 起，若在此时长内没有收到 `tool_call_end`，则**不杀进程**，只做「超时收尾」：发 `tool_call_end` + 合成 result（running in background），让 App 停止计时、对话继续；cursor-agent 进程继续跑。**设为 `0` 则禁用单次 tool 超时（Codex 风格）**：不设 per-tool  cutoff，仅依赖进程级超时或自然 `tool_call_end`。 |

### 1.2 单次 tool 超时时的具体逻辑（runCursor.ts）

- 每个 `tool_call_start` 时：`setTimeout(perToolTimeoutMs)`，把 handle 存到 `toolCallTimeoutHandles`。
- 超时触发时：
  - 从 map 里删掉该 call 的 handle；
  - 向 session 发「running in background」的 tool result（output + codex/cursor 双写）；
  - 发 session protocol 的 `tool-call-end`，让 App 停止该工具的计时、UI 显示「仍在后台运行」；
  - **不** kill cursor-agent，对话可继续，后续若 cursor-agent 再发该 call 的 tool_call_end，仍会再写一次 result（可能重复，但不会卡死）。
- 若在超时前收到 `tool_call_end`：`clearTimeout` 对应 handle，正常写 result、发 tool-call-end。

### 1.3 可借鉴点

- **进程超时**：防止单轮对话无限跑，用环境变量可调/可关。
- **单 tool 超时**：不杀进程，只「结束本轮工具等待」并给一个占位 result，避免长时间工具拖死整轮；用户仍能看到「还在跑」的提示。

---

## 2. Claude 路径（Happy 作为 MCP 服务端）

在 Claude 模式下，**工具执行**发生在 Claude Code 进程内：Claude Code 通过 HTTP 调用我们的 Happy MCP（startHappyServer），我们的 handler 同步返回（如 change_title、spawn_subagent 立即返回 id）。  
因此：

- **Happy MCP 服务端**：没有对单个 tool 请求设「最大执行时间」；handler 若 `await` 很久（例如若改成「等子 agent 结束再返回」），HTTP 连接会一直挂着，直到客户端断开或我们主动超时（当前未实现）。
- **Hook 服务**（startHookServer）：对 `/hook/session-start` 的 POST 设了 **5 秒** 超时，防止 Claude 不关 stdin 导致请求一直挂；超时则 408 + `clearTimeout`。
- **API 会话**（apiSession）：  
  - `fetchMessages`：`timeout: 60000`（1 分钟）；  
  - `flushOutbox`：`timeout: 120000`（2 分钟），超时视为可重试（ECONNABORTED + 重试次数未满则重试）。

「Claude CLI」作为**调用我们 MCP 的客户端**，其 HTTP 超时不在本仓库；通常 HTTP 客户端会有默认超时（例如 2–5 分钟），若我们的 MCP 某次 tool 调用长时间不返回，会由**客户端**先超时断开。

### 2.1 若要在 Happy MCP 侧加 tool 超时

- 可在 `startHappyServer.ts` 的 tool handler 外包一层：用 `Promise.race(handler(args), AbortSignal.timeout(ms))` 或 `setTimeout` + reject，超时则返回 `{ content: [{ type: 'text', text: 'Tool call timed out after Ns' }], isError: true }`，避免无限挂住。
- 对 `spawn_subagent`：当前设计是立即返回 id，由主 agent 轮询 `get_subagent`，故**不会**长时间占用一次 HTTP 请求；若将来改成「长连等子 agent 结束再返回」，则需要配合客户端超时或我们自己的超时，否则容易与「Claude CLI」的 HTTP 超时冲突。

---

## 3. Codex 路径（Happy 作为 MCP 客户端）

Happy 通过 Codex MCP Client 调用 Codex 的 MCP 工具（如 `codex`、`codex-reply`）。  
在 `codexMcpClient.ts` 中，`client.callTool` 使用了：

- `timeout: DEFAULT_TIMEOUT`，其中 `DEFAULT_TIMEOUT = 14 * 24 * 60 * 60 * 1000`（14 天），即单次 tool 调用几乎不因「时间到」而失败，仅受 `signal`（如用户取消）影响。

因此 Codex 路径下，**tool call 超时**主要由外部 AbortSignal 或 Codex 服务端决定，Happy 侧没有短超时。

---

## 4. 小结与对照

| 路径 | 谁发 tool call | 进程/轮次超时 | 单次 tool 超时 | 超时后行为 |
|------|----------------|----------------|----------------|------------|
| **Cursor** | cursor-agent（我们解析 stream-json） | 有，进程级 1h，可配/可关 | 有，单 tool 10min，可配 | 不杀进程；发「running in background」+ tool-call-end，对话继续 |
| **Claude** | Claude Code 调我们 Happy MCP | 无（我们未杀 Claude 进程） | 我们 MCP 未设；客户端 HTTP 超时未知 | 若我们 handler 长时间不返回，大概率客户端先超时断开 |
| **Codex** | Happy 调 Codex MCP | 无 | 14 天（等效无） | 仅 AbortSignal 可提前取消 |

**参考 Cursor 的做法**可用于：  
- 在**其他 agent 路径**若我们也「解析并驱动」tool 生命周期，可引入类似的**进程级 + 单 tool 级**超时；  
- 单 tool 超时后**不杀主进程**、只结束「等待该 tool」并给占位结果，能避免长时间 tool 拖死整轮对话。

**参考 Codex 的做法（单 tool 不设短超时）**：  
- Codex 路径下我们对 Codex MCP 的 `callTool` 使用 14 天超时，等效不因「时间到」掐断单次 tool。  
- Cursor 路径已支持 **Codex 风格**：设置 `CURSOR_TOOL_CALL_TIMEOUT_MS=0` 即**禁用 per-tool 超时**，单次 tool 只会在进程超时或收到 `tool_call_end` 时结束，适合长时间构建等场景。

若需对齐「Claude CLI」官方行为，需查阅 Anthropic / Claude Code 文档或源码中关于 **tool call / MCP HTTP 超时** 的说明。
