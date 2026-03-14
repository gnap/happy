# Cursor CLI 会话调试一览

## 当前在跑的 CLI 进程（cursor）

| PID   | 命令/路径 | 说明 |
|-------|-----------|------|
| 47231 | main-repo `dist/index.mjs cursor` | 主仓库已编译 |
| 10891 | main-repo `dist/index.mjs cursor` | 主仓库已编译 |
| 21212 | worktree ios `tsx src/index.ts cursor` | iOS worktree 开发模式 |
| 90808 | worktree ios `dist/index.mjs cursor` | iOS worktree 已编译 |
| 44403 | main-repo `dist/index.mjs cursor` | 主仓库已编译 |
| 47229 | main-repo `node ./bin/happy.mjs cursor` | 主仓库 bin |
| 59000 | main-repo `tsx src/index.ts cursor` | 主仓库开发模式 |

另有 59017 为 daemon（`daemon start-sync`），不是会话。

**结论：同时有 6～7 个 cursor 会话进程在跑。**  
每个进程启动时会创建或加载一个 session，所以 App 里会看到多笔会话。

---

## 今天（2026-02-25）日志里出现过的会话 ID

每个「Session created/loaded」对应一次 CLI 启动，对应 App 里的一条会话（或复用已有会话）。

| Session ID | 日志文件 (pid) | 备注 |
|------------|----------------|------|
| cmm1qjkwrpvr5yn145wjx22zr | 15-51-00-pid-47350 | 最近一次我们启动的 |
| cmm1qizt2ptv8yn144iqxfbet | 15-50-30-pid-47231 | |
| cmm1q635golmgyn145fi4u6gq | 15-40-38-pid-44403 | |
| cmm1q93l5ownyyn14n6aojtyw | 15-42-56-pid-45278 | |
| cmm1ptde9n8szyn148g0qf3my | 15-30-46-pid-41531 | |
| cmm1pmw9emho8yn148sbuuxrj | 15-25-43-pid-39977 | |
| cmm1m1mtq92m8yn14ectli0oi | 13-45-13-pid-10891 | |
| cmm1hn7knrvteyn14dcc2aj7n | 12-21-45-pid-90808, 11-42-00-pid-78817 | 两进程同一 session |
| cmm1na926dytjyn14xhlfzfs8 | 14-19-54-pid-21216 | |
| cmm0at4a47ghcyn14ayu7i487 | 00-53-16-pid-68548 | |

**不重复的 session 数：约 10 个**（今天日志里出现的）。

App 里的「N 个」会话 = 这些历史会话都会列在列表里（服务端/本地列表），不一定每个都还有 CLI 在连。

---

## 为什么这次「完全没有消息、也没有 thinking」

- 你在 App 里点的很可能是**其中某一个会话**（例如 `cmm1qjkwrpvr5yn145wjx22zr`）。
- 但**真正还在跑、并且收你消息的**是**某一个** CLI 进程；服务端会把「新消息」推给**当前连上该 session 的那个 CLI**。
- 若有**多个 CLI 同时连了不同（或同一）session**，或你点的会话已经**没有 CLI  attached**，就会出现：
  - 消息发到 A 会话，但你看的是 B 会话；或
  - 该会话没有活跃 CLI，所以没有任何回复/thinking。

所以：**会话数 = 多个；真正在收消息的 = 当前连上该 session 的那一个 CLI。**

---

## 建议操作（方便复现「一条会话」）

1. **先关掉所有 cursor 会话进程，只留一个**（在终端里对每个跑着 `happy cursor` 的窗口 Ctrl+C，或）：
   ```bash
   pkill -f "happy.mjs cursor"
   pkill -f "dist/index.mjs cursor"
   # 若用 tsx：pkill -f "tsx src/index.ts cursor"
   ```
2. **只起一个 cursor**：
   ```bash
   cd /Users/gnap/Projects/happy-coder/packages/happy-cli && node ./bin/happy.mjs cursor
   ```
3. 看终端里打印的 **Happy Session ID**，在 App 里**只进这个 ID 对应的那条会话**发消息，这样就能确定「一个 CLI ↔ 一个会话」，方便看有没有消息/thinking。

这样 App 里仍然会显示 N 条历史会话，但**只有刚起的这一条**背后有 CLI 在跑并会回复。

---

## 调试约定：只保留一个会话

- **只调试一个会话**：要么复用当前这一个，要么先杀掉再起新的，不要同时跑多个 cursor CLI。
- 起新会话前先清掉旧的：
  ```bash
  pkill -f "dist/index.mjs cursor"
  pkill -f "happy.mjs cursor"
  pkill -f "tsx src/index.ts cursor"
  ```
  再起一个：`cd packages/happy-cli && node ./bin/happy.mjs cursor`

---

## cursor-agent 在干嘛？有它的日志吗？

- **cursor-agent 没有单独日志文件**。我们通过 CursorProcess 拉起的子进程，只把它的 **stdout**（按行解析成 stream-json）和 **stderr** 接进我们的 CLI。
- **我们的 CLI 日志**（`~/.happy/logs/`）里会看到：
  - `[CursorBackend] stream msg type: <type>`：cursor-agent 发的每条流消息类型（system / user / thinking / assistant / result 等）
  - `[cursor] stderr: ...`：cursor-agent 的 stderr（已过滤 `tcgetattr` / `ioctl` 等 script 噪音）
- **~/.cursor/projects/.../worker.log** 是 Cursor IDE 的 project worker（LSP、索引等），**不是** cursor-agent CLI 的日志。
- **想看更细的 cursor-agent 行为**：起会话时加环境变量  
  `CURSOR_AGENT_VERBOSE=1`，例如：  
  `CURSOR_AGENT_VERBOSE=1 node ./bin/happy.mjs cursor`  
  会在同一 CLI 日志里多打 `[cursor-agent] type=...` 和 `[cursor-agent stderr] ...`（stderr 不再过滤），便于排查它在干嘛。

---

## 一句「你好」不该等太久

- 若回复明显变慢，多半是 **script 把 stdout 缓冲了**（我们读的是 script 的 pipe，不是 TTY）。
- **先试无 PTY**（不经过 script，直接跑 cursor-agent）：
  ```bash
  CURSOR_AGENT_NO_PTY=1 node ./bin/happy.mjs cursor
  ```
  若这样回复明显变快，说明是 script 缓冲导致的；若 cursor-agent 不输出或报错，说明它需要 TTY，只能继续用 script。
- 已默认加 **`PYTHONUNBUFFERED=1`**，若 cursor-agent 是 Python 会减少自身缓冲。
