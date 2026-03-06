# 计费/用量信息通讯方式对比：Cursor vs Happy

## 一、Cursor 的用量获取方式（调研结论）

Cursor 的用量/配额**不是**公开文档 API，而是：

1. **从本地 DB 读 Token**
   - 路径（macOS）：`~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`（SQLite）
   - 查询：`SELECT key, value FROM ItemTable WHERE key LIKE 'cursorAuth/%'`
   - 用到的 key：`cursorAuth/accessToken`、`cursorAuth/refreshToken`、`cursorAuth/cachedEmail`、`cursorAuth/stripeMembershipType`、`cursorAuth/stripeSubscriptionStatus`、`cursorAuth/cachedSignUpType`

2. **调 Cursor 内部 API**
   - Base：`https://api2.cursor.sh`
   - 接口：`GET /auth/usage-summary`
   - 鉴权：`Authorization: Bearer <accessToken>`

3. **解析的配额结构**
   - 账户：membershipType、isUnlimited、billingCycleStart、billingCycleEnd
   - 套餐用量 individualUsage.plan：used、limit、remaining、totalPercentUsed、autoPercentUsed、apiPercentUsed
   - 按量 individualUsage.onDemand：used、limit、remaining

即：**本地 state.vscdb 的 accessToken + api2.cursor.sh 的 usage-summary**，无公开文档。

---

## 二、Happy 的计费/用量通讯方式

Happy **不走** Cursor 那套本地 DB + 内部 API，而是**自有服务 + 鉴权**，用量由 CLI 上报、服务端落库，App 通过 REST 查询或消息内 usage 展示。

### 2.1 数据流概览

```
┌─────────────┐     usage-report (WebSocket)      ┌─────────────┐     POST /v1/usage/query      ┌─────────────┐
│  Happy CLI  │ ───────────────────────────────► │ Happy Server│ ◄───────────────────────────── │  Happy App  │
│ (各 Agent)  │   key, sessionId, tokens, cost   │ (usageReport│   Authorization: Bearer       │ (设置-用量) │
└─────────────┘                                   │  存 DB)     │     + 时间/会话筛选           └─────────────┘
       │                                          └──────┬──────┘
       │                                                 │
       │  assistant 消息里带 usage 时                    │ ephemeral (type: 'usage')
       │  sendUsageData(usage, model)                    │ 推给已连接客户端（当前未在 App 里消费）
       ▼                                                 ▼
  sendClaudeSessionMessage 等路径                   buildUsageEphemeral → eventRouter.emitEphemeral
```

### 2.2 CLI → Server：用量上报

- **方式**：WebSocket 事件 `usage-report`
- **入口**：`packages/happy-cli/src/api/apiSession.ts`
  - `sendUsageData(usage: Usage, model?: string)`：把 `usage`（input_tokens, output_tokens, cache_*）和按 model 算出的 cost 组成 payload，`this.socket.emit('usage-report', usageReport)`
  - **触发时机**：当前仅在 **Claude 会话** 的 `sendClaudeSessionMessage` 中，当 `body.type === 'assistant' && body.message?.usage` 时调用 `sendUsageData(body.message.usage, body.message.model)`
- **Payload 形状**：`{ key, sessionId, tokens: { total, input, output, cache_creation, cache_read }, cost: { total, input, output } }`（如 `key: 'claude-session'`）
- **鉴权**：复用 Happy 的 WebSocket 连接（已用 Happy 账号鉴权），不涉及 Cursor 的 state.vscdb 或 accessToken

#### 2.2.1 现有 CLI 上报调用链（谁在何时发什么）

| 路径 | 是否上报 usage | 说明 |
|------|----------------|------|
| **Claude（Remote）** | ✅ 是 | API 流式返回的 assistant 消息带 `usage` → `sdkToLogConverter` 转成 `{ type: 'assistant', message: { usage, model, ... } }` → `session.client.sendClaudeSessionMessage(logMessage)`（见 `claudeRemoteLauncher.ts` 104、420）→ `sendClaudeSessionMessage` 内 `body.type === 'assistant' && body.message?.usage` 时调用 `sendUsageData` → `socket.emit('usage-report', usageReport)` |
| **Claude（Local）** | ✅ 是 | `claudeLocalLauncher.ts` 中 `session.client.sendClaudeSessionMessage(message)`；若 message 来自本地 Claude 进程的 log 且含 assistant + usage，同样会触发 `sendUsageData` |
| **Claude（runClaude 离线重连）** | ✅ 是 | `runClaude.ts` 里 `createSessionScanner` 的 `onMessage: (msg) => session.sendClaudeSessionMessage(msg)`，msg 若为 assistant + usage 会触发上报 |
| **Cursor** | ❌ 否 | 仅 `sendCursorMessage(body)` → `enqueueMessage` 发内容，**不经过** `sendClaudeSessionMessage`，没有任何地方调用 `sendUsageData` 或 emit `usage-report` |
| **Codex** | ❌ 否 | 仅 `sendCodexMessage(body)` → `enqueueMessage`，同上，无 usage 上报 |
| **Gemini** | ❌ 否 | 无 `sendClaudeSessionMessage` / `sendUsageData` 调用，无 usage 上报 |

