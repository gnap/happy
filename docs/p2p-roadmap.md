# P2P 递进增强方案

目标：**局域网优先直连**（连得上就不依赖 server），同时**消息仍然分发给 server**，并保证各副本之间**可复制、相对可靠地同步**。全程**服务端零改动**。

---

## 一、目标与非目标

| | |
|---|---|
| **目标** | ① 局域网优先直连，不依赖 server ② 消息同时分发给 server（老客户端与其它读者不受影响）③ 副本之间可复制、相对可靠地同步 |
| **非目标** | 首次配对无 server、CLI 换网无 rendezvous、多 server 联邦、完全去 server、多副本间的服务端协议 |
| **约束** | 每个阶段服务端改动为 0；每个阶段可独立回退 |

---

## 二、核心：消息是可复制的追加日志

这一层是**前提**，不是 P2P 的附属品。所有阶段的可靠性都建立在它上面。

### 2.1 日志条目

```
{
  id:   <envelope.id, cuid2，客户端生成>
  site: <写者稳定 id：CLI=machineId，App=deviceId>
  n:    <该 site 在该会话内的单调计数>
  ct:   <AEAD 密文>
}
```

**关键：`id` / `site` / `n` 全部在密文内部**（客户端加密前组装，见 `apiSession.ts:1530-1539` → `1410`）。服务端看不见也改不了 → 这正是「服务端零改动」与「向后兼容」的来源。

### 2.2 同步语义 —— 「相对可靠」的准确定义

| 维度 | 采用 | 说明 |
|---|---|---|
| 投递 | **at-least-once** | 每个 sink 独立重试直到确认 |
| 去重 | **按 `id` 幂等** | 重复投递无害 → **效果上等价 exactly-once** |
| 排序 | **`(n, site)`** | 与 server `seq` 解耦，任何副本可独立重建顺序 |
| 一致性 | **最终一致** | 不是强一致 |
| 丢失检测 | **同一 `site` 的 `n` 必须连续** | 缺号 = 有消息丢失，可据此补拉 |

> 即：**at-least-once + 幂等去重 = 效果上恰好一次**；**最终一致 + 可检测缺口**。这就是本方案对「相对可靠」的定义。

### 2.3 五条不变量（每个阶段都必须成立）

- **I1** 每条消息有稳定唯一 `id`，跨路径**逐字节相同**
- **I2** 排序键 `(n, site)` 位于**密文内** → 不依赖 server
- **I3** 每个 sink **独立**投递进度且**持久化** → at-least-once
- **I4** 消费端**按 `id` 去重** → 重复投递无害
- **I5** 新增字段**全部位于信封内** → 服务端无感、向后兼容

**只要这五条守住，双写与复制就是安全的。**

### 2.4 写者身份的覆盖范围与读取规则（App 侧按此实现）

**覆盖**：**每一条**出站记录都带 `(sid, site, n)`，且全部在 AEAD 内。此前只有 session-protocol 与 lifecycle 两条路径带，`role:'agent'` 的五种遗留记录（cursor / codex / output / acp / session-event）**连 `site` 都没有**——对 cursor 会话而言那恰是主消息路径，缺口检测等于完全没有。

**读取**（`role` 决定身份所在，其余一律在 AEAD 内，不依赖 server）：

| `role` | 身份所在 |
|---|---|
| `session` | `content.data ?? content`（lifecycle 包在 `data` 里，protocol 就是 `content`） |
| 其他（遗留） | `content`，与 `type` 同级——这些形状没有信封可戳 |

**I1 的边界**：出站条目写入时只能拿到 `localId`（server id 尚不存在），而日志是 append-only，**回填不可能**。跨通道去重必须包含 `localId`——server 的 `GET /v1/sessions/:id/messages` 与 WS 推送都返回它。这不是缺口，是「id 在两端不同名」而已。

**tag**：resume 路径的 tag 必须贯穿；离线重连**必须复用**原 tag（`runClaude.ts:196`）。换 tag = 换 server 会话 + 换日志/outbox/密钥分桶 = 同一段历史被割成两截。

---

## 三、进程模型与身份归属

### 3.1 现状（已验证）

```
daemon/run.ts:215-234    一个 daemon 管 N 个 session（pidToTrackedSession / sessions / stoppedSessions）
controlServer.ts:373     daemon 的 control server 绑定 127.0.0.1 ← 仅本机，LAN 不可达
runClaude.ts:91          startedBy: 'daemon' | 'terminal' ← session 可脱离 daemon 独立跑
apiMachine.ts             machine 作用域 socket（daemon 注册为 Machine）
apiSession.ts             session 作用域 socket（每个 session 一条）
```

### 3.2 对 daemon 的依赖：P2P 100% 依赖 daemon

| 需要的能力 | 生命周期 | 承担者 |
|---|---|---|
| listener 端口 | 长驻 | **daemon** |
| mDNS 广播 | 长驻 | **daemon** |
| NAT 映射与 keepalive | 长驻、恒定 | **daemon** |
| 端点发布（`daemonState.p2p`） | 长驻 | **daemon** |
| 会话密钥 / `(site,n)` / outbox | 短命（一次对话） | session 进程 |

session 进程是短命的，无法承担任何长生命周期职责。

**结论：daemon 从「可选的便利」升级为「P2P 的前提」。**
**代价**：`startedBy: 'terminal'` 的用法拿不到 P2P，退化为纯 server 路径（仍然完整可用）。

