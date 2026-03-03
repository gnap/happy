# 会话列表与消息同步、回放及 App 端持久化

本文档描述 Happy App 中**会话列表**、**会话消息**的同步与回放机制，以及 **App 端持久化存储**的范围与方式。

---

## 一、整体架构

```
                    ┌─────────────────────────────────────────────────────────┐
                    │                     Happy App (Zustand)                   │
                    │  storage.sessions  │  storage.sessionMessages           │
                    │  storage.machines  │  storage.sessionListViewData        │
                    └───────────┬───────┴────────────────────────────────────┘
                                │
         ┌──────────────────────┼──────────────────────┐
         │                      │                      │
         ▼                      ▼                      ▼
   REST (fetch)           Socket.io               REST (fetch)
   GET /v1/sessions       'update' event          GET /v3/sessions/:id/messages
   GET /v1/machines       'ephemeral' event       POST (send message)
         │                      │                      │
         └──────────────────────┴──────────────────────┘
                                │
                                ▼
                    ┌───────────────────────────┐
                    │     Happy Server (API)    │
                    └───────────────────────────┘
```

- **会话列表**与**会话消息**的“持久化”在 App 端**仅存在于内存**（Zustand store），不写入本地磁盘。
- 真正持久化在服务端；App 每次启动或重连后通过 **REST 拉取 + Socket 增量** 恢复/更新状态。

---

## 二、会话列表同步

### 2.1 数据流

1. **初次加载 / 失效时拉取**  
   - `Sync.#init()` 里对 `sessionsSync` 调用 `invalidate()`。  
   - `sessionsSync` 由 `InvalidateSync(fetchSessions)` 实现，触发 `fetchSessions`。
2. **REST 拉取**  
   - `fetchSessions`：`GET ${API_ENDPOINT}/v1/sessions`，返回会话列表（含加密的 metadata、agentState、dataEncryptionKey 等）。
3. **解密与密钥**  
   - 用账号级加密先解密各会话的 `dataEncryptionKey`，得到会话级密钥。  
   - `encryption.initializeSessions(sessionKeys)` 建立会话加密上下文。  
   - 再用会话级密钥解密每条会话的 `metadata`、`agentState`。
4. **写入内存**  
   - 解密后的会话通过 `storage.getState().applySessions(decryptedSessions)` 写入 Zustand。  
   - `applySessions` 会合并到 `state.sessions`，并调用 `buildSessionListViewData(state.sessions)` 生成 `sessionListViewData`，供 UI 使用。

### 2.2 何时刷新会话列表

- **启动 / 恢复**：`#init()` 中 `sessionsSync.invalidate()`。
- **App 回到前台**：`AppState` 为 `active` 时 `sessionsSync.invalidate()`。
- **Socket 重连**：`onReconnected` 里 `sessionsSync.invalidate()`。
- **收到 new-session**：`handleUpdate` 中 `body.t === 'new-session'` 时 `sessionsSync.invalidate()`。
- **收到 new-message 但本地没有该 session**：会先 `fetchSessions()` 再处理消息。
- **收到 delete-session**：不从服务器再拉列表，而是直接 `storage.getState().deleteSession(sessionId)` 并从内存清理相关状态（见下文）。

### 2.3 会话列表 UI 数据：sessionListViewData

- **来源**：`buildSessionListViewData(sessions)`，输入为 `state.sessions`（Record&lt;sessionId, Session&gt;）。
- **结构**：`SessionListViewItem[]`，每一项为：
  - `{ type: 'active-sessions', sessions }`：当前活跃会话一组；
  - `{ type: 'header', title }`：日期标题（"Today" / "Yesterday" / "N days ago"）；
  - `{ type: 'session', session }`：单条非活跃会话。
- **排序**：先按 `active` 分活跃/非活跃，再按 `updatedAt` 降序。
- **Hook**：`useVisibleSessionListViewData()` / `useSessionListViewData()` 从 `storage` 读 `sessionListViewData`（并在 ready 后按设置过滤“隐藏不活跃”等）。

---

## 三、会话消息同步与回放

### 3.1 按会话的拉取（fetchMessages）

