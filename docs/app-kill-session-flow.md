# App 侧 Kill Session 机制 Review

## 1. 入口与 session id 来源

### 1.1 入口

- **会话详情页**：`app/(app)/session/[id]/info.tsx`
  - 路由参数 `[id]` 即 session id（来自列表点击或 deep link）。
  - 用 `useSession(id)` 从 storage 取会话，`session.id` 与路由 `id` 一致。
- **活跃会话列表**：`ActiveSessionsGroup.tsx` / `ActiveSessionsGroupCompact.tsx`
  - 列表项来自 `useVisibleSessionListViewData()`，每一项里有 `session`，用 `session.id`。

两处归档都调用同一个方法：

```ts
const result = await sessionKill(session.id);
```

所以 **session id 的来源** 是：

1. 路由：`/session/[id]` 的 `id`（来自 `useLocalSearchParams()`）。
2. Storage：`storage.sessions[id]`（来自 `useSession(id)`）。

Storage 里的会话列表来自 **sync 的 fetchSessions**（见下）。

---

## 2. sessionKill 与 sessionRPC

### 2.1 ops.sessionKill

- 文件：`packages/happy-app/sources/sync/ops.ts`
- 作用：对指定 session 发一次 kill RPC，并规范成 `SessionKillResponse`。

```ts
export async function sessionKill(sessionId: string): Promise<SessionKillResponse> {
    try {
        const response = await apiSocket.sessionRPC<SessionKillResponse, {}>(
            sessionId,
            'killSession',
            {}
        );
        return response;
    } catch (error) {
        return {
            success: false,
            message: error instanceof Error ? error.message : 'Unknown error'
        };
    }
}
```

- **入参**：`sessionId` 唯一关键信息，来自 UI 的 `session.id`。
- **返回**：期望 `{ success: boolean, message?: string }`；若 RPC 抛错则走 catch，返回 `success: false`。

### 2.2 apiSocket.sessionRPC

- 文件：`packages/happy-app/sources/sync/apiSocket.ts`
- 作用：用「该 session 的加密」对 params 加密，经 socket 发 `rpc-call`，再解密 result。

关键逻辑：

1. **Session 加密**：`this.encryption.getSessionEncryption(sessionId)`  
   - 若没有该 session 的加密实例 → 抛错 `Session encryption not found for ${sessionId}`，不会发 RPC。
2. **方法名**：`${sessionId}:${method}` → 即 `cmm3ox7o45ck0yn14m82w7uqr:killSession`。
3. **params**：`await sessionEncryption.encryptRaw(params)`（killSession 为 `{}`）。
4. **发 RPC**：`this.socket.emitWithAck('rpc-call', { method, params })`。  
   - 这里用的是 **App 自己的 socket**（user-scoped），不是会话进程的 socket。
5. **收结果**：
   - `result.ok === false`（服务器层错误，如找不到目标 socket）→ 用 `result.error` 抛错。
   - `result.ok === true` → 用同一 session 的 `sessionEncryption.decryptRaw(result.result)` 解密，再返回给 sessionKill。

所以 **关键信息** 在这里是：

- **sessionId**：调用方传入，必须和 storage/路由一致。
- **session 加密**：来自 `encryption.getSessionEncryption(sessionId)`，必须已为该 session 初始化过（见下）。

---

## 3. Session 加密从哪里来（关键信息如何具备）

Session 的加解密只在「拉取会话列表并解密」时初始化，**不会**在「点归档」时再查服务器。

### 3.1 拉会话列表：fetchSessions

- 文件：`packages/happy-app/sources/sync/sync.ts` 的 `fetchSessions`。
- 触发：sync 启动时、以及之后需要刷新会话列表时（如 invalidate）。

流程概要：

1. **GET /v1/sessions**（带 Bearer token）。
2. 响应里每个 session 有：
   - `id`
   - `dataEncryptionKey`（服务端用用户公钥加密的「该 session 的数据密钥」）
   - `metadata`（用该数据密钥加密的元数据，含 hostPid 等）
3. **解密 dataEncryptionKey**：用当前用户的 master secret / 密钥派生得到 content key，再解密每个 session 的 `dataEncryptionKey` → 得到该 session 的 **dataKey**（或 null，走 legacy）。
4. **初始化 session 加密**：`await this.encryption.initializeSessions(sessionKeys)`，其中 `sessionKeys = Map<sessionId, dataKey>`。
5. 再用这些 dataKey 解密每个 session 的 metadata/agentState，写入 storage（含 `session.id`、`session.metadata` 等）。

因此：