### 3.3 实例粒度：传输层 per-node，会话层 per-session

```
传输层：一个节点一个实例（daemon）
        ├── 一个 listener 端口
        ├── 一条 mDNS 记录
        ├── 一套 NAT 映射 + 一条 keepalive
        └── 一条到对端的 P2P 连接
                 ↑ 所有 session 复用这一条，按 sid 多路复用

会话层：每个 session 独立
        ├── 会话密钥
        ├── (site, n) 计数器
        ├── outbox / 投递位图
        └── 排序与去重
```

**为什么不是 per-session**：N 个并发会话会产生 N 个端口、N 条 mDNS 记录、N 套 NAT 映射、N 倍 keepalive、App 侧 N 条连接。连接数为 O(sessions × peers)，不可接受。

**为什么这样安全**：该结构与今天 server 的模型**同构** —— 今天就是一条 socket 承载全部 session，按会话作用域路由（`recipientFilter: all-interested-in-session`）。协议可直接照搬：**一条连接，按 `sid` 分流**。

> 连接数从 **O(N sessions × M peers)** 降到 **O(M peers)**，keepalive 成本恒定。

### 3.4 session 创建：客户端拥有身份，server 降为 registrar

**现状**：server 是 issuer。
```
api.ts:62-95   POST /v1/sessions { tag, 加密metadata, 加密agentState, dataEncryptionKey }
               → server 生成 Session.id (@default(cuid()), schema.prisma:94)
               → @@unique([accountId, tag]) 去重 (schema.prisma:112)
```

**新架构**：客户端拥有身份。
```
CLI 本地创建（不依赖 server）:
  1. 生成 sid = cuid2()              ← 客户端 id；复用 tag 作为对外标识
  2. 生成会话密钥                    ← 已有逻辑：api.ts:42-58，32 字节随机
  3. wrap 给 App 的内容公钥 → dataEncryptionKey
  4. 写入本地 outbox，作为一条【创建事件】
  5. server 可用 → POST /v1/sessions（幂等）
     server 不可用 → 仅广播 P2P 创建事件
```

| | 现状 | 新架构 |
|---|---|---|
| 谁生成会话 id | server | **客户端生成 `sid`；server 只记录** |
| 去重 | `@@unique([accountId, tag])` | **同一约束不变**，仍是幂等保证 |
| 可否离线创建 | ❌ 必须 server | ✅ **可以离线创建** |

**关键：创建本身必须是可复制的日志条目**，不能是 side-channel 的 REST 调用 —— 否则 CLI 离线建的会话，App 通过 P2P 看到了而 server 没有，两边视图分叉。

- 表达为**会话级事件**（现有 `new-session` 事件已是该形状）
- 走同一套 outbox / 幂等 / 排序
- **两条路径均以 `sid` 为幂等键**
- 离线创建 → 创建事件留在 outbox → server 恢复后补发 → 幂等去重 → **不产生重复会话**

**两个必须落实的细节**
1. **创建事件必须携带 `dataEncryptionKey`**（wrap 后的会话密钥）。离线新建的会话，App 只能经 P2P 拿到密钥；该 blob 本身已加密，广播是安全的。
2. **`tag` 必须是抗碰撞的随机 id（cuid2），不能是用户可见名称**。否则两台设备离线各自创建「同名」会话会在 `@@unique([accountId, tag])` 处冲突。

---

## 四、分阶段

### P0 · 地基 —— 只加字段，不改行为

| | |
|---|---|
| 做什么 | 信封加 `sid` / `site` / `n`。**只改 `happy-wire/src/sessionProtocol.ts` 的 `sessionEnvelopeSchema`** |
| **`sid` 定义** | **客户端生成的 cuid2，复用 `tag` 作为对外标识**（*不是* server 的 `Session.id` —— 后者由 server 生成（`schema.prisma:94`），P2P 世界无法复现） |
| **App 侧副本** | **P0a 不改 `happy-app/sources/sync/typesRaw.ts:188`。** 该副本是 `.passthrough()`，未声明字段照样保留且不报错 → 兼容性已由构造保证；P0a 不做校验，声明它们只会造出两个死字段。留到 P2（App 真正要按 `(n,site)` 排序去重时）再动 |
| **`n` 的时机** | `n` **不随 P0a 一起上** —— 它必须持久化才有意义（否则 CLI 重启后 `n` 重置，产生假的「消息被删」信号）。等 P1 的 outbox 落盘就位后再引入 |
| server | **0** |
| 验收 | 新旧客户端混跑无回归；服务端无感知 |
| 回退 | 字段 optional，去掉即可 |

> **P0a 已实施（2026-10-06）**：`sid`/`site` 加在 `sessionEnvelopeSchema`；CLI 在 `ApiSessionClient` 上以 `withWriterIdentity()` 于两个发送漏斗（`sendSessionProtocolMessage`、`sendSessionLifecycleEnvelope`）注入，字段随信封进入密文。`Session.tag`（客户端拥有的身份）与 `Session.site`（= `machineId`）由 runner 经 `getOrCreateSession` 传入。验证：happy-wire 19/19、CLI typecheck 0 错误、CLI 全量测试与改动前**逐项一致**。
> **已知缺口**：`setupOfflineReconnection.ts:97` 路径未传 `site`（该处只有 `sessionTag` 在作用域内，P0a 不新增管道）。P0a 不校验故无影响，P1/P2 需要时再补。

