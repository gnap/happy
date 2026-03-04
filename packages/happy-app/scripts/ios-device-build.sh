#!/usr/bin/env bash
# Build and install the development variant to a connected iPhone/iPad.
# Prerequisites:
#   - Device connected via USB
#   - Developer Mode ON: Settings → Privacy & Security → Developer Mode
#   - Device trusted (unlock and tap Trust if prompted)
#   - DEVELOPMENT_TEAM: defaults to personal team (WNNK7EH57R). Override with env if needed.
set -e
export DEVELOPMENT_TEAM="${DEVELOPMENT_TEAM:-WNNK7EH57R}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
IOS_DIR="$APP_DIR/ios"
# Monorepo root (for yarn workspaces)
ROOT_DIR="$(cd "$APP_DIR/../.." && pwd)"

# Install yarn dependencies before build (so node_modules and patches are up to date)
if [[ -f "$ROOT_DIR/package.json" ]]; then
  echo "Installing yarn dependencies..."
  (cd "$ROOT_DIR" && yarn install)
  echo ""
fi

# Prebuild: regenerate native ios/android from app config (optional; set RUN_PREBUILD=1 to enable).
# Skip by default because prebuild overwrites custom ios files (e.g. Happydev-NoPush.entitlements).
if [[ "$RUN_PREBUILD" == "1" ]]; then
  echo "Running prebuild (expo prebuild)..."
  (cd "$APP_DIR" && yarn prebuild)
  echo ""
fi

cd "$IOS_DIR"

# Use device name or UDID. Example: ./ios-device-build.sh 00008140-001E55691160801C
# Optional second arg: "release" or "--release" → build Release and install to device.
DEST="${1:-00008140-001E55691160801C}"
if [[ "$2" == "release" || "$2" == "--release" ]]; then
  BUILD_CONFIG="Release"
else
  BUILD_CONFIG="Debug"
fi

if [[ "$DEST" =~ ^[0-9A-Fa-f-]+$ ]]; then
  DEST_SPEC="id=$DEST"
else
  DEST_SPEC="name=$DEST"
fi

# Personal team: use a distinct bundle ID (com.slopus.happy.dev is taken by org) and no-push entitlements.
if [[ "$DEVELOPMENT_TEAM" == "WNNK7EH57R" ]]; then
  CODE_SIGN_ENTITLEMENTS_ARG="CODE_SIGN_ENTITLEMENTS=Happydev/Happydev-NoPush.entitlements"
  BUNDLE_ID_ARG="PRODUCT_BUNDLE_IDENTIFIER=com.slopus.happy.dev.personal"
else
  CODE_SIGN_ENTITLEMENTS_ARG=""
  BUNDLE_ID_ARG=""
fi

echo "Building Happydev ($BUILD_CONFIG) for device: $DEST (team: $DEVELOPMENT_TEAM)"
echo ""

xcodebuild -workspace Happydev.xcworkspace -scheme Happydev \
  -destination "$DEST_SPEC" \
  -configuration "$BUILD_CONFIG" \
  -derivedDataPath build \
  -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$DEVELOPMENT_TEAM" \
  $BUNDLE_ID_ARG \
  $CODE_SIGN_ENTITLEMENTS_ARG \
  build

APP_PATH="$IOS_DIR/build/Build/Products/${BUILD_CONFIG}-iphoneos/Happydev.app"
if [[ ! -d "$APP_PATH" ]]; then
  echo "Error: .app not found at $APP_PATH"
  exit 1
fi

echo ""
echo "Installing to device..."
xcrun devicectl device install app --device "$DEST" "$APP_PATH"
echo "Done. Open the Happy (dev) app on your device."
if [[ "$BUILD_CONFIG" == "Debug" ]]; then
  echo "Start Metro (yarn start:metro or start:metro:loop) and enter your Mac IP:8081 if prompted."
fi
