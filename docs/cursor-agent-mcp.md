# Cursor Agent MCP 能力与 Happy 注册方案

## 1. Cursor agent 的 MCP 能力

### 1.1 配置来源

- **配置文件**：`cursor-agent` 从以下位置读取 MCP 配置（无 CLI 内联 `--mcp-config`）：
  - 工作区：`<workspace>/.cursor/mcp.json`
  - 用户级：`~/.cursor/mcp.json`
- **子命令**：`cursor-agent mcp` 用于管理 MCP：
  - `mcp list` — 列出已配置的 MCP 及状态
  - `mcp enable <id>` / `mcp disable <id>` — 加入/移出本地“已批准”列表
  - `mcp login <id>` — 对需要认证的 MCP 做登录
  - `mcp list-tools <id>` — 列出某 MCP 的工具与参数

### 1.2 mcp.json 格式（实测）

- 顶层键：`mcpServers`，值为 `Record<string, ServerEntry>`。
- **HTTP 服务器**（Happy 使用）：
  ```json
  {
    "mcpServers": {
      "happy": {
        "url": "http://127.0.0.1:PORT"
      }
    }
  }
  ```
- 若仅配置未批准，`mcp list` 会显示 `happy: not loaded (needs approval)`；批准后或使用 `--approve-mcps` 后才会加载。

### 1.3 自动批准

- 启动时加 `--approve-mcps` 可自动批准本次运行中在 mcp.json 里配置的所有 MCP，无需交互 `mcp enable`。
- 非交互/脚本场景（如 Happy 启动 cursor-agent）应使用此参数。

### 1.4 与 Claude/Codex 的对比

| 能力           | Claude (local)     | Codex                    | Cursor agent        |
|----------------|--------------------|---------------------------|---------------------|
| MCP 配置方式   | `--mcp-config` JSON | API `config.mcp_servers`  | 仅 mcp.json 文件    |
| HTTP MCP       | 支持 `type: 'http', url` | 通过 STDIO bridge 转 HTTP | 支持 `url`          |
| STDIO MCP      | 支持 `command`+`args`   | 支持 command+args         | 支持（同 Cursor IDE）|
| 自动批准       | 由 permission 模式决定  | 由会话配置决定            | `--approve-mcps`    |

## 2. Happy CLI 侧现状

- **Happy MCP 服务**：`startHappyServer(session)` 在 `runCursor` / `runClaude` 等中启动，提供 HTTP MCP，工具包括 `change_title` 等，URL 为动态 `http://127.0.0.1:<port>`。
- **runCursor**：已调用 `startHappyServer(session)`，但未把该 URL 注册给 cursor-agent，因此 cursor-agent 启动时没有加载 Happy MCP。
- **Codex/Gemini/ACP**：通过各自 API 或 `--mcp-config` 传入 `mcpServers`（或 STDIO bridge + URL）；Cursor 无类似入口，只能通过 mcp.json。

## 3. 方案：启动 cursor-agent 时注册 Happy MCP

### 3.1 思路

1. **先起 Happy MCP**：`runCursor` 中已有 `const happyServer = await startHappyServer(session)`，得到 `happyServer.url`。
2. **写工作区 mcp.json**：在 spawn cursor-agent 之前，确保 `workspacePath/.cursor/mcp.json` 存在，且 `mcpServers.happy.url === happyServer.url`（若已有文件则合并，保留其它 MCP）。
3. **传 `--approve-mcps`**：spawn 时对 cursor-agent 加上 `--approve-mcps`，使本次运行自动加载 Happy，无需用户执行 `mcp enable`。
4. **工作目录**：`CursorProcess` 已使用 `cwd: workspacePath`，cursor-agent 会读取 `workspacePath/.cursor/mcp.json`。

### 3.2 实现要点

