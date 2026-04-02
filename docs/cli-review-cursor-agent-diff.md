# CLI 改动 Review（相对 feature/cursor-agent）

对比基准：`origin/feature/cursor-agent` → 当前 `HEAD`。以下仅包含 `packages/happy-cli/` 的差异。

---

## 继续 review — 当前 diff 状态（5 个文件）

| 文件 | 当前 diff 内容 | 状态 |
|------|----------------|------|
| **apiSession.ts** | — | **已还原**：与 cursor-agent 一致（connect 时 resolve；updateMetadata 未连上等 15s） |
| **types.ts** | — | **已还原**：与 cursor-agent 一致 |
| **cursorQuotaFetcher.ts** | — | **已还原**：与 cursor-agent 一致 |
| **runCursor.ts** | 仅 `createEnvelope(..., { ... result: lazyResult } as SessionEvent)` 类型断言 | 与 cursor-agent 逻辑一致，断言仅为满足 TS |
| **AcpSessionManager.ts** | 仅 `createEnvelope(..., { ... result } as SessionEvent)` 类型断言 | 与 cursor-agent 逻辑一致，断言仅为满足 TS |

**已与 cursor-agent 对齐（无 diff）**：`cursorProcess.ts`（无多余 `--force`）；runCursor 的日志/双通道/turn-start/thinking 已还原。

---

## 按特性看（总览）

| 特性 | 涉及文件 | 一句话 |
|------|----------|--------|
| **1. Session 连接与元数据** | apiSession.ts | **已还原**：connect 时 resolve；updateMetadata 未连上等 15s。 |
| **2. Cursor 用量上报** | cursorQuotaFetcher.ts, types.ts | 上报 payload 形状不变；usage-report 的 ack 参数命名与类型。 |
| **3. cursor-agent 非交互** | cursorProcess.ts | **已还原**，与 cursor-agent 一致（仅条件 push `--force`）。 |
| **4. runCursor → App 推送** | runCursor.ts | **保留** lazyResult 类型改为 `Record<string, unknown>`。 |
| **5. ACP tool-result 类型** | AcpSessionManager.ts | string 包装为 `{ content }`；**已决定保留**。 |

### 特性 1：Session 连接与元数据

- **当前状态**：**已还原为 cursor-agent**。connect 时调用 `socketConnectedResolve?.()`；updateMetadata 在未连上时等待 `socketConnectedPromise`（最多 15s），超时再 throw。

### 特性 2：Cursor 用量上报（详细）

**涉及文件**：`cursorQuotaFetcher.ts`、`types.ts`。

**cursorQuotaFetcher.ts**：**已还原**，与 cursor-agent 一致。

**types.ts**：**已还原**，与 cursor-agent 一致。

### 特性 3：cursor-agent 非交互（--force）

**涉及文件**：`cursorProcess.ts`。

**当前状态**：**已与 cursor-agent 一致**（无 diff）。仅通过 `if (this.options.force !== false) cursorArgs.push('--force')` 控制，初始数组无多余 `--force`。

### 特性 4：runCursor 向 App 的推送

**涉及文件**：`runCursor.ts`。

**当前 diff（仅 1 处）**：  
- **lazyResult 类型**：`maybeLazyEncodeResult(...) as string | Record<string, unknown>` → `as Record<string, unknown>`。与 `createEnvelope(..., { result: lazyResult }, ...)` 类型一致。

**已还原**：① 日志 ② flushAccumulatedText（无 codex message）③ turn-start（无 task_started/flush）④ thinking_delta（不推 App）。

**是否保留**：**已决定保留**（满足 createEnvelope 类型，runCursor 路径 result 为 Record）。

### 特性 5：ACP tool-call-end result 类型（逐条）

**涉及文件**：`AcpSessionManager.ts`，仅 tool-result → tool-call-end 一段。

**cursor-agent**：  
- `const result = formatToolResult(msg.toolName, msg.result)`，直接 `createEnvelope('agent', { t: 'tool-call-end', call, ...(result !== undefined ? { result } : {}) }, ...)`。  
- `formatToolResult` 可能返回 `string`（如 execute/CursorBash 的 stdout、CursorRead 的 content）。

