# Cursor 改用 Claude 封装（仅发 session 协议）的改动规模

## 目标

让 Cursor 只发送 **session 协议**（与 Claude 一致），不再发送 `content.type === 'cursor'`，以便旧 App 能按 Claude 类型回退显示。

---

## 0. 「统一流程在发 session」是什么意思？为什么旧客户端不展示回复？

**「统一流程在发 session」** 指的是：在 `runCursor.ts` 的**同一条执行流程**里，目前会发**两套**东西：

1. **Cursor 格式**（`sendCursorMessage`）：`content.type === 'cursor'`，包括  
   - 正文：`data.type === 'message'`（累积文本、错误/中止文案）  
   - 生命周期：`task_started` / `task_complete` / `turn_aborted`  
   - 工具：`tool-call`、`tool-call-result`（含 output）

2. **Session 协议**（`sendSessionProtocolMessage`）：`content.type === 'session'`，目前**只发了生命周期**：  
   - `ev.t === 'turn-start'`、`turn-end`  
   - `ev.t === 'tool-call-start'`、`tool-call-end`  
   - **没有**用 session 发「回复正文」或「工具结果内容」（没有 `ev.t === 'text'` 的 agent 正文、也没有在 tool-call-end 前发 result）。

所以：**同一流程里已经在发 session，但只发了 turn/tool 起止，没有用 session 发任何「可展示的回复内容」。**

**为什么旧客户端会识别成 Claude 但不展示任何回复？**

- 旧客户端很可能只按 **session 协议**来展示 Claude 会话：只认 `content.type === 'session'` 里的 `ev.t`（如 `text`、`tool-call-start`、`tool-call-end`）来渲染回复。
- Cursor 的**正文和工具结果**目前只通过 **cursor 格式**（`content.type === 'cursor'`）发送；旧客户端若不支持 cursor 或在该会话里只当 Claude 处理、只消费 session，就会**忽略**这些 cursor 消息。
- 结果：会话被识别成 Claude，但没有任何「回复消息」来自 session，所以界面上不展示任何回复。

**结论**：要让旧客户端展示 Cursor 的回复，必须在**同一条流程里用 session 协议发正文**（例如 `ev.t: 'text'` 表示回复、错误；工具起止已有，工具结果可酌情用 `text`/`service` 或扩展协议），而不能只发 cursor 格式。

---

## 1. 当前 Cursor 发送方式

### 1.1 使用 `sendCursorMessage` 的调用点（runCursor.ts）

| 位置（约） | 发送内容 | 说明 |
|------------|----------|------|
| 309 | `{ type: 'turn_aborted', id }` | handleAbort 时 |
| 452–456 | `{ type: 'message', message: accumulatedResponse }` | 累积文本 flush |
| 464–468 | `{ type: 'task_started', id }` | turn 开始（与 turn-start 重复） |
| 541–547 | `{ type: 'tool-call', name, callId, input, id }` | 工具开始（与 tool-call-start 重复） |
| 570 | `{ type: 'tool-call-result', callId, output, id }` | 单工具超时“running in background” |
| 593–599 | `{ type: 'tool-call-result', callId, output, id }` | 工具正常结束 |
| 618–624 | `{ type: 'tool-call-result', callId, output, id }` | turn 结束时补发未结束的 tool |
| 631–635 | `{ type: 'message', message: 'Error: ...' }` | error 事件 |
| 649 | `{ type: 'message', message: 'Aborted by user' }` | catch 里 abort |
| 654–658 | `{ type: 'message', message: errorMsg }` | catch 里其它错误 |
| 669–673 | `{ type: 'tool-call-result', ... }` | finally 里未结束的 tool（aborted） |
| 682–685 | `{ type: 'task_complete', id }` | turn 结束（与 turn-end 重复） |

共 **12 处** `sendCursorMessage`。

### 1.2 已使用 session 协议的地方（runCursor.ts）

- turn 开始：`sendSessionProtocolMessage(createEnvelope('agent', { t: 'turn-start' }, { turn: turnId }))`
- 工具开始：`sendSessionProtocolMessage(createEnvelope('agent', { t: 'tool-call-start', ... }))`
- 工具结束：`sendSessionProtocolMessage(createEnvelope('agent', { t: 'tool-call-end', call }, ...))`
- turn 结束：`sendSessionProtocolMessage(createEnvelope('agent', { t: 'turn-end', status }, ...))`

即：**生命周期和工具起止已经有一条 session 协议链路**，与 `sendCursorMessage` 并行。

---

## 2. Session 协议能力（happy-wire + App 归一化）

- **ev.t**：`text`（可选 `thinking: true`）、`service`、`tool-call-start`、`tool-call-end`、`turn-start`、`turn-end`、`start`、`stop`、`file` 等。
- App 对 session 的归一化：
  - `text` → agent `text` 或 `thinking`（由 `ev.thinking` 决定）
  - `tool-call-start` → `tool-call`
  - `tool-call-end` → `tool-result`，**content 固定为 null**（协议里没有 result body）

因此：**若只发 session，工具“结果内容”在现有协议下不会进 UI**，除非用 `text`/`service` 再发一条把结果当正文/服务消息发出去。

---

## 3. 改动方案与规模