- **合并策略**：若已有 `.cursor/mcp.json`，只更新或添加 `mcpServers.happy`，不覆盖其它 server。
- **生命周期**：mcp.json 在会话期间存在即可；会话结束后可保留（下次同 workspace 仍可用）或仅删除 `happy` 条目，按产品需求选择。
- **STDIO 备选**：若希望与 Codex 一致，也可用 `happy-mcp.mjs`（STDIO bridge + `HAPPY_HTTP_MCP_URL`）在 mcp.json 里配置为 `command`+`args`；当前方案采用 HTTP 直连，实现更简单，且 Cursor 已支持 `url`。

### 3.3 代码位置

- **写/合并 mcp.json**：在 `runCursor.ts` 中 `startHappyServer` 之后、主循环内首次 spawn 之前（或每次 spawn 前）调用一小段逻辑，写入 `workspacePath/.cursor/mcp.json`。
- **传 `--approve-mcps`**：在 `cursorProcess.ts` 的 `CursorProcessOptions` 中增加 `approveMcps?: boolean`，在 `run()` 里若为 true 则在 cursor-agent 参数中追加 `--approve-mcps`；在 `runCursor.ts` 创建 `CursorProcess` 时传入 `approveMcps: true`。

### 3.4 工作目录（monorepo 下用仓库根）

默认 `workspacePath = process.cwd()`。**Daemon 能直接启动到正确路径**：App/后端调用 spawn 时传入 `directory`（用户选的工作区），daemon 用 `cwd: directory` 起子进程，子进程的 `process.cwd()` 已是工作区根，无需再传 `--cwd`。

**手动从终端/tmux 启动**时没有“调用方传 directory”，`process.cwd()` 可能是执行 `yarn cli` 时的目录（例如 monorepo 里常是 `packages/happy-cli`），所以需要**显式**指定工作目录为仓库根，且用**绝对路径**（与 daemon 行为一致）：

- **`--cwd`**：`happy cursor --cwd /path/to/repo`
- **环境变量**：`HAPPY_CURSOR_WORKSPACE=/path/to/repo yarn cli cursor`

示例（tmux 中用**绝对路径**，保证和 daemon 一样从正确 cwd 启动）：

```bash
REPO_ROOT="/path/to/monorepo"  # 或 $(pwd) 在 repo 根执行时
tmux new-session -d -s happy-cursor-test -c "$REPO_ROOT" "yarn cli cursor --cwd $REPO_ROOT"
```

这样 `workspacePath` 为仓库根，`.cursor/mcp.json` 写在仓库根，cursor-agent 的 cwd 也是仓库根，MCP 能正确加载。

### 3.5 改标题（change_title）与实时连接

`change_title` 通过 WebSocket 的 `update-metadata` 更新会话标题，**没有 HTTP 降级**。若 CLI 日志里出现 “Session real-time: disconnected (using HTTP poll)”，说明当前是轮询模式，改标题可能超时或失败。此时可等待重连后再试，或检查网络/防火墙是否允许与 Happy 服务器的 WebSocket 连接。

### 3.6 改标题被拒绝时排查 MCP 是否已授权

若测试会话提示「通过 MCP 改标题被拒绝」，先确认启动时是否已加载并授权 Happy MCP：

- **用 Happy CLI 启动**（`happy cursor` / `yarn cli cursor`）时，会写入 `workspacePath/.cursor/mcp.json` 并在 spawn cursor-agent 时传入 `--approve-mcps`，无需额外操作。
- **看日志**：启动后应出现 `[cursor] Happy MCP: url=..., workspacePath=...` 以及 spawn 时的 `[cursor] MCP: --approve-mcps enabled ...`。若没有，说明该会话可能不是经当前 CLI 启动，或工作目录与预期不一致。
- **手动启动 cursor-agent** 时，需在会话目录下保证存在 `.cursor/mcp.json`（且 `mcpServers.happy.url` 指向 Happy MCP 的 URL），并加上参数 `--approve-mcps`，否则 MCP 可能未加载或需在 Cursor 里手动批准。

### 3.7 「User rejected MCP: happy-change_title」说明

若系统返回 **「User rejected MCP: happy-change_title」**，表示**在请求到达 Happy MCP 之前**就被拒绝了，即工具审批层（Cursor/App）没有放行这次调用。