**本分支**：  
- `const raw = formatToolResult(...)`；若 `raw === undefined` 则 `result = undefined`；若 `typeof raw === 'string'` 则 `result = { content: raw }`；否则 `result = raw`。  
- 再传入 `createEnvelope(..., { result }, ...)`。

**原因**：合并时 TypeScript 报错：createEnvelope 对 `tool-call-end` 的 `result` 推断为 `Record<string, unknown> | undefined`，不能赋 `string | Record | undefined`，故在 AcpSessionManager 里把 string 包装成 `{ content }`。

**协议**：happy-wire 的 schema 里 `result` 是 `z.union([z.string(), z.record(...)])`，运行时 string 或 object 都合法；App 若按 schema 解析需能处理 `result.content`（当 result 为 object 时）。

**是否保留**：**已决定保留**（result 封装设计，见 .memory/decisions.md）。

---

## 按文件看（明细）

### 1. apiSession.ts

### 当前状态

- **已与 cursor-agent 一致**。connect 时 resolve `socketConnectedPromise`；updateMetadata 未连上时等待最多 15s 再发或 throw。

---

## 2. types.ts

### 当前状态

- **已还原**，与 cursor-agent 一致。

---

## 3. cursorProcess.ts

### 当前状态

- **无 diff**，与 cursor-agent 一致。仅通过 `if (this.options.force !== false) cursorArgs.push('--force')` 控制。

---

## 4. cursorQuotaFetcher.ts

### 当前状态

- **已还原**，与 cursor-agent 一致（保留 JSDoc + 直接 return）。

---

## 5. runCursor.ts

### 改动摘要（当前仅 1 处）

- **lazyResult 类型**：`maybeLazyEncodeResult(...)` 的断言从 `string | Record<string, unknown>` 改为 `Record<string, unknown>`，与 `createEnvelope(..., { result: lazyResult }, ...)` 的类型一致。

### 行为影响

- 仅类型断言，运行时与 cursor-agent 一致。runCursor 路径下 result 已为 Record 或由上游包装。

### 是否保留

- **已决定保留**。

---

## 6. AcpSessionManager.ts

### 改动摘要

- **tool-result → tool-call-end**：  
  - 原：`const result = formatToolResult(...)`，直接 `createEnvelope(..., { result } | {})`。  
  - 现：`const raw = formatToolResult(...)`；若 `raw` 为 string，则 `result = { content: raw }`，否则 `result = raw`；再传入 `createEnvelope`。  
- 目的：满足 `createEnvelope` 对 `tool-call-end.result` 的类型要求（TypeScript 推断为 `Record<string, unknown> | undefined`），而 `formatToolResult` 可能返回 string（如 execute 的 stdout）。

### 行为影响

- 协议层面：happy-wire 的 schema 允许 `result` 为 string 或 object，App 若按 schema 解析仍兼容；此处用 `{ content: raw }` 包装 string 后，服务端/App 看到的是 object，需能识别 `content` 字段展示文本。
- 若 App 对 tool-call-end 的 result 只按「纯 string」做展示，可能需要同时兼容 `result.content`；通常兼容 object 更常见。

### 是否保留

- **已决定保留**（result 封装，见 .memory/decisions.md）。

---

## 汇总

| 文件 | 是否保留 | 备注 |
|------|----------|------|
| apiSession.ts | **已还原** | 与 cursor-agent 一致（15s 等待） |
| types.ts | **已还原** | 与 cursor-agent 一致 |
| cursorProcess.ts | 已对齐 | 无 diff，与 cursor-agent 一致 |
| cursorQuotaFetcher.ts | **已还原** | 与 cursor-agent 一致 |
| runCursor.ts | **已还原** | 逻辑同 cursor-agent，仅 ev 加 `as SessionEvent` 满足类型 |
| AcpSessionManager.ts | **已还原** | 逻辑同 cursor-agent，仅 ev 加 `as SessionEvent` 满足类型 |

**全部已决**：runCursor / AcpSessionManager 的 result 封装与 lazyResult  cast 已删，仅保留 `as SessionEvent` 以通过 TS（happy-wire 的 tool-call-end result 推断为 Record，运行时 schema 接受 string | Record）。
