# 同步到 feature/cursor-agent 的「仅 CLI 修改」清单

目标：让 **feature/cursor-agent** 只包含 CLI 相关改动，不包含 App/其他包的修改。

**对比基准**：`origin/feature/cursor-agent`（已合并进本分支一次，当前 diff = 本分支在 cursor-agent 之上的增量）

---

## 1. 与 feature/cursor-agent 的差异概览（合并后重新对比）

当前分支 **HEAD** 相对 **origin/feature/cursor-agent** 在 `packages/happy-cli/` 的**文件级差异**共 **7 个文件**：

| 路径 | 本分支改动要点 | 分类 |
|------|----------------|------|
| ~~index.ts~~ | **已恢复**：`happy cursor` 保持走 runCursor（feature/cursor-agent 设计）；ACP cursor 仍为「happy acp cursor」单独路径，与 runCursor 解耦。 | — |
| `packages/happy-cli/src/api/apiSession.ts` | 去掉 socketConnectedResolve、connect 后首次 receiveSync.invalidate；updateMetadata 不等待 15s 直接抛错（**已保留 404 重试 + flush warn**） | 连接/元数据 |
| `packages/happy-cli/src/api/types.ts` | usage-report 参数 `callback` → `ack`，类型微调 | 类型 |
| `packages/happy-cli/src/cursor/cursorProcess.ts` | 默认加 `--force` 参数 | Cursor 进程 |
| `packages/happy-cli/src/cursor/cursorQuotaFetcher.ts` | 上报 payload 结构（tokens 含 plan_used/plan_limit），与 key 对齐；删注释 | 用量上报 |
| `packages/happy-cli/src/cursor/runCursor.ts` | 回复双通道(codex+session)、task_started+flush、thinking 推 App、lazyResult 类型 | Cursor 会话 |
| `packages/happy-cli/src/agent/acp/AcpSessionManager.ts` | tool-result 的 result：string 时包装为 `{ content: raw }` 以满足 createEnvelope 类型 | ACP 类型修复 |

**说明**：合并时已保留 cursor-agent 的 404 重试与 flush 失败 warn，故 apiSession 的 diff 仅剩「不等待 socket / 不首次 poll / updateMetadata 直接抛错」。

---

## 2. Review 重新对比（按特性）

### 2.1 ACP 相关（index.ts）

- **改动**：`happy cursor` 从 `runCursor()` 改为 `runAcp()` + `CursorBackend({ cwd: process.cwd() })`，与 `happy acp cursor` 共用 runAcp 的 session/消息/权限/重连。
- **行为变化**：
  - **`--cwd` / workspaceRoot**：仍解析，但未传入 runAcp/CursorBackend，**实际未生效**（始终用 `process.cwd()`）。
  - **`--resume` / -r**：仍解析，但 runAcp 不接 resume，**实际未生效**（每次新 sessionTag）。
- **建议**：若要保留 --cwd/--resume，需在 index 里把 workspaceRoot 传给 CursorBackend、并实现 runAcp 或上层的 resume 逻辑；否则从 help 中移除或注明废弃。

### 2.2 apiSession.ts

- **已保留（来自 cursor-agent）**：404 在 FLUSH_RETRY_STATUSES、flush 失败时的 warn。
- **本分支额外改动**：去掉 socket 连接后的 Promise resolve、connect 后不再主动 invalidate 拉一次、updateMetadata 在未连上时直接 throw 不等待 15s。

### 2.3 runCursor.ts

- **回复**：flushAccumulatedText 时同时发 codex `message` + session protocol 的 agent text，并 `await session.flush()` 前发 task_started。
- **Turn 开始**：发 codex task_started + session turn-start，再 flush，便于 App 计时/“思考中”。
- **Thinking**：thinking_delta 时向 App 推 codex thinking + session 的 agent text (thinking: true)。
- **类型**：maybeLazyEncodeResult 视为 `Record<string, unknown>`。

### 2.4 cursorQuotaFetcher.ts

- 上报 payload 的 `tokens` 显式含 `plan_used`、`plan_limit`，与约定 key 对齐；删除多余注释。

### 2.5 其余

- **cursorProcess.ts**：spawn 时默认加 `--force`。
- **types.ts**：usage-report 的 ack 参数名与类型。
- **AcpSessionManager.ts**：tool-result 为 string 时包装为 `{ content: raw }` 以通过 createEnvelope 类型。