- **sessionId**：来自服务器返回的 session 列表里的 `id`，经解密后写入 storage，UI 的 `session.id` 就是它。
- **Session 加密**：只有在 fetchSessions 成功、且该 session 的 `dataEncryptionKey` 能解密时，才会在 `encryption.sessionEncryptions` 里有一项 `sessionId -> SessionEncryption`。
- 若某 session 从未出现在「当前用户拉取过的会话列表」里，或解密失败被 skip，则 `getSessionEncryption(sessionId)` 为 null，**无法发 killSession RPC**（会先抛 "Session encryption not found"）。

---

## 4. 服务器侧：rpc-call 与转发

- 文件：`packages/happy-server/sources/app/api/socket/rpcHandler.ts`

### 4.1 会话进程如何被「认作」某 session

- 会话进程（CLI）连上服务器时，auth 里带 `clientType: 'session-scoped'` 和 `sessionId`。
- 连接建立后，CLI 会发 `rpc-register`，例如 `{ method: 'cmm3ox7o45ck0yn14m82w7uqr:killSession' }`。
- 服务器在 **同一 userId** 下维护 `rpcListeners: Map<method, Socket>`，把该 socket 登记为 `sessionId:killSession` 的 target。

### 4.2 App 发 rpc-call 时

1. App 发：`emitWithAck('rpc-call', { method: 'cmm3ox7o45ck0yn14m82w7uqr:killSession', params: <encrypted> })`。
2. 服务器根据 `method` 在 `rpcListeners` 里找 **targetSocket**：
   - 若没有或 targetSocket 已断开 → `callback({ ok: false, error: 'RPC method not available' })`，App 端会抛错。
   - 若找到 → 向该 targetSocket（会话进程）发 `emitWithAck('rpc-request', { method, params })`，把会话进程的响应原样通过 callback 回给 App。

因此：

- **「方法不存在」在服务器侧**：表现为没有注册 `sessionId:killSession` 的 socket，或该 socket 已断开 → 返回 `ok: false, error: 'RPC method not available'`。
- **「方法不存在」在 CLI 侧**：会话进程还连着，但本连接上没注册 killSession handler → 进程返回加密的 `{ error: 'Method not found' }`，服务器仍 `ok: true` 把这段密文转回 App；App 解密后得到 `{ error: 'Method not found' }`。

---

## 5. CLI 侧：killSession 处理与错误

- 注册：`registerKillSessionHandler(session.rpcHandlerManager, handleKillSession)`（及重连后 onSessionSwap 里对 newSession 再注册）。
- 收到 `rpc-request` 时：`RpcHandlerManager.handleRequest` 根据 `request.method`（如 `cmm3ox7o45ck0yn14m82w7uqr:killSession`）查 handler；若无则返回加密的 `{ error: 'Method not found' }`。
- 有 handler 时：执行 handleKillSession（updateMetadata、sendSessionDeath、flush、close、exit），并 await 完成后再返回 `{ success: true, message: '...' }`（或失败时 `{ success: false, message }`）。

---

## 6. 错误在 App 侧的体现

- **Session encryption not found**：该 session 从未在 fetchSessions 里成功初始化过加密 → 在 sessionRPC 里抛错，sessionKill catch 后返回 `success: false, message: '...'`。
- **RPC method not available**：服务器找不到或断开了对应 session 的 socket → `result.ok === false`，sessionRPC 用 `result.error` 抛错，sessionKill 同样返回 `success: false`。
- **Method not found（CLI 返回）**：服务器 `ok: true`，result 是加密的 CLI 错误体；解密后为 `{ error: 'Method not found' }`。当前 sessionKill 直接 `return response`，类型上是 `SessionKillResponse`，但实际可能带 `error` 而无 `success`。UI 若只检查 `result.success` 和 `result.message`，可能看不到 `result.error`，建议归档失败时同时展示 `result.error || result.message`。

---

## 7. 关键信息小结

| 信息 | 来源 | 何时具备 |
|------|------|----------|
| **session id** | 服务器 GET /v1/sessions 返回的 session.id，解密后写入 storage | 用户打开过会话列表且 sync 已 fetchSessions 成功 |
| **session 加密 (SessionEncryption)** | 同一次 fetchSessions 中，用 dataEncryptionKey 解密得到 dataKey，再 initializeSessions | 同上；仅对「出现在列表且 dataEncryptionKey 解密成功」的 session |
| **RPC 目标** | 服务器 rpcListeners 中 method = `sessionId:killSession` 对应的 socket | 该 session 的 CLI 曾连接并 rpc-register 了该 method（含重连后重注册） |
| **CLI 端 handler** | runCursor/runCodex/runGemini 等里 registerKillSessionHandler + onSessionSwap 重注册 | 当前运行的 CLI 进程且已执行到注册逻辑（含重连后 onSessionSwap） |

