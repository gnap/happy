#!/usr/bin/env bash
# Debug build + Metro for device: builds with Mac IP so the app connects to Metro,
# installs to device, then starts Metro. Run from repo root or packages/happy-app.
#
# Usage: ./scripts/ios-device-debug.sh [device-udid]
# Prerequisites: device connected via USB, trusted, Developer Mode ON. Same WiFi as Mac.
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
IOS_DIR="$APP_DIR/ios"
ENV_LOCAL="$IOS_DIR/.xcode.env.local"
DEST="${1:-00008140-001E55691160801C}"

# Get Mac LAN IP so the app can connect to Metro from the device
METRO_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)
if [[ -z "$METRO_IP" ]]; then
  for iface in en0 en1 en2; do
    METRO_IP=$(ipconfig getifaddr "$iface" 2>/dev/null) && break
  done
fi
if [[ -z "$METRO_IP" ]]; then
  echo "Error: could not get Mac LAN IP. Ensure WiFi is on and connected."
  exit 1
fi

echo "=== 1/2 Building Debug (packager host $METRO_IP) and installing to device: $DEST ==="
# Bake Mac IP into the app so it connects to Metro on this machine
BACKUP=$(mktemp)
if [[ -f "$ENV_LOCAL" ]]; then cp "$ENV_LOCAL" "$BACKUP"; else touch "$BACKUP"; fi
echo "export REACT_NATIVE_PACKAGER_HOSTNAME=$METRO_IP" > "$ENV_LOCAL"
trap "mv \"$BACKUP\" \"$ENV_LOCAL\" 2>/dev/null || true" EXIT

"$SCRIPT_DIR/ios-device-build.sh" "$DEST"
trap - EXIT
mv "$BACKUP" "$ENV_LOCAL" 2>/dev/null || true

echo ""
# Prefer WiFi (en0), then en1; fallback to first non-loopback from 'ipconfig getifaddr'
METRO_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)
if [[ -z "$METRO_IP" ]]; then
  for iface in en0 en1 en2; do
    METRO_IP=$(ipconfig getifaddr "$iface" 2>/dev/null) && break
  done
fi
METRO_ADDRESS="${METRO_IP:-<你的 Mac 局域网 IP>}:8081"
echo "=== 2/2 Starting Metro (JS bundle server) ==="
echo ""
echo "  Metro 地址: $METRO_ADDRESS"
echo "  设备上若提示输入 Bundler URL，就填: http://$METRO_ADDRESS"
echo ""
echo "  若设备连不上 Metro："
echo "  • 设备与 Mac 连同一 WiFi"
echo "  • 设备弹窗「允许访问本地网络」请点「允许」"
echo "  • Mac：系统设置 → 网络 → 防火墙 → 允许 node 入站，或关闭防火墙测试"
echo ""
echo "Keep this terminal open, then open the Happy (dev) app on your device."
echo ""
# Free port 8081 so Metro can start (avoid "Port 8081 is running in another window" in non-interactive mode)
if lsof -ti:8081 >/dev/null 2>&1; then
  echo "Stopping existing process on port 8081..."
  lsof -ti:8081 | xargs kill -9 2>/dev/null || true
  sleep 2
fi
cd "$APP_DIR"
exec yarn start:metro:device