### P1 · 可靠投递 —— outbox 落盘

| | |
|---|---|
| 做什么 | CLI outbox 落盘（P1a）+ **per-sink 投递位图** + `n` 持久化（P1b） |
| 现状缺陷 | `pendingOutbox` 为纯内存（`apiSession.ts:409`），进程退出即丢。**P1 本身就在修一个现存缺陷** |
| server | 0 |
| 验收 | CLI 被 kill 后重启，未确认消息仍会补发；`n` 无断号 |
| 回退 | 保留旧的内存 outbox 路径 |

> **P1a 已实施（2026-10-06）**：新增 `src/api/outboxPersistence.ts`，把队列原子镜像到 `~/.happy/session-outbox/<sha256(tag).slice(0,32)>.json`（整体重写 + temp/rename，不做 append —— 避免撕裂尾行与多进程竞争）。`ApiSessionClient` 在构造时播种、在 `enqueueMessage` / 两处 splice 后落盘、`close()` 空队列即删。文件格式已预留 `v` / `nextN`，entry 容忍可选 `n`，**P1b 无需格式迁移**。
>
> **核心不变量**：磁盘条目**永远不少于**内存（多出来的重启后重发，服务端按 `localId` 幂等去重），因此 **push 必须同步落盘**、不能 debounce。
>
> **播种的条目强制走 HTTP**：WS 路径无 ack、乐观 splice，会立刻丢掉这些刚救回来的消息 —— 设 `seededRemaining` 抑制 WS 直到种子排空。
>
> **已知缺口（均已在代码注释与提交信息中标注）**：
> - **窗口 2 未修**：WS `emit` 返回即 splice，无 ack。需服务端 ack 才能关，违反"服务端零改动"，留待后续。
> - ~~**offline stub 完全不覆盖**~~ → **已修复**，见下。
> - 写放大 O(Q)：长断网时每入队一条重写整个文件。解法是背压，不在本次。

> **P1b 已实施（2026-10-06）**：`n`（每写者单调计数器）落地，`sid`/`site`/`n` 三元组补齐。**零格式迁移**——P1a 的 `{v, tag, nextN, entries}` 本就预留了位置。
>
> - **计数器在「入队点」自增**（紧邻 `enqueueMessage` 的那一行），**不在 `withWriterIdentity` 里**。原因是若两者之间出现提前返回，那个 `n` 会**永久缺席**形成空洞。实测当前无此返回，但结构上避免引狼入室。
> - **文件从"outbox"重新定义为「会话写者状态」**：`close()` 不再删除它。删掉会连 `nextN` 一起删，而 tag 可恢复（`--resume-session-tag`），计数器回退会让读者按 `(n, site)` 排序时看到重复。（`deleteOutbox` 因此成为死代码，已移除。）
> - **`nextN` 无条件播种**（队列为空也要播）——这正是它独立于 `entries` 存在的理由。
> - **`site` 写入文件；加载时若不一致则重置 `nextN` 并告警**：同 tag 在另一台机器恢复时，继承计数会让两个写者的 `n` 区间交织。
>
> **已知限制（不粉饰）**：
> - 上述重置**不阻止交织**——旧 site 的未投递条目仍在盘上会被重发。彻底修需先决定"哪个机器拥有该会话"。
> - **密钥重置 ≡ 消息丢失**：`<agent>-session-key-<tag>` 丢失/重生成时，盘上条目的 `n` 也随之失去意义。P1a 既有隐患，但 `n` 让它**首次以"空洞"的形式可见**。
> - `runClaude.ts:196` 用 `randomUUID()` 当 tag：每次重试产生一个永不复用的 tag + 一份永不读取的状态文件。既存反模式，仅加注释。
> - `pruneOutboxes` 只从构造函数调用，故**长期不 spawn 新会话的 daemon 永不清理**。P1a 既有，不宣称"积累有界"。
> - 路线图 §2.1 说 `sid` 是 cuid2，实际是「tag 是什么就是什么」（`randomUUID()` 或用户输入）。P0a 遗留，未修。

> **离线路径丢消息已修复（2026-10-06）**：此前"启动时服务器不可达"的会话（codex/gemini/cursor/acp）出站消息 **100% 被静默丢弃**——stub 的 send 方法全是空实现，且它的 `sessionEncryptionKey` 是空数组。根因是 `dataKey` 凭证的会话密钥在 `getOrCreateSession` 内部生成、`return null` 时被丢弃，离线时**根本无密钥可用**。
>
> 修法：① `ApiClient.resolveSessionEncryption(tag, existingKey?)` 成为密钥解析的**唯一来源**——`dataKey` 下在 HTTP 调用**之前**落盘到 `~/.happy/session-key-<hash>`（0600），`legacy` 不落盘（密钥已在 `access.key`，再存一份只会扩大暴露面）；② 从 `apiSession.ts` 抽出 `sessionPayloads.ts` 的纯载荷构造函数（**行为保持**的重构，严格 `toEqual` 断言全绿），离线 stub 用它们组装 → 加密 → 写入同一个 tag 键控 outbox；③ 重连时真实 client 播种同一文件并以 HTTP 排空——**无需搬运任何内存状态，文件就是交接点**。同时修正了误导性提示（原"Session syncing in background"对离线路径是假的）。
>
> 未做：`runClaude` 的离线分支结构不同（不建 session 对象、直接退出进程），仅靠密钥落盘受益。

