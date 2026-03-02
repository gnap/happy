# 本地 Session 会话存储方案设计

目标：App 冷启动时从本地 SQLite 恢复会话与消息，仅用 `after_seq=lastSeq` 拉取少量新消息，并对新消息做**增量 merge**；同时在会话归档功能下新增**重建消息缓存**入口。

---

## 一、SQLite 表设计

```sql
-- 每个会话一行：存 lastSeq、schema 版本、序列化后的 ReducerState
CREATE TABLE session_cache (
    session_id     TEXT    PRIMARY KEY,
    last_seq       INTEGER NOT NULL DEFAULT 0,
    min_seq        INTEGER NOT NULL DEFAULT 0,   -- 本地最老消息的 seq
    schema_version INTEGER NOT NULL DEFAULT 1,
    cached_at      INTEGER NOT NULL,             -- 最后写入时间 (unix ms)
    reducer_state  TEXT    NOT NULL              -- 序列化的 ReducerState (JSON)
);

-- 每条 merge 后的 Message 一行（reducer 产出的 UI 层消息）
CREATE TABLE session_messages (
    session_id   TEXT    NOT NULL,
    message_id   TEXT    NOT NULL,   -- reducer 内部分配的 ID（非服务端 seq）
    seq          INTEGER,            -- 对应服务端 seq（permission-only 消息无 seq，为 NULL）
    created_at   INTEGER NOT NULL,
    message_json TEXT    NOT NULL,   -- 序列化的 Message 对象
    is_open      INTEGER NOT NULL DEFAULT 0,  -- 1 = 消息处于"开放"状态（见下）
    PRIMARY KEY (session_id, message_id)
);
CREATE INDEX idx_sm_seq ON session_messages (session_id, seq);
CREATE INDEX idx_sm_open ON session_messages (session_id, is_open);
```

**`is_open` 含义**（见第四节详细说明）：
- `tool-call` 消息，`tool.state === 'running'` → 1
- `agent-text` 消息，`isThinking === true` 且 thinking 流尚未在本页闭合 → 1
- Sidechain 消息，其父 Task 仍 running → 1
- 其余正常闭合的消息 → 0

---

## 二、ReducerState 序列化 / 反序列化

`ReducerState` 内含多个 `Map`，需转为可 JSON 序列化的结构。

### 2.1 序列化格式

```typescript
type PersistedReducerState = {
    schemaVersion: number;                   // 用于迁移检测，当前 = 1
    toolIdToMessageId: [string, string][];
    sidechainToolIdToMessageId: [string, string][];
    permissions: [string, StoredPermission][];
    localIds: [string, string][];
    messageIds: [string, string][];
    lastThinkingMessageId: string | null;
    messages: [string, ReducerMessage][];    // 内部 ReducerMessage（非 UI 层 Message）
    sidechains: [string, ReducerMessage[]][]; 
    tracerState: SerializedTracerState;      // TracerState 的 JSON 化形式
    latestTodos?: ReducerState['latestTodos'];
    latestUsage?: ReducerState['latestUsage'];
};
```

建议在 `reducer.ts` 旁边新增 `reducerStateSerializer.ts`：

```typescript
export function serializeReducerState(state: ReducerState): PersistedReducerState;
export function deserializeReducerState(raw: PersistedReducerState): ReducerState;
```

版本不兼容（如结构变更）时，调用方捕获异常后清空该会话缓存并从 `seq=0` 重建。

### 2.2 为何必须序列化 `state.messages`（内部 ReducerMessage）

这是关键点。reducer 在处理 `tool-result` 时会执行：

```typescript
let message = state.messages.get(messageId);  // 从内部 Map 取 ReducerMessage
message.tool.state = 'completed';             // 原地修改
message.tool.result = c.content;
```

如果只持久化 UI 层 `Message[]` 而不持久化 `state.messages` Map，那么下一次增量 merge 时，reducer 找不到内部 Map 里的 ReducerMessage，无法正确地将跨页 `tool-call-start / tool-call-end` 配对关闭。因此 **`state.messages` 和 `state.sidechains`（ReducerMessage 层）必须一起序列化**。

