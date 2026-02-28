# Cursor Agent 子 Agent 能力：MCP 方案与通讯机制

## 背景与目标

- **现状**：cursor-agent 可能不原生支持 subagent；Happy CLI 侧 session protocol 与 App 已支持 `subagent` 与 `start`/`stop` 生命周期。
- **目标**：通过为 cursor-agent 注册 MCP 工具实现「spawn subagent」能力，并设计主 agent、子 agent 与 CLI 之间的通讯机制，使 App 能正确展示嵌套子 agent 的会话流。

## 总体思路

1. **MCP 作为入口**：在 Happy MCP Server 上新增工具（如 `spawn_subagent`），供 cursor-agent 在需要时调用。
2. **CLI 作为枢纽**：CLI 处理该 MCP 调用时创建并运行子 agent，将子 agent 的所有输出以 session protocol 形式发送，并带上稳定的 `subagent` (cuid2)。
3. **主 agent 只收结果**：主 cursor-agent 通过 MCP 工具返回值拿到子 agent 的完成结果（或摘要）；实时流仅通过 session protocol 推给 App，主 agent 不参与流式协议。

---

## 1. MCP 工具契约

### 1.1 工具名称与用途

建议工具名：**`spawn_subagent`**（与 Claude 的 Task 语义对齐时也可在描述中说明“类似 Task 子任务”）。

| 项 | 说明 |
|----|------|
| 名称 | `spawn_subagent` |
| 描述 | 生成子 agent 执行指定任务；子 agent 的输出会在当前会话中作为嵌套内容展示，完成后将结果返回给主 agent。 |
| 调用方 | cursor-agent（需能访问 Happy MCP，见 4.1） |

### 1.2 输入 Schema（建议）

```ts
{
  prompt: string;      // 必填，发给子 agent 的初始提示
  title?: string;     // 可选，子 agent 的展示标题（对应 session ev.start 的 title）
  backend?: string;   // 可选，未来扩展：'cursor' | 'codex' | 'gemini'，默认 'cursor'
}
```

- `prompt`：子 agent 的「用户消息」，决定子任务内容。
- `title`：用于 session protocol 的 `ev.t === 'start'` 的 `title`，便于 App 展示子 agent 名称。
- `backend`：预留，默认用同一 cursor-agent 子进程；后续可支持用 Codex/Gemini 等作为子 agent。

### 1.3 返回值（工具 result）

子 agent **结束后**一次性返回给主 agent，建议结构：

```ts
{
  success: boolean;
  summary?: string;   // 简短摘要（如最后一段模型输出或 CLI 生成摘要）
  error?: string;     // success === false 时的错误信息
  output_preview?: string;  // 可选，子 agent 输出的前 N 字符，供主 agent 参考
}
```

- 主 agent 只看到这一次性结果，不参与子 agent 的流式协议。
- 若需「流式结果」回主 agent，需在 4.2 节考虑扩展（如进度事件），当前设计先采用「完成后再返回」。

---

## 2. 子 Agent 实现选项

### 2.1 选项 A：子 agent = 子进程 cursor-agent（推荐首版）

| 项 | 说明 |
|----|------|
| 实现 | 在 MCP 工具 handler 内 spawn 新的 cursor-agent 进程，同 cwd，`--print --output-format stream-json`，传入 `prompt` 作为参数。 |
| 通讯 | 子进程 stdout 为 stream-json 行；CLI 解析后转发为 session protocol envelopes，并带上本 spawn 对应的 `subagent`。 |
| 优点 | 与主 agent 同栈、同环境（同一 CLI、同一 workspace），行为一致；无需依赖其他 backend。 |
| 缺点 | 多进程；需确认 cursor-agent 在无 TTY/非交互场景下是否稳定（当前已有 `script` 包装，可复用）。 |

**与主进程的区分**：主 cursor-agent 由 `runCursor` 在每轮用户消息时 spawn；子 agent 由 MCP handler 在「主 agent 调用 spawn_subagent 时」spawn，生命周期仅在这一次工具调用内。