- **确证方式**：看 CLI 日志是否出现 `[happyMCP] change_title called`。
  - **没有**：请求没进我们 MCP，拒绝发生在 cursor-agent 或 App 的「工具审批」步骤（例如需要用户点允许、无操作时视为拒绝）。
  - **有**：请求进了 MCP；若接着出现 `[happyMCP] change_title rejected error=...`，则是我们这边（如 socket 断开、服务端拒绝）返回的失败。
- **可能原因**：cursor-agent 在执行 MCP 工具前会做一次「用户确认」；在无交互/远程会话下没有用户点允许，就会变成 “User rejected”。此时需在 **cursor-agent** 侧配置对部分 MCP 工具（如 change_title）的自动批准，或使用不要求逐工具审批的运行模式（请查阅 cursor-agent 文档/参数）。

### 3.8 tmux 手动启动 vs daemon spawn 的代码路径差异

改标题在 daemon spawn 下能成功、在 tmux 手动启动下被拒时，可对照下列差异排查。

| 环节 | daemon spawn | tmux 手动启动 |
|------|----------------|----------------|
| **入口** | App → 后端 spawn-session → daemon `spawnSession({ directory, agent: 'cursor' })` | 用户执行 `tmux new-session ... 'yarn cli cursor --cwd $REPO_ROOT'` |
| **CLI 进程** | `spawnHappyCLI(['cursor', '--happy-starting-mode', 'remote', '--started-by', 'daemon'], { cwd: directory })` 或 tmux 里 `node dist/index.mjs cursor --happy-starting-mode remote --started-by daemon`，**不传 --cwd**，cwd 由 spawn 的 `cwd: directory` 决定 | `yarn cli cursor --cwd $REPO_ROOT`，**传了 --cwd**，**不传 --started-by** |
| **index.ts 解析** | `startedBy = 'daemon'`，`workspaceRoot` 未传 → runCursor 里 `workspacePath = process.cwd()`（已是 directory） | `startedBy = undefined`，`workspaceRoot = $REPO_ROOT` → runCursor 里 `workspacePath = resolve($REPO_ROOT)` |
| **会话 metadata** | `createSessionMetadata` 时 `startedFromDaemon: true`，`startedBy: 'daemon'` | `startedFromDaemon: false`，`startedBy: 'terminal'` |
| **runCursor 后续** | 同一套：`startHappyServer`、`ensureCursorMcpHappy`、`CursorProcess` 带 `approveMcps: true`、cwd: workspacePath。每轮 spawn cursor-agent 参数一致。 | 同上。唯一区别是 session 的 metadata 里 startedBy/startedFromDaemon 不同。 |

**结论**：到 runCursor 之后，两种方式都会写 `.cursor/mcp.json`、用同一 workspacePath 起 cursor-agent、带 `--approve-mcps`。差异只在**会话创建时的 metadata**（`startedBy` / `startedFromDaemon`）。若 App 或后端根据 `startedFromDaemon` 对 Cursor 的 MCP 工具有「自动放行」逻辑，则只有 daemon 起的会话会生效；当前 App 代码里未发现据此区分 Cursor 权限的逻辑，但后端或后续版本可能依赖该字段。

**建议**：用 tmux 复现时，可先试传 `--started-by daemon`（与 daemon 行为对齐），看改标题是否通过：  
`yarn cli cursor --cwd $REPO_ROOT --started-by daemon`。若通过，则说明问题与 `startedBy`/metadata 相关，再在 App/后端为「终端启动」的 Cursor 会话补同款放行或配置。

## 4. 参考

- `cursor-agent --help` / `cursor-agent mcp --help`
- Happy：`packages/happy-cli/src/claude/utils/startHappyServer.ts`，`packages/happy-cli/src/cursor/runCursor.ts`，`packages/happy-cli/src/cursor/cursorProcess.ts`
- Codex MCP 配置：`packages/happy-cli/src/codex/runCodex.ts`（mcp_servers + STDIO bridge）
