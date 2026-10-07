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

## 三、CLI 侧硬缺口

> **状态（2026-10-07）：三项均已由 CLI 分支处理完毕，见 `e748ed43`。**
> 下方保留原始评估与结论，便于对照「我们预期的」与「他们实际做的」。

### 3.1 `n` 覆盖不完整 ← 最关键 —— ✅ 已修

原始评估：`n` 只在 `enqueueSessionProtocolEnvelope` 与 `sendSessionLifecycleEnvelope` 两处赋值，
而 `sendCursorMessage` / `sendOutputFormatMessage` / `sendAgentMessage` / `sendSessionEvent` 走
`enqueueMessage` 但不经过它们，其记录没有 `n`。

**他们做得比评估更彻底，也更准**：对 cursor 会话，这些都是**主消息路径**，所以不是「覆盖不完整」
而是「完全没有」；claude 会话则由两个 launcher 都会调的 `sendSessionEvent` 把日志搅成混合的。

修法：新增 `stampAgentRecord(record, {sid, site, n})`（`api/sessionPayloads.ts`）与
`enqueueAgentRecord`（`api/apiSession.ts`），五个 legacy sender 全部改走它。legacy 记录
没有信封可盖，三元组放在 `content` 里 `type` 旁边；session 记录仍放信封内。
`n` 的取号**紧贴写入那一行**，与 session-protocol 路径同一纪律（发了号却没有对应的持久化写入
就是永久空洞）。

**读取规则（App 侧解析的权威依据）**：

```ts
role === 'session' ? content.data ?? content : content
```

有测试对每种形状各发一条，断言该规则取出的 `site` 一致、且 `n` 连续。

### 3.2 `tag` 不稳定 —— ✅ 已修

原始评估：tag 是否稳定取决于 runner（cursor 有 workspace 复用；claude/codex/gemini/acp 用
`randomUUID()`），且 `runClaude.ts:196` 离线重连成功后会**新建 tag**。

**已修**：离线重连不再造新 tag，而是重attach 到失败的那个 tag —— 这也顺带恢复了密钥
（`resolveSessionEncryption` 会重读失败前落盘的那把）。

### 3.3 出站条目的 `id` 与 server id 分裂 —— ❌ 请求已撤回（他们是对的）

原始评估提出：出站条目 `id = localId`，server ack 后不回填 server id，于是同一条消息在
「CLI 日志」与「server」上是两个 id，会违反不变量 I1，要求 ack 后回填。

**他们的反驳（我接受）**：

> 不可实现 —— 日志是 append-only，写入时 server id 尚不存在。而且**没有必要**：
> server 在 HTTP 与 websocket 两条路径上都会回传 `localId`，跨路径去重就以它为键。

我原来的判断错在两点：① 跨路径**逐字节相同的是密文**，日志条目里的 `id` 只是本地字段，
并非 I1 所指的那个 id；② 去重键本该落在 `localId` 上（App 的 reducer 对 user 消息已经在这么做）。
append-only 的设计也让「回填」在构造上不成立。

**对 App 设计的修正**：跨通道去重**以 `localId` 为首选键**，不是 `id`。见 §6.2。

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

1. **排序**：按 `(n, site)`。CLI 已保证所有出站记录都带三元组（§3.1），正常路径不需要回退；
   仍保留一条回退（`at` + `id`）以应对更早写入、不含三元组的旧记录。
2. **去重**：**首选 `localId`** —— server 在 HTTP 与 websocket 两条路径上都会回传它，CLI 的日志条目
   也带它，所以它才是真正跨路径稳定、可比的键（见 §3.3）。其次 `(n, site)`，再次 `id`。
3. **缺口检测门控**：CLI 侧 `n` 覆盖已补齐，正常可启用。**但门控仍要保留** —— 对端写入的记录
   （更老的 App）可能不带 `n`；同一 site 内一旦出现无 `n` 条目，就关闭该 site 的缺口检测，
   否则会把「本来没有 `n` 的记录」误判成丢失。

### 6.3 降级与如实呈现

- 局域网通道**只做轮询**，不做推送（缺口 4.1）。
- 明确区分「本地日志的条目」与「来自 server 缓存的条目」，不把后者伪装成本地来源（缺口 4.3）。

### 6.4 不做的事

- **不做双写**。App 是读者。
- 不依赖 `tag` 做寻址（用 server `sessionId`）。

## 七、向 CLI 分支提的请求（按优先级）

1. ~~给所有出站补 `n`~~ —— ✅ **已完成**（`e748ed43`），且比请求更彻底：五个 legacy sender 全部覆盖
2. ~~resume 路径的 tag 必须稳定~~ —— ✅ **已完成**（同一提交）
3. ~~出站条目 ack 后回填 server id~~ —— ❌ **已撤回**，他们的反驳成立（见 §3.3）。App 侧改为以 `localId` 去重
4. **局域网需要真正的消息投递（live 通道）** —— **尚未做。** 这不是体验项，而是 App 侧 UI 调试的
   前置条件：没有它，App 切到局域网后只能反复拉全量快照，「通道切换」就无法作为一个真实行为被
   观察和调试。形态不限：SSE / long-poll / WebSocket 任一。
5.（可选，优化项）history 支持 `after` 游标，降低轮询的全量传输开销

**顺序**：1–3 已清；**4 是 UI 调试的前提**。

## 八、当前可并行的工作

App 侧的 §6.1 / §6.2 / §6.3 **不依赖 CLI 的任何改动**即可开工 —— 唯一的耦合点是 §6.2.3 的门控条件，
而门控的设计恰恰是为了在缺口 3.1 未修时也**正确**（宁可关闭缺口检测，也不要误报）。