### 2.2 选项 B：子 agent = 现有 AgentRegistry（Codex/Gemini 等）

| 项 | 说明 |
|----|------|
| 实现 | 使用现有 `AgentBackend`：`agentRegistry.create(backend, { cwd, env })`，`startSession(prompt)`，`onMessage` 收消息并转成 session protocol。 |
| 通讯 | 通过 `AgentBackend.onMessage` 收 `AgentMessage`，在 CLI 中映射为 session envelopes（带 `subagent`）。 |
| 优点 | 复用现有 ACP/Codex/Gemini 逻辑；可在一套会话里混用不同模型。 |
| 缺点 | 子 agent 与主 agent 不同「大脑」；需处理 auth/cwd 等配置。 |

可作为 `backend === 'codex' | 'gemini'` 时的实现路径，与选项 A 并存。

### 2.3 推荐路线

- **Phase 1**：仅实现选项 A（子进程 cursor-agent），工具参数中暂不暴露 `backend`，或仅支持 `cursor`。
- **Phase 2**：若需要，增加 `backend`，对 `codex`/`gemini` 走选项 B，复用 `AgentRegistry` 与现有 session protocol 映射。

---

## 3. 通讯机制设计

### 3.1 角色与数据流

```
用户 / App
    │
    ▼
Happy Server (加密、推送)
    │
    ▼
Happy CLI ◄──────► 主 cursor-agent (stdio / 若支持则 MCP)
    │                    │
    │                    │ 调用 MCP 工具 spawn_subagent(prompt, title?)
    │                    ▼
    │              Happy MCP Server (HTTP)
    │                    │
    │                    │ 执行 spawn_subagent handler
    │                    ▼
    │              ┌─────────────────────────────────────┐
    │              │ 1. 分配 subagentId = createId()      │
    │              │ 2. 发送 session: start(turn, subagent)│
    │              │ 3. 启动子 agent（子进程或 Backend）   │
    │              │ 4. 子 agent 输出 → session envelopes  │
    │              │    全部带 subagent                    │
    │              │ 5. 子 agent 结束 → session: stop(...)│
    │              │ 6. 返回 tool result 给 MCP 调用方     │
    │              └─────────────────────────────────────┘
    │                    │
    │                    │ 子 agent 输出（stream-json 或 AgentMessage）
    │                    ▼
    │              CLI 映射为 session protocol
    │              (text, tool-call-start, tool-call-end, …)
    │              每条 envelope 带 turn + subagent
    │
    ▼
Session protocol stream → App（含 subagent 的嵌套展示）
```

### 3.2 主 agent ↔ CLI

- **cursor-agent 调用 MCP**：若 cursor-agent 支持 MCP，需在启动时配置 MCP server 为 Happy 的 HTTP MCP（或通过 STDIO bridge 代理）。当前 runCursor 已启动 `startHappyServer(session)`，仅需确保 cursor-agent 进程能连上该 MCP（见 4.1）。
- **CLI → 主 agent**：仅通过 MCP 工具返回值（请求/响应模型），主 agent 不订阅 session protocol 流。

### 3.3 子 agent ↔ CLI

- **选项 A（子进程 cursor-agent）**：
  - CLI 与子 agent 通讯 = 子进程 stdin/stdout。
  - 输入：子进程启动时把 `prompt` 作为参数传入（与当前主 agent 的 `cursorProc.run(prompt)` 一致）。
  - 输出：子进程 stdout 的 stream-json 行，CLI 用与 `runCursor` 相同的解析逻辑（或复用 `CursorProcess`/`CursorMessageParser`）得到事件，再映射为 session protocol。
- **选项 B（AgentBackend）**：
  - CLI 与子 agent 通讯 = `AgentBackend` API：`startSession(prompt)`、`onMessage(cb)`、`waitForResponseComplete()` 等。
  - 输出：在 `onMessage` 里将 `AgentMessage` 转为 session envelopes（带 `subagent`），与 Codex/Claude 现有做法一致。