### P2 · 局域网优先 + 双写 ← 第一步交付

```
CLI 挂机:
  · mDNS 广播 _happy._tcp.local
      TXT: accountId, machineId, sid 列表, pubKey, v
  · 本地 listener
  · server sink 保持【必选】

APP（同 LAN）:
  · mDNS 发现 → 直连 CLI（session key 握手）
  · 消息从两条路进来 → 按 id 去重 → 按 (n, site) 排序
```

| | |
|---|---|
| 关键 | **server sink 不摘** —— 消息照常发 server，老 App 完全不受影响 |
| **CLI 库选型** | **`@homebridge/ciao`**（已实测验证，见第十节）。**不要用 `bonjour-service`/`multicast-dns`** |
| server | 0 |
| 验收 | ① 同 WiFi 下**关掉 server 仍能从 CLI 读** ② server 在线时老 App 行为零变化 ③ **无重复消息** ④ 直连比走 server 快 |
| 回退 | 关闭 mDNS 开关 → 回到纯 server |
| 前置 | iOS 侧声明**已存在**（`app.config.js:36-37`），只需补服务类型（见第十节） |

> **P2 的 CLI 半边已实施（2026-10-06）** —— App 侧仍不在本分支。
>
> **为什么范围比路线图小**：路线图说 P2 走"消息"，但**消息数据不在 daemon 手里**——已发送的在 server 上，未发送的在各 session 进程的 outbox 里（P1a）。daemon 只有会话列表。所以 **LAN 消息读取需先解决数据归属**，本次不做。
>
> **做了什么**：daemon 新增一个**独立**的只读、带认证的 LAN 监听器（`src/daemon/lanServer.ts`）+ mDNS 广播（`src/daemon/lanDiscovery.ts`）。
>
> - **不碰现有控制面**。`controlServer.ts` **完全没有认证**，唯一防护是硬编码 `127.0.0.1`（`:373`），而它有 `/spawn-session` `/stop-session` `/stop`。把它暴露到 LAN 是严重漏洞，所以新监听器独立、只读。测试里有承重断言：`POST /lan/spawn-session` 等**必须 404**。
> - **认证用 `machineKey` 挑战-应答**：它是 CLI 自造的 32 字节对称密钥，已通过 Machine 记录的 `dataEncryptionKey` 分发给 App，**无需新密钥分发**；且 `machineKey` 永不上链路。令牌是**无状态 HMAC**、TTL **90 秒**（明文下 bearer 令牌可被嗅探，TTL 是主要缓解）。
> - **`legacy` 凭证直接拒绝启动**：`machineKey` 只在 dataKey 分支生成（`auth.ts:249`）。对 legacy 用它等于 `HMAC(undefined)`（**攻击者可自算**），用 `secret` 顶替更糟（能解密全部会话）。不做 fallback。
> - **nonce 存储有界 + 逐 IP 限速**：`/lan/challenge` 无认证，不限量就是远程 OOM 向量。
> - TXT 只放 `{v, machineId, accountFingerprint}` —— **不放会话列表**（RFC 6763 体积约束 + 会话变动会造成多播 churn）。端口用 0 临时分配、由 SRV 记录携带。
> - 默认**关闭**（`HAPPY_LAN_ENABLED`）；绑定或广播失败**一律非致命**。
>
> **显式决定（非遗漏）**：明文 HTTP → App 届时需 `NSAllowsLocalNetworking` ATS 例外；绑 `0.0.0.0` 使**监听面 ⊃ 广播面**（会覆盖 VPN / VM bridge / awdl 等 ciao 不广播的接口），opt-in + 认证下接受，列为后续项。
>
> **验证**：8 个单测（含 nonce 单次使用、存储上界、速率限制、变更路由 404）；`scripts/lan-e2e.ts` 跑通完整认证流程；`dns-sd` 确认发现与 TXT。

> **⚠️ P2 的前提修正（2026-10-06 调研）**
>
> 路线图原文假设 CLI 能提供会话消息。**这个假设是错的。** 实测收发路径（`apiSession.ts:1260-1269`、`:662-675`、`routeIncomingMessage:826`）：收到的消息走「解密 → 转发给 agent 循环 → **丢弃**」，**CLI 不保留任何消息历史**；`lastSeq` 只是游标——**有位置，无内容**。daemon 亦只有元数据。
>
> | 需要什么 | 谁有 |
> |---|---|
> | **密文（历史）** | **只有 server**（`SessionMessage`；且**无任何保留/修剪/压缩，历史无界**） |
> | **内容密钥** | session 进程内存 + P1a 的 `session-key-<hash>`（明文） |
> | **游标** | `lastSeq`（内存，进程退出即丢） |
>
> **结论：「LAN 读消息」的真实前置是「CLI 本地消息日志」**——即本文第 2 节那套可复制日志（不变量 I1–I5）。它不是 P2 的子任务，而是 P2 的地基，应当按自己的节奏立项，而不是被 LAN 需求反向驱动。
>
> **可照搬的参照实现**：App 已有本地 SQLite 消息库（`session_messages(session_id, message_id, message_json)` + per-session 游标 + 版本化 reducer sidecar），服务器不可达时**读缓存、不失败**，`after_seq` 增量对账、游标陈旧时锚定 `sessionSeq - 100` 以保证先显示最新。**但它只对 `flavor = cursor / acp-cursor / claude` 启用**（`messageCache.ts:34-37`），其他 agent 被刻意排除——照搬前需先弄清这个限制。
>
> **两个必须先接受的代价**：
> 1. **信任等级提升**：要把消息交给 LAN 客户端，CLI 必须交出**明文内容密钥**。当前用 `machineKey` 认证，这意味着 **`machineKey` 泄露 = 会话内容泄露**，而不只是元数据泄露。
> 2. **副本扩散**：CLI 开始存全量历史后，**每台跑过会话的机器都成为一份完整副本**。这是安全面的实质扩大，值得单独权衡。
>
> **决定**：LAN 消息读取**暂缓**。先做本地日志，让它以「自然消费者」的身份回归，而不是反过来。下一步做 **P1b（`n` 计数器）**——它小、磁盘格式已铺好，且是那套日志的前置。

