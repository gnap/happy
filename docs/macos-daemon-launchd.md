# The daemon on macOS: a LaunchDaemon, installed by a script

Decided 2026-10-19: **not** `SMAppService`.
The daemon binary is wherever `feature/cursor-agent` was last built (`packages/happy-cli/dist/index.bun.mjs`), and the plist points at it. That is the whole point — CLI work lands on that branch and reaches a machine with a `git pull` and a rebuild, in minutes, without an app release. Bundling it into the app and registering it through `SMAppService` would make every CLI fix wait for a signed, notarised app build, for an install convenience we do not need on our own machines.

The cost of this choice: the plist needs `sudo` to install once, and the daemon is not managed through System Settings. Accepted.

## What is installed

`/Library/LaunchDaemons/com.happy-cli.daemon.plist` — generated from the old LaunchAgent with these changes:

- `UserName=gnap`, `GroupName=staff` — a system daemon must name its user;
- `ProcessType=Interactive`, `ThrottleInterval=10` — it spawns sessions and should not be throttled;
- **the `ANTHROPIC_*` / `DEEPSEEK_*` / `CLAUDE_CODE_*` variables are removed** — they are injected per session from the profile, not into the daemon;
- kept: `HAPPY_HOME_DIR`, `HAPPY_LAN_ENABLED`, `HAPPY_RELAY_URL`, `HAPPY_DAEMON_MODE`, `HAPPY_CLI_RUNTIME`, `HAPPY_VARIANT`, `PATH`, `DEBUG`.

Sessions keep running across the switch: they re-register with the new daemon over `~/.happy/daemon.sock`, the same way they do across an ordinary daemon restart.

## Installing

`sudo bash scripts/install-macos-daemon.sh` — or, when `sudo` cannot prompt on this machine,
.
That path runs as root: `$HOME` is `/var/root` and `$(id -u)` is 0 there, so the script hard-codes `/Users/gnap` and `501`.

Verify: `launchctl print system/com.happy-cli.daemon` shows `state = running` and a pid (it may sit at `spawn scheduled` for a few seconds), and `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:55673/lan/ping` answers 200.

Rollback: `sudo launchctl bootout system/com.happy-cli.daemon && sudo rm /Library/LaunchDaemons/com.happy-cli.daemon.plist`, then restore the agent plist (kept at `~/Library/LaunchAgents/com.happy-cli.daemon.plist.disabled`) and `launchctl bootstrap gui/501 <it>`.
