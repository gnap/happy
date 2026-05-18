# Issues

## CLI 进程被 SIGKILL 后的检测与恢复

**背景**：SIGKILL 无法被捕获，signal handler 和 finally 块都不执行，进程直接消失。  
**现状**：
- daemon 自己 spawn 的进程通过 `child.on('exit')` 立即检测
- 跨重启继承的进程靠 60s PID 轮询，最坏 ~90s 才发现
- 服务端依赖 WebSocket 断线感知，但 App 侧缺乏及时反馈

**分析结论**：
- 不能依赖 daemon（daemon 本身也会重启）
- 需要独立于 daemon 的检测机制

**候选方案**：
1. **sidecar 进程**：session 启动时 spawn 轻量 watcher（`tail --pid`），daemon 重启不影响它
2. **POSIX flock 死亡开关**：session 持锁，死后 OS 自动释放，任何人可检测
3. **服务端 WebSocket 断线**：完全不依赖 CLI 侧，但需服务端主动处理

**死亡原因诊断分类**（决策 recovery 策略）：
- `signal=SIGKILL` + dmesg OOM → 内存压力，重启安全
- `signal=SIGKILL` 无 OOM → 外部强杀，重启安全
- `signal=SIGSEGV` / 多次崩溃 → 可能是 bug，限制重启次数
- 长时间无活动后死亡 → 进程 hang，重启 + 上报
- exit code 0 → 正常退出，不应重启

**下一步**：用 tmux 挂到进程退出现场做实地分析，再决定实现方案

## socket 断线后 MessageQueue 不重新消费的问题
- 复现路径：消息入队 → socket 断开 → socket 重连 → 队列不被触发
- 需要排查 `MessageQueue2` 的消费逻辑是否在重连后重新触发
