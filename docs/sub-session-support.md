# 基础框架对「子会话」的支持分析

## 结论：**支持子会话，但只在「消息树」层面，不在「会话」层面**

- **会话 (Session)**：没有父子或层级，只有一个 session id，所有消息都属于这个 session。
- **消息树 (Message tree)**：支持嵌套。一个 Task 工具调用下可以挂一整条子消息链（sidechain），即**子会话在 UI 上的表现**。

---

## 1. 会话层 (Session) — 无子会话概念

| 位置 | 说明 |
|------|------|
| `storageTypes.ts` | `Session` 只有 `id, seq, metadata, ...`，没有 `parentSessionId` 或 `subSessions`。 |
| API / 存储 | 消息按 session 拉取与写入，key 只有 session id，没有「子 session id」。 |
| CLI | 一个进程对应一个 session；子 agent 不创建新 session，只是同一 session 下带 `subagent` 的 envelope。 |

因此：**没有「子会话」这种独立会话实体**，只有「一个主会话 + 其消息里的嵌套结构」。

---

## 2. 消息层 (Message / Reducer) — 支持子会话（侧链）

### 2.1 类型

- **`typesMessage.ts`**  
  `ToolCallMessage` 带 `children: Message[]`，即一个 tool-call（如 Task）可以挂一串子消息，形成子树。

### 2.2 协议与归一化

- **`typesRaw.ts`**  
  - Session 协议里 envelope 可有 `subagent: string`（cuid2）。  
  - 归一化时：`parentUUID = envelope.subagent ?? null`，并标记 `isSidechain = parentUUID !== null`。  
  即：**子 agent 的每条消息都带上「父」= 该 Task 的 call id（subagent id）**。

### 2.3 侧链追踪 (reducerTracer)

- **`reducerTracer.ts`**  
  - `toolCallToMessageId: Map<toolCallId, messageId>`：Task 的 tool-call 的 id（我们用作 subagent id）→ 该 Task 的 message id。  
  - 带 `parentUUID` 的消息：若 `parentUUID` 在 `toolCallToMessageId` 里，则得到 `sidechainId` = 对应 Task 的 message id，从而归入该 Task 的侧链。  
  - 支持乱序：子消息先到时先当 orphan 缓冲，等父 tool-call 到了再挂上去。

因此：**子会话在数据里 = 同一 session 下、挂在一个 Task 消息上的 sidechain**。

### 2.4 Reducer 与输出

- **`reducer.ts`**  
  - Phase 4：带 `sidechainId` 的消息写入 `state.sidechains.get(sidechainId)`。  
  - 输出时：`ToolCallMessage` 的 `children` = `state.sidechains.get(reducerMsg.realID)` 再递归转成 `Message[]`。

因此：**UI 看到的「Task 下面的子会话」= 该 Task 的 `children`**。

---

## 3. 数据流小结

```
CLI 同一 session：
  sendEnvelope(agent, tool-call-start, { turn, no subagent })     → 主流 Task 开始
  sendEnvelope(agent, text/tool-call-*, { turn, subagent: id })    → 子 agent 事件

App 归一化：
  envelope.subagent → parentUUID
  tool-call-start (call: id) → toolCallToMessageId.set(id, messageId)

Tracer：
  parentUUID 在 toolCallToMessageId 中 → sidechainId = Task message id

Reducer：
  sidechain 消息 → state.sidechains.get(sidechainId)
  输出时 ToolCallMessage.children = sidechains.get(realID)
```

---

## 4. 对当前子 Agent 设计的含义

| 能力 | 是否支持 |
|------|----------|
| 一个主会话下多条「子会话」流 | ✅ 支持（多个 Task，每个 Task 一个 sidechain） |
| 子会话多轮（多条消息） | ✅ 支持（同一 subagent id 下多条 envelope，同一 sidechainId） |
| 子会话内再有 tool-call | ✅ 支持（Phase 4 里对 sidechain 内 tool 有专门处理） |
| 独立「子会话」会话 id / 会话表 | ❌ 不支持，也无必要 |
| 按子会话单独拉消息 | ❌ 不适用；消息按 session 拉，子会话只是主 session 消息树的一部分 |

