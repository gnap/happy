# Remote Happy Cursor CLI ↔ App 通讯调试

当 Happy Cursor 在远程环境（SSH、devcontainer、Codespaces 等）运行时，CLI 与手机 App 无法通讯时，可按下面排查。

## 通信架构

- **CLI ↔ 后端**: Socket.IO（`configuration.serverUrl`，path `/v1/updates`）或退化为 HTTP 轮询（约 8s 一次）。
- **App ↔ 后端**: 同样连到同一 Happy 后端。
- **会话绑定**: 同一 `sessionId` 下，后端把 App 的消息推给 CLI，把 CLI 的消息推给 App。

因此「远程 CLI 和 App 不通」通常是：**CLI 与后端不通**，或 **CLI 与 App 不在同一会话**。

## 调试步骤

### 1. 打开调试日志

```bash
DEBUG=1 happy cursor
```

关注日志中的：

- `[API] Socket connected successfully` → 实时 socket 已连上。
- `[API] Socket connection error:` → 连不上，会提示可能原因；随后会启用 HTTP fallback。
- `[cursor] Session real-time: socket connected` 或 `disconnected (using HTTP poll)` → 约 3.5s 后的连接状态。
- `[API] User message from app received, routing to CLI` → App 发来的消息已到 CLI。

### 2. 确认会话一致（远程常见）

- 在**远程机器**上执行 `happy cursor` 会创建**新会话**（或复用该机器上的 `~/.happy` 里的 tag）。
- 若 App 里打开的是**本机**之前某次会话，和当前远程 CLI 的 session 不是同一个，会收不到彼此消息。
- **做法**: 远程启动后，在手机点 **「It's ready!」** 推送，用该推送打开会话，保证 App 和当前这次 `happy cursor` 是同一 session。

### 3. 远程网络与代理

- 后端地址默认来自 `HAPPY_SERVER_URL`（未设置则用默认 API）。
- 若环境有防火墙/代理，需放行对后端的 **HTTPS + WSS（WebSocket）** 出站。
- Socket 连不上时，CLI 会自动用 **HTTP 轮询** 拉消息；只要 HTTPS 可用，App→CLI 仍可工作，只是延迟略高。

### 4. 快速检查清单

| 现象 | 可能原因 | 建议 |
|------|----------|------|
| 日志里一直是 `disconnected (using HTTP poll)` | 出站 WSS 被拦或网络问题 | 检查防火墙/代理；可先依赖 HTTP fallback |
| 从未出现 `User message from app received` | App 和 CLI 不是同一 session，或 App 未发到该 session | 用「It's ready!」重新进会话；在 App 里发一条测试 |
| 首次创建 session 就失败 | 无法访问 `HAPPY_SERVER_URL` | 检查 DNS、代理、VPN |
| 复用 session 后密钥/解密错误 | 不同机器用了不同 `~/.happy`，encryption key 不一致 | 在该远程环境用 `HAPPY_CURSOR_NEW_SESSION=1 happy cursor` 起新会话 |

## 代码中的调试入口

- **连接状态**: `ApiSessionClient.isSocketConnected()`（约 3.5s 后在 runCursor 里打日志）。
- **App→CLI 消息**: `apiSession.routeIncomingMessage` 里在解析到 UserMessage 时打 `[API] User message from app received, routing to CLI`。
- **Socket 失败**: `apiSession` 的 `connect_error` 里会打错误信息并提示远程/SSH 时检查出站。
