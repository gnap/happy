# Cursor 路径重复消息排查

## 结论摘要

- **推送**：`feature/cursor-agent` 已 push（876294db）。
- **envelope + no output 双发**：当前实现是「只发 session envelope、不双发 output/cursor」；-wip worktree 与主仓逻辑一致。
- **开发版 + session 已开启仍重复**：CLI 未双发 output/cursor；App 已 skip output/codex/user。重复更可能来自：(1) 同一内容被两条不同 id 的 session envelope 发出，(2) realtime 与 poll 导致同一条消息被应用两次但 id 不一致，(3) 服务端存了两条（例如 App 发出的 user + CLI 回的 session user）。下面给出针对性排查与可加日志。

## 1. CLI 侧：没有双发

- **Happy cursor 路径**（`runCursor.ts`）：只调用 `session.sendSessionProtocolMessage(envelope)`，没有 `sendOutputFormatMessage` / `sendCursorMessage`。注释写明：*"Happy cursor path: only send session protocol (envelope). No output-format dual-send."*
- **旧 Cursor 路径（ACP）**（`CursorBackend` → `runAcp.ts`）：只通过 `sendEnvelopes` → `sendSessionProtocolMessage` 发 session envelope，没有调用 `sendOutputFormatMessage` 或 `sendCursorMessage`。
- 全仓库 grep：**没有任何地方**在 Cursor 路径下调用 `sendOutputFormatMessage`；`sendCursorMessage` 仅在 `runCursor.ts` 里有一处被注释掉的调用。

因此：无论新路径还是旧路径，CLI 都**只发 envelope，没有 output/cursor 双发**。

## 2. App 侧：envelope vs output 的 skip 逻辑（主仓 = wip）

在 **主仓** 与 **-wip worktree**（`happy-cursor-ios-wip`，branch `wip/device-debug-cache`）的  
`packages/happy-app/sources/sync/typesRaw.ts` 中，逻辑一致：

- `isSessionProtocolSendEnabled()`：由 `EXPO_PUBLIC_ENABLE_SESSION_PROTOCOL_SEND` / `ENABLE_SESSION_PROTOCOL_SEND` 或 app config 决定。
- **output**（`raw.content.type === 'output'`）：当 `isSessionProtocolSendEnabled()` 为 true 时 **return null**，避免与 session 内容重复（注释：*"skip output to avoid duplicate bubbles"*）。
- **codex/cursor**（`raw.content.type === 'codex' || 'cursor'`）：当 session protocol 开启时，对 `message` / `reasoning` / `thinking` **return null**，只保留 tool-call / tool-call-result 等。
- **user**（`raw.role === 'user'`）：当 session protocol 开启时 **return null**，用户消息只来自 session envelope，避免和「App 自己发出的 user」重复。

即：**envelope + no output 的「不双发」逻辑在主仓和 -wip 上都已经实现**。

## 3. 若旧版 App 仍出现重复，可能原因

1. **Session protocol 未开启**  
   - 旧版 App 未设置 `EXPO_PUBLIC_ENABLE_SESSION_PROTOCOL_SEND=1`（或等价配置），则不会执行上述 skip，可能仍会渲染 legacy 的 user/output/codex 等。  
   - **建议**：在出现重复的设备/构建上确认 `isSessionProtocolSendEnabled()` 是否为 true（可打 log 或通过构建配置确认）。

2. **同一条内容被多条 envelope 发送**  
   - CLI 若因重试、重连或逻辑错误，对同一段 agent 文本发了多条 session envelope（不同 `envelope.id`），reducer 会按两条消息展示。  
   - **建议**：在 CLI 或 App 抓包/打 log，看同一 turn 内是否有多条 `ev.t === 'text'` 且内容相同的 envelope。

3. **Sync/Reducer 去重边界**  
   - Reducer 通过 `localId`（user）和 `messageId`（所有消息）去重；若同一逻辑消息以不同 id 出现两次（例如一条来自 legacy user、一条来自 session user envelope），且 session protocol 未开启，则可能两条都展示。  
   - 在 session protocol 开启且 CLI 不双发的前提下，理论上不应出现「一条来自 output、一条来自 envelope」的重复。

## 4. 开发版 + session 已开启仍重复时的排查

在确认是**开发版**且 **session 协议已开启** 的前提下，重复只可能来自：

1. **两条不同 id 的 session 消息、内容相同**  
   - CLI 对同一段内容发了两个 envelope（两个 `envelope.id`），或  
   - 服务端存了两条（例如：App 发出的 `role: 'user'` 一条 + CLI 回的 `role: 'session'` 一条；App 端会 skip `role: 'user'`，但若两条都是 `role: 'session'` 且 id 不同就会显示两条）。

2. **同一条消息被应用两次且 id 一致**  
   - Reducer 会用 `state.messageIds.has(msg.id)` 去重，理论上同 id 不会出现两条。若仍重复，需确认：realtime 与 fetchMessages 拿到的同一条消息的 `decrypted.id` 是否一致；若不一致（例如服务端对同一 body 返回了不同 id），就会变成两条。

3. **用户消息的「两条」**  
   - 发送时：session 开启下 `normalizeRawMessage(role: 'user')` 返回 null，不会做乐观更新。  
   - 若服务端先回传「App 发出的那条」再回传「CLI 的 user envelope」，且两条在 App 里用不同 id 落地，就会看到两条用户消息。排查时看服务端该会话的消息列表里是否既有 `role: 'user'` 又有 `role: 'session'`（user envelope）两条。

### 建议加的日志（便于定位是「两条 id」还是「同一条两次」）

- **CLI**：已支持 `HAPPY_CURSOR_TRACE_ENVELOPES=1`。设置后会在 `apiSession.sendSessionProtocolMessage` / `sendSessionLifecycleEnvelope` 打 `envelope.id`、`ev.t` 及 text 前 80 字（需 `DEBUG=1` 或 logger 输出 debug 才可见）。可确认同一 turn 内是否对同一内容发了多个 envelope。
- **App**（如 `sync.ts` realtime 分支、或 fetchMessages 应用处）：在 `normalizeRawMessage` 前打 `decrypted.id`、`decrypted.content.role`、若 session 再打 `content.data?.ev?.t`；在 `applyMessages`/reducer 前打本次应用的 `normalizedMessages.map(m => m.id)`。对比是否出现同一 id 被应用两次，或两个不同 id 对应同一显示内容。

## 5. 建议的下一步

- 在仍出现重复的 App 构建上：确认 **session protocol 是否开启**（环境变量或 app config）。
- 若已开启仍重复（尤其是开发版）：对 **同一会话** 抓一次 realtime/sync 的原始消息序列，看是否出现：
  - 多条 `role: 'user'`，或  
  - 多条 `role: 'session'` 且 `ev.t === 'text'` 内容相同（或两条 user envelope），或  
  - 同时存在 `type: 'output'` 与对应 session envelope。  
- 用上面 4 的日志确认：是「两个不同 id 的同内容」还是「同 id 被应用两次」。

据此可判断是「未开 session protocol」「CLI 多发」「服务端双条」还是「sync 重复投递 / id 不一致」导致。
