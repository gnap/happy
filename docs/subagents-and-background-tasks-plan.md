# 子 Agent 与后台任务：可观测性调研 + 开发计划

只记录调研结论与计划，**不含代码改动**（发错主机了，先落文档，改起来在能调试的机器上做）。

三个问题：

1. **能不能拿到 agent 列表**（现在活跃的）？
2. **后台任务**（monitor、后台 bash、异步子 agent 之类）**能不能拿到活跃列表**？
3. 后台任务常常跨过 turn 的结束，**把「响应」block 住**——有没有办法避免？

结论：1 和 2 都能拿到，而且**不需要升级 SDK**；3 的成因在我们自己的代码里，且当前那段防护是**死代码**。

---

## 1. 结论摘要

| 要什么 | 能不能 | 用什么 | 证据 |
|---|---|---|---|
| 活跃 agent（会话级，含后台会话） | 能 | `claude agents --json` | 实测输出见 §2.1；bundle CLI 2.1.195 同样支持 |
| 可用的子 agent **定义** | 能 | SDK `Query.supportedAgents()`、`init.agents` | `sdk.d.ts:2324`、`:4083` |
| **正在跑**的子 agent / 后台任务 | 能，但要自己维护 map | 流事件 `task_started` / `task_progress` / `task_updated` / `task_notification` | `sdk.d.ts:4118-4197`；三个 CLI 里都有这些字符串 |
| 每 turn 结束时的**权威任务快照** | 能，白捡 | Stop hook 输入里的 `background_tasks: BackgroundTaskSummary[]` | `sdk.d.ts:6347`；CLI 二进制里 `background_tasks` 与 `session_crons` 相邻 |
| 主动停某个任务 | 能 | `Query.stopTask(taskId)` / `Query.backgroundTasks(toolUseId)` | `sdk.d.ts:2461`、`:2474` |
| 「列全部任务」的一次性接口 | **没有** | —— | SDK 注释明确要求客户端自己 merge 本地 task map（`sdk.d.ts:4185`） |

---

## 2. 可用面明细

### 2.1 会话级 agent 列表：`claude agents --json`

实测（本机，CLI 2.1.287）：

```json
[{"pid":71876,"cwd":"/Users/gnap/Worktrees/device-debug-cache","kind":"interactive",
  "startedAt":1791808930261,"sessionId":"cfa8798f-…","name":"device-debug-cache-6e","status":"busy"}]
```

- 字段：`pid`、`cwd`、`kind`（`interactive` | `background`）、`startedAt`、`sessionId`、`name`、`status`（`busy` | …）。
- 选项：`--json`（机器可读、非交互）、`--all`（含已完成）、`--cwd <path>`（按项目过滤）。
- 交互模式下必须 TTY，非 TTY 会明确提示改用 `--json`。
- 配套子命令：`attach <id>` / `logs <id>` / `stop|kill <id>` / `rm <id>` / `respawn`。
- **我们 bundle 的 CLI（2.1.195）也有**：`claude --help` 里 `agents [options]`、`--bg/--background`，`agents --help` 里同样有 `--json` / `--all`。所以这条不依赖 SDK 升级。

注意层次差别：这里列的是**会话/进程**（一个 `claude` 运行实例），不是会话内 Task 工具起的子 agent。

### 2.2 可用的子 agent 定义（不是实例）

- `Query.supportedAgents(): Promise<AgentInfo[]>` → `{ name, description, model? }`（`sdk.d.ts:2324`、`:97-110`）。
- `init` 消息带 `agents?: string[]`（只有名字，`sdk.d.ts:4083`）。
- `SDKControlInitializeResponse.agents: AgentInfo[]`（`:3269`）。
- `AgentDefinition`（`:38-92`）里有 `background?: boolean`——「invoked as a background task (non-blocking, fire-and-forget)」；这是**定义**层的能力开关。

### 2.3 会话内正在跑的子 agent / 后台任务：流事件

四种，全部 `type: 'system'`：

| subtype | 关键字段 | 位置 |
|---|---|---|
| `task_started` | `task_id`、`tool_use_id?`、`description`、`subagent_type?`、`task_type?`、`workflow_name?`、`prompt?`、`skip_transcript?` | `sdk.d.ts:4158` |
| `task_progress` | + `usage{total_tokens,tool_uses,duration_ms}`、`last_tool_name?`、`summary?` | `:4136` |
| `task_updated` | `patch{status: pending\|running\|completed\|failed\|killed\|paused, description?, end_time?, error?, is_backgrounded?}` | `:4182` |
| `task_notification` | `status: completed\|failed\|stopped`、`output_file`、`summary`、`usage?` | `:4118` |

