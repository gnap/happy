# Codex / Claude / Cursor 消息格式差异与 Cursor 兼容 Claude 方案

## 1. App 侧收到的三种 wire 格式

服务端存储的 `RawRecord` 里，`role === 'agent'` 时 `content` 可能是：

| content.type | 来源 | 数据结构 | App 归一化入口 |
|--------------|------|----------|----------------|
| **output** | Claude（旧 API / 部分流水） | `data.type` in `assistant` \| `user` \| `system` \| `result` \| `summary`；assistant 时 `data.message.content[]` 为 `{ type: 'text' \| 'thinking' \| 'tool_use' \| 'tool_result' }` | `normalizeRawMessage` 中 `raw.content.type === 'output'` |
| **session** | Claude CLI、Codex/Cursor 的 turn 生命周期 | Session 协议：`data` 为 envelope，`ev.t` in `text` \| `service` \| `tool-call-start` \| `tool-call-end` \| `turn-start` \| `turn-end` \| `start` \| `stop` 等 | `normalizeSessionEnvelope(raw.content.data)` |
| **codex** | Codex CLI | `data` 为 codexCursorDataSchema：`type` in `message` \| `reasoning` \| `thinking` \| `task_started` \| `task_complete` \| `turn_aborted` \| `tool-call` \| `tool-call-result` | `raw.content.type === 'codex'` 分支，与 cursor 共用逻辑 |
| **cursor** | Cursor CLI | 与 codex 同结构，仅最外层 `content.type === 'cursor'` | `raw.content.type === 'cursor'`，与 codex 共用；**仅** `data.type === 'thinking'` 时归一化为 `type: 'thinking'`（codex 归一化为 `type: 'text'`） |

旧 App 若只实现了 `output` 或只实现了 `session`，则收到 `codex` / `cursor` 时可能不解析或直接忽略，无法“回退到 Claude 类型”显示。

---

## 2. Codex vs Claude 的差异（与 Cursor 的关系）

- **Claude**
  - 发的是 **session 协议**：`sendClaudeSessionMessage` → `mapClaudeLogMessageToSessionEnvelopes` → `sendSessionProtocolMessage(envelope)`。
  - 线上格式：`role: 'session'` 或经预处理后 `content.type === 'session'`，`data` 为 envelope（`ev.t` 等）。
- **Codex**
  - 主体内容走 **codex 格式**：`sendCodexMessage({ type: 'message' \| 'thinking' \| 'tool-call' \| ... })` → 线上为 `content.type === 'codex'`。
  - 部分生命周期走 **session**：turn-start、tool-call-end、turn-end 等用 `sendSessionProtocolMessage`。
- **Cursor**
  - 主体内容走 **cursor 格式**：`sendCursorMessage({ type: 'message' \| 'thinking' \| 'tool-call' \| ... })` → 线上为 `content.type === 'cursor'`。
  - 生命周期同 Codex，也用 `sendSessionProtocolMessage`（turn-start、tool-call-end、turn-end）。

因此：**Codex 与 Cursor 在“主体内容”的 wire 格式上一致（都是 codex/cursor 那套 data 结构），与 Claude 的 session / output 都不同。**

---

## 3. App 归一化后的统一形态（NormalizedMessage）

无论哪种 wire 格式，最终都会变成：

- `role: 'agent'`，`content: NormalizedAgentContent[]`
- 其中 `NormalizedAgentContent` 为：`{ type: 'text' \| 'thinking' \| 'tool-call' \| 'tool-result' | ... }` 等。

唯一语义差异在 **thinking**：

- **cursor**：wire 上 `data.type === 'thinking'` → 归一化为 `type: 'thinking'`。
- **codex**：同一 wire 形状 → 归一化为 `type: 'text'`（不单独标 thinking）。

---

## 4. 如何让 Cursor 在旧 App 上“回退到 Claude 类型”

旧 App 无法改代码，因此只能让 **Cursor 发出的线上格式** 落在旧 App 已支持的格式上。

- 若旧 App 只支持 **session**：  
  需要 Cursor **只发 session 协议**，不再发 `content.type === 'cursor'`。
- 若旧 App 只支持 **output**：  
  需要 Cursor 发 `content.type === 'output'`、`data.type === 'assistant'` 等 Claude 那套结构。

推荐做法：**让 Cursor 与 Claude 一致，只发 session 协议**（与当前 Claude CLI 一致），这样旧 App 只要支持 session，就能把 Cursor 当成“另一种 Claude 会话”来显示。

---

## 5. 实现思路：Cursor 全量走 session 协议

- Cursor 已有 **session 协议 mapper**：`packages/happy-cli/src/cursor/sessionProtocolMapper.ts` 的 `mapCursorMessageToSessionEnvelopes`，已支持：
  - `task_started` → turn-start
  - `task_complete` / `error` → turn-end
  - `text_delta` → `ev.t: 'text'`
  - `thinking_delta` → `ev.t: 'text', thinking: true`
  - `tool_call_start` → tool-call-start
  - `tool_call_end` → tool-call-end
- 当前 runCursor 是：
  - 生命周期 / 工具边界：已用 `sendSessionProtocolMessage`（session）。
  - 主体内容（message、thinking、tool-call、tool-call-result）：用 `sendCursorMessage`（cursor 格式）。

要兼容旧 App，需要：

1. **不再使用 `sendCursorMessage` 发主体内容**，改为：
   - 把“当前流式/非流式内容”整理成与 `mapCursorMessageToSessionEnvelopes` 一致的 **CursorParsedMessage**（或等价结构），
   - 调用 `mapCursorMessageToSessionEnvelopes` 得到 `SessionEnvelope[]`，
   - 用 `sendSessionProtocolMessage(envelope)` 逐条发送。
2. 这样 Cursor 会话在线上 **只有 session 一种格式**，和 Claude 一致；旧 App 按 session 解析即可“回退到 Claude 类型”展示。

需要区分的只有“流式 vs 非流式”：当前 `sendCursorMessage` 可能是整条 message/thinking/tool-call 一次发送，而 session 协议里多为按 delta 的 `ev.t: 'text'`。若 runCursor 目前是“整块发送”，则要么在 CLI 里先把整块拆成若干 envelope（例如按句或按块生成多条 `ev.t: 'text'`），要么在 mapper 里支持“整块 text/thinking 对应一条 envelope”。具体可以按现有 runCursor 的调用点逐个改成“生成 envelope → sendSessionProtocolMessage”。

---

## 6. 小结

| 项目 | Codex | Claude | Cursor（当前） | Cursor（兼容方案） |
|------|--------|--------|----------------|--------------------|
| 主体内容 wire | `content.type === 'codex'` | session 协议 | `content.type === 'cursor'` | 仅 session 协议 |
| 生命周期 | session | session | session | session |
| thinking 在 App 中 | 归一化为 text | 归一化为 thinking（session 里 ev.thinking） | 归一化为 thinking | 同 Claude（session 中 thinking: true） |
| 旧 App 回退到 Claude | 需旧 App 支持 codex 或改服务端 | 原生支持 | 需旧 App 支持 cursor 或改 CLI | 与 Claude 一致，旧 App 支持 session 即可 |

结论：要让 Cursor 在旧 App 上能按“Claude 类型”回退显示，应让 **Cursor 只发 session 协议、不再发 cursor 格式**；实现上就是把 runCursor 里所有 `sendCursorMessage` 改为通过 `mapCursorMessageToSessionEnvelopes`（或等价逻辑）生成 envelope，再用 `sendSessionProtocolMessage` 发送。