整体上，**从 App 侧 kill session 的机制** 依赖三条线一致：  
(1) App 有 session id 和对应 session 加密；  
(2) 服务器有该 session 的活跃连接且注册了 `sessionId:killSession`；  
(3) CLI 该连接上确实注册了 killSession handler。  
任一环断掉都会导致归档失败，并对应到上面某一种错误表现。

---

## 附录：加密体系里 daemon 的角色

### 结论：会话加密里 daemon **不参与**；只在「机器通道」加密里作为一端。

- **会话级加密（session 内容、session RPC）**  
  - 密钥：每会话的 data key（由服务器下发的 dataEncryptionKey + 用户密钥解密得到）。  
  - 持有者：**App**（fetchSessions 后）、**该会话的 CLI 进程**（自己的那条会话）。  
  - **Daemon 不持有任何 session 密钥，不处理任何 session 的加密/解密，也不在 session RPC 路径上**（killSession、bash 等是 App → 服务器 → 会话进程，不经过 daemon）。

- **机器级加密（机器元数据、daemon 状态、服务器 ↔ daemon 的 RPC）**  
  - 密钥：机器密钥（来自 credentials，与 CLI 共用）。  
  - Daemon 进程用 `credentials` 建 `ApiClient` / `ApiMachineClient`，与服务器建立 **machine-scoped** WebSocket；该通道上的 metadata、daemonState、spawn-happy-session / stop-session 等 RPC 的 params/result 由 **machine 的 encryptionKey** 加解密。  
  - 因此，在「服务器 ↔ 机器」这条加密通道上，**daemon 是其中一端**，负责加解密机器通道上的数据；这与「会话内容 / session RPC」的加密体系是分开的。

- **Daemon 本机 HTTP 控制（/session-started、/list、/stop-session）**  
  - 本机 localhost HTTP，**不加密**；payload 为明文（如 sessionId、metadata 等）。  
  - 文档中也有说明：控制端口目前未做传输加密或鉴权，是已知的改进点。

---

## 附录 2：Daemon 能否从服务器拿到 session id ↔ PID 映射？

**可以。** 服务器上已经有足够信息，daemon 只要具备和 App 相同的「解密会话列表」能力，就能从服务器得到映射。

### 服务器上有什么

- **GET /v1/sessions**（带 Bearer token）返回当前用户的会话列表。
- 每条会话包含：`id`、`metadata`（加密）、`dataEncryptionKey`（加密）等。
- 会话进程在更新 metadata 时会把 **hostPid**（以及 host、path 等）写入；服务器存的是**加密后的 metadata**。
- 因此：服务器侧是「session id → 加密 metadata」，解密后即可得到 **hostPid**，即「session id ↔ PID」的映射。

### Daemon 要怎么做

1. **调用**：用 daemon 已有的 credentials 发 **GET /v1/sessions**（与 App 相同接口）。
2. **解密**：对每个 session：
   - 用**用户 content 密钥**解密 `dataEncryptionKey`，得到该会话的 data key；
   - 用该 data key 解密 `metadata`，得到明文 metadata（内含 `hostPid`、`host` 等）。
3. **过滤**：只保留「本机」的会话（例如 `metadata.host === os.hostname()` 或 `metadata.machineId === daemon 的 machineId`）。
4. **合并**：把得到的 `(sessionId, hostPid)` 合并进 daemon 的 `pidToTrackedSession`（例如以 pid 为 key，没有则新增一条；避免覆盖 daemon 自己 spawn 且已存在的条目）。

这样 daemon 的 list / stop-session 就能覆盖「没来得及上报或上报失败」的会话，和 App 的会话列表对齐。

### 依赖与注意点

- **解密能力**：App 的 `Encryption` 是用 **masterSecret** 派生出 content keypair，再用其 **privateKey** 解密各 session 的 `dataEncryptionKey`。Daemon 若要从服务器拿映射，需要具备同样的解密链：
  - **Legacy 认证**：CLI 存的是 `secret`，若与 App 的 masterSecret 一致或能派生出同一 content key，则 daemon 可用当前 credentials 实现上述解密。
  - **DataKey 认证**：credentials 里是 `publicKey` + `machineKey`；session 的 `dataEncryptionKey` 是用**用户公钥**加密的，解密需要**用户私钥**。若 CLI 端从未持久化该私钥（只存公钥），则 daemon 在 dataKey 体系下无法解密会话列表，除非在 CLI/daemon 侧增加对「用户 content 私钥」的存储与使用。
- **实现位置**：可在 daemon 启动或定时/按需同步时，增加一段「从服务器拉会话列表并解密」的逻辑（与 sync 的 fetchSessions 类似），只用到 session id 和 metadata 中的 hostPid/host/machineId，不触碰消息等其它数据。