> **CLI 本地消息日志已实施（2026-10-06）** —— 本轮只做日志本身；**LAN 读取端点不在本轮**。
>
> 新增 `src/api/sessionLog.ts`：**分段 JSONL**，`~/.happy/session-log/<sha256(tag + ':' + site)>/<NNNNNNNNNN>.jsonl`。条目 `{id, localId, dir, at, c}`，**`c` 是与 server 上逐字节相同的密文**。
>
> - **为什么 JSONL 而 outbox 是整体重写**：outbox 有**删除**（每次 flush 后 splice 并重写），它的语义是"当前的集合"，整体重写让它在构造上自洽；日志**只追加、从不删除**，没有压缩、"当前集合"这些概念，最坏情况（撕裂尾部）可由截断恢复。这是结构性差异。
> - **分段而非超上限重写**：重写是 O(n) 且**每次 append 都触发**——p95 20KB × 5000 条意味着每条消息重写 100MB，而那发生在最热的路径上（session 进程就是 agent 循环）。分段是 O(1) 轮转、O(1) 删除最旧段。
> - **路径含 `site`**：否则同一 tag 在两台机器上、且 `HAPPY_HOME` 在同步盘上时，两个进程会往同一 JSONL 追加 → 不可恢复的损坏。跨 site 合并属于读者层（按 `id`）。
> - **不存 `seq`**：`in` 恒有、`out` 只有 HTTP flush 的响应里有（当前代码只取 `maxSeq`，从未关联回条目）、WS 路径永远没有。这样一个字段会诱导读者按它排序而排错——排序键本该是密文内的 `(n, site)`。
> - **捕获点在 `routeIncomingMessage` 内部、去重之后**（这是本设计最关键的一处）：它的 seq 去重发生在**调用点之后**，所以在两个调用点挂钩会把"先走 socket 快路径、之后又被 HTTP 补拉"的消息**记录两次**。为此把密文与元数据透传进了该方法。
> - 读取**遇到第一行畸形即停**（撕裂尾部良性，撕裂中部才是真损坏源，跳过会静默留洞）；写入单次 `writeSync(line + "\n")` 保证部分写入永远是部分尾部；每条 append 前把残留的撕裂尾行截掉。
> - 目录 `0o700`、段文件 `0o600`（条目里的 id/时序/密文长度都是明文）；永不抛出（与 outbox 同纪律）。
>
> **必须写死的一条语义**：**日志不是"服务器有什么"的真相源**。outbox 随 flush 收缩而日志只增长，两者必然分歧——outbox = 尚未被服务端确认，日志 = CLI 见过的一切。
>
> **验证**：7 个模块测试（往返、撕裂恢复、轮转与保留、不可写目录不抛、权限、目录清扫）+ 3 个集成测试（**同 seq 重放不重复记录**、出站密文与上线字节一致、跨重启保留并追加）；全量测试与改动前按测试名逐项一致。

> **LAN 历史读取端点已实施（2026-10-06）** —— CLI 侧的**生产者**至此完整；App 侧仍是独立一轮。
>
> 新增 `GET /lan/sessions/:sessionId/history` → `{ v, tag, dataEncryptionKey, entries }`。
>
> - **按 `sessionId` 寻址**：客户端从 server 学到的就是它，tag 是这一侧的事；daemon 自己做映射。
> - **密钥与密文同一响应**：历史没有密钥就没用，拆成两个请求只多一次往返而不带来解耦。
> - 字段名 `dataEncryptionKey` **刻意与 server 的 `Session.dataEncryptionKey` 同名同义**（`version(1) || box(contentKey → 账户内容公钥)`），客户端解包代码可原样复用。
> - **用哈希版 `readSessionKey`，不用旧方案**：旧方案（`<prefix>-session-key-<tag>`）是 claude/cursor runner 另写的一份，而 CLI 实际加密用的是 `resolveSessionEncryption` 写进哈希路径的那把；codex/gemini/acp 根本不写旧方案。**两者不合并**（那是独立的重构）。
> - `sessionTag` 尚未上报时返回 **404**（可区分于 401），客户端应重试而非当作永久缺失。
>
> **关键验证**：`scripts/lan-e2e.ts` 现在跑**完整往返**——生成一对 X25519「账户内容密钥对」扮演 App → 用真实的 `persistSessionKey`/`appendSessionLog` 产出真实历史 → 起真实 LAN 服务 → 完整认证 → 取历史 → **用账户内容私钥解包出 32 字节会话密钥** → 解密每条密文 → 断言明文一致。
>
> **这一步的价值**：App 在这一路径上的工作**全是密码学与协议、没有 UI**，所以脚本跑通 ≈ 证明「server 挂掉后，持有 machineKey 与账户私钥的客户端能读到并解开历史」。**不需要 iPad。** 剩下的 App 侧工作是把这套流程接上 UI。
>
> **已在真机闭环（2026-10-06）**：`lan-e2e.ts` 用的是合成 App，覆盖不到 daemon 里 `getHistory` 的 sessionId → tag → 日志目录映射——那需要**一个真的写过日志的会话**。用 launchd 起的 daemon（pid 3339，`HAPPY_LAN_ENABLED=1`）+ `restart-session` 重启一个真实会话后：
> - `[lan] serving read-only API on 0.0.0.0:55673` / `advertising _happy._tcp.local`，`dns-sd -B _happy._tcp local` 能看到（两个接口各一条）
> - `scripts/lan-query.ts` 用**真实凭证**走完挑战-应答 → 列出会话 → `GET .../history` → 用本地持久化的会话密钥**解密 7/7 条**
> - 该会话的日志目录由**会话进程**写出（`~/.happy/session-log/<hash>/0000000000.jsonl`），daemon 只读——跨进程的路径契约（`tag` + `site`）成立
>
> **只记本机 site 的边界在此可见**：日志只含该进程启动**之后**的消息，不回填 server 已有的历史。这符合既定语义（日志 = CLI 见过的一切），缺口收敛属于 P5。

