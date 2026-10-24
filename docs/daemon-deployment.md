# Deploying the daemon (macOS and Linux)

This is the runbook. `macos-daemon-launchd.md` next to it records *why* macOS uses a LaunchDaemon
instead of `SMAppService`; this file explains what to install, in what order, and how to check it.

The daemon is the part of the CLI that stays running when no terminal is open. The App talks to a
machine through it: it spawns sessions on request, serves the LAN/relay control surface, and keeps
the machine's record on the server up to date. Sessions are child processes of the daemon, but they
are not tied to its lifetime — a daemon restart re-registers them over `~/.happy/daemon.sock`.

## What a machine needs

- `bun` (the daemon and its sessions run the prebuilt `packages/happy-cli/dist/index.bun.mjs`);
- Claude Code (`claude`) on `PATH` for claude sessions — a missing binary shows up when the first
  message is sent, as `Claude Code native binary not found at the configured path (ENOENT)`;
- a built CLI: `packages/happy-wire/dist` and `packages/happy-cli/dist` must exist, because the CLI
  bundle is built with `--packages external` and resolves them at runtime.

Build order, from the repo root:

```bash
bun install                                  # happy-app's postinstall 404 is ignorable
cd packages/happy-wire && bun x pkgroll      # or `npm run build` where node ≥ 18 exists
cd ../happy-cli && bun run build:bun
```

Two build traps worth knowing: a system `node` older than 18 cannot run the TypeScript toolchain
(the wire build fails inside `tsc`), and `bun install` hoists `ink` to the repo root, where it
resolves a different React than the CLI expects — move it to
`packages/happy-cli/node_modules/ink` after install.

## Installing, Linux (systemd user service)

```bash
cd packages/happy-cli
bun dist/index.bun.mjs auth login     # once per machine; see "Authentication"
bun dist/index.bun.mjs daemon install
```

`daemon install` writes and enables `~/.config/systemd/user/happy-daemon.service`, seeds
`~/.config/happy/daemon.env` (it is reused, not overwritten, on reinstall), enables user linger so
the daemon survives logout, and starts the service. The unit runs the daemon as the invoking user,
with `KillMode=process` (stopping the daemon does not kill sessions) and `OOMPolicy=continue` (an OOM
kill inside the unit does not stop the daemon).

## Installing, macOS (LaunchDaemon)

```bash
sudo bash packages/happy-cli/scripts/install-macos-daemon.sh
```

It backs up the LaunchAgent plist, removes it (an agent and a daemon with one label fight), installs
`/Library/LaunchDaemons/com.happy-cli.daemon.plist`, and bootstraps it in the system domain. The
plist runs as the user (`UserName=gnap`), not root, and deliberately carries no `ANTHROPIC_*`
credentials — those are injected per session from the profile. Rollback is printed by the script and
documented in `macos-daemon-launchd.md`.

## The env file: one source of truth

Linux reads `~/.config/happy/daemon.env`; the macOS plist carries the same keys. Both outlive the
daemon, so edits take effect with `systemctl --user restart happy-daemon` (Linux) or
`sudo launchctl kickstart -k system/happy-cli.daemon` (macOS).

Seeded keys: `HOME`, `HAPPY_HOME_DIR`, `HAPPY_PROJECT_ROOT`, `HAPPY_CLI_RUNTIME=bun`, `PATH`.
Optional keys a deployment may set:

| Key | Purpose |
|---|---|
| `HAPPY_SERVER_URL` | Defaults to the public server; set for a self-hosted one. |
| `HAPPY_LAN_ENABLED=true` | The LAN read API (and the relay client) only starts when this is on. |
| `HAPPY_RELAY_URL` | Relay used when the server is unreachable, e.g. `https://47.80.241.214`. |
| `HAPPY_DAEMON_HTTP_PORT` | Control port; default 55672. Set it when another process on the machine holds that port. |
| `HAPPY_LAN_PORT` | LAN API port; default 55673. |
| `HAPPY_DAEMON_SESSION_SCOPE=1` | Linux: spawn each session in its own systemd scope (`happy-sessions.slice`), so a session's runaway process cannot take the daemon or other sessions down. |

Do not put `ANTHROPIC_*` in the daemon env: credentials belong to the profile a session is started
with, so per-session models and keys stay per-session.

## Authentication

Each machine authenticates on its own — `~/.happy/access.key` must not be copied between machines.
`bun dist/index.bun.mjs auth login` offers a mobile QR (`happy://terminal?...`) and a web URL
(`https://app.happy.engineering/terminal/connect#key=...`); for a headless machine run it inside
`tmux` (the QR needs a TTY) and complete the web URL from any browser signed into the account.

## Verifying

Linux:

```bash
systemctl --user is-active happy-daemon
python3 -c "import json;d=json.load(open('$HOME/.happy/daemon.state.json'));print(d['startedWithCliVersion'], d['pid'])"
grep -E "Connected to server|relay.*registered|lan\] serving" "$(ls -t ~/.happy/logs/*daemon.log | head -1)" | tail
```

macOS:

```bash
launchctl print system/com.happy-cli.daemon | grep -E "state = |pid = "
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:55673/lan/ping   # 200
```

Then from the App create a session on the machine; the daemon log shows
`Spawning session in systemd scope …` (scope mode) or `Spawned process with PID …`, and the session
registers back over the unix socket. Relay health lists the machine:
`curl -s <relay>/health` → `{"daemons": N}` increments.

## Troubleshooting

- **Daemon restarts in a loop with `EADDRINUSE` on 55672** — another process on the machine owns the
  control port. Set `HAPPY_DAEMON_HTTP_PORT` (and `HAPPY_LAN_PORT` if 55673 is taken too) and restart.
- **Session spawns but never answers** — check for a missing `claude` (above) and for
  `Claude Code returned an error result` in the session log; an outdated Claude Code can also be
  rejected by the upstream API.
- **Machine shows offline while the daemon is running** — look at `[API MACHINE] Connection error`
  and `listChangedSessions … canceled` in the daemon log; a machine with no route to the server
  cannot refresh its record even though local sessions stay alive.
- **A session dies with `reason="signal: SIGTERM"` right after a heavy child process fails** — the
  child was OOM-killed inside the session's systemd scope and systemd stopped that scope. Expected
  in scope mode; the daemon itself is unaffected.
