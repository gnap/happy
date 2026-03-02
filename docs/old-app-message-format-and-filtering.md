# 旧 App 可能的消息格式与过滤机制（挖掘总结）

本文档汇总：消息从服务端到展示的完整路径、每一处可能「丢弃/过滤」的逻辑，以及旧 App 若来自不同代码库时需对比的要点。

---

## 1. 消息从服务端到 UI 的完整路径

```
服务端 push (new-message) 或 拉取 (GET /v3/sessions/:id/messages)
  → 解密: encryption.decryptMessage(...) → decrypted.content = raw
  → normalizeRawMessage(id, localId, createdAt, raw)
      若 return null → 该条消息不进入后续流程
  → 若非 null: enqueueMessages(sid, [normalized])
  → storage.applyMessages(sid, messages)
  → reducer(reducerState, messages, agentState)
  → sessionMessages[sid].messages / messagesMap
  → UI 渲染
```

**关键结论**：唯一能导致「整条消息不展示」的关卡是 **`normalizeRawMessage` 返回 `null`**。reducer 只会跳过少数几种（如 `ready`、`Turn started`），不会按 agent 类型或 flavor 过滤普通 agent 消息。

---

## 2. 导致 normalizeRawMessage 返回 null 的原因

### 2.1 Schema 校验失败（rawRecordSchema.safeParse）

- **位置**：`typesRaw.ts`，`normalizeRawMessage` 开头。
- **现象**：控制台会打 `=== VALIDATION ERROR ===` 和 Zod 的 `issues`、原始 `raw`。
- **常见原因**：
  - **没有 `role: 'session'` 分支**：旧 App 的 `rawRecordSchema` 若只有 `agent` | `user`，则 `role: 'session'` 的 raw 会校验失败。
  - **没有 session 的 preprocess**：我们 CLI 发的是 `{ role: 'session', content: envelope }`（envelope 无 `content.type`）。若旧 App 没有这段 preprocess：
    ```ts
    if (data.role === 'session' && data.content && typeof data.content === 'object') {
      const content = data.content;
      const looksLikeEnvelope = content.type !== 'session' && typeof content.id === 'string' && typeof content.role === 'string' && content.ev !== undefined;
      if (looksLikeEnvelope) {
        data.content = { type: 'session', data: content };
      }
    }
    ```
    则 `raw.content` 仍是 envelope，没有 `content.type === 'session'` 和 `content.data`，校验会失败。
  - **sessionEnvelopeSchema 更严**：例如 `ev` 的 discriminatedUnion 里没有 `ev.t === 'text'`，或 `turn` 在旧版为必填且我们没传，都会导致解析失败。
  - **agent 分支没有 `content.type === 'session'`**：若消息被服务端或中间层改成 `role: 'agent'` 且 `content.type === 'session'`，则必须在 `rawAgentRecordSchema` 里有对应分支，否则同样失败。

### 2.2 normalizeRawMessage 内显式 return null

- **user + isSessionProtocolSendEnabled()**：`raw.role === 'user'` 且开启了 session 协议发送时，user 消息会 return null（与本问题无关，我们发的是 agent/session）。
- **normalizeSessionEnvelope 返回 null**：见下节。

### 2.3 normalizeSessionEnvelope 内 return null

- **agent 且无 turn**：`if (envelope.role === 'agent' && !envelope.turn) return null;`  
  我们 CLI 已传 `{ turn: turnId }`，若服务端或旧 App 解析时丢掉了 `turn`，会在这里被丢。
- **turn-start**：`ev.t === 'turn-start'` 直接 return null（生命周期，不展示）。
- **start/stop**：`ev.t === 'start'|'stop'` return null（子 agent 边界）。
- **service 且 role !== 'agent'**：return null。
- **user + ev.t === 'text' 且 !isSessionProtocolSendEnabled()**：user 的 text 在未开启时 return null。

**与当前 Cursor 相关**：我们发的是 agent 的 `ev.t === 'text'`、`tool-call-start`、`tool-call-end`、`turn-end` 等。只要 schema 里有这些类型且 `envelope.turn` 存在，就不会在这里被丢。

---

## 3. 我们 CLI 实际发送的 raw 形状（session 协议）

- **入口**：`apiSession.enqueueSessionProtocolEnvelope(envelope)`。
- **写入队列并最终发到服务端的 content**：
  ```ts
  { role: 'session', content: envelope, meta: { sentFrom: 'cli' } }
  ```
  其中 `envelope` 形如：`{ id, time, role: 'agent', turn, ev: { t: 'text'|'turn-start'|'turn-end'|'tool-call-start'|'tool-call-end', ... } }`，**没有** `content.type` 或 `content.data`。

- **App 端 preprocess 后**：应变成 `raw.content = { type: 'session', data: envelope }`，再进入 `rawRecordSchema` 的 `role: 'session'` 分支，用 `sessionEnvelopeSchema` 解析 `data`，最后走 `normalizeSessionEnvelope(raw.content.data, ...)`。

若旧 App **没有**上述 preprocess，或 **没有** `role: 'session'` 或 `normalizeSessionEnvelope`，则所有 session 协议消息都会在「校验」或「归一化」阶段变成 null，一条都不会展示。

---

