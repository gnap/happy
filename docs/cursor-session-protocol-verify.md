# 确认 Cursor 已用新 CLI（session 协议）并排查旧 App 不展示消息

## 1. 确认 CLI 已重新编译

- 已做**强制完整重建**：`cd packages/happy-cli && shx rm -rf dist && npx tsc --noEmit && pkgroll`
- dist 已包含 session 协议发送逻辑：
  - `dist/runCursor-*.mjs` 中有 `formatToolResultForSession` 以及多处 `t: "text"` 的 session 发送

## 2. 你实际跑的是哪套 CLI？

- **从源码跑**：`yarn cli` / `yarn workspace happy-coder cli` → 执行的是 `tsx src/index.ts`，**不会用 dist**，直接带我们改的代码。
- **从构建跑**：`node bin/happy.mjs` 或全局 `happy` → 执行的是 `dist/index.mjs`，**必须 build 后才是新逻辑**。
- **Daemon 起的 Cursor 会话**：daemon 通过 `spawnHappyCLI` 起子进程时，跑的是 **`dist/index.mjs`**（路径来自 `projectPath()/dist/index.mjs`）。  
  - 若 daemon 本身是用 **tsx** 起的（例如 `yarn cli daemon start`），`projectPath()` 会指向 `packages/happy-cli/src`，此时会去找 `src/dist/index.mjs`（不存在），spawn 会失败。  
  - 因此能正常起会话时，daemon 一般是用**已构建的 CLI** 起的（例如 `node bin/happy.mjs daemon start` 或 `./bin/happy.mjs daemon start`），子进程用的就是**当前 workspace 的 dist**。

结论：只要在**本仓库**里做过一次 `yarn workspace happy-coder build`，之后用 **同一仓库** 的 `node bin/happy.mjs daemon start` 起的 Cursor 会话，用的就是新编译的、带 session 协议发送的 CLI。

## 3. 建议的验证步骤

1. **在本仓库强制重建 CLI**  
   ```bash
   cd /Users/gnap/Worktrees/happy-cursor-ios && yarn workspace happy-coder build
   ```

2. **若用 daemon，用「构建后的入口」重启 daemon**（不要用 `yarn cli daemon start`）  
   ```bash
   cd packages/happy-cli && node bin/happy.mjs daemon start
   # 或先 stop 再 start
   ```

3. **新开一个 Cursor 会话**（从旧 App 或从终端发起均可），不要用之前已存在的会话。

4. **确认跑的是本仓库的 dist**（可选）  
   - 看 daemon 起的 Cursor 进程可执行路径里是否包含本仓库的 `happy-cursor-ios` / `happy-cli`。  
   - 或在 `runCursor.ts` 里临时加一行 `console.log('[cursor] session protocol text sent')`，build 后再跑一轮，看终端/日志里是否出现。

## 4. 若确认跑的是新 CLI 但旧 App 仍不展示消息

则问题在 **App 或同步路径**，可逐项查：

- **旧 App 是否支持 session 协议**  
  - 需能解析 `content.type === 'session'`（或 `role === 'session'` 且 preprocess 成 `content.type === 'session', content.data = envelope`），并对 `ev.t === 'text'` 做归一化并渲染。  
  - 若旧版没有 `normalizeSessionEnvelope` 或没有处理 `ev.t === 'text'`，就不会展示这些消息。

- **服务端/同步是否把 session 消息写进会话**  
  - 确认 Cursor 会话的 feed/消息列表里，是否能看到 `role: 'session'` 或 `content.type === 'session'` 的条目。  
  - 若服务端或同步层对 Cursor 会话只存 `cursor` 不存 `session`，旧 App 也收不到。

- **是否被「仅 Claude 展示 session」逻辑过滤**  
  - 若旧 App 只在 `agentType === 'claude'` 时渲染 session 协议消息，Cursor 会话（agentType === 'cursor'）可能被过滤掉，需要改 App 或兼容逻辑。

---

**简短结论**：dist 已确认包含 session 协议发送；要确保「旧 App 端真的在用新 CLI」，需要：用**本仓库 build 后的** `node bin/happy.mjs daemon start` 起 daemon，并**新开** Cursor 会话。若仍不展示，再按上面第 4 步查 App/同步与 agent 类型逻辑。
