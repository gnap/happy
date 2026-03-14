# App 与 Relay 服务连接诊断

## 1. 架构概览

- **Relay 地址**: `https://api.cluster-fluster.com`（经 Cloudflare，边缘节点示例：Singapore）
- **CLI/App**: 通过 Socket.IO（WebSocket + polling）连接 `/v1/updates`，REST 用于发消息、拉历史

## 2. 日志中看到的错误类型

### 2.1 502 Bad Gateway（服务端）

```
flushOutbox failed ... status:502
"title":"cluster-fluster.com | 502: Bad gateway"
"Host":"api.cluster-fluster.com" → "Error"
```

- **含义**: Cloudflare 能通，但**后端 origin（Happy 业务服务）** 返回错误或超时。
- **结论**: 属于 **Relay 服务端/机房** 问题，不是客户端或网络配置能修好的。需要服务端/运维排查（后端是否挂掉、过载、部署变更等）。

### 2.2 Socket transport error（连接中断）

```
[API] Socket disconnected: transport error
[API] Socket disconnected, starting fallback HTTP poll every 8000ms
...
Socket connected successfully
[API] Stopped fallback HTTP poll
```

- **含义**: WebSocket 被中断（网络抖动、代理掐长连接、移动网络切换等），随后自动重连或走 HTTP 轮询。
- **当前行为**: 已开启 `reconnection: true`、`reconnectionAttempts: Infinity`，断线后会启动 **每 8 秒的 HTTP 轮询** 拉消息，重连成功后停掉轮询。所以 CLI 侧在断线期间仍能拿到新消息。

## 3. 客户端已做的优化

- **IPv4 强制**: `configuration.ts` 里 `serverHttpsAgent` 使用 `family: 4`，避免 IPv6 不可达导致 ETIMEDOUT。
- **Socket 选项**: `transports: ['polling', 'websocket']`，先 polling 再升级到 WebSocket；断线后自动重连（delay 1s–5s）。
- **Fallback 轮询**: Socket 断开后每 8s 用 REST 拉消息，减少“收不到消息”的时间窗口。

## 4. 可能原因归纳

| 现象           | 可能原因                         | 可采取动作                     |
|----------------|----------------------------------|--------------------------------|
| 502 Bad Gateway | Relay 后端宕机/过载/部署问题     | 联系运维/服务方查后端与日志   |
| 经常 transport error | 网络不稳定、代理/防火墙断 WebSocket、WiFi/4G 切换 | 客户端已重连+轮询；可考虑在 App 展示“连接不稳定”提示 |
| App 提示连接错误 | 同上，或 App 与 CLI 使用的会话/环境不一致 | 确认 App 与 CLI 连同一会话、同一 HAPPY_SERVER_URL |

## 5. 建议的排查步骤

1. **确认 Relay 是否正常**  
   - 浏览器或 `curl` 访问 `https://api.cluster-fluster.com/v1/sessions`（需带合法 Token）。  
   - 若这里就 502/504，问题在服务端，需运维/服务方处理。

2. **看错误发生时段**  
   - 若 502 集中在某段时间，说明是服务端或机房故障。  
   - 若 transport error 在切换网络/锁屏后频繁出现，偏网络/长连接环境。

3. **App 与 CLI 使用同一环境**  
   - 确认 App 没有单独配置别的 API 地址或代理。  
   - 确认两边都连到同一会话（同一 `sessionId` / 同一会话入口）。

4. **客户端可做的增强（可选）**  
   - 在 App/CLI 展示“当前连接状态”（如：已连接 / 断开-轮询中 / 错误），便于用户判断是“暂时断线”还是“服务挂了”。  
   - 若 502 重试：对 REST 请求（如 flushOutbox）在 502/503/504 时做有限次指数退避重试，减少偶发 502 导致的发送失败。

## 6. App 页面顶部显示的错误是什么？

App 顶部状态来自 **Socket 连接状态**，由 `happy-app` 的 `apiSocket` 驱动：

| 显示文案 | 含义 | 触发条件 |
|----------|------|----------|
| 已连接 / connected | 正常 | `socket.on('connect')` |
| 连接中 / connecting | 正在连 | 调用 `connect()` 时 |
| 已断开 / disconnected | 已断线 | `socket.on('disconnect', reason)` |
| **错误 / error** | **连接异常** | `socket.on('connect_error')` 或 `socket.on('error')` |

**“错误”出现时：**

- **代码位置**  
  - `packages/happy-app/sources/sync/apiSocket.ts`  
    - `connect_error` → `updateStatus('error')`（约 234 行）  
    - `error` → `updateStatus('error')`（约 240 行）
- **展示位置**  
  - `packages/happy-app/sources/components/HomeHeader.tsx`：`HeaderTitleWithSubtitle` 里根据 `socketStatus.status === 'error'` 显示 `t('status.error')`（中文为「错误」）  
  - `packages/happy-app/sources/components/MainView.tsx`：同样根据 connection status 显示状态文案
- **文案来源**  
  - `packages/happy-app/sources/text/translations/zh-Hans.ts`：`status.error: '错误'`  
  - 英文：`status.error: 'error'`

**常见原因：**

- 与 Relay 的 WebSocket 连接失败（`connect_error`：网络不可达、超时、TLS 问题、代理拦截等）
- Socket 收到 `error` 事件（例如服务端关闭连接、transport error）
- 与 CLI 诊断一致：Relay 502、网络抖动、移动网络切换等会导致断线或连不上，进而触发上述事件，App 就把状态设为 `error` 并显示「错误」。

## 7. 相关代码位置

- **Relay URL**: `packages/happy-cli/src/configuration.ts` → `serverUrl`（默认 `https://api.cluster-fluster.com`）
- **Socket 创建与重连**: `packages/happy-cli/src/api/apiSession.ts` → `io(configuration.serverUrl, { reconnection: true, ... })`
- **断线后 HTTP 轮询**: `apiSession.ts` → `startFallbackPoll()`，间隔 8s
- **IPv4 强制**: `configuration.ts` → `serverHttpsAgent`（`family: 4`）
- **App 顶部状态**: `packages/happy-app/sources/sync/apiSocket.ts`（`connect_error` / `error` → `'error'`）→ `HomeHeader.tsx` / `MainView.tsx` 显示 `t('status.error')`（「错误」）