### P3 · server 偶发挂的 fallback

| | |
|---|---|
| 做什么 | 端点写入 `Machine.daemonState.p2p`（**零服务端改动**，该字段是加密 opaque string，`schema.prisma:210`，App 已在消费 `daemonState`）；App 侧端点缓存；**CLI 侧 NAT keepalive**；Direct Mode 状态机 |
| 触发 | `ConnectionStatus`（`apiSocket.ts:41`）进入 `error` / `disconnected` 且超 5–8s → Direct Mode。**`auth_error` 不触发**（凭证问题，P2P 救不了） |
| 连接顺序 | mDNS 重查 → 缓存 `lastSuccess` → 缓存 LAN → 缓存 srflx/ipv6 → 降级提示 |
| **成败关键** | **CLI 每 ~20s 发一次 STUN binding request 维持 NAT 映射。** 没有它，srflx 缓存几分钟即失效，整个 fallback 形同虚设 |
| server | 0 |
| 验收 | server 断开后同 LAN 100% 可用；跨网未换网场景成功率达标；**降级时用户看到明确提示，不静默失败** |
| 回退 | Direct Mode 开关 |
| 明确不覆盖 | 首次配对、CLI 换网（超出范围） |

> **P3 的 CLI 半边已实施（2026-10-06）** —— App 侧的端点缓存与 Direct Mode 状态机仍不在本分支。
>
> **先修了一个既存 bug**：`cleanupAndShutdown` 里的 `await apiMachine.updateDaemonState(...)`（`run.ts:1768`）内部是 `backoff`，而 `backoff` 是 `while(true)`、**只在成功时返回**。**服务器不可达时关停 daemon 会永久挂起**，其后的控制面停止、**LAN/mDNS 撤销**、daemon 锁释放、甚至 `process.exit(0)` 全都不执行——P2 的广播会滞留。→ 新增有界变体 `tryUpdateDaemonState`（2s 超时、返回布尔、绝不在关停路径上阻塞），关停路径改用它。
>
> **⚠️ 偏离路线图：STUN / srflx / NAT keepalive 从 P3 移到 P4。** 路线图称 20s STUN binding request 是 P3 的**成败关键**，但这经不起推敲：一个已发布的 srflx 地址要被**入站**打通，需要该 NAT **同时**满足端点无关的映射与过滤（即 full-cone）——只有这一个格子可行，而它在全球占少数、在国内住宅 CGNAT/移动网络下更少。没有打洞（P4），keepalive 只维持「到 STUN 服务器」的那条映射，对地址相关过滤的 NAT 与客户端入站毫无关系。**它保住的是一个入站打不通的地址**，留在 P3 会制造「跨网 fallback 可用」的假象。
>
> **做了什么**：
> - 新增 `src/daemon/lanEndpoints.ts`：`computeEndpoints`（纯函数：硬 deny-list 接口名 `awdl/llw/utun/tun/tap/wg/bridge/docker/vmnet/vboxnet` + 丢弃 APIPA/链路本地 + 排名「私网 IPv4 → 全局 IPv6 → ULA」+ 上限 4/2）与 `startEndpointPublisher`（tick 重算、**仅在地址集变化且已连接时**才写、失败由下一 tick 重试）。
> - 端点写入 `Machine.daemonState.p2p`（**服务端零改动**：它只校验 `typeof === 'string'`，从不解析）。`DaemonStateSchema` 加可选 `p2p`——注意该 schema **从不被 parse**，App 也以 `any` 具名取值，故这是纯类型变更。
> - **LAN 端口改为稳定**（`HAPPY_LAN_PORT`，默认 55673；占用则回退临时分配）。Daemon 每次 CLI 版本升级都会重启，临时端口会让已发布的端点每次失效。
> - **不写 `daemon.state.json`**：那是另一个类型，加端点等于复制服务端状态并制造陈旧陷阱；且端口可能回退到临时分配，持久化它就是错的。启动时重新发布即可。
>
> **必须承认的 promise 边界**：「server 挂掉仍可达」的准确表述是「**server 挂掉 且 机器没换网 且 用户开了 LAN**」。`enableLan` **默认关闭**，所以本功能对默认用户是 no-op。跨网能力在本阶段为**零**（srflx/打洞在 P4），且 App 必须在 server 在线时至少与机器同网一次才缓存得到端点。
>
> **验证**：7 个单测（过滤与排名、上限、未变化时保持安静、变化时重发、断连不发、失败重试、stop 后不再 tick）；全量测试与改动前按测试名逐项一致。

