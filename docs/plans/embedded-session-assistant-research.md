# Per-Machine Embedded Session Assistant — Research Handoff

**Purpose**: Handoff document from OpenClaw/Happy integration analysis. This captures the research and design for a "per-machine embedded assistant" that can query other sessions, summarize progress, and start new sessions. **Intended for Happy’s agent or maintainers to continue the research and implementation.**

---

## 1. Source of the idea

- **OpenClaw** has an **agent-to-agent (a2a)** session model:
  - Sessions are first-class: `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`.
  - Visibility: `self` | `tree` | `agent` | `all`; cross-agent requires `tools.agentToAgent.enabled` + allowlist.
  - `sessions_send`: primary run → optional ping-pong (max turns, `REPLY_SKIP`) → announce step (result to channel).
  - `sessions_spawn`: fire-and-forget sub-session, no session tools in child, announce result back to requester.
- **Question**: Can Happy adopt a similar idea — **one “assistant” per machine** that can list sessions, summarize progress, and start new sessions?

---

## 2. Design: no extra process, main agent gets tools

- **Do not** add a separate long-lived “small agent” process per machine.
- **Do** give the **main agent** (e.g. `happy codex` / `happy`) **three tools** so it acts as the assistant when the user asks “what’s going on in my other sessions?” or “start a background session to do X.”
- “One per machine” is implicit: tool data is scoped to **this account** and optionally **this machine** (server session list + this daemon’s active sessions).

---

## 3. Three tools (API surface)

| Tool | Purpose | Implementation in Happy |
|------|--------|-------------------------|
| **sessions_list** | List sessions the user can see | Use existing `GET /v1/sessions` (same as `happy sessions list`). Merge with daemon `POST /list` (happySessionId, pid) to know which sessions are on this machine. Optionally filter by `machineId` for “this machine only.” |
| **session_summary** | Get progress/summary for one session | **Gap**: Server must expose either (a) session history (e.g. `v3/sessions/:id/messages` — last N messages for the agent to summarize), or (b) a stored summary per session. First version: “fetch last N messages + agent summarizes” is enough. |
| **session_start** | Start a new session on this machine | Call this machine’s daemon **spawnSession** (`directory`, `sessionId?`, `agent?`). Return `sessionId`. Optional later: extend `SpawnSessionOptions` with `initialPrompt` so the new session starts with a task. |

---

## 4. Where to implement the tools

- **Option A (recommended first)**: Implement as **native tools** in the main agent. In happy-cli, register these three tools for Codex/Claude. Handlers run **in the CLI process**, using:
  - **ApiClient** (existing credentials) for server (list, summary or messages),
  - **Daemon control client** for daemon (list, spawnSession).
- **Option B**: Implement as an **MCP server** exposed by Happy: tools `happy_sessions_list`, `happy_session_summary`, `happy_session_start`. Main agent loads them via `--mcp-config`. Aligns with “OpenClaw exposes tools to Happy via MCP” and keeps session tooling consistent.

---

## 5. Scope and security

- **Visibility**: Only this user’s sessions; optionally “this machine only” (sessions where `machineId` matches this daemon).
- **session_start**: Only allow spawn on this machine’s daemon; validate `directory` (e.g. allowlist or under user workspace / cwd).
- No cross-user or cross-machine delegation in v1; if added later, use an explicit allowlist (similar to OpenClaw’s `tools.agentToAgent.allow`).

---

## 6. User-facing usage (target)

- “What are my other sessions doing?” → Agent calls `sessions_list`, then `session_summary` for relevant sessions, and answers in natural language.
- “Start a background session to fix the tests and tell me when done.” → Agent calls `session_start` (directory, agent); if `initialPrompt` exists, pass “fix tests in this repo and summarize when done.” Later, user or agent can check progress via `session_summary` or push.
- “Summarize progress across all my sessions today.” → Agent uses `sessions_list` → `session_summary` for each (or only active) → synthesizes a short report.

---

## 7. Mapping to OpenClaw a2a

| OpenClaw | Happy counterpart |
|----------|-------------------|
| sessions_list / sessions_history | sessions_list + session_summary (summary = lightweight history) |
| sessions_send | Omit in v1; later add session_send (send message into an existing session) |
| sessions_spawn (child session, result back to requester) | session_start (spawn on this machine) + optional initialPrompt; “result back” via push or main agent polling session_summary |
| visibility (self/tree/agent/all) | v1: this account + optional “this machine only” |
| agentToAgent.enabled + allow | v1: no cross-machine; add allowlist later if needed |

---

## 8. Next steps for continued research (for Happy’s agent)

- [ ] **Server API**: Confirm whether `GET /v1/sessions` can be filtered by `machineId` (or equivalent). Document response shape for “sessions on this machine.”
- [ ] **Session summary**: Decide and document how to get “summary” or “last N messages” per session (new endpoint vs existing `v3/sessions/:id/messages`). If the agent summarizes on the fly, define N and token limits.
- [ ] **Daemon**: Document `spawnSession` (e.g. in `registerCommonHandlers.ts` / daemon `run.ts`). Confirm whether `session_start` can pass an initial prompt (extend `SpawnSessionOptions` with `initialPrompt` and how the new process receives it).
- [ ] **Tool surface**: Choose native tools vs MCP (or both). If MCP: add Happy MCP server that exposes these three tools; document `--mcp-config` shape for happy-cli.
- [ ] **Credentials / auth**: Ensure tool handlers (in CLI or MCP server) can use the same credentials as the running session (ApiClient, daemon control) without prompting again.
- [ ] **Docs**: Add a short “Session assistant” section to user-facing docs (how to ask for “other sessions,” “start background session,” “summarize progress”) once the feature exists.

---

## 9. References (OpenClaw)

- OpenClaw session tools: `docs/concepts/session-tool.md`
- Multi-agent and a2a config: `tools.agentToAgent.enabled`, `tools.agentToAgent.allow`, `session.agentToAgent.maxPingPongTurns`
- OpenClaw repo: https://github.com/openclaw/openclaw

---

*Document created as research handoff from OpenClaw/Happy integration analysis. Update this file as the design is refined or implemented.*
