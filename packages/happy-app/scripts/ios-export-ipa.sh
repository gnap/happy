#!/usr/bin/env bash
# Build Release and export an IPA (no device needed).
# Uses same signing as ios-device-build.sh: personal team WNNK7EH57R by default.
# Output: ios/build/Happydev.ipa (and .xcarchive in build/)
# Install: connect device → Finder → drag IPA to device, or: xcrun devicectl device install app --device <UDID> Happydev.ipa
set -e
export DEVELOPMENT_TEAM="${DEVELOPMENT_TEAM:-WNNK7EH57R}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
IOS_DIR="$APP_DIR/ios"
ARCHIVE_PATH="$IOS_DIR/build/Happydev.xcarchive"
EXPORT_PATH="$IOS_DIR/build"
EXPORT_PLIST="$IOS_DIR/build/ExportOptions-development.plist"
cd "$IOS_DIR"
mkdir -p "$IOS_DIR/build"
# Generate plist so teamID matches DEVELOPMENT_TEAM
cat > "$EXPORT_PLIST" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>method</key>
	<string>development</string>
	<key>teamID</key>
	<string>$DEVELOPMENT_TEAM</string>
	<key>signingStyle</key>
	<string>automatic</string>
</dict>
</plist>
EOF

# Personal team: same bundle ID and entitlements as device build
if [[ "$DEVELOPMENT_TEAM" == "WNNK7EH57R" ]]; then
  CODE_SIGN_ENTITLEMENTS_ARG="CODE_SIGN_ENTITLEMENTS=Happydev/Happydev-NoPush.entitlements"
  BUNDLE_ID_ARG="PRODUCT_BUNDLE_IDENTIFIER=com.slopus.happy.dev.personal"
else
  CODE_SIGN_ENTITLEMENTS_ARG=""
  BUNDLE_ID_ARG=""
fi

echo "Building Happydev (Release) for archive (team: $DEVELOPMENT_TEAM)"
echo ""

xcodebuild -workspace Happydev.xcworkspace -scheme Happydev \
  -destination "generic/platform=iOS" \
  -configuration Release \
  -derivedDataPath build \
  -archivePath "$ARCHIVE_PATH" \
  -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$DEVELOPMENT_TEAM" \
  $BUNDLE_ID_ARG \
  $CODE_SIGN_ENTITLEMENTS_ARG \
  archive

echo ""
echo "Exporting IPA..."
# ExportOptions-development.plist uses teamID WNNK7EH57R; override if you set DEVELOPMENT_TEAM
xcodebuild -exportArchive \
  -archivePath "$ARCHIVE_PATH" \
  -exportPath "$EXPORT_PATH" \
  -exportOptionsPlist "$EXPORT_PLIST" \
  -allowProvisioningUpdates

IPA_PATH="$EXPORT_PATH/Happydev.ipa"
if [[ ! -f "$IPA_PATH" ]]; then
  echo "Error: IPA not found at $IPA_PATH"
  exit 1
fi
echo ""
echo "Done. IPA: $IPA_PATH"
echo "Install: connect device, then: xcrun devicectl device install app --device <UDID> \"$IPA_PATH\""
echo "Or drag the IPA onto the device in Finder."