### P4 · 公网 P2P（rendezvous + 打洞）

| | |
|---|---|
| 做什么 | rendezvous **复用 server 的 `daemonState`**（不新增服务）；STUN + 打洞；失败走 relay（可复用 server 转发密文，**E2EE 保持**） |
| STUN | 实测国内可用：`stun.cloudflare.com` / `stun.miwifi.com` / `stun.chat.bilibili.com` / `stun.douyucdn.cn`。**Google 不可用（IP 级全端口封锁）；`stun.qq.com` 不响应。** 多配几个由 ICE 自动切换 |
| server | 0 |
| 验收 | 跨网络直连成功率达标；打洞失败能正确降级到 relay |
| 回退 | 关闭公网 P2P，仅保留 LAN + 缓存 |

### P5 · 收敛与修复（最终一致）

| | |
|---|---|
| 做什么 | 每个 `site` 的 `n` 连续性检查；按 `(site, n)` 区间补拉缺失；启动时做一次 digest 对齐 |
| server | **0**（补拉复用现有 `after_seq` 一类接口即可，无需新协议） |
| 验收 | 人为断网 5 分钟后恢复 → 自动补齐、无重复、顺序正确 |
| 回退 | 关闭补拉，仅保证「新的能到」 |

---

## 五、保证强度演进

| 阶段 | 投递保证 | 一致性 | server 改动 |
|---|---|---|---|
| P0 | 现状（尽力而为） | — | 0 |
| P1 | **at-least-once**（每 sink） | 幂等去重 | 0 |
| P2 | + LAN 双路 | 双路去重 | 0 |
| P3 | + 断服可用 | — | 0 |
| P4 | + 跨网直连 | — | 0 |
| P5 | + 缺口检测与补拉 | **最终一致** | 0 |

**全程服务端零改动。** 这是本路线最大的价值 —— 不需要动线上服务即可逐步上线。

---

## 六、兼容性规则

**唯一必须遵守的规则：新增字段一律加在信封内部；改动传输层时服务端不参与。**

只要守住它：

| 改动 | 对官方 server | 对老 App |
|---|---|---|
| 信封加 `sid`/`site`/`n` | ✅ 无感（在密文里） | ✅ zod 静默 strip 未知字段，不报错 |
| outbox 落盘 | ✅ 纯客户端 | ✅ |
| mDNS / P2P sink | ✅ server 根本不知道 | ✅ |
| Direct Mode | ✅ 纯客户端 | ✅ |

**唯一的不兼容**：老 App 没有 P2P 能力 —— 这是**能力缺失**，不是回归。因此**过渡期 server sink 必须保持必选**，直到老 App 淘汰。

---

## 七、依赖顺序

```
P0 ──→ P1 ──→ P2 ──→ P3 ──→ P4
                │
                └──→ P5（P2 之后任意时点可插入）

P0 必须最先：没有 (n, site)，双写无法去重与排序
P1 必须在 P2 前：没有落盘 outbox，双写第二条路一断就丢消息
P2 是第一步交付，且它一次性验证全部五条不变量
```

---

## 八、风险与对策

| 风险 | 对策 |
|---|---|
| 双写导致重复消息 | I4 按 `id` 去重（reducer 已具备：`reducer.ts:291-300`） |
| 两路顺序不一致 | I2 按 `(n, site)` 排序，与 server `seq` 解耦 |
| CLI 换网后缓存失效 | **明确接受**（超出范围）→ 显示降级提示 |
| 对称 NAT / CGNAT 打洞失败 | 降级到 relay；LAN 场景不受影响 |
| iOS 局域网权限 | 一次性 Info.plist 配置，提前验证 |
| 关掉 server 时老 App 不可用 | **保持 server sink 必选**，直到老 App 淘汰 |
| 离线创建会话导致视图分叉 | 创建事件走可复制日志，以 `sid` 幂等（见 3.4） |

---

## 九、建议的第一刀

**P0 + P1 一起做。** 理由：

- 两者**不改变任何现有行为**、服务端零改动、风险最低
- P1 顺带修掉一个**现存缺陷**（进程退出丢消息）
- 做完这两步，P2 的双写才是安全的；否则双写会放大现有的丢消息问题

---

## 十、mDNS 可行性验证结果（2026-10-06）

在开发者 Mac（macOS，en1 = 192.168.31.75，**15 个网络接口 + utun0 VPN**）上实测。

### 10.1 库选型：`@homebridge/ciao` ✅，`bonjour-service` ❌

| 项 | `bonjour-service`（multicast-dns） | `@homebridge/ciao` |
|---|---|---|
| 默认参数发包 | ❌ `send EHOSTUNREACH 224.0.0.251:5353` | ✅ |
| 传 `interface` 指定出口 | ❌ `bind EADDRINUSE <ip>:5353`（与系统 `mDNSResponder` 抢端口） | ✅ |
| `interface` + `bind=0.0.0.0` | ⚠️ 发包错误消失，但… | — |
| **原生栈能否发现** | ❌ **不能**（Node 收不到 5353 多播包：原生 `dns-sd -R` 的通告，Node 浏览端 0 发现） | ✅ **能**（见下） |
| 结论 | **不可用** | **采用** |

