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