### 3.4 CLI → Session Protocol（含 subagent）

- 每个 `spawn_subagent` 调用对应一个 **稳定的 subagent id**：`subagentId = createId()`（cuid2），仅在此次调用内使用。
- **生命周期**：
  - 在启动子 agent 前：发送 `createEnvelope('agent', { t: 'start', title?: title }, { turn, subagent: subagentId })`。
  - 子 agent 运行期间：所有 text、tool-call-start、tool-call-end 等均带 `{ turn, subagent: subagentId }`。
  - 子 agent 结束时：发送 `createEnvelope('agent', { t: 'stop' }, { turn, subagent: subagentId })`。
- **turn**：使用**当前主 agent 的 turnId**（即触发 spawn_subagent 的那一轮），保证主/子同属一个 turn，App 可正确嵌套。

### 3.5 错误与取消

- **子 agent 超时**：可配置超时（如 30 分钟），超时则 kill 子进程/结束 Backend，发送 `stop`，工具返回 `success: false, error: 'Timeout'`。
- **主 agent 被用户 abort**：若主 agent 所在 turn 被 abort，应尽快终止正在运行的子 agent（kill 子进程或 backend.cancel），并仍发送该 subagent 的 `stop`，避免 App 状态不一致。
- **子 agent 崩溃**：子进程异常退出或 Backend 报错时，发送 `stop`，工具返回 `success: false, error: <message>`。

---

## 4. 实现要点（Happy CLI 侧）

### 4.1 让 cursor-agent 能调用 Happy MCP

当前 `runCursor` 已调用 `startHappyServer(session)`，但 **cursor-agent 进程并未配置使用该 MCP**。需要二选一或兼有：

- **方式 1（HTTP）**：若 cursor-agent 支持通过配置或环境变量指定 MCP server URL，则把 `happyServer.url` 注入到 cursor-agent 的启动环境（例如 `HAPPY_MCP_URL` 或 Cursor 的 MCP 配置）。
- **方式 2（STDIO bridge）**：若 cursor-agent 只支持 STDIO MCP，则沿用 Codex/Gemini 的 happy-mcp STDIO bridge：用 `HAPPY_HTTP_MCP_URL` 启动 bridge，cursor-agent 的 MCP 配置指向该 bridge 的 stdio；bridge 再转发到 Happy HTTP MCP。

具体以 Cursor 官方文档/能力为准；若当前版本尚不支持 MCP，本设计在「cursor-agent 支持 MCP 之后」即可按上述方式接入。

### 4.2 Happy MCP Server 扩展（startHappyServer）

- **新增工具**：`spawn_subagent`，inputSchema 与返回值见 1.2、1.3。
- **Handler 依赖**：handler 内需要：
  - `session`：`ApiSessionClient`，用于发送 session protocol（`sendSessionProtocolMessage` / `sendSessionLifecycleEnvelope` 等）。
  - **当前 turnId**：因为 MCP 是长驻的，而 turn 每轮用户消息一个，需要从「当前运行中的 runCursor 轮次」获取。可选做法：
    - 在 `runCursor` 里将 `getCurrentTurnId(): string | null` 和 `sendSessionEnvelope(envelope)` 通过某种上下文传给 `startHappyServer`（例如 `HappyServerOptions.cursorContext`），仅在使用 cursor 时传入；
    - 或由 `startHappyServer` 接受可选 `context: { getCurrentTurnId, sendSessionEnvelope }`，在注册 `spawn_subagent` 时使用该 context。
- **并发**：同一 turn 内主 agent 可能多次调用 `spawn_subagent`（串行或理论上的并行）。若并行，每个调用各自一个 subagentId，互不干扰；若 MCP 是单请求单会话，则通常为串行调用。

### 4.3 子 agent 运行与协议发送（选项 A）

