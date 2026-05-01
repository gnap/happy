# Gotchas

## stable:daemon:stop && start 不一定真的换了进程
- `yarn workspace happy-coder stable:daemon:stop && stable:daemon:start` 在某些情况下，新 daemon 和旧 daemon PID 相同（408510），说明 stop 后 start 启动的是同一个进程实例
- 验证方法：检查 `daemon.state.json` 里的 `pid` 字段，以及 `/root/.happy/logs/` 里最新的 `*-daemon.log` 文件名

## daemon 对继承进程（跨重启存活）无法即时检测死亡
- daemon 自己 spawn 的进程：通过 `child.on('exit')` 立即感知死亡（包括 SIGKILL）
- 跨 daemon 重启存活的进程：只有 30s 心跳 webhook，daemon 靠 60s PID 轮询检测，最坏情况延迟 ~90s
- 日志特征：`evicted (pid missing — no exit event received)` 表示是轮询检测到的，不是 exit 事件

## cursor 会话 30s "Session started" 日志不是重启循环
- daemon 日志里每 30 秒出现 `[CONTROL SERVER] Session started: <sessionId>` 且 PID 不变，是 `runCursor.ts` 里 `setInterval(reportToDaemon, 30_000)` 发出的心跳
- 不是进程崩溃重启，是正常的 liveness 汇报机制

## MessageQueue2 有消息入队但没有触发 cursor-agent spawn 的情况
- 观察到 06:24:11 消息入队（Queue size: 1），但随后 socket 断开（06:24:42 ping timeout），重连后队列没有被重新触发消费
- 消息永久卡在内存队列里，进程还在跑但该消息永远不会被处理
