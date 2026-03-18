# App 对 tool-call-end result 的处理确认

## 数据流

1. **CLI** 发 session envelope：`createEnvelope('agent', { t: 'tool-call-end', call, result })`，`result` 可为 string 或 Record。
2. **typesRaw.ts**（约 702–712 行）：`envelope.ev.t === 'tool-call-end'` 时，构造 `content: [{ type: 'tool-result', tool_use_id: envelope.ev.call, content: envelope.ev.result ?? null, ... }]`。即 **envelope.ev.result 原样** 放进 `content` 字段。
3. **reducer.ts**（约 862 行）：`message.tool.result = c.content`，即 **tool.result = 当时 envelope 里的 result**（string 或 object 都原样存）。
4. **展示**（ToolView.tsx、ToolFullView.tsx）：  
   `code={typeof tool.result === 'string' ? tool.result : JSON.stringify(tool.result, null, 2)}`  
   → **string 直接显示；object 整份 JSON.stringify 显示**。

## 若 CLI 把 string 包装成 `{ content: raw }`

- App 里 `message.tool.result` 会变成 `{ content: "stdout..." }` 这类对象。
- 展示逻辑不会特别处理 `.content`，会走 `JSON.stringify(tool.result, null, 2)`，用户看到的是整段 JSON，例如 `{\n  "content": "stdout..."\n}`，而不是纯文本 `stdout...`。

## 结论

- **当前 App 不会**根据 `result.content` 做“纯文本展示”，只区分 string（直接显示）和 非 string（JSON 展示）。
- 若保留 CLI 的「string → { content: raw }」：
  - **不改 App**：协议和类型都兼容，但纯文本类 result 会以 JSON 形式展示。
  - **改 App**：在展示处增加“若 `tool.result` 为 object 且仅有字符串类型的 `content`，则显示 `tool.result.content`，否则再 `JSON.stringify(tool.result)`”，则纯文本体验与现在一致。