- **终止**只有 `task_notification`（没有 `task_completed`）。
- `skip_transcript: true` 表示「环境/杂务任务」——SDK 注释建议这类**不要进内联记录**，但可以进任务面板。
- 我们 bundle 的 CLI 里这些字符串都在：`task_started` 17 处、`task_progress` 17、`task_updated` 16、`task_notification` 25。

### 2.4 每 turn 结束的权威快照：Stop hook 的 `background_tasks`

```ts
// sdk.d.ts:123-154
type BackgroundTaskSummary = {
  id: string;
  type: string;          // 'shell' | 'subagent' | 'monitor' | 'workflow'（未知类型回落为原始判别值）
  status: string;
  description: string;
  command?: string;      // 仅 shell
  agent_type?: string;   // 仅 subagent
  server?: string; tool?: string;  // 仅 monitor / MCP task
  name?: string;         // 仅 workflow
};
```

- 出现在 `StopHookInput.background_tasks?`（`sdk.d.ts:6347`）和 `SubagentStopHookInput.background_tasks?`（`:6388`）。
- **我们已经在装 Stop hook**（现在只用它读 `session_crons`，`claudeRemote.ts:281-292`），CLI 二进制里 `background_tasks` 与 `session_crons` 就在相邻位置——所以这份快照是白捡的。
- 这是唯一「一次拿全」的地方：**turn 结束时点**，正是我们要判断「这个 turn 到底还有什么在跑」的时刻。

### 2.5 工具层

- `Monitor`：`MonitorInput{description, timeout_ms, persistent, command|ws}` → `MonitorOutput{taskId, timeoutMs, persistent?}`（`sdk-tools.d.ts:2495`、`:3273`）。
- 后台 bash：`BashInput.run_in_background?: boolean`（`:475`）。
- 异步子 agent：`AgentInput{description, prompt, subagent_type?, run_in_background?, name?, mode?, isolation?: 'worktree'|'remote'}`（`:411-448`）；输出 `status: 'async_launched'` 时带 **`outputFile`**（可以直接读输出，不必等通知）；`status: 'remote_launched'` 带 `taskId`/`sessionUrl`。

### 2.6 子 agent 的痕迹（离线可读）

- `listSubagents(sessionId)` / `getSubagentMessages(sessionId, agentId)`（`sdk.d.ts:949`、`:736`）。
- 约定路径：`~/.claude/projects/<dir>/<sessionId>/subagents/agent-<agentId>.jsonl`（`:942-943`）。
- 渲染用开关：`Options.forwardSubagentText`（把子 agent 的 text/thinking 以 `parent_tool_use_id` 转发，`:1563`）、`Options.agentProgressSummaries`（子 agent 每 ~30s 的 AI 进度摘要，`:1724`）。

---

## 3. 现状与「turn 卡住」的机理（我们自己的代码）

### 3.1 那段防护是死的

`claudeRemote.ts:354-359` 维护 `liveBackgroundTasks`，唯一填充点在 `:483-489`：

```ts
if (message.type === 'system' && subtype === 'background_tasks_changed') {
    liveBackgroundTasks.clear();
    for (const task of tasks ?? []) liveBackgroundTasks.add(task.task_id);
```

**我们这版 CLI（bundle 2.1.195）根本不发 `background_tasks_changed`**——二进制里该字符串出现 **0 次**。于是：

- 集合恒为空 → `:619-623` 的「result 到达但仍有后台任务 → `stopDeferred = true; continue`」**永远不触发**；
- 旁边 `:491-495` 的注释恰恰描述了它想防的 bug（任务结束却没有后续消息 → 集合永不排空 → deferred stop 一直等一个已经结束的任务）。这段注释现在的处境是：**防的东西不再是这条路造成的，而防护本身不生效**。

### 3.2 「turn 结束了又忙碌」从哪来

- `result` 到达时 `updateThinking(false)`（`:558`），但**turn 信封不是这时关的**：`closeClaudeSessionTurn` 由 launcher 在 `claudeRemote()` **返回**后调用（`claudeRemoteLauncher.ts:765`、`:771`）。
- 后台任务完成时，CLI 会把它**当成新的 user turn** 灌回来：`:564-575`（`updateThinking(true)`，并把 `Task completed.` / 任务摘要 push 成一条 user 消息，`:550`）。
- App 侧 busy 只来自 `keepAlive(thinking)`（`session.ts:90-93`、`apiSession.ts:1885-1902`），并且 `apiSession.ts:1893-1895` 已经记着：volatile 的 thinking 标志在 WSS 抖动时会丢（true 丢了 → App 卡 idle；false 丢了 → 卡 thinking）。

