# App 1.5.0 计时器与生命周期（仓库历史）

从 slopus/happy 仓库历史追到的结论，便于 CLI 兼容商店版 1.5.x。

## 1.5.0 对应提交

- **e87aa71** (2025-09-12): `ref: update some native libraries`，将 `app.config.js` 的 version 从 1.4.1 改为 **1.5.0**，runtimeVersion 17。
- 当时代码在 **sources/sync/**（后来才迁到 packages/happy-app/sources/sync/）。

## 两种不同的「计时器」

1. **Turn 级 / thinking 计时器**  
   - UI：整轮「思考中」的指示（例如顶部或 session 的 thinking 状态）。  
   - 在 1.5.0 里**只**由 **ephemeral activity**（`session-alive` 的 thinking）更新，**不**看消息里的 task_complete / turn-end。  
   - 对应 CLI：`keepAlive(thinking, 'remote')`。

2. **Per-tool 计时器（每个 tool 卡的 running 状态）**  
   - UI：单个 tool 的「执行中」转圈/计时。  
   - 在 1.5.0 里由 **reducer Phase 3** 驱动：收到 **tool-result** 消息（`role: 'agent'`，`content[].type === 'tool-result'`，`tool_use_id` 与之前的 tool-call 的 id 一致）时，把对应 tool 的 state 从 `running` 改为 `completed`，计时才停。  
   - **与 keepAlive / thinking 无关**；只认「归一化后的 tool-result 消息 + tool_use_id 匹配」。

所以：**你看到的「toolcall 计时不停」是 per-tool 计时器，停下来的条件是「收到并归一化出 tool-result，且 tool_use_id 能对上」**，不是 turn 级的 thinking/keepAlive。

## 1.5.0 的 sync：不按消息改 thinking

在 e87aa71 的 `sources/sync/sync.ts` 里：

- **handleUpdate（new-message）** 只做：解密 → normalizeRawMessage → applyMessages；更新 session 的 `updatedAt`、`seq`。  
- **没有**对 `task_complete`、`turn-end`、`contentType`、`sessionEventType` 的判断，也**不会**根据任何消息设置 `thinking: false`。  
- thinking 唯一来源是 **ephemeral activity**（handleEphemeralUpdate → ActivityUpdateAccumulator → flushActivityUpdates → applySessions 里写 `thinking` / `thinkingAt`）。

因此：**keepAlive(false)** 只影响 **turn 级/thinking 计时器**，**不会**停 per-tool 的 tool 卡计时。

## 1.5.0 的 per-tool 计时：reducer Phase 3 + typesRaw

- **reducer**（e87aa71）：Phase 3 遍历 `nonSidechainMessages`，若 `msg.role === 'agent'` 且 `c.type === 'tool-result'`，则 `messageId = state.toolIdToMessageId.get(c.tool_use_id)`，找到后把对应 message 的 `tool.state` 设为 `'completed'`（或 error）。  
- **toolIdToMessageId** 是在处理 **tool-call** 时写的（Phase 2，`state.toolIdToMessageId.set(c.id, mid)`），所以 **tool_use_id 必须和当时 tool-call 的 id 一致**。

1.5.0 的 **typesRaw**（见 slopus/happy 提交 e87aa71 的 `sources/sync/typesRaw.ts`）：

- **output**：有 assistant（tool_use → tool-call，id 用 `c.id`）和 user（tool_result → tool-result，`tool_use_id: c.tool_use_id`）。output 的 assistant/user **都要** `raw.content.data.uuid`，否则 return null。
- **codex**：schema 要求 **必填 `id`**：
  - `tool-call`：`callId`, `input`, `name`, **`id`**（z.string()，缺一不可）
  - `tool-call-result`：`callId`, `output`, **`id`**
  归一化时用 `raw.content.data.callId` 作为 tool-call 的 id、tool-result 的 tool_use_id，不依赖 uuid。**CLI 必须同时发 `id` 与 `callId`（同值）才能通过 1.5.0 的 zod 校验，否则消息被丢弃。**

因此：要让 1.5.0 的 **tool 计时**停下，必须让 App 收到一条能归一化成 **role: 'agent' + content[].type === 'tool-result' + tool_use_id** 的消息，且该 **tool_use_id** 与之前某条 **tool-call** 的 **id** 一致（要么都走 output，要么都走 codex，id 体系一致）。

## CLI 侧当前行为与建议

- **Turn 级计时**：已做 `keepAlive(false, 'remote')` 并在 flush 前调用，对 1.5.0 的 thinking 计时器有效；对 per-tool 无影响。  
- **Per-tool 计时**：我们发的是 **output** 的 tool_use（assistant）和 tool_result（user），且带 uuid。  
  - 若商店 1.5.0 的 typesRaw 与 e87aa71 一致，output 的 tool_result 会归一化成 tool-result，且 reducer 用 `tool_use_id` 匹配；**前提**是 tool-call 和 tool-result 的 id 一致（我们已用 `msg.callId`）。  
  - 若商店版仍不停，可能原因：消息顺序（tool_result 先于 tool_use 到达）、商店 build 与 e87aa71 的 output/codex 分支不一致、或 id 字段名/取值不一致。可再排查是否需**同时发 codex** 的 tool-call 和 tool-call-result（与 89b8e1b 的结论一致），以便只认 codex 的 build 也能停 per-tool 计时。

## 后续版本（bb7a117 及以后）

- handleUpdate 里增加了按 **message 内容** 的 lifecycle（contentType / dataType / sessionEventType），用 task_complete、turn-end 设置 `thinking: false`。  
- 因此 **turn 级** 在新版既可被 keepAlive 停，也可被消息停；**per-tool** 仍只由 tool-result 消息停，逻辑与 1.5.0 一致。
