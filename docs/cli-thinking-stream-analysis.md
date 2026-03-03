# CLI thinking 流处理分析

## 目标

在保留「状态提示」（例如「思考中」「思考开始时间」）的前提下，评估各 CLI 的 thinking 消息流对消息列表与 UI 渲染的压力，以及 thinking 流本身的必要性。

---

## 1. 当前各 CLI 行为对比

### 1.1 状态提示（保留）

所有 CLI 都通过 **keepAlive(thinking, 'remote')** 驱动 App 的「思考状态」：

- Socket 发送：`session-alive`（volatile），payload 含 `thinking: boolean`
- App：`session.thinking` / `session.thinkingAt` 由 sync 层根据 task 生命周期（task_started / task_complete、turn-start / turn-end）或 session-alive 更新
- UI：会话详情等可显示「思考中」「思考开始时间」

**结论**：状态提示不依赖 thinking 内容流，只依赖「是否在思考」的布尔 + 时间，当前设计已满足。

---

### 1.2 Cursor（runCursor.ts）

| 环节 | 行为 | 对消息/UI 的影响 |
|------|------|-------------------|
| 解析 | cursor-agent 流式输出 `thinking` → 解析为 **thinking_delta**（每 chunk 一条） | - |
| CLI 本地 UI | 每个 thinking_delta → `messageBuffer.updateLastMessage('[Thinking] ' + text.slice(0,100) + '...', 'system')` | 仅更新最后一条，压力小 |
| 发往 App | **每个 thinking_delta** → `session.sendCursorMessage({ type: 'thinking', text: msg.text })` | 每条 delta 一条消息上送 |
| 协议 | 走 Cursor 通道：content.type = `'cursor'`, content.data = `{ type: 'thinking', text }` | App 端每条都会进 raw → normalize → reducer |
| App 归一化 | typesRaw：cursor 的 thinking → `content: [{ type: 'thinking', thinking: text }]`，每条一条 NormalizedMessage | 消息列表里 thinking 条数 = delta 条数 |
| App reducer | 60s 内同 turn 的 thinking 会 **merge 到同一条**（lastThinkingMessageId + THINKING_MERGE_WINDOW_MS） | 减轻气泡数，但每条 delta 仍触发一次 reducer 与一次消息更新 |

**结论**：Cursor 是 **按 delta 流式上送 thinking**，消息条数多、reducer 与 UI 更新频繁，对消息流和渲染压力最大。

---

### 1.3 Codex（runCodex.ts + sessionProtocolMapper）

| 环节 | 行为 | 对消息/UI 的影响 |
|------|------|-------------------|
| MCP | `agent_reasoning_delta` / `agent_reasoning`（整段）/ `agent_reasoning_section_break` | - |
| 发往 App | **不**把 `agent_reasoning_delta`、`agent_reasoning`、`agent_reasoning_section_break` 交给 `mapCodexMcpMessageToSessionEnvelopes`（runCodex 509 行排除） | 原始 reasoning 流不上送 |
| 上送内容 | 仅 **ReasoningProcessor 回调**：当 `complete(msg.text)` 或产出 tool-call 等时，通过 `mapCodexProcessorMessageToSessionEnvelopes` 发 `{ t: 'text', text, thinking: true }` | 按「段落/节」发送，不是按 token |
| 状态 | task_started → keepAlive(true)，task_complete / turn_aborted → keepAlive(false) | 仅状态，无 reasoning 内容流 |

**结论**：Codex **不上送 reasoning 流**，只上送段落级 thinking 或由 reasoning 解析出的 tool-call；状态提示靠 task 生命周期，对消息与 UI 压力最小。

---

### 1.4 Gemini（runGemini.ts）

| 环节 | 行为 | 对消息/UI 的影响 |
|------|------|-------------------|
| 事件 | 收到 `event.name === 'thinking'`，payload 含 `text` | 每 chunk 一次 |
| CLI 本地 UI | 非 `**` 开头的 thinking → `messageBuffer.updateLastMessage('[Thinking] ' + preview + '...', 'system')` | 只更新最后一条 |
| 发往 App | **每个 thinking chunk** → `session.sendAgentMessage('gemini', { type: 'thinking', text: thinkingText })` | 每条 chunk 一条 ACP 消息 |
| 协议 | content.type = `'acp'`, content.data.type = `'thinking'` | App 端每条都会 normalize → reducer |
| App | 与 Cursor 类似：normalize 成 thinking content，reducer 内 60s 合并到同一气泡 | 仍按 chunk 触发多次更新 |

**结论**：Gemini 与 Cursor 类似，**按 chunk 流式上送 thinking**，对消息流和 UI 压力大。

---

## 2. App 端对 thinking 的使用

### 2.1 状态（已满足）

- **session.thinking / session.thinkingAt**：来自 keepAlive + 任务生命周期，用于「思考中」「思考开始时间」等状态展示。
- 不依赖 thinking 内容流。

### 2.2 消息列表与 reducer