---

## 三、跨请求的"开放消息"问题

以下三类消息**天然跨越分页边界**，处理不当会在 SQLite 中残留未闭合的中间态：

### 3.1 Thinking 流（streaming 思考块）

```
seq 50: thinking chunk A   → reducer 创建 bubble X，is_open=1，lastThinkingMessageId=X
seq 51: thinking chunk B   → reducer 在 60s 窗口内将 B 追加到 X
seq 52: thinking chunk C   → 继续追加 ...
-- ↑ 如果分页边界在这里，X 仍处于 is_open=1
seq 53（下一页）: text message → reducer 清除 lastThinkingMessageId，X 隐式"闭合"
```

**处理方式**：  
每页处理完毕后，从 `ReducerState.lastThinkingMessageId` 判断最后一条 thinking bubble 是否仍是最后处理的消息类型。若是，该 bubble 的 `is_open=1`；下一页 merge 后若 `lastThinkingMessageId` 改变或 user message 到来，将其更新为 `is_open=0`。

### 3.2 Tool Call（开 / 闭状态）

```
seq 80: tool-call-start  (callId=X) → state: running, is_open=1, toolIdToMessageId[X]=msgId
-- 分页边界
seq 95（下一页）: tool-call-end (callId=X) → reducer 找到 toolIdToMessageId[X]，更新 state: completed, is_open=0
```

**处理方式**：  
reducer 调用后，遍历 `result.messages` 中 `kind==='tool-call'` 的消息；若 `tool.state === 'running'` 则写 `is_open=1`；若 `completed/error` 则 `is_open=0`。对 SQLite 做 UPSERT。

### 3.3 Task / Sidechain（subagent 消息流）

```
seq 70: task-started (subagentId=S) → 父 Task message 创建，is_open=1
  seq 71-85: sidechain messages      → 写入 sidechains Map
seq 95: task-complete (subagentId=S) → 父 Task 闭合，is_open=0
```

**处理方式**：同 tool-call 逻辑，根据父 Task ToolCallMessage 的 `tool.state` 判断 `is_open`。

### 3.4 核心保证：ReducerState 是跨请求的连续性载体

只要每次 merge 后正确序列化并写回 SQLite（含 `state.messages` Map、所有 ID 映射、`lastThinkingMessageId`），下一次增量 merge 调用：

```typescript
reducer(deserializedReducerState, newNormalizedMessages, agentState)
```

时，reducer 内部的所有状态机（thinking 窗口、工具配对、sidechain 关联）均可正确延续，无需在应用层维护额外的"跨请求持有缓冲区"。

**唯一的应用层责任**是：每次 merge 结束后，对 `is_open=1` 的消息做好标记，以便快速定位哪些消息在下一次 merge 中可能被更新。

---

## 四、增量 Merge 流程（详细）

### 4.1 冷启动

```
1. fetchSessions → 得到 session 列表 + DEK → initializeSessions(sessionKeys)
2. 从 SQLite 读取 session_cache（lastSeq、reducer_state）
3. 从 SQLite 读取 session_messages（按 created_at 排序得 Message[]）
4. deserializeReducerState → ReducerState
5. hydrateFromLocal(sessionId, messages[], reducerState)
   → 写入 Zustand sessionMessages[sessionId]，isLoaded=true
   → 首屏立即可以展示本地已有消息
6. 后台按 after_seq=lastSeq&limit=50 拉取新消息（见 4.2）
```

### 4.2 增量 merge（每次拉取新页）