结论：**现有基础框架已经支持我们需要的「子会话」语义**（Task + sidechain + children），无需引入会话级的父子或新表，只要继续用 session 协议里的 `subagent` + tracer 的 `toolCallToMessageId` + reducer 的 sidechain 即可。

---

## 5. Session Metadata 支持

Session 有完整的 `metadata` 字段，DB 里加密存储，带 `metadataVersion` 乐观并发控制。

### 主要字段（`storageTypes.ts` / `packages/happy-cli/src/api/types.ts`）

| 字段 | 说明 |
|---|---|
| `path` / `host` / `os` | 工作目录、主机名、操作系统 |
| `name` | 会话自定义名称 |
| `models` / `currentModelCode` | 可用模型列表 + 当前选中 |
| `operatingModes` / `currentOperatingModeCode` | 操作模式（plan/act 等） |
| `thoughtLevels` / `currentThoughtLevelCode` | 思考深度档位 |
| `summary { text, updatedAt }` | AI 生成的会话摘要 |
| `machineId` | 关联 Machine ID |
| `lifecycleState` / `lifecycleStateSince` | 生命周期（running / archiveRequested / archived） |
| `archivedBy` / `archiveReason` | 归档来源与原因 |
| `flavor` | 会话变体标识 |
| `sandbox` | Sandbox 配置 |
| `tools` / `slashCommands` | CLI 可用工具列表 |
| `hostPid` / `startedBy` | 进程 PID、启动来源（daemon / terminal） |

---

## 6. 用 Tag 代替 SessionId 交互

`POST /v1/sessions` 是 **upsert** 语义：`tag + userId` → 已有则返回，否则新建。

```typescript
// packages/happy-cli/src/api/api.ts
api.getOrCreateSession({ tag: 'my-project', metadata, state })
// → 服务端: findFirst({ accountId: userId, tag }) 或 create
```

- **固定 tag**：每次启动连到同一个 session（Cursor backend 的持久化原理）
- **`randomUUID()` tag**：每次启动新建 session（Codex / Gemini / ACP / Claude 的默认行为）
- App 侧不暴露 tag，通过 `session.id` 导航；tag 对 App 透明

---

## 7. Envelope 子会话封装细节（`happy-wire/src/sessionProtocol.ts`）

### Envelope 结构

```typescript
{
  id: cuid2,           // 消息唯一 ID
  time: number,        // 时间戳
  role: 'user' | 'agent',
  turn?: string,       // 所属 turn ID
  subagent?: cuid2,    // ← 子会话标识符（有则为 sidechain）
  ev: SessionEvent     // text / tool-call-start / tool-call-end / turn-start / turn-end / start / stop / ...
}
```

### 约束（wire 层校验）
- `start` / `stop` 事件必须是 `role: 'agent'`
- `subagent` 必须是合法 cuid2

### 子会话 envelope 序列

```
{ role:'agent', subagent:'<sid>', ev:{ t:'start', title:'子任务名' } }    ← 子会话开始（App 不渲染）
{ role:'agent', subagent:'<sid>', ev:{ t:'turn-start' } }
{ role:'agent', subagent:'<sid>', ev:{ t:'text', text:'...' } }
{ role:'agent', subagent:'<sid>', ev:{ t:'tool-call-start', ... } }
{ role:'agent', subagent:'<sid>', ev:{ t:'tool-call-end', ... } }
{ role:'agent', subagent:'<sid>', ev:{ t:'turn-end', status:'completed' } }
{ role:'agent', subagent:'<sid>', ev:{ t:'stop' } }                       ← 子会话结束（App 不渲染）
```

### 用 Session 级子会话复用现有机制的路径

若想实现独立 sessionId 的子会话，可以在子 session 的发送端将 envelope 转发到父 session 的消息流并加 `subagent` tag —— App 侧零改动即可渲染子会话树。当前 `runSubagent.ts` 正是此思路：子 agent 进程复用父 session 的 `ApiSessionClient` 发送带 `subagent` 的 envelope，只是子 agent 不是独立 session 实体。
