# 破坏性改动的向后兼容方案

对象是计划里剩下的三项破坏性改动：

1. 删除旧的生命周期别名（`killSession`、旧 `/lan/sessions/:id/archive`、`/archive-session`、`happy daemon archive-session`）
2. 从 roster/wire 移除 `tag`
3. U11 rekey（用 uid 当 App 主键）

约束不变：**不改 happy-server**。所有兼容面都在 CLI / App / relay 这一侧。

---

## 0. 共同原则

| 原则 | 含义 |
|---|---|
| 先加后删 | 新名称先落地并成为唯一写路径，旧名称至少并存一个发布周期 |
| 能力探测用字段/路由是否存在 | 不用版本号判断“能不能”；版本号只用来判断“还会不会有人用” |
| 删除也要可回滚 | 旧别名保留到最后一个周期时，放在一个显式开关后面（如 `HAPPY_LEGACY_LIFECYCLE=1`），删开关才算完成 |
| 先观测再删除 | daemon 统计旧别名的实际使用及客户端版本；没有观测就不删 |
| 服务端零改动 | 别名跨 server socket 时名字由 daemon 注册，server 只转发 |

---

## 1. 前置：观测（非破坏性，先做）

**App 侧**

- 每个 LAN 请求带一个明文的 `x-happy-client-version: <app-version>-<build>` 头。
  会话 metadata 是密文，daemon 读不到，所以版本只能走明文通道。
- 这只用于统计，不参与鉴权，也不拒绝任何请求。

**CLI 侧**

- 给四个旧别名各加一个计数器（daemon 日志 + roster 的 `legacyUsage` 可选）：
  - machine RPC `killSession`
  - LAN `POST /lan/sessions/:id/archive`
  - control server `/archive-session`
  - `happy daemon archive-session`
- LAN 路径记录请求头里的版本；经 server socket 转发的 `killSession` 只有方法名是明文，
  params 是密文，因此**记为“版本未知”**，不能因此判断它来自新客户端。

**删除门**

同时满足才进入下一阶段：

- 最近一个完整发布周期（建议 30 天）内，没有任何 `x-happy-client-version` 大于等于最低版本的
  LAN 别名调用；
- 经 server socket 到达的别名调用在同一窗口内为 0（版本未知，只能按时间判断）；
- 所有在用 App 的最低版本已高于新名称发布版本；
- 本机 daemon 已运行包含新名称的构建；
- 回滚开关可用。

---

## 2. 删除旧生命周期别名

**影响**

- 旧 App 的删除/归档会失败（`killSession` 变成未知方法，旧 `/archive` 变成 404）。
- 失败是可见的，不会造成数据丢失：行保留，用户会看到失败提示。

**步骤**

1. 新客户端只走 `deleteSession` / `archiveSession` 与 `/lan/v2/...`（已完成）。
2. 旧别名继续服务，并计数。
3. 开关已实现：`HAPPY_LEGACY_LIFECYCLE`（默认开启）。观测门通过后，先把它切为关闭并发布一个周期。
4. 下一个周期删除代码与开关（`daemon/legacySurface.ts` 及其三个调用点）。

**回滚**

- 重新打开开关即可恢复别名；代码在一个小模块里，删除前始终可 revert。

**保留**

- server-only 行（没有 machineId）的 server delete 路径与别名无关，不动。
- `killSession` 的名字虽然经 server socket 传输，但 handler 由 daemon 注册，删它不需要 server 改动。

---

## 3. 从 roster/wire 移除 `tag`

**影响**

- 旧 App 以 `tag` 作为 scheduled 行（server 尚未命名）的 key；没有 `tag` 时这些行无法显示。
- `/lan/tags/:tag/...` 路由也依赖它。

**前置**

- 每个 daemon 在接受 spawn spec 时铸造 uid（已完成）；
- 每个 App 以 `happySessionId ?? sessionUid ?? tag` 建键（已完成）；
- 观测门通过：在场 App 的最低版本都优先使用 uid。

**步骤**

1. 先停止在 roster 中发布 `tag`（旧 App 的 pending 行会消失，因此必须在门通过后）。
2. 观察一个周期；如果没有“pending 行不显示”的反馈，再决定是否移除 `/lan/tags/:tag/...`。
3. **建议保留 tag-addressed 路由**：它是我们自己的寻址方式，用于 server 还没命名会话时直达机器；保留它不需要向 App 暴露 tag。

**回滚**

- 重新发布 `tag` 是一个加法字段，旧 App 立即恢复。

**注意**

- tag 不是密文内容，保留它没有安全问题；移除是契约收敛，不是风险修复，可以最后做。

---

## 4. U11 rekey（uid 当主键）

**影响**

- 缓存、墓碑、outbox、深链、路由、消息缓存、LAN window、本地 profile 映射。
- 任何漏改的 map 都会导致行“消失”或删除失效。

**前置**

- 所有 daemon-owned 行都有 uid（scheduled 行已提前铸造；resume 复用同一 uid）；
- 所有在用 App 版本都持久化 uid；
- 完成 key 审计：每个以 `sessionId` 取键的 map 都列出并改到统一入口；
- 单独授权，不放进 M1–M4。

**设计**

- 新增唯一入口 `identityKey(session) = sessionUid ?? sessionId`，所有 map 只经它取键。
- 保留 `sessionId → uid` 别名索引，供路由、深链、老客户端和 server-only 行使用。
- 双读双写：uid 可用时按 uid 存，否则按 sessionId；读取时两者都查。
- 不做批量重写、不改缓存文件名、不清缓存。行在 owner 上报 uid 时惰性补齐。

**回滚**

- 一个开关让 `identityKey` 暂时返回 `sessionId`；两套键始终可解析，回滚不丢数据。

---

## 5. 执行顺序

1. **观测**：`clientVersion` + 别名计数（非破坏性，先合入）。
2. **收口旧别名**：开关保留一个周期 → 默认关闭 → 删除。
3. **收口 tag**：停发 tag → 观察 → 决定是否移除 tag 路由。
4. **rekey**：单独授权，按上面的双键方案执行。

每一步只在前一步的观测门通过后开始；任何一步都可以停在当前状态而不影响功能。