```typescript
async function incrementalMerge(sessionId: string, newNormalizedMessages: NormalizedMessage[]) {
    const { reducerState, messagesMap } = getSessionState(sessionId);
    const agentState = getSession(sessionId).agentState;

    // 1. 增量 reduce（只处理新消息）
    const result = reducer(reducerState, newNormalizedMessages, agentState);

    // 2. 将 result.messages（新增/变更）合并进 messagesMap
    for (const msg of result.messages) {
        messagesMap[msg.id] = msg;
    }

    // 3. 按 createdAt 排序，写回 Zustand
    const sorted = Object.values(messagesMap).sort((a, b) => b.createdAt - a.createdAt);
    writeToZustand(sessionId, sorted, reducerState);

    // 4. 更新 lastSeq
    const newLastSeq = max(newNormalizedMessages 中有 seq 的最大值, lastSeq);

    // 5. 写回 SQLite
    await db.transaction(() => {
        // 5a. UPSERT 变更/新增的消息
        for (const msg of result.messages) {
            const isOpen = calcIsOpen(msg);
            db.run(`
                INSERT OR REPLACE INTO session_messages
                    (session_id, message_id, seq, created_at, message_json, is_open)
                VALUES (?, ?, ?, ?, ?, ?)
            `, [sessionId, msg.id, resolveSeq(msg), msg.createdAt, JSON.stringify(msg), isOpen]);
        }

        // 5b. 更新 is_open=0 对那些已经闭合的旧 open 消息
        //     （检查 result.messages 中原来 is_open=1 且现在已 completed/closed 的）
        for (const msg of result.messages) {
            if (!calcIsOpen(msg)) {
                db.run(`UPDATE session_messages SET is_open=0, message_json=?
                        WHERE session_id=? AND message_id=?`,
                    [JSON.stringify(msg), sessionId, msg.id]);
            }
        }

        // 5c. 更新 session_cache（lastSeq + reducer_state）
        db.run(`
            INSERT OR REPLACE INTO session_cache
                (session_id, last_seq, schema_version, cached_at, reducer_state)
            VALUES (?, ?, 1, ?, ?)
        `, [sessionId, newLastSeq, Date.now(), JSON.stringify(serializeReducerState(reducerState))]);
    });
}

function calcIsOpen(msg: Message): 0 | 1 {
    if (msg.kind === 'tool-call' && msg.tool.state === 'running') return 1;
    if (msg.kind === 'agent-text' && msg.isThinking) return 1;
    return 0;
}
```

### 4.3 分页完成后检查 thinking 窗口关闭

每页 fetch 完毕后，额外检查：

```typescript
// 当前 reducerState.lastThinkingMessageId 是否对应一条 is_open 消息
const thinkingId = reducerState.lastThinkingMessageId;
if (thinkingId) {
    const thinkingMsg = messagesMap[thinkingId];
    if (thinkingMsg && thinkingMsg.kind === 'agent-text' && thinkingMsg.isThinking) {
        // 仍 open，保留 is_open=1（已在上面 UPSERT 中处理）
    }
}
```

---

## 五、重建消息缓存功能

### 5.1 UI 入口（session/[id]/info.tsx）

在当前的"Quick Actions"组，归档和删除按钮后面，增加一个"重建消息缓存"按钮：

```tsx
<ItemGroup title={t('sessionInfo.quickActions')}>
    {/* ... 现有的 archive / delete 按钮 ... */}

    {/* 新增：重建消息缓存 */}
    <Item
        title={t('sessionInfo.rebuildMessageCache')}
        subtitle={t('sessionInfo.rebuildMessageCacheSubtitle')}
        icon={<Ionicons name="refresh-circle-outline" size={29} color="#007AFF" />}
        loading={rebuilding}
        onPress={handleRebuildCache}
    />
</ItemGroup>
```

### 5.2 逻辑

```typescript
const [rebuilding, performRebuild] = useHappyAction(async () => {
    // 1. 清空该会话的本地缓存
    await db.run('DELETE FROM session_messages WHERE session_id = ?', [session.id]);
    await db.run('DELETE FROM session_cache WHERE session_id = ?', [session.id]);

    // 2. 清空内存中该会话的消息状态
    storage.getState().clearSessionMessages(session.id);

    // 3. 重置 lastSeq = 0，触发全量重新拉取
    sync.resetSessionCache(session.id);       // 内部将该会话的 sessionLastSeq 设为 0
    sync.onSessionVisible(session.id);        // 触发 fetchMessages(sessionId)

    // 4. 提示用户
    Modal.alert(t('common.success'), t('sessionInfo.rebuildCacheStarted'));
});

const handleRebuildCache = useCallback(() => {
    Modal.alert(
        t('sessionInfo.rebuildMessageCache'),
        t('sessionInfo.rebuildMessageCacheConfirm'),
        [
            { text: t('common.cancel'), style: 'cancel' },
            { text: t('sessionInfo.rebuildMessageCache'), onPress: performRebuild }
        ]
    );
}, [performRebuild]);
```

