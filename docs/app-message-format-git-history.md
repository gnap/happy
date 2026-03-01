# 从 Git 历史看旧 App 可能支持的消息格式

在 `packages/happy-app/sources/sync/typesRaw.ts` 上查了最近相关提交，结论如下。

---

## 1. 涉及 typesRaw 的提交（时间顺序）

| Commit    | 日期        | 说明 |
|-----------|-------------|------|
| **bb7a117** | 2026-02-13 | feat(happy-app): metadata-driven model/mode selection with sync mode hacks |
| **641c8eb** | 2026-02-25 | fix(sync): Codex message types and machine encryption logging |
| **83626fc** | 2026-02-25 | fix: sync session redeclaration + Cursor i18n for all locales |
| **3f90087** | 2026-02-25 | refactor: drop sessionFlavor from normalization; fix Metro asset path decoding |

（更早的 27f6c79 等提交中，当前路径下的 `typesRaw.ts` 可能尚未存在或路径不同，未再往前追。）

---

## 2. 各提交里 raw 的「可接受 shape」

- **bb7a117 / 641c8eb**（早于 Cursor 接入 typesRaw）  
  - **role**：`'agent'` | `'user'` | `'session'`  
  - **agent 分支**：`content.type` 有 `'output'`、`'codex'`、`'session'`、`acp`、`event` 等，**没有** `'cursor'`。  
  - **session 分支**：`role === 'session'`，预处理后 `content: { type: 'session', data: sessionEnvelopeSchema }`，有 `normalizeSessionEnvelope`（含对 `ev.t === 'text'` 等的处理）。

- **83626fc / 3f90087**（当前逻辑）  
  - 在 **agent** 分支里**新增**了 `content.type === 'cursor'`，与 `codex` 共用 `codexCursorDataSchema`。  
  - 其余同上（session、codex、output、acp、event 仍在）。

结论：

- **“旧 App” = 基于 bb7a117 或 641c8eb 构建**：  
  - 会接受 **session 协议**（`role: 'session'` + `content.type === 'session'` + envelope），能展示 session 的 text / tool-call-start/end 等。  
  - **不会**接受 **cursor 格式**（`role: 'agent'`, `content.type === 'cursor'`），因为 schema 里没有 `cursor` 分支 → `safeParse` 失败 → `normalizeRawMessage` 返回 `null` → 不展示。
- **“旧 App” = 基于 83626fc 或之后构建**：  
  - 同时支持 cursor 和 session，所以会出现「两套文本」（cursor + session 双发都展示）。

---

## 3. 和“旧 App 一套都没有”的对应关系

- 若旧 App 是 **641c8eb 或更早**（没有 `content.type === 'cursor'`）：  
  - Cursor 若**只发 cursor 格式**：所有 agent 消息都会因 schema 不包含 `cursor` 被拒绝 → **一套都不展示**。  
  - Cursor 若**发 session 协议**（`role: 'session'`）：应能被接受并展示；若仍不展示，需再查该版本是否真有 `role: 'session'` 和 `normalizeSessionEnvelope`（例如是否从别的分支/仓库构建，或 session 分支被改过）。
- 若旧 App 是 **83626fc 之后**：应至少能展示一种格式；若仍“一套都没有”，更可能是网络/加密/推送路径或其它层问题，而不是 typesRaw 的 shape 不支持。

---

## 4. 3f90087 的变更（sessionFlavor）

- 仅去掉了 `NormalizeRawMessageOptions.sessionFlavor` 和「codex + sessionFlavor === 'cursor' 时当 thinking」的 fallback。  
- **没有**删掉 `role: 'session'` 或 session 的归一化，不影响「是否接受 session 协议消息」。

---

## 5. 建议的“旧 App 消息格式”结论

- **有 git 历史的“旧 App”**（本仓库 bb7a117 / 641c8eb）：  
  - 支持：**session 协议**（`role: 'session'`）、**codex**、**output**、**acp**、**event**。  
  - 不支持：**cursor 格式**（`content.type === 'cursor'`）。  
- 若你们说的“旧 App”是**其它仓库或未合入 83626fc 的分支**，需要在该仓库/分支上对 `typesRaw.ts` 做一次同样检查：  
  - 是否包含 `role: 'session'` 及 `content.type === 'session'`；  
  - 是否包含 `normalizeSessionEnvelope` 及对 `ev.t === 'text'` 等的处理。

这样可以从 git 历史确定「旧 App 可能的消息格式」和「为何只发 cursor 时旧 App 一套都没有、发 session 时应能有一套」的逻辑。
