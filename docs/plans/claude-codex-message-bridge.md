# Claude ↔ Codex 消息 bridge：调研与设计

**状态：调研完成，实现未开始。** 本文记录已验证的事实、收敛后的架构和第一版范围，留给后续会话实现。

目标是在一个 Claude 会话和一个 Codex 会话之间双向传消息：

- 两边都用**真实的会话/线程**，不模拟子 agent、不代理最终文本；
- 模型显式调用发送工具时才跨会话，普通输出仍留在各自会话；
- 记录消息来源、目标、thread/turn、回复关系和投递状态，可去重；
- bridge 是**独立服务**，重启周期与 daemon 分开。

---

## 1. 已验证的事实

### Claude 侧

- `claude agents --json` 可列活跃会话；按 name/sessionId 定位。
- 每个会话在 `~/.claude/sessions/<pid>.json` 里有：
  - `messagingSocketPath`（AF_UNIX / SOCK_STREAM）
  - `startedAt`、`peerProtocol`、`peerFeatures`、`status`
- 向该 socket 写一行 UTF-8 JSON：

  ```json
  {"type":"user","from":"uds:bridge","msg_id":"<uuid>","message":{"role":"user","content":"<text>"}}
  ```

- **已验证**：Codex 侧的 bridge-probe 以 cross-session message 形式到达 `happy-cursor-ios-14`，对方回 `BRIDGE_PROBE_ACK`。即 **写入 → 跨会话投递**这一段已经实投成功；模型是否处理、回复寻址还需单独验。
- peer socket 是**入站通道**；写入成功只代表投递，不代表模型已处理。
- Claude 的正常输出仍走 stdout / transcript / Happy session events。
- Happy 的发现逻辑可参考 `packages/happy-cli/src/daemon/peerSocket.ts`：扫描 daemon 的 session 进程树，选最新的有效 socket。

### Codex 侧

- 原生边界是 app-server JSON-RPC：
  - stdio 上 JSONL；
  - `initialize` → `initialized` → `thread/start` 或 `thread/resume`；
  - `turn/start` 参数是 `threadId` + 文本 input；
  - 用真实 `item/*`、`turn/*` 事件观察执行，按 threadId/turnId/item id 关联，检查 `turn/completed.status`；
  - 已验证本机 0.172.0 schema 的 `turn/steer` 需要 `threadId`、`expectedTurnId`、input。
- Happy 正在跑的 Codex 使用 `stdio://`，管道由 wrapper 持有；独立 app-server 支持 `stdio://`、`unix://`、`ws://`。
- `codex app-server proxy --sock <path>` 提供 stdio 接口，是“第二个客户端”路径的下一步实测项；**第一版不使用**。
- Happy A2A 仍是可用入口：`POST /a2a/:sessionId/message` 或 `happy daemon send-a2a`。Codex runner 把 A2A 放进隔离队列。HTTP 回执只证明转发，真正起 turn 和沿用原上下文仍需验证。
- MCP：Codex app-server 已有 `mcpServers = { happy: ... }`，可以再加一个 `bridge` MCP；模型在真实 thread 内调用工具。
- 相关代码：
  - `packages/happy-cli/src/daemon/controlServer.ts`
  - `packages/happy-cli/src/codex/runCodex.ts`
  - `packages/happy-cli/src/codex/codexAppServerClient.ts`
  - `packages/happy-cli/src/claude/loop.ts`

### 与 bridge 相关的近期修复

- Codex 的 `CODEX_HOME` 现在按 session tag 固定；切 profile/账号只切换 `auth.json` 链接，threads / plugins / skills 不跟着搬。这样 bridge 绑定的 Codex thread 不会因为换 profile/账号丢失。
  - `packages/happy-cli/src/codex/profileCodexHome.ts`
- 原始 bridge 讨论所在的 Codex thread 是 `01a211fb-3b80-71b2-94e4-38a55021e7d7`。

---

