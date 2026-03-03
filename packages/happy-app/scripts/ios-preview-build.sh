#!/usr/bin/env bash
# Local preview build: Release build with APP_ENV=preview (JS bundled, no Metro).
# Uses ios-device-build.sh signing (personal team); bundle phase reads APP_ENV from .xcode.env.local.
# Prerequisites: device connected via USB, trusted, Developer Mode ON.
# Usage: ./scripts/ios-preview-build.sh [device-udid-or-name]
# Example: ./scripts/ios-preview-build.sh 00008140-001E55691160801C
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
IOS_DIR="$APP_DIR/ios"
ENV_LOCAL="$IOS_DIR/.xcode.env.local"
DEST="${1:-00008140-001E55691160801C}"

# So Xcode bundle phase builds with APP_ENV=preview
BACKUP=$(mktemp)
if [[ -f "$ENV_LOCAL" ]]; then
  cp "$ENV_LOCAL" "$BACKUP"
else
  touch "$BACKUP"
fi
echo "export APP_ENV=preview" >> "$ENV_LOCAL"
trap "mv \"$BACKUP\" \"$ENV_LOCAL\" 2>/dev/null || true" EXIT

echo "Building preview (Release, JS bundled, no Metro) for device: $DEST"
echo ""

"$SCRIPT_DIR/ios-device-build.sh" "$DEST" release

echo ""
echo "Done. App is installed; no Metro needed."