## 4. 其他可能影响「展示」的机制（非按 agent 过滤）

- **Feed**：`sync.ts` 里 `compatibleItems = allItems.filter(...)` 只过滤 feed 项（如 friend_request 等），**不**过滤会话消息。
- **会话列表**：`applySessions` 会合并所有服务端返回的 session，没有按 `metadata.flavor` 或 agent 类型过滤。之前旧 App 看不到 Cursor 会话是因为 flavor 为 `cursor` 时被别处（如 UI 或服务端）过滤；改成 `flavor: 'claude'` 后会话已出现，说明列表本身不按消息格式过滤。
- **Reducer**：
  - 会跳过：`role === 'event' && content.type === 'ready'`、`Turn started`、`Context was reset` 等少数几种。
  - 不会因为「是 session 协议」或「flavor」丢弃 agent 文本/工具消息；只要 `normalizeRawMessage` 返回了非 null 的 NormalizedMessage，就会进入 reducer 并参与展示。

因此，**旧 App 不展示消息**几乎可以确定是：**在「解密 → normalizeRawMessage → normalizeSessionEnvelope」这条链上某一步把消息丢掉了**，而不是「按 agent 类型或 flavor 做展示过滤」。

---

## 5. 本仓库 Git 历史里「旧 App」的 schema 能力

- **bb7a117 / 641c8eb**：已有 `role: 'session'`、preprocess（把直接 envelope 转成 `{ type: 'session', data }`）、`normalizeSessionEnvelope`、`sessionEnvelopeSchema`（含 `ev.t === 'text'` 等）。**没有** `content.type === 'cursor'`。
- **83626fc 起**：在 agent 分支增加 `content.type === 'cursor'`。

若你们说的「旧 App」就是本仓库这两次提交之前的构建，理论上**应该能**正确解析并展示 session 协议消息；若仍不展示，需要从下面「诊断步骤」逐项排除。

---

## 6. 建议在旧 App 上的诊断步骤

1. **看控制台**  
   在旧 App 打开该会话并触发/等待一条 AI 回复时，看是否出现 **`=== VALIDATION ERROR ===`**。  
   - 若有：说明 raw 在旧 App 的 `rawRecordSchema` 下校验失败，需要对比旧 App 的 `typesRaw.ts`（见下节）。  
   - 若无：说明要么消息没到达旧 App，要么在解密或更早环节就失败了。

2. **确认消息是否到达**  
   在旧 App 的 `handleUpdate`（或收 push 的地方）里临时打 log：收到 `new-message` 时打印 `updateData.body.sid`、是否拿到 `decrypted`、`decrypted.content.role`、`decrypted.content.content?.type` 或 `decrypted.content.ev?.t`。  
   若根本没有带 `role: 'session'` 或 envelope 的 payload，可能是服务端/推送对旧客户端做了裁剪或用了不同 API 版本。

3. **确认解密是否成功**  
   若 `decryptMessage` 在旧 App 返回 null，该条不会进入 `normalizeRawMessage`。可打 log 看是否经常为 null（尤其是该会话的消息）。

4. **对比旧 App 的 typesRaw**  
   在旧 App 代码库里搜：
   - `raw.role === 'session'`
   - `normalizeSessionEnvelope`
   - `preprocessMessageContent` 里对 `data.role === 'session'` 的处理
   - `sessionEventSchema` 是否包含 `ev.t === 'text'`（sessionTextEventSchema）
   - `sessionEnvelopeSchema` 是否要求 `turn` 必填（我们当前是 optional）  
   任缺一项或形状不一致，都可能导致 session 协议消息被丢弃。

5. **可选：在旧 App 里打 log normalizeRawMessage 结果**  
   在 `normalizeRawMessage` 里对 `raw.role === 'session'` 分支打 log，看入参 `raw.content`（preprocess 后应有 `type: 'session'`, `data`）和 `normalizeSessionEnvelope` 的返回值。若入参正确但返回 null，说明是 `normalizeSessionEnvelope` 内某条件导致丢弃（例如缺 `turn`）。

---

## 7. 小结表：旧 App 可能的消息格式与过滤

| 层级 | 是否按 agent/flavor 过滤 | 会丢弃消息的情况 |
|------|---------------------------|------------------|
| 会话列表 | 否（本仓库）；若旧 App 隐藏 cursor 会话则是 UI/策略） | 无（已用 flavor 'claude' 规避） |
| 收 push / 拉消息 | 否 | 服务端未下发、解密失败 |
| normalizeRawMessage | 否（只按 raw 的 shape） | safeParse 失败；或 role/user 分支里 isSessionProtocolSendEnabled 等 |
| normalizeSessionEnvelope | 否 | agent 无 turn；ev.t 为 turn-start/start/stop；或 user text 未开开关 |
| reducer | 否 | 仅 ready、Turn started、Context was reset 等少数 event |
| UI | 否（不按 flavor 过滤单条消息） | - |

**结论**：要解决「旧 App 不展示消息」，需要确认旧 App 的 **typesRaw（schema + preprocess + normalizeSessionEnvelope）** 是否完整支持我们发出去的 session 协议形状；必要时按当前新 App 的 session 逻辑在旧 App 补一份或放宽 schema，再配合上述诊断缩小范围。