## 2. 结论与架构

**收敛方案：独立 bridge 服务 + 两侧显式 MCP 工具 + 现有 A2A/peer socket 入口。**

不采用：

- 第二个 app-server 客户端（`proxy --sock`）作为第一版主路径：Happy 的 app-server 由 wrapper 以 stdio 持有，再挂一个客户端会引入事件重复、turn/steer 归属和 thread writer 竞争。
- 转发最终文本、模拟子 agent、代理并合成 turn 事件。

```
happy-bridge.service（独立进程/独立 launchd 单元）
  ├─ 本地 HTTP MCP：/mcp/<sessionToken>   ← Codex/Claude 会话的 MCP 客户端连这里
  ├─ 本地控制 socket/HTTP：links / status / pair  ← App 或 CLI 调
  ├─ Claude peer socket 客户端（~/.claude/sessions/<pid>.json 的 messagingSocketPath）
  └─ Codex A2A 客户端（daemon 控制端口；daemon 重启时重读 state 并重试）
```

会话侧只挂一个很薄的 `happy-bridge-mcp` stdio shim（类似现在的 `bin/happy-mcp.mjs`），把工具调用转发到 bridge 的 HTTP MCP。bridge 重启时会话不用重启；下一次工具调用自动重连；bridge 不在时工具不可用，fail closed。

### 消息流

**Claude → Codex**

1. Claude 模型调用 `send_to_peer(text, reply_to?)`。
2. bridge 解析 link，向 Codex 会话的 A2A 入口投递（带 bridge `msg_id`、来源、reply_to）。
3. Codex runner 起一个 user turn，模型在同一 thread 里看到消息。
4. Codex 要回复时调用 `send_to_peer`。

**Codex → Claude**

1. Codex 模型调用 `send_to_peer(text, reply_to?)`。
2. bridge 写 Claude 的 `messagingSocketPath` user frame。
3. Claude 模型把它当 user turn 处理；要回复时调用 `send_to_peer`。

普通最终文本不转发；只有显式工具调用才算“发给对方”。

---

## 3. 独立服务的生命周期

用户已定：**像 sidecar 一样独立服务，重启周期与 daemon 分开。**

- `happy bridge start/stop/status`，自己的 PID / state / lock / log，版本独立。
- `happy bridge install/uninstall` 注册独立 launchd/systemd 单元，`KeepAlive` + `ThrottleInterval`。
- 建议 macOS 用 **LaunchAgent**（和 sidecar 一样在用户会话里）：bridge 需要用户的 Claude peer socket；注销后本来也没有 Claude 会话可桥。LaunchDaemon（和 happy daemon 一样注销后仍在）可以在需要时再讨论。
- bridge 重启：
  - 持久化 links/messages 从 `~/.happy/bridge/` 恢复；
  - 正在进行的工具调用返回失败，会话继续；
  - 下一次工具调用重连。
- daemon 重启：
  - bridge 的 Codex A2A 调用重读 `daemon.state.json` / 控制端口并重试；
  - Claude 路径不受影响。

参考现有 sidecar 的控制通道实现：

- `packages/happy-cli/src/daemon/sidecar.ts`
- `packages/happy-cli/src/daemon/sidecarHub.ts`
- `packages/happy-cli/src/daemon/sidecarClient.ts`
- `packages/happy-cli/src/daemon/sidecarInstall.ts`

注意 bridge 与 sidecar 的方向相反：sidecar 是 daemon 的客户端；bridge 是对会话提供 MCP 的服务，同时是 daemon A2A 和 Claude peer socket 的客户端。

### 目录

```
~/.happy/bridge/
  state.json          # pid, port, version, startedAt
  bridge.sock         # 控制接口（0600）
  links.json          # Claude session ↔ Codex session
  messages.db/json    # msg_id, reply_to, status, thread/turn ids
  logs/...            # 或 ~/.happy/logs/bridge-<pid>.log
```

---