- **触发**：某会话变为“可见”时（例如进入会话页）调用 `sync.onSessionVisible(sessionId)`，内部对 `getMessagesSync(sessionId).invalidate()`，从而触发 `fetchMessages(sessionId)`。
- **接口**：分页拉取  
  `GET /v3/sessions/${sessionId}/messages?after_seq=${afterSeq}&limit=100`  
  多次请求直到 `hasMore === false`（或分页不再前进，防死循环）。
- **解密**：用该会话的 `encryption.getSessionEncryption(sessionId)` 解密每条 `ApiMessage`。
- **归一化**：解密后的 content 经 `normalizeRawMessage(...)` 转为 `NormalizedMessage`（统一 role、content 结构，便于 reducer 消费）。
- **入队**：`enqueueMessages(sessionId, normalizedMessages)` 将本批消息放入 `sessionMessageQueue`，由 `scheduleQueuedMessagesProcessing` 在**该会话的 AsyncLock** 内按批调用 `applyMessages(sessionId, batch)`。
- **seq 追踪**：`sessionLastSeq.set(sessionId, maxSeq)`，用于后续增量判断（见 3.3）。

### 3.2 实时增量（Socket 'update'）

- **订阅**：`apiSocket.onMessage('update', handleUpdate)`，path 为 `/v1/updates`（WebSocket）。
- **类型**（由 `ApiUpdateContainerSchema` 校验）：
  - **new-message**：单条新消息（`body.sid` + `body.message` 加密体）。
  - **new-session**：新建会话，只做 `sessionsSync.invalidate()`。
  - **delete-session**：删除会话，本地直接删状态并清理该 session 相关 sync/outbox/queue。
  - **update-session**：会话元数据/agentState 更新（如 metadata、agentState 的加密 value+version）。

**new-message 处理要点**：

1. 若本地没有该 session 的加密上下文，先 `fetchSessions()` 再返回。
2. 用 `sessionEncryption.decryptMessage(message)` 解密，再 `normalizeRawMessage(...)`。
3. 根据内容更新会话的 `thinking` 等（如 task_complete / turn-end → thinking: false，task_started / turn-start → thinking: true）。
4. **快路径**：若 `incomingSeq === currentLastSeq + 1`，认为连续，直接 `enqueueMessages(sid, [lastMessage])` 并更新 `sessionLastSeq`，不再拉全量。
5. **慢路径**：否则 `getMessagesSync(sid).invalidate()`，重新走 `fetchMessages` 分页拉取。
6. 最后 `onSessionVisible(sid)`，保证该会话的 messages sync 已失效/会刷新。

### 3.3 消息“回放”到 UI 状态（Reducer）

- **入口**：所有经 `enqueueMessages` 进来的 `NormalizedMessage[]`，在队列处理中调用 `storage.getState().applyMessages(sessionId, messages)`。
- **作用**：  
  - 把同一会话的**多条消息**按顺序、幂等地合并进该会话的 `sessionMessages[sessionId]`（messages 数组 + messagesMap + reducerState）。  
  - 等价于在本地对“消息流”做一次**回放**：先有会话列表和会话级 agentState，再逐条应用消息，得到当前 UI 需要的 Message 列表和工具状态。

**Reducer 职责（见 reducer.ts 注释）**：

- **去重**：localId / messageId / permissionId 维度，避免重复展示。
- **与 AgentState 结合**：把 pending/completed 的 permission 转成占位或已匹配的 tool 消息；tool call 与 permission 按 name+args 匹配。
- **工具调用生命周期**：创建、匹配 permission、结果/错误、完成状态。
- **Sidechain**：嵌套会话/分支单独存储并挂到父 tool。
- **Mode / 事件**：如 turn-start、turn-end 等转为 UI 可用的状态。

**applyMessages 流程简述**：

- 取 `sessionMessages[sessionId]` 的现有 `reducerState`、`messagesMap`。
- 用 `reducer(existingSession.reducerState, normalizedMessages, agentState)` 得到新 messages 和可能更新的 todos/latestUsage。
- 将新 messages 合并进 messagesMap，再按 `createdAt` 排序得到最终 `messages` 数组。
- 若有 todos 或 latestUsage，顺带更新 `state.sessions[sessionId]`。
- 返回 `{ changed: messageIds, hasReadyEvent }`，供 Sync 层做语音等副作用（如 voiceHooks.onMessages / onReady）。

