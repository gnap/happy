# 会话 cmmsuq8nnb5rwxe1405dqixa8 (PID 84473) 退出原因排查

## 1. 结论摘要

- **进程 84473** 在 **2026-03-17 19:47:46 ~ 19:47:59** 之间被终止，daemon **未收到**子进程的 `exit` 事件，仅在一次心跳中发现 PID 已不存在，故记录为 `evicted (pid missing — detected in heartbeat)`。
- ** spawn 方式**：**常规进程**（`Using regular process spawning`），**非 tmux**，故 84473 是 daemon 的**直接子进程**；按常理子进程退出时父进程应收到 `exit`，本次未收到，属异常。
- **根因**：无法从日志或系统侧拿到确切 exit code/signal；结合“静默消失 + 父进程未收 exit”，最可能为 **SIGKILL（如 OOM 或外部 kill -9）** 或 **机器休眠/合盖** 等系统行为，在少数情况下可能导致父进程未收到 SIGCHLD/exit。

---

## 2. 时间线

| 时间 | 事件 |
|------|------|
| 2026-03-16 15:18:01 | daemon (PID 80134) 使用 **regular process spawning** 启动会话，PID 84473 |
| 2026-03-17 19:47:46 | 会话日志最后一行：`[API] flushOutbox: sent 8 message(s) to server`，无 error/exit |
| 2026-03-17 19:47:59 | daemon 在一次 **heartbeat** 中发现 84473 已不存在，写入 evicted，exitTime=1773748079143 |
| 2026-03-17 20:06:54 | daemon 80134 收到 **SIGTERM**（如 launchctl 重启），正常 shutdown |

说明：84473 的退出早于 daemon 的 SIGTERM，故不是“daemon 被 kill 导致子进程一起没”的情况。

---

## 3. 证据与逻辑

### 3.1 spawn 方式

- daemon 日志：`[15:18:01.250] [DAEMON RUN] Using regular process spawning`，随后 `Spawned process with PID 84473`。
- 未出现 `Attempting to spawn session in tmux`，故 **非 tmux**；84473 为 daemon 80134 的**直接子进程**。

### 3.2 未收到 exit 事件

- `run.ts` 中对 `happyProcess.on('exit', ...)` 会打：`[DAEMON RUN] Child PID ${pid} (session ${sessionId}) exited: code=... signal=...`。
- 在 daemon 日志中**无** “Child PID 84473 exited” 记录（若未开 DEBUG，该行为 debug 级别，可能不落盘，但至少说明没有在“收到 exit 后”走正常退出路径）。
- 最终该会话是以 **heartbeat 中发现 PID 丢失** 的方式被移入 stoppedSessions，并写上 `evicted (pid missing — detected in heartbeat)`，且 persisted state 中**无** `exitCode`/`exitSignal`，与“从未收到 exit”一致。

### 3.3 heartbeat 如何发现“进程没了”

- 每约 60s 的 `restartOnStaleVersionAndHeartbeat` 中会遍历 `pidToTrackedSession`，对每个 pid 执行 `process.kill(pid, 0)`。
- 若发现 84473 已不存在，则：
  - 设置 `session.exitReason = 'evicted (pid missing — detected in heartbeat)'`
  - 设置 `session.exitTime`，并 persist、移入 stoppedSessions。
- 因此 **19:47:59** 对应的是“某次心跳发现 84473 已消失”的时间，真实退出时间在 **19:47:46（最后一条会话日志）到 19:47:59 之间**。

### 3.4 为何父进程可能没收到 exit

- 理论上，直接子进程退出（含 SIGKILL）应触发 SIGCHLD，Node 的 child_process 应收到 `exit`。
- 可能情况包括：
  1. **SIGKILL（如 OOM killer）**：内核杀进程，父进程通常仍会收到 SIGCHLD，但在高负载/极端情况下存在未交付或延迟的少数报告。
  2. **机器休眠/合盖**：macOS 对部分进程在 sleep 时的行为可能导致进程被终止且父进程未及时或未收到通知。
  3. **外部 `kill -9 84473`**：若发生在非常短的时间窗口内，与上述类似。
  4. **Node/平台边缘情况**：理论上存在极少数未收到 exit 的 bug，无法从当前日志证实或排除。

综合“会话日志无任何 error、进程静默消失、父进程仅通过心跳发现”这些现象，**最合理的推断是进程被系统或外部强制终止（SIGKILL/休眠等）**，在个别情况下父进程未收到 exit。

---

## 4. 改进建议（可选）

1. **evict 时尽量保留一点上下文**  
   - 在发现 pid 丢失并写入 `evicted (pid missing — ...)` 时，若环境支持（如 Linux /proc），可尝试读取一次该 pid 的 exit 状态再 reaped（若还能读到），再 persist；macOS 上无 /proc，可忽略或只记“evicted at …”。

2. **heartbeat/evict 路径增加 info 级日志**  
   - 例如：当把某 session 因 pid missing 移入 stoppedSessions 时，打一条 `[DAEMON RUN] Evicted session ${sessionId} PID ${pid} (pid missing in heartbeat)`，便于以后不依赖 DEBUG 也能在日志里看到 evict 时刻。

3. **会话进程侧**  
   - 在 session 进程内对 `SIGTERM`/`SIGINT` 做友好 shutdown，并调用 daemon 的 session-ending webhook，带上 reason/exitCode，这样即使后续被 SIGKILL，至少正常退出时 daemon 能拿到明确原因。

---

## 5. 相关文件与位置

- daemon spawn / exit 处理：`packages/happy-cli/src/daemon/run.ts`（spawn 约 570–620 行，child `.on('exit')` 约 661–669 行，heartbeat 中 evict 约 1058–1072 行）。
- 会话日志：`~/.happy/logs/2026-03-16-15-18-01-pid-84473.log`（最后活动 19:47:46）。
- daemon 日志：`~/.happy/logs/2026-03-16-14-47-29-pid-80134-daemon.log`（15:18  spawn 84473，20:06:54 收到 SIGTERM）。
