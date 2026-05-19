# CLI 连接稳定性 & A2A Inbox 堆积（调查笔记）

## 连接稳定性（会话 `cmok15bblbnw10f0ufpyjbely`）

### 历史问题（PID 4037392，~16:07–17:40）

- WebSocket **秒断秒连**：1549 次 connect / 1549 次 `transport close`，约 97% 连接存活 &lt;1s。
- 断线后走 **HTTP fallback 每 8s** 拉消息 → App→CLI 用户消息最多约 **8s 额外延迟**；RPC（abort 等）**无 HTTP 兜底**，易丢。
- 诱因之一：每次 `recordA2AMessage` / `markA2A*` 通过 `update-state` 同步**完整** `agentState.a2aInbox`（可非常大），与高频 `session-alive`、outbox flush 叠加，易在 Cloudflare/弱网下触发 `transport close`。

### 重启后（PID 900060，18:28+）

- 当前日志：**1 connect / 0 disconnect**（稳定）。
- 用户消息 **App→CLI 路由 ~2ms**；首条回复 flush **0.6–1.5s**（spawn 后）。
- **整轮耗时**主要来自 **cursor-agent 执行**（例：18:37:35 用户消息 → 18:38:28 Turn completed ≈ **53s**），不是队列排队或收消息慢。

### 用户感知「回复慢」分解

| 阶段 | 稳定 WS | WS 抖动时 |
|------|---------|-----------|
| App → CLI 收到 | 实时 / &lt;100ms | 最多 **+8s**（fallback poll） |
| 进入 cursor-agent | 立即 dequeue | 同上 |
| agent 跑完一轮 | 数十秒（模型/工具） | 同上 |

### CLI 已实现（2026-05）

1. **a2aInbox 修剪**：`mark` 后默认删除已读行；`upsert` 后按 `CURSOR_A2A_INBOX_MAX_MESSAGES`（默认 64）上限裁剪。
2. **update-state 防抖**：`recordA2AMessage` 400ms 合并；`mark*` 立即同步。
3. **快照 GC**：`pruneA2AInboxSnapshots`（默认每 session 保留 5 个，见 `CURSOR_A2A_INBOX_SNAPSHOT_KEEP`）。
4. **keepAlive(false)** 非 volatile `emit`。

### 仍待做

1. **P1** WS 抖动时 abort / RPC HTTP 兜底。
2. **P2** session-scoped `polling` transport 回退。

---

## A2A Inbox：已读会不会清掉？

**结论：不会。** 已读只打 `readAt`，消息仍留在内存、服务端 `agentState` 和磁盘快照里，会持续堆积。

### 内存 + 服务端 agentState

- **本地**：`~/.happy/a2a-inbox-state/{sessionId}.json` 存全文。
- **Server**：`agentState.a2aInbox` 仅 `{ unreadCount }`（`update-state`，非 metadata）。
- `recordA2AMessage` / `mark*` 更新本地文件；server 只收到未读数。

相关代码：

- `packages/happy-cli/src/a2a/inbox.ts`
- `packages/happy-cli/src/api/apiSession.ts`（`recordA2AMessage`, `markA2AMessageRead`）
- MCP：`packages/happy-cli/src/claude/utils/startHappyServer.ts`

### 磁盘快照（浪费空间）

- 每次 A2A inbox turn 写 `{workspace}/.happy/a2a-inbox/{sessionId}-{turnId}.json`（`writeA2AInboxSnapshot`），**从不删除**。
- 实测 AutoQuant：`592` 个文件、约 **35MB**；`~/.happy/a2a-inbox` 另有 **760** 个文件（若 daemon 也写）。

### 已实现行为

- **Server `agentState.a2aInbox`**：仅 `{ unreadCount: number }`，**不含消息正文**。
- **本地全文**：`~/.happy/a2a-inbox-state/{sessionId}.json`；MCP / inbox turn 只读本地。
- **已读**：`markA2A*` 后从本地 `messages[]` 移除（`CURSOR_A2A_INBOX_KEEP_READ=1` 可保留只打 `readAt`）。
- **上限**：`CURSOR_A2A_INBOX_MAX_MESSAGES`（默认 64，仅本地文件）。
- **快照**：`.happy/a2a-inbox/{sessionId}-{turnId}.json`（工作区内，不上 server）。
- **迁移**：若 server 上仍有旧版带 `messages[]` 的 blob，首次启动会导入本地并改写为仅 `unreadCount`。

### A2A turn 与用户消息的排队

- `MessageQueue2`：用户消息 `pushIsolated`，与 A2A inbox turn（`a2aInboxTurn: true`）串行。
- `scheduleA2ATurnIfNeeded` 在有未读 inbox 时会插一轮 **空 prompt 的 inbox turn**；若 inbox 未正确 mark read，会反复占用队列，拖慢用户消息（与 autoloop 配置无关，是 inbox 状态问题）。
