#!/usr/bin/env bash
# Start Metro so devices on the LAN (e.g. the iPad) can reach it, advertising a Bonjour name
# rather than an address.
#
# Why the name and not the IP: Metro hands the packager hostname back to clients as the address to
# fetch bundles from, and it is read once, at startup, into the process environment. So after a
# DHCP lease change (192.168.31.75 -> .231) a device that reaches Metro perfectly well is still
# told to load from the address that no longer exists — which presents as "the dev client cannot
# connect" while Metro is completely healthy, and the only fix is restarting Metro. The `.local`
# name resolves through Bonjour — the same stack the app's own LAN discovery uses — so it survives
# the address changing.
set -e
cd "$(dirname "$0")/.."

# Only used for the informational line and as a fallback when no name is available.
LAN_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)
LAN_HOST="$(scutil --get LocalHostName 2>/dev/null || true)"
if [ -n "$LAN_HOST" ]; then
  LAN_HOST="${LAN_HOST}.local"
else
  LAN_HOST="$LAN_IP"
fi

if [ -z "$LAN_HOST" ]; then
  echo "Could not determine a Bonjour name or LAN IP to advertise."
  exit 1
fi

echo "Metro bundler will advertise: $LAN_HOST"
echo "Devices should connect to: http://${LAN_HOST}:8081"
if [ -n "$LAN_IP" ] && [ "$LAN_IP" != "$LAN_HOST" ]; then
  echo "  (this machine's LAN IP is currently ${LAN_IP} — the name above avoids depending on it)"
fi
export REACT_NATIVE_PACKAGER_HOSTNAME="$LAN_HOST"
export APP_ENV=development
# Ensure session-protocol-only filtering in app (avoids duplicate bubbles when expoConfig.extra is missing in dev)
export EXPO_PUBLIC_ENABLE_SESSION_PROTOCOL_SEND=1
exec npx expo start --port 8081 --lan