### 5.3 翻译 key 建议（在各语言文件中新增）

```typescript
// _default.ts
rebuildMessageCache: 'Rebuild Message Cache',
rebuildMessageCacheSubtitle: 'Clear and re-fetch all messages from server',
rebuildMessageCacheConfirm: 'This will clear the local message cache and re-download all messages. Continue?',
rebuildCacheStarted: 'Message cache cleared. Re-fetching messages...',
```

---

## 六、存储容量控制

```typescript
const MAX_MESSAGES_PER_SESSION = 500;   // 每会话最多缓存 N 条 merged 消息
const MAX_CACHED_SESSIONS = 30;         // 最多缓存多少个会话

// 每次写入后，若超过上限则淘汰（按 created_at asc 删最旧）
async function trimSessionMessages(sessionId: string) {
    const count = await db.getFirst<{n: number}>(
        'SELECT COUNT(*) as n FROM session_messages WHERE session_id=?', [sessionId]
    );
    if (count.n > MAX_MESSAGES_PER_SESSION) {
        const excess = count.n - MAX_MESSAGES_PER_SESSION;
        await db.run(`
            DELETE FROM session_messages
            WHERE session_id=? AND message_id IN (
                SELECT message_id FROM session_messages
                WHERE session_id=? ORDER BY created_at ASC LIMIT ?
            )
        `, [sessionId, sessionId, excess]);
        // 同步更新 min_seq
        const minRow = await db.getFirst<{seq: number}>(
            'SELECT MIN(seq) as seq FROM session_messages WHERE session_id=?', [sessionId]
        );
        await db.run('UPDATE session_cache SET min_seq=? WHERE session_id=?',
            [minRow.seq ?? 0, sessionId]);
    }
}
```

---

## 七、边界情况

| 情况 | 处理方式 |
|------|---------|
| `schema_version` 不匹配 | 清空该会话缓存，从 seq=0 重建 |
| ReducerState 反序列化失败 | 同上 |
| session 被删除（服务端） | `DELETE FROM session_messages / session_cache WHERE session_id=?` |
| 用户登出 | 清空整个 SQLite DB（或加密 DB 密钥轮换） |
| Web 端 | 用 IndexedDB 实现同一接口抽象（StorageAdapter），MMKV/SQLite 仅 native |
| 服务端 seq 回退（极少见） | 检测到 `newSeq < lastSeq` 时触发重建 |
| `is_open` 消息在下次 merge 后仍未闭合 | 保持 `is_open=1`，不影响功能；重建缓存后会从服务端重拉完整历史 |

---

## 八、实现优先级与步骤

1. **新增 `reducerStateSerializer.ts`**：序列化/反序列化 ReducerState（含 `state.messages` Map）。
2. **建 SQLite 表**（可用 `expo-sqlite` 的 `SQLiteDatabase`），封装 `sessionCacheDB.ts`。
3. **改造 `sync.ts`**：在 `fetchMessages` 分页循环和 Socket 新消息路径中，调用 `incrementalMerge()`，将 merge 结果写回 SQLite。
4. **新增 `hydrateFromLocal(sessionId)`**：冷启动时从 SQLite 读取，写入 Zustand，设 `isLoaded=true`。
5. **在 `info.tsx` 添加 "Rebuild Message Cache" 按钮**，配套翻译 key。
6. **存储容量 trim**：每次写入后调用 `trimSessionMessages()`。
7. **schema 迁移机制**：`schema_version` 升级时 DROP+RECREATE 或按需 ALTER。