---

## 3. 建议的同步方式

合并后 cursor-agent 已含 404 重试与 flush warn，本分支的 apiSession diff 不再冲掉它们。可按需选择：

### 方式 A：同步全部 7 个文件（与当前分支 CLI 一致）

```bash
git checkout feature/cursor-agent
git pull origin feature/cursor-agent

git checkout wip/device-debug-cache -- \
  packages/happy-cli/src/agent/acp/AcpSessionManager.ts \
  packages/happy-cli/src/api/apiSession.ts \
  packages/happy-cli/src/api/types.ts \
  packages/happy-cli/src/cursor/cursorProcess.ts \
  packages/happy-cli/src/cursor/cursorQuotaFetcher.ts \
  packages/happy-cli/src/cursor/runCursor.ts \
  packages/happy-cli/src/index.ts

git status
git add -A && git commit -m "sync(cli): cursor ACP entry, runCursor/app push, quota payload, --force, usage ack, AcpSessionManager result type, apiSession socket/metadata behavior"
git push origin feature/cursor-agent
```

### 方式 B：只同步 6 个文件（不动 apiSession）

若希望 cursor-agent 保留「等待 socket / 首次 poll / updateMetadata 等 15s」行为，仅不拿 apiSession.ts，其余 6 个文件同上（去掉 apiSession 那一行即可）。

### 方式 C：按提交 cherry-pick（仅限纯 CLI 提交）

下面这些提交**只动 happy-cli（及少量 docs/root）**，可以整提交 cherry-pick 到 feature/cursor-agent（可能需解决冲突）：

| 提交 | 说明 | 涉及文件（仅 CLI/root） |
|------|------|-------------------------|
| `f9aa3e22` | Cursor IDE quota fetch and report | apiSession, cursorQuotaFetcher, cursorQuotaPaths, runCursor, docs |
| `04386e56` | wait for socket before quota report | runCursor.ts |
| `f528cef7` | usage-report ack callback | apiSession.ts, docs |
| `c050366a` | align cursor quota report key names | cursorQuotaFetcher.ts |
| `0f530922` | cursor quota timing and plan limit parsing | cursorQuotaFetcher.ts, runCursor.ts |
| `fae1b6f1` | unified diff @@ headers | apiSession.ts, package.json, yarn.lock |
| `f8621ef8` | persist diffString | apiSession.ts |
| `751bd0f8` | recompute diffString after truncation | apiSession.ts |
| `44a2c4b3` | lazy-encode large Cursor tool content | apiSession, types, registerKillSessionHandler |
| `185c5ee4` | 同上（另一笔） | apiSession, registerKillSessionHandler |
| `21421f1d` | lazy-encode Cursor tool results | apiSession, runCursor |
| `4ea8a0c5` | 同上 | apiSession, runCursor |
| `5a649a73` / `848a69c6` | skip redundant machine reg, parallelize session init | runAcp, runClaude, runCodex, runCursor, runGemini |

**注意**：含 `packages/happy-app` 的提交（如 `5e032e14`、`3ee0e38d`）不要整提交 cherry-pick，否则会把 App 改动带过去；若要其 CLI 部分，用方式 A 只同步对应文件。

---

## 4. 涉及功能摘要（方便 code review）

- **cursorQuotaFetcher / runCursor**：quota 上报时机、等 socket 再报、plan/on-demand limit 解析、key 与 cursor-agent 对齐。
- **apiSession**：lazy-encode 大块 Cursor tool 结果、compact/full diff、diffString 持久化、usage-report ack。
- **index**：入口/参数与 cursor 相关的小改动。
- **cursorProcess**：小改动（如一行注释或兼容）。
- **types**：与 apiSession 配套的类型。

---

## 5. 不建议同步到 cursor-agent 的内容

- 所有 **packages/happy-app/** 的修改（UI、usage 展示、sync、i18n 等）。
- **yarn.lock**（除非你在 cursor-agent 分支也跑 `yarn` 并接受 lockfile 变更）。
- **Merge 提交**（7352dfd2、5a18baec 等）不要 cherry-pick，会带进整棵分支历史。

按 **方式 A** 或 **方式 B** 做一次即可让 feature/cursor-agent 与当前分支的 CLI 修改对齐（或仅对齐除 apiSession 外的部分）。
