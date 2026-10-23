# The daemon on macOS: a LaunchDaemon, installed by a script

Decided 2026-10-19: **not** `SMAppService`.

The daemon binary is wherever `feature/cursor-agent` was last built
(`packages/happy-cli/dist/index.bun.mjs`), and the plist points at it. That is the point — CLI work
lands on that branch and reaches a machine with a `git pull` and a rebuild, in minutes, without an app
release. Bundling the CLI into the app and registering it through `SMAppService` would make every CLI
fix wait for a signed, notarised app build, for an install convenience that matters to users and not to
our own machines.

The cost of this choice: the plist needs `sudo` to install once, and the daemon is not managed through
System Settings. Accepted.

## What is installed

`/Library/LaunchDaemons/com.happy-cli.daemon.plist`, generated from the old LaunchAgent with:

- `UserName=gnap`, `GroupName=staff` — a system daemon must name its user;
- `ProcessType=Interactive`, `ThrottleInterval=10` — it spawns sessions and should not be throttled;
- **the `ANTHROPIC_*` / `DEEPSEEK_*` / `CLAUDE_CODE_*` variables removed** — those are injected per
  session from the profile, not into the daemon;
- kept: `HAPPY_HOME_DIR`, `HAPPY_LAN_ENABLED`, `HAPPY_RELAY_URL`, `HAPPY_DAEMON_MODE`,
  `HAPPY_CLI_RUNTIME`, `HAPPY_VARIANT`, `PATH`, `DEBUG`.

Sessions keep running across the switch: they re-register with the new daemon over
`~/.happy/daemon.sock`, the same way they do across an ordinary daemon restart.

## Installing

    sudo bash packages/happy-cli/scripts/install-macos-daemon.sh

When `sudo` cannot prompt on the machine, go through the system dialog instead — but note that this
path runs as root, where `$HOME` is `/var/root` and `$(id -u)` is 0, so the script hard-codes
`/Users/gnap` and `501`:

    osascript -e 'do shell script "bash /Users/gnap/Projects/happy/packages/happy-cli/scripts/install-macos-daemon.sh" with administrator privileges'

Verify: `launchctl print system/com.happy-cli.daemon` shows `state = running` and a pid (it may sit at
`spawn scheduled` for a few seconds), and the LAN API answers:

    curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:55673/lan/ping     # 200

Rollback: boot out the daemon, remove its plist, restore the agent plist that the script keeps at
`~/Library/LaunchAgents/com.happy-cli.daemon.plist.disabled`, and bootstrap it in `gui/501`.
