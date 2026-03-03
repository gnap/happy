# App 基于 agent 类型的消息路由与「agent 未知」时的处理

## 结论摘要

- **Sync 层不做按 agent 类型的路由**：消息是否被接受和展示，只由 **raw 记录的 shape**（`role` + `content.type`）决定，与 session 的 `metadata.flavor` / agent 类型无关。
- **「Agent 未知」**：仅影响 UI 展示（头像、标签、权限模式等）。**不会**用来过滤或丢弃消息；消息归一化逻辑里没有 agent 类型分支。
- **旧 App 一套都不展示**：多半是旧版 **没有** 对 `role: 'session'` 或 `content.type === 'session'` 的 schema/归一化支持，导致 session 协议消息校验失败 → `normalizeRawMessage` 返回 `null` → 不进入 reducer → 不展示。
- **新 App 两套文本**：新 App 同时支持 `cursor` 与 `session`，Cursor 又双发两种格式，所以同一条内容被当成两条 normalized 消息展示（需后续在 CLI 或 App 做去重/只认一种）。

---

## 1. 消息从服务器到 UI 的路径

```
服务器 push / 拉取
  → 解密 (decrypted.content = raw)
  → normalizeRawMessage(id, localId, createdAt, raw)
  → 若返回非 null：enqueueMessages(sessionId, [normalized])
  → storage.applyMessages(sessionId, messages)
  → reducer(reducerState, messages, agentState)
  → sessionMessages[sessionId].messages / messagesMap
  → UI 渲染
```

**没有任何一步**会根据 session 的 `metadata.flavor` 或「agent 类型」过滤或路由某条消息。  
**唯一关卡**是：`raw` 必须通过 `rawRecordSchema.safeParse(raw)`，并且 `normalizeRawMessage` 里对应该 shape 的分支返回非 null。

---

## 2. Raw 记录的路由逻辑（按 shape，不按 agent）

`RawRecord` 是**按 `role` 区分的联合类型**（见 `typesRaw.ts`）：

| `raw.role` | `raw.content` 要求 | 归一化入口 |
|------------|--------------------|------------|
| `'user'`   | `content.type === 'text'` | 直接返回 user 消息（若未开 session 发送则可能 return null） |
| `'session'`| 预处理后为 `content.type === 'session'`，`content.data` = SessionEnvelope | `normalizeSessionEnvelope(raw.content.data, ...)` |
| `'agent'`  | `content` 符合 `rawAgentRecordSchema` | 按 `content.type` 再分：`output` / `codex` / `cursor` / `session` / `acp` / `event` |

- **Agent 分支**里，`raw.content.type` 可以是：
  - `output`：Claude 等 output 格式（含 assistant/user 等）
  - `codex`：Codex 格式（data.type: message, reasoning, tool-call, tool-call-result, thinking, task_started/complete, turn_aborted）
  - `cursor`：与 codex 同 data 形状
  - `session`：**注意**：这里是 `role: 'agent'` 且 `content.type === 'session'` 的另一种写法（部分路径可能用这种 shape）
  - `acp`：ACP 统一格式
  - `event`：事件

**Session 协议（当前 CLI 发的）** 实际是 **`role: 'session'`**，`content` 经预处理后为 `{ type: 'session', data: envelope }`。  
因此：

- 若某版本 App **没有**在 `rawRecordSchema` 里定义 `role: 'session'` 这一支，或没有 `preprocessMessageContent` 把「直接 envelope」转成 `{ type: 'session', data }`，则所有 session 协议消息都会 **parse 失败** → `normalizeRawMessage` 里会 `console.error` 并 **return null** → 不会进 reducer，也不会展示。
- 若某版本 App **没有**在 `rawAgentRecordSchema` 里定义 `content.type === 'cursor'`（或 `codex`），则 Cursor 发的 cursor 格式消息也会 parse 失败 → 同样不展示。

所以「旧 App 一套都没有」可以归纳为：**旧 App 的 schema/归一化不支持当前 Cursor 发出的某种或两种 shape（cursor 和/或 session）**，而不是「按 agent 类型故意不展示」。

---

## 3. 「Agent 未知」时消息如何被处理

- **Session 的 agent 类型**来自 session 的 `metadata.flavor`（或创建时的 agentType），用于：
  - 头像、会话列表/详情里的 agent 名称
  - 权限模式、模型等配置（如 `modelModeOptions.ts` 里按 `flavor` 取模式）
- **消息归一化**没有使用 `metadata.flavor` 或任何「agent 类型」字段。  
  因此：
  - **Agent 未知**（例如 `flavor == null` 或未识别的值）只影响上述 UI/配置，**不会**导致消息被丢弃。
  - 只要 raw 能通过当前 App 的 `rawRecordSchema` 且对应分支返回非 null，消息就会进 reducer 并参与展示。

若旧 App 上「agent 未知」的会话一条消息都不显示，仍然是**该版本的 schema 不支持这些 raw 的 shape**（例如缺少 session 或 cursor 支），而不是「未知 agent 被特殊过滤」。

---

## 4. 新 App 出现两套文本的原因

- Cursor CLI 当前**双发**：
  - `sendCursorMessage(...)` → raw `role: 'agent'`, `content.type: 'cursor'`
  - `sendSessionProtocolMessage(createEnvelope('agent', { t: 'text', text }, ...))` → raw `role: 'session'`, `content: { type: 'session', data: envelope }`
- 新 App 同时支持：
  - `content.type === 'cursor'` → 归一化为 agent 文本
  - `role === 'session'` 且 `ev.t === 'text'` → 也归一化为 agent 文本
- 同一条回复因此会变成**两条** normalized 消息 → 两套文本。

解决方向（二选一或组合）：

- **CLI 只发 session**：去掉 Cursor 的 `sendCursorMessage`，只发 session 协议（新/旧 App 都只认 session 即可）。
- **App 去重**：对同一 turn 内、同一内容的 session 与 cursor 文本做去重（需要约定规则，例如按 turn + 内容哈希）。

---

## 5. 建议在旧 App 上做的确认

1. **看控制台**：收到 Cursor 会话的 push 时，是否有 `=== VALIDATION ERROR ===` 和 Zod 的 schema 报错。若有，说明 raw 的 shape 不被当前 schema 接受。
2. **确认 schema**：在旧 App 的 `typesRaw.ts` 中是否：
   - 存在 `role: 'session'` 且 `content: { type: 'session', data: sessionEnvelopeSchema }` 的分支；
   - 存在 `preprocessMessageContent` 里对 `data.role === 'session'` 且 content 像 envelope 时转为 `{ type: 'session', data }` 的逻辑。
3. **确认归一化**：是否存在 `normalizeSessionEnvelope`，并对 `ev.t === 'text'` 等返回可展示的 NormalizedMessage。

若旧 App 没有上述 session 支持和预处理，则**无需改「按 agent 类型路由」**，只需在旧 App 中**补齐 session 的 schema + 预处理 + normalizeSessionEnvelope**，即可让仅发 session 的 Cursor（或双发时的 session 部分）在旧 App 上展示；再配合 CLI 只发 session，可同时消除新 App 上的两套文本问题。
