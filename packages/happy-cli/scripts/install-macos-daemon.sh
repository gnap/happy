#!/bin/bash
# Move the Happy daemon from the user's GUI domain (LaunchAgent) to the system domain (LaunchDaemon),
# so it starts at boot instead of at login. Run with sudo from a terminal.
#
# The daemon plist is GENERATED from the agent's, not copied: a system daemon needs a user and a
# group, and the credentials in the agent plist must not come along — sessions get those from the
# profile they are started with. See docs/daemon-deployment.md.
#
#   sudo bash packages/happy-cli/scripts/install-macos-daemon.sh
#   bash packages/happy-cli/scripts/install-macos-daemon.sh --dry-run   # write the plist to /tmp only
set -euo pipefail

# Explicit, because this runs as root through an authorization prompt: $HOME would be
# /var/root and $(id -u) would be 0 — both would point at the wrong user.
TARGET_USER="${HAPPY_DAEMON_USER:-gnap}"
TARGET_GROUP="${HAPPY_DAEMON_GROUP:-staff}"
TARGET_UID="${HAPPY_DAEMON_UID:-501}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"   # packages/happy-cli — what projectPath() returns

AGENT="/Users/$TARGET_USER/Library/LaunchAgents/com.happy-cli.daemon.plist"
DAEMON="/Library/LaunchDaemons/com.happy-cli.daemon.plist"
# mktemp, not fixed names: a previous run as root leaves root-owned files that this one
# (as the user) cannot overwrite.
GENERATED="$(mktemp /tmp/com.happy-cli.generated.XXXXXX)"
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

# Re-runnable: the first run moves the agent aside, so a second run has only the installed daemon
# plist to work from. It carries the same keys the transform touches (user, group, env), so
# regenerating from it is idempotent — which is what a redeploy after a code change needs.
SOURCE="$AGENT"
[ -f "$SOURCE" ] || SOURCE="$DAEMON"
if [ ! -f "$SOURCE" ]; then
  echo "Neither $AGENT nor $DAEMON exists — install the agent first (bin/happy.mjs daemon start)." >&2
  exit 1
fi

echo "1/4 generating the daemon plist from $SOURCE"
AGENT_JSON="$(mktemp /tmp/com.happy-cli.agent.XXXXXX)"
GENERATED_JSON="$(mktemp /tmp/com.happy-cli.daemon.XXXXXX)"
plutil -convert json -o "$AGENT_JSON" "$SOURCE"

HAPPY_DAEMON_USER="$TARGET_USER" HAPPY_DAEMON_GROUP="$TARGET_GROUP" \
HAPPY_PROJECT_ROOT="$PROJECT_ROOT" python3 - "$AGENT_JSON" "$GENERATED_JSON" <<'PY'
import json, os, sys

src, dst = sys.argv[1], sys.argv[2]
plist = json.load(open(src))

# A system daemon runs as whoever the plist names. Without these it would run as root, and the
# sessions it spawns would write root-owned files into the user's worktrees.
plist['UserName'] = os.environ['HAPPY_DAEMON_USER']
plist['GroupName'] = os.environ['HAPPY_DAEMON_GROUP']
# A daemon restart must not take its sessions with it. `detached: true` already separates
# them into their own process group; this stops launchd from reaping that group anyway.
plist['AbandonProcessGroup'] = True
# It spawns sessions and should not be throttled for doing so.
plist['ProcessType'] = 'Interactive'
plist['ThrottleInterval'] = 10

# Credentials belong to the profile a session is started with: per-session models and keys
# stay per-session, and the daemon env is world-readable in /Library/LaunchDaemons.
env = plist.get('EnvironmentVariables', {})
for key in [k for k in env if k.startswith(('ANTHROPIC_', 'DEEPSEEK_', 'CLAUDE_CODE_'))]:
    del env[key]
    print(f'  removed {key}')
# Locating the launcher by inference works under the agent, where the plist sits beside the
# install; a system daemon has no such relationship to its working directory.
env['HAPPY_PROJECT_ROOT'] = os.environ['HAPPY_PROJECT_ROOT']
plist['EnvironmentVariables'] = env

json.dump(plist, open(dst, 'w'), indent=2)
PY
plutil -convert xml1 -o "$GENERATED" "$GENERATED_JSON"

if [ "$DRY_RUN" = "1" ]; then
  echo "Dry run: wrote $GENERATED, nothing was installed or stopped."
  plutil -p "$GENERATED"
  exit 0
fi

echo "2/4 removing the agent (a daemon and an agent with one label would fight)"
launchctl bootout "gui/$TARGET_UID/com.happy-cli.daemon" 2>/dev/null || true
if [ -f "$AGENT" ]; then
  mv "$AGENT" "$AGENT.disabled"
else
  echo "  agent already removed"
fi

echo "3/4 installing and starting the daemon"
install -m 644 -o root -g wheel "$GENERATED" "$DAEMON"
launchctl bootout system/com.happy-cli.daemon 2>/dev/null || true
launchctl bootstrap system "$DAEMON"
launchctl enable system/com.happy-cli.daemon

echo "4/4 check"
sleep 3
launchctl print system/com.happy-cli.daemon | grep -E "state = |pid = |program = " | head -4
echo "sessions still running (they re-register with the new daemon over ~/.happy/daemon.sock):"
ps -eo pid,user,command | grep "index.bun.mjs claude" | grep -v grep | awk '{print $1, $2}' | head -6

cat <<ROLLBACK

Rollback, if needed:
  sudo launchctl bootout system/com.happy-cli.daemon
  sudo rm $DAEMON
  mv "$AGENT.disabled" "$AGENT"
  launchctl bootstrap gui/$TARGET_UID "$AGENT"
ROLLBACK
