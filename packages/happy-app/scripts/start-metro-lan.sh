#!/usr/bin/env bash
# Start Metro with LAN IP so devices (e.g. iPad) connect via 192.168.x.x
set -e
cd "$(dirname "$0")/.."

# Prefer en0 (Wi-Fi), then en1 (often Ethernet)
LAN_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)
if [ -z "$LAN_IP" ]; then
  echo "Could not detect LAN IP (tried en0, en1). Use start:metro:device for --lan discovery."
  exit 1
fi

echo "Metro bundler will use LAN IP: $LAN_IP"
echo "Devices should connect to: http://${LAN_IP}:8081"
export REACT_NATIVE_PACKAGER_HOSTNAME="$LAN_IP"
export APP_ENV=development
# Ensure session-protocol-only filtering in app (avoids duplicate bubbles when expoConfig.extra is missing in dev)
export EXPO_PUBLIC_ENABLE_SESSION_PROTOCOL_SEND=1
exec npx expo start --port 8081 --lan
