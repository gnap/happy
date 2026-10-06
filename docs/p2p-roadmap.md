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
> - **offline stub 完全不覆盖**：`offlineSessionStub.ts:41-53` 全是空实现，且 `sessionEncryptionKey` 是**空数组**（无法加密）。即"启动时服务器不可达"的会话，出站消息仍 100% 丢弃，落盘救不了。**这是既存缺陷，需专门一轮。**
> - 写放大 O(Q)：长断网时每入队一条重写整个文件。解法是背压，不在本次。

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
