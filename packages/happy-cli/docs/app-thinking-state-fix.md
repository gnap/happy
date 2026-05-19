# App：修复 session.thinking 卡住（给 App Agent）

> CLI 侧可选：`keepAlive(false)` 已改为非 volatile `emit`（`apiSession.ts`）。本文仅描述 **happy-app** 改动。

## 问题

会话能正常收发消息，但 `session.thinking` 长期为 `true`，顶部一直显示「思考中」。

根因：thinking 主要靠 ephemeral 的 `session-alive` 更新；`turn-end` 等持久消息在 **HTTP `fetchMessages` 补拉** 路径未同步清 thinking；reducer 收到 `ready` 事件（由 `turn-end` 归一化）时也未清 thinking。

## 1. 新建 `sources/sync/sessionThinkingLifecycle.ts`

```ts
export function getSessionThinkingPatchFromMessageContent(
  rawContent: unknown,
): { thinking: boolean } | null
```

| 条件 | 返回 |
|------|------|
| `content.type === 'session'` 且 `data.ev.t === 'turn-end'` | `{ thinking: false }` |
| `content.type === 'session'` 且 `data.ev.t === 'turn-start'` | `{ thinking: true }` |
| `content.type === 'acp' \| 'codex'` 且 `data.type === 'task_complete' \| 'turn_aborted'` | `{ thinking: false }` |
| `content.type === 'acp' \| 'codex'` 且 `data.type === 'task_started'` | `{ thinking: true }` |
| 其他 | `null` |

`data` 对应 CLI `sendSessionLifecycleEnvelope`：`content: { type: 'session', data: envelope }`，生命周期在 `data.ev.t`。

建议单测：`sessionThinkingLifecycle.test.ts`（turn-end / turn-start / codex task_complete / 普通文本）。

## 2. `sync.ts` — 实时 `new-message` 路径

解密后删除内联 `isTaskComplete` / `isTaskStarted`，改为：

```ts
import { getSessionThinkingPatchFromMessageContent } from './sessionThinkingLifecycle';

const thinkingPatch = getSessionThinkingPatchFromMessageContent(decrypted.content);
// applySessions:
...(thinkingPatch ?? {}),
```

## 3. `sync.ts` — `fetchMessages` 路径（重要）

在每个 `decrypted` 消息 `normalize` 之后增加：

```ts
const thinkingPatch = getSessionThinkingPatchFromMessageContent(decrypted.content);
if (thinkingPatch) {
  const currentSession = storage.getState().sessions[sessionId];
  if (currentSession && currentSession.thinking !== thinkingPatch.thinking) {
    this.applySessions([{
      ...currentSession,
      ...thinkingPatch,
      thinkingAt: Date.now(),
    }]);
  }
}
```

否则仅 HTTP 同步历史时 thinking 不会被 lifecycle 纠正。

## 4. `sync.ts` — `applyMessages` 收到 `ready` 时清 thinking

`result.hasReadyEvent` 为 true 时（reducer 对 `role === 'event' && content.type === 'ready'`），在 `voiceHooks.onReady(sessionId)` 之后：

```ts
const session = storage.getState().sessions[sessionId];
if (session?.thinking) {
  this.applySessions([{
    ...session,
    thinking: false,
    thinkingAt: Date.now(),
  }]);
}
```

## 验收

1. Cursor 会话一轮结束后，thinking 应在 `turn-end` / `ready` 后消失（含仅 HTTP、无 WS 场景）。
2. 新 turn 开始仍可显示 thinking。
3. 普通用户/助手文本不误改 thinking。
