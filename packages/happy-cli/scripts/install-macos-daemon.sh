#!/bin/bash
# Move the Happy daemon from the user's GUI domain (LaunchAgent) to the system domain (LaunchDaemon),
# so it starts at boot instead of at login. Run with sudo from a terminal.
set -euo pipefail

# Explicit, because this runs as root through an authorization prompt: $HOME would be
# /var/root and $(id -u) would be 0 — both would point at the wrong user.
TARGET_USER="gnap"
TARGET_UID=501
AGENT="/Users/gnap/Library/LaunchAgents/com.happy-cli.daemon.plist"
BACKUP="/tmp/com.happy-cli.daemon.agent.plist"
DAEMON="/Library/LaunchDaemons/com.happy-cli.daemon.plist"

echo "1/4 backing up the agent plist to $BACKUP"
cp "$AGENT" "$BACKUP"

echo "2/4 removing the agent (a daemon and an agent with one label would fight)"
launchctl bootout "gui/$TARGET_UID/com.happy-cli.daemon" 2>/dev/null || true
mv "$AGENT" "$AGENT.disabled"

echo "3/4 installing and starting the daemon"
install -m 644 -o root -g wheel /tmp/com.happy-cli.daemon.plist "$DAEMON"
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