**调用关系小结：**

- **唯一上报入口**：`apiSession.ts` 的 `sendUsageData(usage, model)`，内部 `this.socket.emit('usage-report', usageReport)`。
- **唯一调用点**：`apiSession.ts` 的 `sendClaudeSessionMessage(body)` 中，当 `body.type === 'assistant' && body.message?.usage` 时。
- **谁会调 sendClaudeSessionMessage**：只有 Claude 相关逻辑——`claudeRemoteLauncher`（流式 log 回调 + 中断 tool 的 converted）、`claudeLocalLauncher`、`runClaude` 的 scanner `onMessage`、`startHappyServer` 的 `sendClaudeSessionMessage`。  
  因此 **Cursor / Codex / Gemini 的 CLI 端目前都不向 Happy Server 上报用量**。

### 2.3 Server：接收与存储

- **处理**：`packages/happy-server/sources/app/api/socket/usageHandler.ts`
  - 监听 `usage-report`，校验 key / tokens / cost / sessionId，按 `accountId_sessionId_key` upsert 到 `db.usageReport`
  - 若带 `sessionId`，则调用 `buildUsageEphemeral(sessionId, key, tokens, cost)`，经 `eventRouter.emitEphemeral` 推给该用户的连接（ephemeral type: `'usage'`）

### 2.4 App：用量展示

- **拉取**：`packages/happy-app/sources/sync/apiUsage.ts`
  - `queryUsage(credentials, params)`：`POST ${API_ENDPOINT}/v1/usage/query`，Header `Authorization: Bearer ${credentials.token}`（Happy 的 token，非 Cursor）
  - 参数：`sessionId?`, `startTime`, `endTime`, `groupBy: 'hour'|'day'`
- **服务端**：`packages/happy-server/sources/app/api/routes/accountRoutes.ts`
  - `POST /v1/usage/query`，`app.authenticate` 取 userId，从 `db.usageReport` 按 accountId、可选 sessionId、时间范围查询，按 groupBy 聚合成时间点序列，返回 `UsageResponse`
- **UI**：设置页「用量」`(app)/settings/usage.tsx` 使用 `UsagePanel`，内部 `getUsageForPeriod(credentials, period, sessionId)` → `queryUsage`，再 `calculateTotals` 展示图表与汇总

### 2.5 消息内 usage（当前 reducer 路径）

- **来源**：归一化消息里若带 `usage`（如 output 格式的 assistant message 的 `message.usage`），reducer 在 Phase 2 会调用 `processUsageData(state, msg.usage, msg.createdAt)`，更新 `state.latestUsage`，最终通过 `ReducerResult.usage` 暴露给上层。
- **用途**：会话内「本条/本轮」的 token 与 context 展示用，和「设置-用量」的跨会话统计是两条线；设置页用量主要依赖 `/v1/usage/query` 查 DB，而不是仅靠 ephemeral。

### 2.6 Ephemeral usage 在 App 的现状

- **定义**：`packages/happy-app/sources/sync/apiTypes.ts` 中 `ApiEphemeralUsageUpdateSchema`（type: `'usage'`）与 `ApiEphemeralUpdateSchema` 已包含 usage 的 ephemeral 结构。
- **接收**：sync 层 `handleEphemeralUpdate` 收到 ephemeral 后，仅对 `type === 'activity'` 和 `type === 'machine-activity'` 做了处理，**没有** `type === 'usage'` 的分支，因此服务器下发的 usage ephemeral 目前不会更新 App 的本地状态或驱动 UI。

---

## 三、GitHub Quotio 的实现（参考）

