# Bugs

## hostPid not updated on session respawn → App shows stale PID
- **Symptom**: App displays old PID after session process respawns
- **Root cause**: `notifyDaemonSessionStarted` sends `hostPid` only to daemon via HTTP; `session.updateMetadata` (server-side) never includes the new PID
- **Fix**: Added `session.updateMetadata((m) => ({ ...m, hostPid: process.pid }))` in `runCursor.ts` after `daemonReportInterval` setup
- **Commit**: `fix(cursor): sync hostPid to server metadata on session start/respawn`

## turn-end status incorrectly 'completed' when cursor-agent killed with no tool calls
- **Symptom**: If cursor-agent is SIGKILL'd mid-turn with no open tool calls, App receives `turn-end: completed` instead of `failed`
- **Root cause**: `turnEndStatus` defaults to `'completed'`; catch block (which sets it to `'failed'`) is not triggered when `cursorProc.run()` resolves (not rejects) on external kill
- **Fix**: Changed status logic in `runCursor.ts` finally block:
  `turnCompletedNormally ? 'completed' : (turnEndStatus === 'cancelled' ? 'cancelled' : 'failed')`
- **Commit**: same PR as above

## Claude sessions pass UI model selector `adaptiveUsage` as API model
- **Symptom**: Claude session using a DeepSeek-compatible Anthropic endpoint fails with `API Error: 400` because the request model is `adaptiveUsage` instead of `deepseek-v4-pro` or `deepseek-v4-flash`
- **Root cause**: App message metadata can carry UI-only model selectors; `runClaude`/`claudeRemote` forwarded `meta.model` directly to Claude Code `--model`
- **Fix**: Added `normalizeClaudeModelForSdk()` and apply it in Claude message state and SDK options so `adaptiveUsage`, `default`, and `auto` are treated as unset while concrete provider model names still pass through
- **Prevention**: Keep provider SDK boundaries responsible for translating app/UI selectors into backend-specific model arguments
