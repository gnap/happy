#!/usr/bin/env bash
# Build and install the Preview app (Release) to a connected iPhone/iPad.
# Uses prebuild with APP_ENV=preview (bundle com.slopus.happy.preview, scheme Happypreview).
# Prerequisites: same as ios-device-build.sh (device USB, Developer Mode, trust).
# Usage: ./scripts/ios-preview-device-build.sh [device-udid-or-name] [release|--release]
set -e
export DEVELOPMENT_TEAM="${DEVELOPMENT_TEAM:-WNNK7EH57R}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
IOS_DIR="$APP_DIR/ios"
ROOT_DIR="$(cd "$APP_DIR/../.." && pwd)"

if [[ -f "$ROOT_DIR/package.json" ]]; then
  echo "Installing yarn dependencies..."
  (cd "$ROOT_DIR" && yarn install)
  echo ""
fi

# Prebuild for Preview (generates ios with Happypreview scheme and com.slopus.happy.preview)
if [[ ! -d "$IOS_DIR/Happypreview.xcodeproj" ]] || [[ "$RUN_PREBUILD" == "1" ]]; then
  echo "Running prebuild for Preview (APP_ENV=preview)..."
  (cd "$APP_DIR" && rm -rf ios && APP_ENV=preview yarn prebuild --platform ios)
  (cd "$IOS_DIR" && pod install)
  echo ""
fi

# Ensure NoPush entitlements exist for personal team (prebuild does not create it)
if [[ ! -f "$IOS_DIR/Happypreview/Happypreview-NoPush.entitlements" ]]; then
  mkdir -p "$IOS_DIR/Happypreview"
  cp "$SCRIPT_DIR/entitlements/Happypreview-NoPush.entitlements" "$IOS_DIR/Happypreview/Happypreview-NoPush.entitlements"
fi

cd "$IOS_DIR"

DEST="${1:-00008140-001E55691160801C}"
if [[ "$2" == "release" || "$2" == "--release" ]]; then
  BUILD_CONFIG="Release"
else
  BUILD_CONFIG="Release"
fi

if [[ "$DEST" =~ ^[0-9A-Fa-f-]+$ ]]; then
  DEST_SPEC="id=$DEST"
else
  DEST_SPEC="name=$DEST"
fi

# Personal team: use .personal bundle ID (so profile exists) and no-push entitlements
if [[ "$DEVELOPMENT_TEAM" == "WNNK7EH57R" ]]; then
  CODE_SIGN_ENTITLEMENTS_ARG="CODE_SIGN_ENTITLEMENTS=Happypreview/Happypreview-NoPush.entitlements"
  BUNDLE_ID_ARG="PRODUCT_BUNDLE_IDENTIFIER=com.slopus.happy.preview.personal"
else
  CODE_SIGN_ENTITLEMENTS_ARG=""
  BUNDLE_ID_ARG=""
fi

echo "Building Happypreview ($BUILD_CONFIG) for device: $DEST (team: $DEVELOPMENT_TEAM)"
echo ""

xcodebuild -workspace Happypreview.xcworkspace -scheme Happypreview \
  -destination "$DEST_SPEC" \
  -configuration "$BUILD_CONFIG" \
  -derivedDataPath build \
  -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$DEVELOPMENT_TEAM" \
  $BUNDLE_ID_ARG \
  $CODE_SIGN_ENTITLEMENTS_ARG \
  build

APP_PATH="$IOS_DIR/build/Build/Products/${BUILD_CONFIG}-iphoneos/Happypreview.app"
if [[ ! -d "$APP_PATH" ]]; then
  echo "Error: .app not found at $APP_PATH"
  exit 1
fi

echo ""
echo "Installing to device..."
xcrun devicectl device install app --device "$DEST" "$APP_PATH"
echo "Done. Open the Happy (preview) app on your device."