[Quotio](https://github.com/nguyenphutrong/quotio) 是 macOS 菜单栏应用，用于管理 **CLIProxyAPI** 本地代理、多账户配额与 CLI Agent 配置。其用量/配额实现与 Happy、Cursor 都不同，可作为「代理侧聚合 + 多数据源拉取」的参考。

### 3.1 架构概览

- **CLIProxyAPI**：独立二进制，由 Quotio 首次启动时下载，作为**本地 HTTP 代理**运行（默认 localhost:8317）。
- **CLI 工具**（Claude Code、Codex CLI、Gemini CLI、OpenCode、Amp、Factory Droid 等）经 Quotio/Agent 配置后，**请求先发到该代理**，代理再按账户与路由策略转发到各厂商 API。
- **用量来源**因此有两类：
  1. **代理运行时**：所有经代理的请求/响应都可被解析，代理内部聚合用量，通过 **Management API** 暴露给 Quotio。
  2. **不依赖代理时（Quota-Only 模式）**：Quotio 直接按 Provider 用不同方式拉取配额（见下）。

### 3.2 代理侧用量（Full Mode）

- Quotio 通过 **ManagementAPIClient**（HTTP，Bearer 鉴权）访问代理的 **Management API**。
- 用量接口：`GET /usage` → 返回 `UsageStats`（代理进程内聚合的请求量/成功率等）。
- 代理在转发 Claude/Gemini/Codex 等 API 时，能看到响应体中的 token/usage 字段，从而在本地汇总；具体聚合逻辑在 **CLIProxyAPI** 二进制内（该二进制非同一仓库，未在本次查阅）。

即：**用量由代理在中间层从 API 响应里解析并聚合，App 只轮询 GET /usage**，无需各 CLI 主动上报。

### 3.3 不跑代理时的配额（Quota-Only / Standalone）

Quotio 支持「仅看配额、不启代理」模式，此时配额来自 **Provider 专属 Fetcher**（见其 `Quotio/Services/*QuotaFetcher.swift`）：

| Provider / 场景     | 方式 |
|---------------------|------|
| **Antigravity**      | 用 auth 文件调 Antigravity API 拉配额 |
| **OpenAI (Codex)**  | 用 auth 文件调 OpenAI API |
| **GitHub Copilot**  | 用 auth 文件调 Copilot API |
| **Claude Code**     | 调本地 **CLI**：`claude usage` 命令 |
| **Cursor**          | **仅监控**：读本地 Cursor 状态（如 state.vscdb / 浏览器会话），不作为代理上游 |
| **Codex CLI**       | 读本地 auth 文件（如 `~/.codex/auth.json`） |
| **Gemini CLI**      | 读本地 auth（如 `~/.gemini/oauth_creds.json`） |

Cursor / Trae 在 Quotio 里被标为 **IDE Quota Tracking (Monitor Only)**：只做用量展示，不能作为代理的 Provider。

### 3.4 Quotio 的 Cursor 计费信息更新（重点参考）

Quotio 对 Cursor **不跑代理、只管计费信息更新**：用 `CursorQuotaFetcher` 读本地 Cursor 鉴权 + 调 Cursor 内部 API 拉用量，在 Quota 屏/菜单栏展示。实现要点如下（源码：`Quotio/Services/QuotaFetchers/CursorQuotaFetcher.swift`）。

#### 3.4.1 角色与数据流

- **不参与代理**：Cursor 不能作为 CLIProxyAPI 的 Provider，请求不会经 Quotio 代理。
- **只读 + 拉取**：本地读 Cursor 的 state.vscdb 拿 accessToken → 用该 token 请求 `api2.cursor.sh` 的 usage-summary → 解析后转为统一的 `ProviderQuotaData` 用于 UI 展示（Quota 屏、菜单栏等）。
- **与代理用量分离**：代理的 `GET /usage` 只统计经代理的 Claude/Gemini/Codex 等；Cursor 用量单独由 CursorQuotaFetcher 刷新，不写入代理。

#### 3.4.2 读本地鉴权（state.vscdb）

- **路径**（macOS）：`~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`（SQLite）。
- **打开方式**：只读、避免锁/WAL 问题——`file://<path>?mode=ro&immutable=1`，`SQLITE_OPEN_READONLY | SQLITE_OPEN_URI`。
- **查询**：`SELECT key, value FROM ItemTable WHERE key LIKE 'cursorAuth/%'`。
- **使用的 key**：
  - `cursorAuth/accessToken` — 调 usage-summary 的 Bearer
  - `cursorAuth/refreshToken`、`cursorAuth/cachedEmail`、`cursorAuth/stripeMembershipType`、`cursorAuth/stripeSubscriptionStatus`、`cursorAuth/cachedSignUpType` — 用于展示或 API 失败时的回退信息

若 `accessToken` 或 `cachedEmail` 都不存在，视为未登录，不拉用量。

#### 3.4.3 拉取用量（usage-summary）

- **接口**：`GET https://api2.cursor.sh/auth/usage-summary`
- **鉴权**：`Authorization: Bearer <accessToken>`（来自 state.vscdb），`Accept: application/json`。
- **解析字段**（与文档「一、Cursor 的用量获取方式」一致）：
  - 账户：`membershipType`、`isUnlimited`、`billingCycleStart`、`billingCycleEnd`
  - **individualUsage.plan**：`enabled`、`used`、`limit`、`remaining`、`totalPercentUsed`、`autoPercentUsed`、`apiPercentUsed`
  - **individualUsage.onDemand**：`enabled`、`used`、`limit`、`remaining`（可选）

#### 3.4.4 失败与回退

- **401 / 非 200 / 网络错误**：不抛错，用**本地已读的 auth** 构造「仅账户信息」的 `CursorQuotaInfo`（email、membershipType、subscriptionStatus），无 plan/onDemand 用量，便于 UI 显示「已登录但暂时拿不到用量」。
- **未安装 Cursor**：`isInstalled()` 检查 `/Applications/Cursor.app` 或 `~/Applications/Cursor.app`，未安装则直接返回空，不展示 Cursor 卡片。

#### 3.4.5 统一展示格式

- `fetchAsProviderQuota()` 返回 `[String: ProviderQuotaData]`，key 为 email（或 "Cursor User"）。
- 将 plan 转为一条 `ModelQuota`（name: `plan-usage`，含 used/limit/remaining、remainingPercentage、resetTime 取 billingCycleEnd）；onDemand 转为另一条（name: `on-demand`）；若无用量但有账户则给一条占位（name: `cursor-usage`，percentage 依 isUnlimited）。
- `planType` 用 membershipType 转成展示名（如 `pro_student` → "Pro Student"），供菜单栏/Quota 屏统一展示。

#### 3.4.6 Happy 可借鉴点

| 要点 | Quotio 做法 | Happy 可参考 |
|------|-------------|--------------|
| Cursor 不参与代理 | 仅 IDE Monitor，不加入 Provider 列表 | 与现有「Cursor 会话走 Happy 自有链路」一致；计费单独一条线 |
| 鉴权来源 | 只读 state.vscdb，cursorAuth/* | 若在 App/CLI 侧做「Cursor 用量」：需读同一路径（或 Electron 的等价路径）；服务端无法直接读用户机器 DB |
| 用量来源 | GET api2.cursor.sh/auth/usage-summary | 同上；只能在有 state.vscdb 的环境（如桌面 App 或本地 CLI）发该请求 |
| 数据归属 | 仅本地展示，不写回代理 | Happy 若做 Cursor 用量：可仅在前端/CLI 展示；或可选「上报到 Happy Server」存为单独 key（如 cursor-ide），与 claude-session 等并列 |
| 失败回退 | 用本地 auth 显示账户信息 | 401/网络错误时仍可显示「已登录 Cursor」+ 套餐类型，避免空白 |

若 Happy 要在设置/用量里增加「Cursor 账户用量」：需在**能访问 state.vscdb 的端**（如 Tauri/Electron 桌面 App，或用户本机运行的 CLI）实现「读 DB → 调 usage-summary → 展示或上报」；服务端仅可做存储与查询，不能代用户读 Cursor DB 或调 api2.cursor.sh。

#### 3.4.7 Happy CLI 多环境 Cursor 目录（已实现）

CLI 可能跑在本机 macOS/Linux/Windows、SSH 远端、devcontainer、Codespaces 等，Cursor 的 state.vscdb 路径因平台/环境不同。Happy CLI 已做：

- **路径解析**（`packages/happy-cli/src/cursor/cursorQuotaPaths.ts`）  
  - **darwin**：`~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`  
  - **linux**：`$XDG_CONFIG_HOME/Cursor/User/globalStorage/state.vscdb`（未设则 `~/.config/Cursor/User/...`）  
  - **win32**：`%APPDATA%\Cursor\User\globalStorage\state.vscdb`
- **环境覆盖**（适配多种运行环境）：  
  - **CURSOR_STATE_DB_PATH**：直接指定 state.vscdb 的完整路径（例如远端机器上 DB 拷到某处、或 devcontainer 挂载宿主机路径）。  
  - **CURSOR_USER_DATA_DIR**：指定 Cursor 的 User 数据目录，内部会拼上 `globalStorage/state.vscdb`。
- **读取与上报**（`cursorQuotaFetcher.ts`）：用本地 `sqlite3` CLI 只读 state.vscdb 取 cursorAuth/*，再请求 api2.cursor.sh 的 usage-summary；在 `happy cursor` 会话建立后可选上报一次（key: `cursor-ide`）到 Happy Server。
- **依赖**：读 DB 依赖当前环境有 **sqlite3** 命令（常见于 macOS/Linux）；Windows 或无 sqlite3 时可设 **CURSOR_STATE_DB_PATH** 指向已导出的数据或跳过。

### 3.5 与 Happy 的差异（可借鉴点）

| 维度         | Quotio + CLIProxyAPI                    | Happy（当前）                    |
|--------------|-----------------------------------------|----------------------------------|
| 用量谁算     | **代理**从上游 API 响应里解析并聚合      | **CLI** 在收到 assistant 消息后上报 |
| 谁主动报     | 无「CLI 上报」；代理被动看到所有请求     | 仅 Claude 路径 sendUsageData 上报 |
| 多 Provider  | 代理统一出口，自然覆盖所有经代理的流量   | Cursor/Codex/Gemini 未上报        |
| 不跑代理时   | 各 *QuotaFetcher 按 Provider 拉取        | 无 Quota-Only 模式，依赖会话上报  |

若要为 Happy 做「多 Agent 用量统一」或「不依赖 CLI 上报的用量」，可参考 Quotio：在**中间层（如 Happy Server 或本地代理）**从 API 响应中解析 usage，再聚合；或对 Cursor 等做「只读监控」时，参考 CursorQuotaFetcher 的本地 DB/会话读取方式（注意 Cursor 无公开 API，需逆向/本地读取）。

---

## 四、对比小结

| 维度           | Cursor                         | Happy                                      | Quotio（参考）                           |
|----------------|--------------------------------|--------------------------------------------|------------------------------------------|
| Token/鉴权来源 | 本地 state.vscdb (cursorAuth/*) | Happy 登录后的 token（auth 流程）          | 各 Provider OAuth/API Key；代理 Management API Key |
| 用量数据来源   | 内部 API GET usage-summary     | CLI 上报 → Server 存 DB；App 查 /v1/usage/query | 代理 GET /usage + Quota-Only 时各 *QuotaFetcher |
| 公开文档       | 无                             | 有（如 docs/api.md 的 POST /v1/usage/query） | README / docs，CLIProxyAPI 二进制闭源     |
| 套餐/订阅字段  | stripeMembershipType 等        | 当前实现未涉及 Stripe/套餐字段，仅 tokens/cost | 各 Provider 不同                         |
| 实时性         | 轮询或按需请求 usage-summary   | 上报即存；可加 ephemeral 推送到 App（当前未用） | 轮询代理 /usage、定时拉 Fetcher           |

若要「像 Cursor 那样」在 Happy 里展示 Cursor 账户的配额/用量，需要单独做：读 Cursor 的 state.vscdb 取 accessToken，再请求 api2.cursor.sh 的 usage-summary，并定义好 Happy 侧的展示与权限边界；与现有 Happy 计费通讯（CLI → Server → App）是两套独立链路。

---

## 五、如何确认 CLI 上报被服务端正确聚合

### 5.1 Record 与 object 对 schema 有无影响

**结论：无影响。**

- 线上传的是 **JSON**。TypeScript 的 `Record<string, number>` 与 `object` 在运行时都是普通对象，序列化结果一致。
- 服务端 `usageHandler` 只要求 `tokens` / `cost` 为 `typeof === 'object'` 且含 `total: number`；聚合时用 `Object.entries(data.tokens)` / `Object.entries(data.cost)` 遍历，只要存进 DB 的是「可枚举键 + 数字值」的普通对象即可。
- Prisma 的 `data: Json` 存的就是你传进去的普通对象；合并冲突时把类型从 `Record` 改成 `object` 只影响类型检查，**不会**改变实际发送/存储的 payload 形状。

### 5.2 如何验证「上报 → 落库 → 聚合」整条链

1. **App 用量页 Debug 面板**  
   设置 → 用量 → 展开「Show raw JSON」，看当前周期内 `/v1/usage/query` 返回的 `usage` 与 `totals`。若 CLI 已用 Cursor 会话上报过，应能在某时间点的 `tokens` / `cost` 里看到 `plan_requests_used`、`on_demand_cents` 等 key。

2. **CLI 使用 usage-report 的 ack（可选）**  
   服务端 `usage-report` 的 handler 支持 callback；CLI 若用 `emitWithAck('usage-report', ...)` 或传 callback，可收到 `{ success, reportId, createdAt, updatedAt }` 或 `{ success: false, error }`，便于在本地日志确认「服务端已落库」。

3. **服务端日志**  
   `usageHandler` 在成功写入后会打 `Usage report saved: key=..., sessionId=..., userId=...`，可配合时间与 key（如 `cursor-ide`）确认该条上报已被处理。