合起来就是你看到的现象：**turn 看起来结束了，会话又转入忙碌，而且没有任何地方说明在等什么**——用户发消息时撞上这个状态，操作不清晰。

---

## 4. 计划

### P0 — CLI：让「还有什么在跑」有权威来源（最小闭环）

- Stop hook 里读 `input.background_tasks`，不再依赖 `background_tasks_changed`；集合由 `background_tasks`（权威重扫）+ `task_started`（新增）+ `task_notification`（移除）共同维护。
- `turn-end` 信封带上任务摘要（id / type / description / status）。
- 验收：日志出现快照行；App 的 turn 记录里能读到任务列表；deferred-stop 逻辑不再依赖一个不存在的消息。

### P1 — CLI：turn 状态可解释（不再无限转圈）

- `result` 一到就结束 turn、`thinking=false`；把「还有 N 个后台任务」作为**状态**交给 App，而不是继续挂住。
- 任务完成仍走现有的「新 turn」路径（agent 需要反应）——但它此时是一个**有起因**的 turn，而不是莫名忙碌。
- 真需要立即停：用 `Query.stopTask(taskId)` / `backgroundTasks()`，不要靠 `STREAM_CLOSE_GRACE_MS = 10_000` 的硬 abort。
- 验收：有后台任务时 App 不再无限 loading；turn 结束后仍有「等待中」的说明；会话不会进入「活着但对消息聋」的状态。

### P2 — App：把任务/agent 显出来

- 会话内任务列表（来自 P0 的摘要 + 实时事件），区分 `skip_transcript` 的杂务任务。
- 顶栏/机器面板接 `claude agents --json` 的 `status`（busy/idle）。
- 可选：嵌套子 agent 渲染（`forwardSubagentText` + `agentProgressSummaries`）。

### P3 — 可选：机器级 agent 视图

daemon 定期跑 `claude agents --json --cwd <project>` 汇总，作为机器状态的一部分上报；跨机器可见。

---

## 5. 决策点（要你定）

1. **接受「turn 提前结束 + 任务完成再开新 turn」吗？** 这是 P1 的核心，代价是同一段工作在 UI 上可能表现为两个 turn。
2. **P2 做到哪一层**：只做任务列表，还是连嵌套子 agent 的实时渲染一起（后者会明显放大流量，`forwardSubagentText` 会转发子 agent 的全部文本）。
3. **P3 要不要**：机器级 agent 面板需要 daemon 周期性调 CLI（成本/权限都要定）。

---

## 6. 风险与注意

- **版本差异**：`package.json` 声明 `^0.3.187`，实际装的是 `0.3.195`；手装 CLI 是 `2.1.287`，bundle 是 `2.1.195`。本文用到的能力我在两版 CLI 上都核过（`agents --json`、四种 task 事件、Stop hook 的 `background_tasks`）；但**再新/再旧**的版本要重新核。
- `background_tasks_changed` 在 bundle CLI 里为 0，但**新版本可能又有**——实现时应两者兼容（有快照就用快照，有增量就用增量），不要二选一。
- `task_updated.patch` 是**增量**，需要合并进本地 map，不能当成全量。
- `Monitor` 的 `persistent: true` 没有超时，只受 `TaskStop` 控制——这类任务如果出现在快照里，需要 App 有显式「停止」入口。
- 不要为了拿列表去轮询 CLI 进程（成本、权限、以及把「读状态」变成「起进程」）。

---

## 7. 复现命令与索引（都是本机实测）

```bash
# 活跃 agent 列表
claude agents --json
claude agents --help          # --json / --all / --cwd
# 我们 bundle 的 CLI 是否也有
packages/happy-cli/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude agents --help

# 「我们这版不发 background_tasks_changed」的证据
strings -a <bundle cli> | grep -c background_tasks_changed   # 0
strings -a <bundle cli> | grep -nE '^background_tasks$|^session_crons$'  # 相邻出现
```

代码索引：`claudeRemote.ts:354-359`（集合）、`:483-489`（唯一填充点）、`:491-502`（注释与任务结束清理）、`:543-553`（任务完成当新 turn 灌回）、`:619-623`（defer 分支）、`claudeRemoteLauncher.ts:765/771`（turn 信封在这关）、`session.ts:90-93` + `apiSession.ts:1885-1902`（App 的 busy 来源）。