ciao 实测结果（`scripts/spike-mdns-ciao.mjs`）：
```
$ dns-sd -B _happy._tcp local
14:35:06.134  Add  2  1 local.  _happy._tcp.  happy-mach-spike-001

$ dns-sd -L happy-mach-spike-001 _happy._tcp local
happy-mach-spike-001._happy._tcp.local. can be reached at happy-mach-spike-001.local.:51234
```
**发现 ✅ 解析 ✅ 无错误 ✅** —— 且 `dns-sd` 走的是 macOS 原生 Bonjour 栈，与 iOS `NSNetService` 同源，因此该结果可外推到 App 侧。

### 10.2 关键坑

1. **多网卡/VPN 是常态**：本机 15 个接口。Node 裸 `dgram` 不会自动选多播出口 → 必须依赖库自行处理接口选择（ciao 会）。
2. **macOS 上 5353 被 `mDNSResponder` 占用**：自建 mDNS 栈容易出现"能发不能收"或端口冲突。这是 `multicast-dns` 在本机失效的根因。
3. **`dns-sd -B` 无结果时输出全缓冲**（0 字节）：用它做验证时，**必须先 SIGTERM 再读输出**，否则会得到假阴性。对照实验：不存在的服务类型同样 0 字节。

### 10.3 iOS 侧现状

| 项 | 状态 |
|---|---|
| `NSLocalNetworkUsageDescription` | ✅ **已存在**（`app.config.js:36`） |
| `NSBonjourServices` | ⚠️ 仅 `["_http._tcp","_https._tcp"]`（`:37`）→ **需追加 `_happy._tcp`** |
| `ios/` 目录 | 不存在（prebuild 生成）→ **改 `app.config.js` 即可，无需手改 plist** |
| 现有局域网调用 | 无（声明是预置的，该路径从未被触发过） |

### 10.4 尚未验证（待 iPad ↔ 主机联调时验证）

**跨机验证不在本期做**，留待 iPad（App）↔ 主机（CLI）联调时一并完成。

- **跨机发现**：本次仅验证同机 + 原生栈互操作。`knowhere`（192.168.31.174）测试期间离线，未做双机验证。
  → 待 iPad ↔ 主机联调验证。**注意：该测试不需要 App 侧代码** —— 用 App Store 上的 Bonjour 浏览工具（如 *Discovery - DNS-SD Browser*）即可验证"CLI 的通告能否被 iOS 原生 Bonjour 栈发现"，从而在写任何 App 代码前先把最大风险排除。
- **iOS 权限弹窗**：必须一次真机构建才能确认（授权后能否 browse 到结果）。注意第三方浏览工具**不会触发本 App 的权限声明**，因此权限弹窗仍需 App 侧真实构建来验证 —— 这是两件独立的事，别混淆。
- **TXT 载荷送达原生栈**：未确认（`dns-sd -L` 不显示 TXT）。
- **Android**：未验证（`NsdManager`）。
- **TXT 体积约束**：把全部 session id 塞进 TXT 会膨胀广播包，**建议 TXT 只放身份与版本，session 枚举改在连接建立后进行**。

### 10.5 本期代码变更

| 变更 | 位置 |
|---|---|
| 新增依赖 `@homebridge/ciao@^1.3.12` | `packages/happy-cli/package.json` |
| 新增验证脚本 | `packages/happy-cli/scripts/spike-mdns-ciao.mjs` |

> **App 侧（`react-native-zeroconf` + 真机构建）不在 `feature/cursor-agent` 分支实施。** 本期只做 CLI 侧验证与选型；App 侧留待后续分支，届时只需：`NSBonjourServices` 追加 `_happy._tcp`、引入 zeroconf 库、一次真机验证。

---

## 附：关键代码位置

| 主题 | 位置 |
|---|---|
| 信封 schema | `happy-wire/src/sessionProtocol.ts:130-144`；App 副本 `happy-app/sources/sync/typesRaw.ts:188` |
| 信封组装与加密 | `happy-cli/src/api/apiSession.ts:1530-1539` → `:1410` |
| outbox（内存） | `happy-cli/src/api/apiSession.ts:409` |
| 会话创建 | `happy-cli/src/api/api.ts:62-95`；密钥生成 `:42-58` |
| 服务端 seq 分配 | `happy-server/sources/storage/seq.ts:27-35` |
| 消息唯一约束 | `happy-server/prisma/schema.prisma:127` `@@unique([sessionId, localId])` |
| Machine daemonState | `happy-server/prisma/schema.prisma:210` |
| App 去重 | `happy-app/sources/sync/reducer/reducer.ts:291-300` |
| App 缺口检测（待迁移到 `(n,site)`） | `happy-app/sources/sync/sync.ts:2928` |
| 连接状态枚举 | `happy-app/sources/sync/apiSocket.ts:41` |
| 后台挂起处理 | `happy-app/sources/sync/apiSocket.ts:330-343` |
| daemon 进程模型 | `happy-cli/src/daemon/run.ts:215-234`；control server 绑定 `controlServer.ts:373` |
| 设备间信令（可复用） | `happy-server/sources/app/api/socket/rpcHandler.ts` |
