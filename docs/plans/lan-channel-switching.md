# 会话通道切换（App 侧设计 + CLI 侧差距）

> 状态：**设计阶段**。本文只做评估与设计，不改 CLI。
> CLI 有其专门分支并由其自行实现；我们这边只同步、只做 App 侧设计。
> 上游背景见 `docs/p2p-roadmap.md`（P0–P5 的完整规划与各阶段自述的遗留缺口）。

## 一、问题

App 需要能**在两条通道之间读同一个会话**：

- **server 通道**（现状，唯一使用中的）：socket.io 推送 `update` + HTTP `after_seq` 拉取
- **局域网通道**（CLI 侧已实现只读 API）：mDNS 发现 → 挑战-应答认证 → `GET /lan/sessions/:sessionId/history`

目标是在 server 不可达时切到局域网继续读，并且切换**不产生重复、顺序正确、缺口可检测**。

**首要定性（决定了分工）**：CLI 是**写者**，双写与 per-sink 投递是 CLI 的职责，路线图 P1 已在 CLI 侧完成。
**App 是读者，不存在也不应存在任何双写逻辑。** App 要解决的是**通道切换**与切换过程中的**收敛**。

## 二、关键结论：App 不需要知道 `tag`

LAN 的 history 端点按 **server 的 `sessionId`** 寻址（`happy-cli/src/daemon/lanServer.ts:257`），daemon 内部自己做
`sessionId → tag` 映射（`daemon/run.ts:1276-1300`，数据来自 session 进程上报的 webhook）。

因此 App **用 server 的 sessionId 就能同时命中两条通道**，不需要引入新的会话标识。标识问题只影响 CLI 侧的**日志分桶**
（目录为 `sha256(tag + ':' + site)`，`api/sessionLog.ts:67-70`）。

## 三、CLI 侧硬缺口（必须 CLI 分支修，App 无法绕过）

### 3.1 `n` 覆盖不完整 ← 最关键

`n` 只在两处赋值，且都走 session-protocol 路径：

- `api/apiSession.ts:1662`（`enqueueSessionProtocolEnvelope`）
- `api/apiSession.ts:1715`（`sendSessionLifecycleEnvelope`）

而 `sendCursorMessage` / `sendOutputFormatMessage` / `sendAgentMessage` / `sendSessionEvent` 走 `enqueueMessage`
但**不经过上述两处**，其信封没有 `n`。

**后果**：本地日志里 `dir:'out'` 的条目**混杂「有 n」与「无 n」两类**。App 若按 `n` 连续性做缺口检测，
会在**合法数据上误报** —— 路线图 P5 承诺的缺口检测实际上不可用。

**要求**：给所有出站补 `n`，**或者**明确声明「缺口检测仅对 session-protocol 信封有效」，让 App 能据此门控。
两者取其一即可，但必须明确，否则 App 无法区分「真的缺号」与「这类消息本来就没有 n」。

### 3.2 `tag` 不稳定

稳定与否取决于 runner：

| runner | 行为 | 位置 |
|---|---|---|
| cursor | 显式 `--resume-session-tag` → 否则 workspace 文件复用 → 否则 `randomUUID()` | `cursor/runCursor.ts:343-368` |
| claude / codex / gemini / acp | `resumeSessionTag?.trim() \|\| randomUUID()` | `runClaude.ts:108`、`runCodex.ts:85`、`runGemini.ts:71`、`runAcp.ts:544` |
| claude 离线重连 | **重连成功后用新 `randomUUID()` 建 session** | `runClaude.ts:196` |

**后果**：换 tag 即换日志/outbox/密钥分桶 → 同一会话的历史被割成两段，App 无法认作同一会话。

**要求**：至少 resume 路径的 tag 必须贯穿，**不得在重连时更换**。

### 3.3 出站条目的 `id` 与 server id 分裂

日志条目形如 `{ id, localId, dir, at, c }`（`api/sessionLog.ts:43-52`）。出站写入时 `id = localId`
（`apiSession.ts:1546-1552`），**server ack 后不回填 server id**。

**后果**：同一条出站消息在「CLI 日志」与「server」上是两个不同的 id → 违反不变量 I1（跨路径逐字节相同 id）
→ 跨通道按 `id` 去重会**产生重复**。

**要求**：ack 后回填 server id，或在条目里同时保留两个 id。

## 四、CLI 侧软缺口（App 可降级，代价是带宽/延迟，不是正确性）