因此，“回放”指的是：**用服务端下发的消息序列 + 当前 AgentState，在本地用 reducer 重算出一致的 Message 列表和工具状态**，而不是简单 append。

---

## 四、发送消息（Outbox 与 flush）

- 用户发消息时 `sync.sendMessage(sessionId, text, displayText)`：
  - 生成 localId，用 session 加密加密 content，得到加密的 raw record。
  - **先乐观更新**：构造 `NormalizedMessage` 并 `enqueueMessages(sessionId, [normalizedMessage])`，UI 立刻显示。
  - 同一 payload 加入 `pendingOutbox.get(sessionId)`，并 `getSendSync(sessionId).invalidate()`。
- **flushOutbox(sessionId)**（由 SendSync 触发）：  
  把该会话 outbox 里的条目通过 API 发送（如 POST 到服务端），成功后服务端会通过 **new-message** 或后续拉取把“服务端确认版”消息再推/拉回来，由上述同步与 reducer 再次应用，完成闭环。  
  若在后台超过约 30s 未发送成功，会有本地超时和推送提示。

---

## 五、App 端持久化（MMKV）——什么存了、什么没存

持久化通过 **react-native-mmkv** 的 `persistence.ts` 完成，且**只持久化与“会话列表/会话消息”无关**的配置与用户数据。

### 5.1 会持久化的内容

| Key / 用途              | 说明 |
|-------------------------|------|
| `settings`              | 应用设置 + version（含服务器下发的设置同步版本） |
| `pending-settings`      | 未提交到服务器的设置草稿 |
| `local-settings`        | 本地设置（如主题、语言等） |
| `purchases`              | RevenueCat 购买状态 |
| `profile`               | 用户 profile |
| `session-drafts`        | 各会话输入框草稿 `Record<sessionId, string>` |
| `new-session-draft-v1`   | 新建会话向导的草稿（机器、路径、agent 类型等） |
| `temp_text_*`           | 临时大文本（用后即删） |

### 5.2 不持久化的内容（仅内存或通过消息最终一致）

- **会话 permission / model**：不写入 MMKV；由 CLI 在用户发带 `meta` 的消息时写入 `session.metadata`，App 拉会话列表时从 `session.metadata` 解析，最终一致。
- **会话列表**（`sessions`、`sessionListViewData`）：不写入 MMKV，完全依赖启动后 `fetchSessions` + Socket。
- **会话消息**（`sessionMessages[sessionId]`）：不写入 MMKV，依赖进入会话时 `fetchMessages` + Socket 增量。
- **Machines**：不写入 MMKV，由 `fetchMachines` + Socket 更新。
- **Artifacts / Friends / Feed 等**：同样仅内存，通过各自 sync 从 API/Socket 拉取。

因此，**会话列表和会话消息没有“本地数据库/本地队列回放”**，只有“服务端是真相源，App 用 REST + Socket 做同步与内存内回放”。

---

## 六、小结

| 维度           | 机制 |
|----------------|------|
| 会话列表来源   | REST `GET /v1/sessions` + Socket（new-session / delete-session / update-session） |
| 会话列表存储   | 仅内存（Zustand），不落盘 |
| 消息拉取       | 按会话分页 `GET /v3/sessions/:id/messages?after_seq=&limit=100` |
| 消息实时更新   | Socket `update`（new-message 快路径/慢路径） |
| 消息“回放”     | `applyMessages` → reducer 与 AgentState 合并，得到 Message 列表与工具状态 |
| 消息存储       | 仅内存（sessionMessages[sessionId]），不落盘 |
| App 持久化     | MMKV：settings、profile、drafts、purchases 等；**不包含**会话列表与消息内容 |

如需为会话列表或消息增加本地缓存（例如离线可读、启动即显），需要在现有 sync + reducer 之上增加一层“持久化层”（如 SQLite/MMKV 大对象/AsyncStorage），并在启动时从本地恢复再与服务器增量合并；当前实现未做这一步。
