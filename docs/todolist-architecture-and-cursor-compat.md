# Todo List 架构与 Cursor 兼容

## 1. 当前架构概览

### 1.1 数据流

```
CLI/Agent (tool_use / tool_call) 
  → name + input/result 
  → 服务端 / session protocol 
  → App reducer 
  → Session.todos + latestTodos 
  → UI (TodoView)
```

### 1.2 约定：工具名与结构

- **工具名**：`TodoWrite`（App 与 Claude/Codex 统一用此名）
- **Input 结构**（发往 agent）：
  - `todos`: `Array<{ content, status: 'pending'|'in_progress'|'completed', priority?, id? }>`
- **Result 结构**（agent 返回）：
  - `oldTodos` / `newTodos`: 同上结构的数组（用于展示「变更后」的列表）

### 1.3 App 侧涉及点

| 位置 | 作用 |
|------|------|
| **knownTools.tsx** | 定义 `TodoWrite` 的 input/result schema、标题、minimal 规则 |
| **views/_all.tsx** | `toolViewRegistry['TodoWrite'] = TodoView`，按工具名选渲染组件 |
| **TodoView.tsx** | 用 `knownTools.TodoWrite.input` / `.result` 解析，优先 `input.todos`，否则 `result.newTodos` |
| **reducer.ts** | 仅当 `message.tool.name === 'TodoWrite'` 且 `message.tool.input?.todos` 时更新 `state.latestTodos`，最终产出 `ReducerResult.todos` |
| **storage.ts** | 把 `reducerResult.todos` 写回 `session.todos`；设置里 `expandTodos` 控制是否展开 todo 列表 |
| **settings** | `expandTodos`（expandTodoLists）控制「只显示变更」还是「展开全部待办」 |

要点：

- 只有 **工具名为 `TodoWrite`** 的 tool call 会参与「待办状态」的更新和展示。
- 只有 **input 里带 `todos` 数组** 的才会写入 `latestTodos` / `session.todos`。

## 2. Cursor 侧现状

- **packages/happy-cli/src/cursor/runCursor.ts** 中 `toCodexToolShape(toolName, args)` 负责把 Cursor 的工具名/参数映射成 App 认识的「Codex/App 形状」：
  - 已映射：`CursorBash`→`CodexBash`，`CursorRead`→`Read`，`CursorWrite`→`Write`，`CursorEdit`→`Edit`
  - **未**对任何 todo 类工具做映射；其余工具直接 `{ codexName: toolName, codexInput: args }` 透传。

因此：

- 若 Cursor 发出的工具名就是 **`TodoWrite`**，且参数里就是 **`todos`** 数组，则当前架构下 **无需改 App**，只需确认 Cursor agent 实际是否使用该名与结构。
- 若 Cursor 使用**不同工具名**（例如 `todo_write`、`CursorTodo`、`update_todos` 等）或**不同参数名**（例如 `items` 而非 `todos`），则需要在 CLI 做一层映射，并视情况在 App 做别名或归一化。

## 3. Cursor 兼容方案

### 方案 A：Cursor 与 Claude 对齐（推荐）

- Cursor agent 配置/实现里统一使用：
  - 工具名：**`TodoWrite`**
  - input：**`{ todos: [...] }`**（与 knownTools.TodoWrite.input 一致）
  - result：**`{ oldTodos?, newTodos? }`**（与 knownTools.TodoWrite.result 一致）
- 这样 **CLI 与 App 都不用改**，仅需在 Cursor 侧保证命名与结构一致。

### 方案 B：Cursor 用不同名/结构，在 CLI 做映射

在 **runCursor.ts** 的 `toCodexToolShape` 里为 Cursor 的 todo 工具加分支，例如：

```ts
// 示例：Cursor 若用 todo_write 且 args 为 { items }
if (toolName === 'todo_write' || toolName === 'CursorTodo') {
  const items = Array.isArray(args?.items) ? args.items : Array.isArray(args?.todos) ? args.todos : [];
  return {
    codexName: 'TodoWrite',
    codexInput: { todos: items },
  };
}
```

- 发往 session 的 name 固定为 **`TodoWrite`**，input 固定为 **`{ todos }`**，这样 App 的 reducer、TodoView、knownTools 全部复用，**无需改 App**。

### 方案 C：App 侧支持别名（仅在 CLI 无法统一名字时）

若某端无法改工具名（例如服务端或别处已固定为 `todo_write`），可在 App 做兼容：

1. **views/_all.tsx**  
   - 为同一视图注册别名，例如：  
     `toolViewRegistry['todo_write'] = TodoView;`
2. **reducer.ts**  
   - 在更新 `latestTodos` 时，除 `TodoWrite` 外也认 Cursor 实际使用的名字，例如：  
     `if ((toolCall.name === 'TodoWrite' || toolCall.name === 'todo_write') && ...)`
3. **knownTools**  
   - 若 Cursor 的 input 键名不是 `todos`，可在 knownTools 里为 `todo_write` 加一条 schema，或在 TodoView 里对 `todo_write` 做一次参数归一化（把 `items` 转成 `todos` 再复用现有解析）。

优先在 **CLI 的 toCodexToolShape 里统一成 TodoWrite + { todos }**（方案 A/B），这样 App 只认一个工具名、一种结构，最省事。

## 4. 小结

| 层级 | 当前约定 | Cursor 兼容要点 |
|------|----------|------------------|
| 工具名 | `TodoWrite` | 在 CLI 映射为 `TodoWrite`，或 Cursor 直接发 `TodoWrite` |
| Input | `{ todos: [...] }` | 在 CLI 将 Cursor 的 args 转成 `{ todos }`，或 Cursor 直接发该结构 |
| Result | `{ oldTodos?, newTodos? }` | 若 Cursor 用不同键名，可在 TodoView 或 knownTools 里做一次兼容解析 |
| Reducer | 仅处理 `name === 'TodoWrite'` | 若保留别名，在 reducer 里同时判断 Cursor 的工具名 |

推荐顺序：**先确认 Cursor 实际发出的工具名和 args**；若与 Claude 一致则用方案 A；否则在 CLI 用方案 B 映射到 `TodoWrite` + `{ todos }`，必要时再在 App 用方案 C 做别名/兼容。