## 4. 会话注册与 MCP

- bridge 启动时写 `state.json`（端口 + 控制 socket）。
- Codex runner / Claude runner 启动时读 `state.json`；存在就把 `bridge` MCP server 加进 `mcpServers`，URL 带 per-session token（bridge 侧据此识别调用者并解析 link）。
- bridge 没启动时，会话照常运行，只是没有 `send_to_peer` 工具；bridge 后启动也不会自动补进已启动会话（要么重开会话，要么以后做动态 MCP 注入）。
- bridge 控制接口负责：
  - 建立/解除 link；
  - 列出已连接的 Claude/Codex 会话；
  - 查看消息状态。
- 第一版 link 用 CLI/config 建立，App 面板后补。

---

## 5. 消息模型与投递语义

每条消息至少记录：

- `msg_id`（发送工具生成，幂等键）
- `from` / `to`（claude/codex + session id）
- `reply_to`（可选）
- `text`
- `sourceMessageId`（来源侧的消息 id）
- `codexThreadId` / `codexTurnId`
- `claudeSessionId`
- `status`、时间戳、错误

状态：

```
accepted → injected → running → replied
                     ↘ failed
```

- `accepted`：bridge 接受工具调用；
- `injected`：写入 peer socket 或 A2A HTTP 返回成功；
- `running`：目标会话真的起了 turn（通过 agentState/event 确认，A2A 的 HTTP 回执不算）；
- `replied`：目标调用了 `send_to_peer` 且 `reply_to` 对上；
- 按 `msg_id` 去重，重复投递直接返回已有状态。

第一版：

- 目标空闲再投；忙时排队，不打断；
- Codex 的 `turn/steer` 和 Claude 的运行中 steer 留到后面单独验；
- A2A 的 200 只记 `injected`，`running` 以目标会话事件为准。

---

## 6. 第一版范围

- bridge 独立服务，单 link；
- 两侧各一个 `send_to_peer` MCP 工具；
- Codex → Claude：写 peer socket；
- Claude → Codex：daemon A2A；
- 状态/去重/空闲队列；
- CLI 配对与状态查看；
- 不做第二 app-server client、不做最终文本转发、不做多 link、不做 UI 面板。

---

## 7. 待验证 / 风险

按优先级：

1. **Claude 的 bridge MCP 注册**：Happy 的 Claude runner 是否方便在 SDK `mcpServers` 里加第二个 server，且模型能稳定调用。
2. **Codex 的第二个 MCP server**：app-server 能否同时挂 `happy` + `bridge`，工具在真实 thread 内可用。
3. **A2A 同 thread**：投递到 Codex 后是否真的在同一 thread 起 turn（HTTP 回执不算）。
4. **peer socket 模型处理**：已有投递 ACK，但还没有验证 Claude 模型把入站帧当 user turn 处理并调用 `send_to_peer`。
5. **忙时行为**：目标忙时 A2A / peer socket 是排队、拒绝还是 steer；第一版要求排队直到空闲。
6. **bridge 生命周期**：LaunchAgent vs LaunchDaemon；安装/升级/日志。
7. **多 link / 多会话**：第一版单 link，后续需要 target 参数和权限边界。
8. **安全**：只监听 loopback，socket 0600；MCP token 绑定 session；不绕过目标会话的权限/审批。

后备路径：`codex app-server proxy --sock` / 独立 `unix://` app-server 的第二客户端。只有需要从 bridge 外部驱动 turn 或 steer 时才纳入。

---

## 8. 实施顺序

1. bridge 服务骨架：state/lock/log、控制 socket、MCP HTTP per-session、link 存储。
2. Codex → Claude 最小闭环：Claude bridge MCP 注册 + `send_to_peer` + peer socket 写入。
3. Claude → Codex：Codex bridge MCP + A2A 投递 + 同 thread 验证。
4. 状态机 / 去重 / 空闲队列。
5. App 配对面板、多 link、steer（另验）。