| # | 缺口 | 证据 | App 的降级 |
|---|---|---|---|
| 4.1 | **LAN 零推送** | `lanServer.ts` 共 5 条路由，全为一次性快照；grep `text/event-stream`/`websocket`/`chunked`/`reply.raw` 零命中 | 定时重拉 history |
| 4.2 | **日志无 range 读** | `readSessionLog(tag, site)`（`sessionLog.ts:185`）永远读全部段，无 `after`/`since` | 全量拉取后本地过滤 |
| 4.3 | **无历史回填** | 头注释 `sessionLog.ts:9-12`：只含本进程启动后的消息，不回填 server 已有历史 | 旧历史仍来自 server 缓存，切 LAN 后只有新消息 |

`lanServer.ts` 现有全部路由（用于对照）：

| 方法 | 路径 | 返回 |
|---|---|---|
| POST | `/lan/challenge` | `{ nonce }` |
| POST | `/lan/session` | `{ token, expiresAt }` |
| GET | `/lan/identity` | `{ v, machineId, accountFingerprint, hostname, platform }` |
| GET | `/lan/sessions` | `{ sessions: LanSessionSummary[] }` |
| GET | `/lan/sessions/:sessionId/history` | `{ v, tag, dataEncryptionKey, entries }` |

## 五、已经成立的部分（不要重复造）

- **`(n, site)` 在密文内部**：`happy-wire/src/sessionProtocol.ts:163-171` 中 `sid`/`site`/`n` 三者均在
  `sessionEnvelopeSchema` 内（optional），先注入再整包 `encrypt`。**纯 ciphertext + 会话密钥的读者能解出它们**（I2 成立）。
- **日志条目不含明文 n/site 副本**（只有 `{id, localId, dir, at, c}`）—— 这是正确的，排序键本应在密文内。
- **outbox 持久化 `site` / `nextN`**（`api/outboxPersistence.ts:110-116`）。注意 `OutboxEntry.n` 从未写入（`:50` 注释标明保留），
  `n` 只活在密文里。
- **daemon 的 `sessionId → tag` 映射可靠**，但存在**上报窗口**：session 进程从拿到 server id 到 webhook 到达 daemon 之间，
  daemon 有 id 无 tag → `getHistory` 返回 `null` → 404（`run.ts:1281-1283`、`lanServer.ts:262-266`）。**这是可重试的**，App 侧处理。

## 六、App 侧设计（我们这边的工作）

### 6.1 通道状态机

- 默认 `server`。
- server 进入 `error` / `disconnected` 且持续超时（路线图 P3 取 5–8s）→ 切 `lan`。
- **`auth_error` 不触发切换**（凭证问题，局域网救不了）。
- server 恢复 → 切回，并进入收敛流程。

### 6.2 收敛规则（App 的核心工作）

1. **排序**：优先 `(n, site)`；**对无 `n` 的条目回退到 `at` + `id`**（应对缺口 3.1）。
2. **去重**：优先 `(n, site)`；其次 `id`；再次 `localId`（应对缺口 3.3）。
3. **缺口检测门控**：**仅在同一 site 内、且该 site 的条目全部带 `n` 时才启用**。
   任一条件不满足即关闭该 site 的缺口检测 —— 否则会把「本来没有 n 的消息类型」误判为丢失。

### 6.3 降级与如实呈现

- 局域网通道**只做轮询**，不做推送（缺口 4.1）。
- 明确区分「本地日志的条目」与「来自 server 缓存的条目」，不把后者伪装成本地来源（缺口 4.3）。

### 6.4 不做的事

- **不做双写**。App 是读者。
- 不依赖 `tag` 做寻址（用 server `sessionId`）。

## 七、向 CLI 分支提的请求（按优先级）

1. **给所有出站补 `n`**，或明确「缺口检测仅对 session-protocol 信封有效」—— 否则 §6.2.3 无法实现
2. **resume 路径的 tag 必须稳定**，不得在重连时更换
3. 出站条目在 server ack 后**回填 server id**（或同时保留两个 id）
4. （可选，体验项）history 支持 `after` 游标；一次 live 通道（SSE 或 long-poll）

## 八、当前可并行的工作

App 侧的 §6.1 / §6.2 / §6.3 **不依赖 CLI 的任何改动**即可开工 —— 唯一的耦合点是 §6.2.3 的门控条件，
而门控的设计恰恰是为了在缺口 3.1 未修时也**正确**（宁可关闭缺口检测，也不要误报）。