### 3.1 只删 cursor、保留现有 session（最小改法）

- **删**：所有 `sendCursorMessage(...)` 调用（12 处）。
- **保留**：现有 `sendSessionProtocolMessage`（turn-start、tool-call-start、tool-call-end、turn-end）。
- **结果**：
  - 旧 App 只看到 session，可当 Claude 类型显示。
  - 代价：**不再向 App 发送**  
    - 累积回复正文（message）、  
    - 错误/中止文案（message）、  
    - turn_aborted、  
    - **以及所有 tool-call-result 的 output**（协议里没有，App 目前 tool-call-end 归一化为 content: null）。

**改动量**：约 12 处删除，集中在 `runCursor.ts`，约 1 个文件、数十行。

### 3.2 用 session 补发“正文 + 错误”，不补发 result（折中）

- 删除所有 `sendCursorMessage`。
- **新增**用 session 发“正文/错误”：
  - 累积文本 flush：`sendSessionProtocolMessage(createEnvelope('agent', { t: 'text', text: accumulatedResponse }))`
  - 错误/中止：`sendSessionProtocolMessage(createEnvelope('agent', { t: 'text', text: '...' }))` 或 `ev.t: 'service'`
  - `turn_aborted`：已有 `turn-end` 时可在 handleAbort 里发 `turn-end` status `cancelled`，不再发 cursor 的 turn_aborted。
- **不**为 tool result 扩展协议：tool-call-end 仍无 result body，UI 只显示“工具结束”。

**改动量**：  
- `runCursor.ts`：约 12 处改为“删 sendCursorMessage + 在需要处补 1 条 sendSessionProtocolMessage（text/service）”。  
- 可选：在 `sessionProtocolMapper` 或 runCursor 里抽一个 `sendCursorTextAsSession(text: string)` 复用。  
- 仍约 **1 个主文件 + 少量辅助**，估计 **几十行到百行内**。

### 3.3 完整等价：result 也通过 session 发（需约定形态）

- 在 3.2 基础上，在每次 `tool-call-end` **之前**多发一条 session：
  - 例如 `ev.t: 'text'` 或 `ev.t: 'service'`，内容为当前 tool 的 result 摘要或 JSON。
- App 端：当前 `tool-call-end` 归一化为 `tool-result` 且 `content: null`。若用 `text`/`service` 发 result，会变成**单独一条 agent 消息**，不会自动挂到上一条 tool-call 上，除非 App 约定“按顺序/按 call id 把紧接着的 text 当作上一个 tool 的 result”并改归一化逻辑。
- 若不想动 App：只能接受“工具结果以一条独立正文/服务消息展示”，不绑在 tool 块里。

**改动量**：  
- CLI：在每处发 `tool-call-result` 的地方改为“先 sendSessionProtocolMessage(text/service)，再发 tool-call-end”，约 **3–4 处**（runCursor 里 570、593、618、669 等）。  
- 若要在 App 里把“紧跟的 text 视为 tool result”，需改 **typesRaw.ts** 的 `normalizeSessionEnvelope`（或 reducer），规模中等。

---

## 4. 建议的落地顺序与规模汇总

| 阶段 | 内容 | 涉及文件 | 规模（粗估） |
|------|------|----------|----------------|
| 1 | 去掉所有 `sendCursorMessage`，仅保留现有 session（3.1） | runCursor.ts | 小（~12 处删） |
| 2 | 用 session 补发“正文 + 错误/中止”（3.2） | runCursor.ts，可选 sessionProtocolMapper / 小 helper | 小–中（几十行） |
| 3 | （可选）用 text/service 发 tool result，或改 App 归一化（3.3） | runCursor.ts + 可选 typesRaw/reducer | 中 |

**结论**：  
- **最小可交付**：只做阶段 1，旧 App 立刻能按 Claude 类型显示 Cursor 会话，但会少掉“回复正文、错误文案、工具结果内容”。  
- **推荐**：阶段 1 + 2，不碰 App，改动集中在 **runCursor.ts**（及可选小 helper），规模在 **百行内**；工具结果仍不展示或只以独立消息展示，除非再做阶段 3 或协议扩展。

---

## 5. 其他需动到的点

- **apiSession.ts**：可保留 `sendCursorMessage` 空实现或标记 deprecated，供 Codex/其他仍用 cursor 形状的路径用；若确认全仓库不再发 cursor，可删。
- **apiSession.test.ts**：若有直接测 `sendCursorMessage` 或 cursor 形状的用例，需改为期望 session 或删/改断言。
- **App typesRaw**：若完全不再接收 `content.type === 'cursor'`，可保留解析以兼容旧数据，新数据将只有 session。

---

## 6. 小结

- **仅 CLI 侧、且不大改协议**的前提下：  
  - 删除 12 处 `sendCursorMessage` 并视需要补少量 `sendSessionProtocolMessage`（text/service），即可让 Cursor 与 Claude 在 wire 上一致，**改动规模约一个 runCursor.ts、几十到百行**。  
- 若还要在旧 App 里完整保留“工具结果”的展示，需要要么在 session 上约定“result 的 text/service 紧跟 tool-call-end”，并在 App 做一次归一化改动，要么接受“工具结果以普通正文/服务消息显示”。
