# 特性 1：Session 连接与元数据（逐段看）

仅涉及 **apiSession.ts**，共三处改动。

---

## 1. connect 时不再 resolve Promise

**原逻辑（cursor-agent）：**
```ts
this.socket.on('connect', () => {
    logger.debug('Socket connected successfully');
    this.socketConnectedResolve?.();   // ← 让「等 socket 连上」的 Promise 完成
    this.socketConnectedResolve = undefined;
    this.stopFallbackPoll();
    this.rpcHandlerManager.onSocketConnect(this.socket);
    this.receiveSync.invalidate();
});
```

**当前（本分支）：**
- 去掉了 `socketConnectedResolve?.()` 和 `undefined` 赋值。
- `connect` 里仍会 `receiveSync.invalidate()`，所以**连上后仍会触发一次拉消息**。

**影响：**
- `socketConnectedPromise` 永远不会被 resolve。
- 唯一等这个 Promise 的地方是 **updateMetadata**（见下）；改成「不等待」后，这两行 resolve 就没人用了，变成死代码。

---

## 2. connect() 后不再主动拉一次

**原逻辑（cursor-agent）：**
```ts
this.socket.connect();

// Trigger an initial HTTP poll so we get any messages already on the server
// (e.g. user sent from App before socket connected). Otherwise we only fetch
// after socket 'connect' or after connect_error (fallback poll every 8s),
// so new sessions can appear unresponsive.
this.receiveSync.invalidate();
```

**当前（本分支）：**
- 去掉了 `this.receiveSync.invalidate()`。
- 拉消息只会在：
  - `connect` 事件里执行一次 `receiveSync.invalidate()`，或
  - fallback poll（每 8s）时执行。

**影响：**
- 若 socket 很快连上，`connect` 里的 invalidate 会触发一次 fetch，和「connect 后再 invalidate 一次」效果接近。
- 若 socket 连得慢或先连后断，少一次「刚 connect() 就拉」的时机，新会话可能稍晚一点才拉到「App 先发的消息」；最差多等一个 fallback 周期（8s）。

---

## 3. updateMetadata：未连上时直接 throw，不再等 15s

**原逻辑（cursor-agent）：**
```ts
if (!this.socket.connected) {
    const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Session real-time disconnected; ...')), 15_000)
    );
    await Promise.race([this.socketConnectedPromise, timeout]);
}
```

**当前（本分支）：**
```ts
if (!this.socket.connected) {
    throw new Error('Session real-time disconnected; title update requires WebSocket (check network / HAPPY_SERVER_URL)');
}
```

**谁在调 updateMetadata：**
- runCursor：hostPid、permission/model 等，都是 `.catch(...)` 不 await。
- runAcp、runClaude、runCodex、runGemini：有 await 的（如 session 结束时写 lifecycleState），也有 fire-and-forget 的。

**影响：**
- **未连上时**：updateMetadata 立刻 reject，调用方若是 `.catch()` 就只打日志，不崩；若是 await 且未 catch 会抛错。
- **典型场景**：会话刚建好、socket 还没连上时就调了 hostPid / mode 等，这些会失败一次，日志里能看到；等 socket 连上后，后续的 updateMetadata（例如下一轮消息里改 mode）会成功。
- 不再出现「为了一次 metadata 更新等最多 15s」的阻塞。

---

## 死代码（可选清理）

当前仍保留：

- 第 187–188 行：`socketConnectedPromise`、`socketConnectedResolve` 声明
- 第 355–357 行：`this.socketConnectedPromise = new Promise(...)`，`this.socketConnectedResolve = resolve`

已无任何地方 await 或 resolve，可整块删除，减少噪音。

---

## 小结

| 改动 | 行为变化 | 建议 |
|------|----------|------|
| 1. connect 不 resolve | 无人再等「已连接」Promise | 与 3 一起看，可顺带删 Promise 相关死代码 |
| 2. connect() 后不 invalidate | 少一次「立刻拉」的时机，首条可能略晚 | 若新会话「App 先发」延迟敏感，可只恢复这一行 |
| 3. updateMetadata 直接 throw | 未连上时立刻失败，不阻塞 15s；多数调用有 .catch | 保持现状即可 |

整体：逻辑一致、可接受；若要更稳可只恢复「connect() 后 invalidate」；并建议顺手删掉 socketConnected 死代码。

---

## 时序策略与影响（补充）

### 相关机制

- **receiveSync**：`invalidate()` 被调用时，会**立刻**启动一次 `fetchMessages()`（HTTP 拉服务端消息），不依赖 socket。
- **fetchMessages**：走 HTTP GET，不依赖 WebSocket；有消息就通过 `routeIncomingMessage` / `onUserMessage` 交给业务。
- **socket**：用于实时收 push、发 update-metadata 等；连上后会触发 `connect` 事件。

所以：「何时第一次拉消息」只取决于「何时第一次调用 `receiveSync.invalidate()`」。

### 时间线（典型：App 先发消息，CLI 后连）

```
T0     App 发消息到服务端
T1     CLI 建 session，new ApiSessionClient(...)
       → 构造函数里注册 connect 等回调，最后 this.socket.connect()
T2     [策略分叉]
T3     Socket 实际连上，触发 'connect'
T4     第一次 fetchMessages 完成，CLI 拿到消息并回调 onUserMessage
```

### 策略 A（cursor-agent）

- **T1 末**：`this.socket.connect()` 之后**立刻**再调一次 `this.receiveSync.invalidate()`。
- **效果**：在 T1 同一轮就触发第一次 `fetchMessages()`，和 socket 是否连上**无关**；拉消息与建连并行。
- **T3**：`connect` 里再 `invalidate()` 一次，可能触发第二次拉或刷新。
- **第一次拿到消息的时间**：约等于 **T1 + 一次 HTTP 往返**，与 socket 延迟几乎无关。

### 策略 B（当前本分支）

- **T1 末**：只调 `this.socket.connect()`，**不再**在后面调 `receiveSync.invalidate()`。
- **效果**：第一次 `invalidate()` 只会在 **T3**（`connect` 回调）里发生，第一次 `fetchMessages()` 从 T3 才开始。
- **第一次拿到消息的时间**：约等于 **T3 + 一次 HTTP 往返** = **T1 + socket 建连时间 + HTTP 往返**。

### 影响对比

| 场景 | 策略 A（cursor-agent） | 策略 B（当前） |
|------|------------------------|----------------|
| Socket 很快（几十 ms） | 首条消息 ≈ HTTP 延迟 | 首条消息 ≈ 几十 ms + HTTP 延迟，略慢一点 |
| Socket 较慢（几百 ms） | 首条消息仍 ≈ HTTP 延迟 | 首条消息多等一整段 socket 时间 |
| Socket 很慢或先失败 | 首条仍可由首次 fetch 拿到；fallback 8s 轮询兜底 | 首条要等 connect 或等 8s fallback |

结论：**策略 B 把「第一次拉消息」绑在了「socket 先连上」上**，所以会多出最多约「一段 socket 建连时间」的延迟；在弱网或服务慢时，这段可能到几百 ms 甚至更久。若希望和 cursor-agent 一致、尽快拿到 App 先发的消息，只需恢复 **connect() 后那一行 `this.receiveSync.invalidate()`**，其余（不 resolve Promise、updateMetadata 直接 throw）可保持不变。
