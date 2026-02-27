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

## 4. 参考

- `cursor-agent --help` / `cursor-agent mcp --help`
- Happy：`packages/happy-cli/src/claude/utils/startHappyServer.ts`，`packages/happy-cli/src/cursor/runCursor.ts`，`packages/happy-cli/src/cursor/cursorProcess.ts`
- Codex MCP 配置：`packages/happy-cli/src/codex/runCodex.ts`（mcp_servers + STDIO bridge）
