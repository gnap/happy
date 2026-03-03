# 首批支持 Codex 时的 Claude 消息格式（Git 历史）

根据 Git 历史，**最早**的「归一化入站消息」实现（commit **27f6c79**，`ref: normalizing incoming messages`）里，App 只认一种 agent 消息格式：**Claude 的 `output` 格式**。当时**没有** codex、session、cursor、acp 等类型。

---

## 1. 27f6c79 时的 Raw 消息格式（最早一版）

**文件**：`sources/sync/typesRaw.ts`（当时尚未在 `packages/happy-app` 下）

### 1.1 RawRecord 的 schema

```ts
// 只有两种 role
const rawRecordSchema = z.discriminatedUnion('role', [
    z.object({
        role: z.literal('agent'),
        content: rawAgentRecordSchema   // 见下
    }),
    z.object({
        role: z.literal('user'),
        content: z.object({ type: z.literal('text'), text: z.string() })
    }),
]);

// Agent 只有一种 content 类型：output
const rawAgentRecordSchema = z.object({
    type: z.literal('output'),
    data: z.discriminatedUnion('type', [
        z.object({ type: z.literal('system') }),
        z.object({ type: z.literal('result') }),
        z.object({ type: z.literal('summary'), summary: z.string() }),
        z.object({
            type: z.literal('assistant'),
            message: z.object({
                role: z.literal('assistant'),
                model: z.string(),
                content: z.array(rawAgentContentSchema)   // text | tool_use | tool_result
            })
        }),
        z.object({
            type: z.literal('user'),
            message: z.object({
                role: z.literal('user'),
                content: z.array(rawAgentContentSchema)
            })
        }),
    ]),
});
```

即：**仅支持 `role: 'agent'` + `content.type === 'output'`**，且 `content.data.type` 只能是 `system` | `result` | `summary` | `assistant` | `user`。

### 1.2 用于展示的 data 类型

- **`data.type === 'assistant'`**：`message.content` 为 `Array<{ type: 'text', text } | { type: 'tool_use', id, name, input }>`，被归一化成 agent 的 text / tool-call。
- **`data.type === 'user'`**：`message.content` 为 tool_result 等，归一化成 tool-result。
- **`data.type === 'summary'`**：归一化成 summary。

没有 codex、cursor、session、acp；若当时收到这些类型，会落在 `raw.content.type === 'output'` 之外，**没有对应 schema 分支，校验会失败**（当时还没有 safeParse + return null 的写法，但逻辑上等价：非 output 的 agent 消息不会被接受）。

---

## 2. 「首批支持 Codex」在本文库里的时间点

- **27f6c79**：只有 **output**（Claude 格式）。
- **bb7a117**（feat(happy-app): metadata-driven model/mode selection）：在 **同一份 typesRaw** 里已经同时有 **output、codex、session**（以及 acp、event 等）；**没有** cursor。
- **83626fc**：在 agent 分支里**新增** `content.type === 'cursor'`。

因此：
- **「首批支持 Codex」** 在本仓库里对应的是 **bb7a117**：那时 App 已支持 **output + codex + session**。
- **更早的「只支持 Claude」** 对应 **27f6c79**：只认 **output** 一种 agent 格式。

---

## 3. Claude「output」格式的精确形状（旧 App 兼容用）

要让**只认 output 的旧 App**（例如 27f6c79 或未合入 codex/session 的构建）能展示 Cursor 的回复，需要发 **output** 形状，例如：

```ts
// 一条 agent 文本回复
{
  role: 'agent',
  content: {
    type: 'output',
    data: {
      type: 'assistant',
      message: {
        role: 'assistant',
        model: 'cursor',   // 或任意 string
        content: [
          { type: 'text', text: '...' }
        ]
      }
    }
  },
  meta: { sentFrom: 'cli' }
}
```

工具调用 / 工具结果在 27f6c79 里也有对应：`content` 里用 `tool_use` / `tool_result`（与当前 rawAgentContentSchema 一致）。当前 App 的 `rawAgentRecordSchema` 里 output 分支更宽（含 isSidechain、uuid 等），但**最小可用的旧格式**就是上面这种。

---

## 4. 和当前 Cursor / 旧 App 不展示的关系

- 当前 Cursor 已改为**只发 session 协议**（`role: 'session'`, `content: envelope`），并**注释掉**了 cursor 格式。
- 若旧 App 是基于 **27f6c79 或仅含 output 的版本**，则它**没有** `role: 'session'` 和 session 的 preprocess，也**没有** codex/cursor 分支，只会认 **output**。
- 因此：**只发 session 时，这类旧 App 会整条不展示**；要兼容，需要要么在旧 App 上补 session（或 codex）支持，要么让 Cursor **同时或仅**发送 **output** 格式（即「首批支持 Codex 时的 Claude 消息格式」）。

---

## 5. 小结

| 时间点 / 提交     | 支持的 agent 消息格式 |
|-------------------|------------------------|
| **27f6c79**       | 仅 **output**（Claude） |
| **bb7a117**       | **output** + **codex** + **session**（无 cursor） |
| **83626fc 及以后**| output + codex + **cursor** + session + acp + event |

「首批支持 Codex 时的 Claude 消息格式」= **output**：`role: 'agent'`, `content: { type: 'output', data: { type: 'assistant'|'user'|'summary'|..., message: { ... } } }`。若需兼容只认 output 的旧 App，Cursor 可增加一条用该形状发送的路径（与 session 双发或单独发）。

---

## 6. 原 repo（slopus/happy-cli）里 Claude CLI 的发送方式

在 **GitHub 上的 slopus/happy-cli**（main 分支）里，`src/api/apiSession.ts` 的 `sendClaudeSessionMessage` 是**直接发 output 格式**，没有 session 协议转换：

```ts
sendClaudeSessionMessage(body: RawJSONLines) {
    let content: MessageContent;
    if (body.type === 'user' && typeof body.message.content === 'string' && body.isSidechain !== true && body.isMeta !== true) {
        content = { role: 'user', content: { type: 'text', text: body.message.content }, meta: { sentFrom: 'cli' } };
    } else {
        // Wrap Claude messages in the expected format
        content = {
            role: 'agent',
            content: {
                type: 'output',
                data: body   // 整条 Claude log 原样放进 data
            },
            meta: { sentFrom: 'cli' }
        };
    }
    const encrypted = encodeBase64(encrypt(...));
    this.socket.emit('message', { sid: this.sessionId, message: encrypted });
    // ... usage / summary
}
```

- **User**：发 `role: 'user'`, `content: { type: 'text', text }`。
- **其他（assistant / summary 等）**：发 **`role: 'agent'`, `content: { type: 'output', data: body }`**，即**历史 Claude CLI 发的是 output 格式**，和 App 端 27f6c79 的「只认 output」一致。

合并进本 monorepo 后，改成了 session 协议（`mapClaudeLogMessageToSessionEnvelopes` → `sendSessionProtocolMessage`）。所以：**旧 App 若只支持 output，兼容的是原 slopus/happy-cli 的 Claude 发法；要让 Cursor 在旧 App 上展示，可同样发 output 格式。**