- **复用/抽取**：从 `runCursor` 中抽取「运行单次 cursor-agent 并解析 stream-json → session protocol」的逻辑（可复用 `CursorProcess`、`CursorMessageParser`），在 MCP handler 内：
  - 创建 `subagentId = createId()`；
  - 发送 `start` envelope；
  - 创建子 cursor-agent 进程，传入 `prompt`，解析 stdout，对每条解析出的事件发送 session envelope（带 `turn`, `subagent`）；
  - 子进程结束后发送 `stop` envelope；
  - 汇总最后输出或生成 summary，作为工具 result 返回。
- **cwd/env**：与主 agent 一致（例如 `workspacePath`、当前 env），由 runCursor 或调用方传入 handler。

### 4.4 与 runCursor 的集成

- **传入 context**：在 `runCursor` 中调用 `startHappyServer(session, { cursorContext: { getCurrentTurnId, sendSessionEnvelope, workspacePath, abortSignal } })`，这样 `spawn_subagent` 能拿到当前 turn 和发送入口。
- **Abort 传播**：用户 abort 主 agent 时，应取消正在执行的子 agent（若有）；可在 context 中提供 `abortSignal`，MCP handler 在 spawn 子进程时传入，或在收到 abort 时 kill 子进程。

### 4.5 Session protocol 映射（子 agent 输出）

- 子 agent 若为 cursor-agent（选项 A），其 stream-json 与主 agent 相同，可直接复用 `CursorMessageParser` 的解析结果，再复用或仿照 `cursor/sessionProtocolMapper.ts` 的映射规则，对每条生成 `createEnvelope(..., { turn, subagent })`。
- 子 agent 若为 Codex/Gemini（选项 B），复用现有 Codex/Claude session protocol mapper，在生成 envelope 时统一加上 `subagent` 即可。

---

## 5. 可选扩展

- **流式结果回主 agent**：若希望主 agent 在子 agent 未结束前就收到进度（例如「子 agent 已找到 3 个文件」），需在 MCP 之外定义进度通道（例如另一工具 `spawn_subagent_status` 或 server push），或使用支持流式 tool result 的 MCP 扩展；当前设计不依赖该能力。
- **子 agent 的「子 agent」**：若子 agent 也是 cursor-agent 且能调用同一 MCP，则可在子进程内再次调用 `spawn_subagent`，形成多层嵌套；每层分配新的 subagentId，session protocol 已支持同一 turn 下多 subagent，App 侧需支持多层嵌套展示（若尚未支持可后续迭代）。

---

## 6. 文档与依赖

- Session protocol：`docs/session-protocol.md`（subagent、start/stop、turn）。
- Happy MCP：`packages/happy-cli/src/claude/utils/startHappyServer.ts`，Codex STDIO bridge：`packages/happy-cli/src/codex/happyMcpStdioBridge.ts`。
- Cursor 运行与解析：`packages/happy-cli/src/cursor/runCursor.ts`、`cursorProcess.ts`、`cursorMessageParser.ts`。

---

## 7. 小结

| 项目 | 结论 |
|------|------|
| 入口 | 在 Happy MCP Server 上新增 `spawn_subagent` 工具，供 cursor-agent 调用。 |
| 子 agent 首版 | 子进程 cursor-agent，同 cwd，stream-json 解析后转 session protocol。 |
| 通讯 | 主 agent 仅通过 MCP 工具返回值获知结果；子 agent 与 CLI 通过子进程 stdout（或 Backend API）通讯；CLI 将子 agent 输出统一带上 `subagent` 发往 session protocol。 |
| 生命周期 | 每次 spawn 分配一个 cuid2 subagentId，先发 start，中间所有事件带 subagent，最后发 stop。 |
| 前置条件 | cursor-agent 需能配置并连接 Happy MCP（HTTP 或 STDIO bridge）。 |

此方案在不依赖 cursor-agent 原生 subagent 支持的前提下，通过 MCP 与既有 session protocol 实现子 agent 的生成与展示，并为后续使用 Codex/Gemini 作为子 agent 预留扩展点。