- **typesRaw**：cursor / acp 的 thinking → `NormalizedMessage` 的 `content: [{ type: 'thinking', thinking: text }]`。
- **reducer**：同一 turn、60s 内合并到 `lastThinkingMessageId` 对应的一条，减少气泡数量；但 **每条上送的 thinking 消息仍会走一遍 reducer 与 messageIds/messages 的更新**。
- 流式 thinking 会导致：
  - 消息列表条目/更新频率高；
  - 长对话时消息表与 UI 的 diff/重绘多。

### 2.3 会话详情 UI

- 展示「思考中」和「思考开始时间」仅依赖 **session.thinking / session.thinkingAt**，不依赖具体 thinking 内容。

---

## 3. 评估：thinking 消息流的必要性

| 维度 | 保留 thinking 流 | 仅保留状态（thinking: true/false） |
|------|-------------------|------------------------------------|
| 状态提示（思考中 / 思考开始时间） | ✅ 有 | ✅ 有（keepAlive + 生命周期即可） |
| 消息列表中的「思考气泡」 | ✅ 有（可展示部分内容） | ❌ 无（或仅一条占位如「思考中…」） |
| 消息条数 / 更新频率 | 高（Cursor/Gemini 按 chunk） | 低 |
| 存储与同步 | 需存 thinking 内容，列表拉取也可能带出 | 不存/少存 thinking 内容 |
| 调试与审计 | 可回溯完整思考过程 | 仅知「曾思考」与时间段 |

**结论**：

- **状态提示**：不依赖 thinking 流，当前设计即可保持。
- **消息与 UI 压力**：主要来自 Cursor / Gemini 的「按 chunk 上送 thinking」；Codex 已证明可以只靠状态 + 少量段落级内容（或零内容）运行。
- **必要性**：若产品上不强制要求「在对话里逐条展示思考过程」，则 **thinking 内容流可视为可选**；保留「思考中」状态即可满足「让用户知道 agent 在忙」的需求。

---

## 4. 可选方案（在保持状态提示前提下）

### 4.1 方案 A：Cursor / Gemini 不再上送 thinking 内容（与 Codex 对齐）

- **Cursor**：thinking_delta 时只做本地 UI 更新（保留现有 `messageBuffer.updateLastMessage(...)`），**不再**调用 `session.sendCursorMessage({ type: 'thinking', text })`。
- **Gemini**：thinking 事件只做本地 UI + ReasoningProcessor，**不再**调用 `session.sendAgentMessage('gemini', { type: 'thinking', text })`。
- **状态**：继续用 task_started / task_complete、turn-start / turn-end 与 keepAlive(thinking) 驱动 session.thinking / session.thinkingAt。
- **效果**：消息列表不再收到 thinking 消息流，压力最小；状态提示不变。

### 4.2 方案 B：节流 / 聚合后再上送（折中）

- 例如：每 N 秒或每累积 K 字符才发一条 thinking 消息；或仅在「思考段落结束」时发一条（类似 Codex ReasoningProcessor 的 complete）。
- 状态仍由 keepAlive + 生命周期驱动。
- **效果**：仍保留部分「思考气泡」，但消息条数与更新频率明显下降。

### 4.3 方案 C：保持现状，仅优化 App 端

- 保持 Cursor/Gemini 上送逻辑不变；
- App 端：例如延长 THINKING_MERGE_WINDOW_MS、或对 thinking 消息做更激进的合并/折叠，减少渲染与 diff。
- **效果**：可减轻 UI 压力，但消息流与存储压力仍在。

---

## 5. 建议

1. **短期**：若希望快速减轻消息与 UI 压力，推荐 **方案 A**（Cursor/Gemini 不再上送 thinking 内容，仅保留状态）。与 Codex 行为一致，产品上仍能保留「思考中」「思考开始时间」等状态提示。
2. **若需保留「思考气泡」**：采用 **方案 B**（节流/按段上送），并约定「思考气泡」仅作轻量展示（如截断、单条合并），避免按 chunk 刷屏。
3. **状态提示**：所有方案下都保持现有 keepAlive(thinking) 与 task/turn 生命周期逻辑，不删减「思考中」「思考开始时间」等展示。

---

## 6. 涉及文件速查

| 角色 | 文件 | 说明 |
|------|------|------|
| Cursor 上送 thinking | `packages/happy-cli/src/cursor/runCursor.ts` | thinking_delta → sendCursorMessage(thinking) |
| Codex 不上送 reasoning 流 | `packages/happy-cli/src/codex/runCodex.ts` | 509 行排除 reasoning；ReasoningProcessor 仅段落级 |
| Gemini 上送 thinking | `packages/happy-cli/src/gemini/runGemini.ts` | thinking 事件 → sendAgentMessage('gemini', { type: 'thinking', text }) |
| App 状态 | `packages/happy-app/sources/sync/sync.ts` | task/turn 生命周期 → session.thinking / thinkingAt |
| App 消息合并 | `packages/happy-app/sources/sync/reducer/reducer.ts` | THINKING_MERGE_WINDOW_MS、lastThinkingMessageId |
| App 归一化 | `packages/happy-app/sources/sync/typesRaw.ts` | cursor / acp thinking → content.type 'thinking' |
