#!/usr/bin/env bash
# Build the Preview app (Release), export an App Store IPA, and upload to TestFlight.
# No device registration needed (App Store distribution).
#
# Signing: archive with automatic development signing, then export with MANUAL
# signing using the Apple Distribution certificate + a pre-installed App Store
# profile. This bypasses the Xcode 26 account-session bug ("No Accounts" /
# "missing Xcode-Username") that makes -allowProvisioningUpdates unreliable.
#
# Upload: uses an App Store Connect API key via altool.
#
# Prerequisites (one-time):
#   - App record already created in App Store Connect for $BUNDLE_ID
#     (com.slopus.happy.preview.testflight — Happy(testflight))
#   - Apple Distribution certificate in the keychain (login.keychain)
#   - App Store provisioning profile installed at
#     ~/Library/Developer/Xcode/UserData/Provisioning Profiles/ (see PROFILE_NAME)
#   - App Store Connect API key placed at ~/.appstoreconnect/private_keys/
#       * Team key:       AuthKey_<KEYID>.p8   (set ASC_ISSUER_ID)
#       * Individual key: ApiKey_<KEYID>.p8    (leave ASC_ISSUER_ID empty)
#
# Usage:
#   ASC_API_KEY_ID=8GI5QGMK0445 ./scripts/ios-preview-testflight.sh
#   BUILD_NUMBER=4 ASC_API_KEY_ID=XXXX ./scripts/ios-preview-testflight.sh
set -euo pipefail

# --- Config (override via env) ---
export APP_ENV="${APP_ENV:-preview}"
DEVELOPMENT_TEAM="${DEVELOPMENT_TEAM:-77Y5JFSH6H}"
BUNDLE_ID="${BUNDLE_ID:-com.slopus.happy.preview.testflight}"
# App Store provisioning profile name (manually created in Developer Portal;
# must have IsXcodeManaged=false for manual signing). Installed at
# ~/Library/Developer/Xcode/UserData/Provisioning Profiles/.
PROFILE_NAME="${PROFILE_NAME:-happy_preview}"
ASC_API_KEY_ID="${ASC_API_KEY_ID:?Set ASC_API_KEY_ID to your App Store Connect API key id}"
ASC_ISSUER_ID="${ASC_ISSUER_ID:-}"   # empty => individual key (uses --api-key-subject user)
MARKETING_VERSION="${MARKETING_VERSION:-1.6.2}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Auto-increment build number from a local counter (1, 2, 3, ...). Never a
# timestamp — App Store Connect rejects duplicate/non-integer CFBundleVersion.
# Set BUILD_NUMBER explicitly to override. The counter is persisted only after
# a successful upload, so a failed build does not consume a number.
BUILD_NUMBER_FILE="$SCRIPT_DIR/.preview-build-number"
if [[ -z "${BUILD_NUMBER:-}" ]]; then
    local_last=1
    [[ -f "$BUILD_NUMBER_FILE" ]] && local_last=$(cat "$BUILD_NUMBER_FILE" 2>/dev/null || echo 1)
    BUILD_NUMBER=$((local_last + 1))
fi
IOS_DIR="$APP_DIR/ios"
ARCHIVE_PATH="$IOS_DIR/build/Happypreview.xcarchive"
EXPORT_DIR="$IOS_DIR/build/export"
EXPORT_PLIST="$IOS_DIR/build/ExportOptions-appstore.plist"

# --- Prebuild if native project is missing (or RUN_PREBUILD=1) ---
if [[ ! -d "$IOS_DIR/Happypreview.xcodeproj" ]] || [[ "${RUN_PREBUILD:-0}" == "1" ]]; then
  echo "==> Prebuild (APP_ENV=$APP_ENV)"
  (cd "$APP_DIR" && rm -rf ios && APP_ENV="$APP_ENV" yarn prebuild --platform ios)
  (cd "$IOS_DIR" && pod install)
fi

cd "$IOS_DIR"
mkdir -p "$IOS_DIR/build"

# RevenueCat 5.55.3 doesn't compile under Swift 6.4 (Xcode 27). Lives in ios/Pods/,
# so it must be re-applied after every pod install.
bash "$SCRIPT_DIR/patch-revenuecat-swift64.sh"

# Force build number + version into Info.plist. Prebuild hardcodes CFBundleVersion
# to '1', and xcodebuild's CURRENT_PROJECT_VERSION flag does not override a
# hardcoded plist value. Without this every upload collides with build '1'.
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $BUILD_NUMBER" "$IOS_DIR/Happypreview/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $MARKETING_VERSION" "$IOS_DIR/Happypreview/Info.plist"

# Self-contained signing keychain: an unlocked keychain created from the exported
# certificate + key, so signing never depends on the login keychain (which may be locked
# and cannot be unlocked from a daemon-spawned session). Same setup as
# ios-dev-testflight.sh.
SIGN_KEYCHAIN="$HOME/Library/Keychains/happy-build.keychain-db"
EXTRA_SIGN_ARGS=()
ARCHIVED_UNSIGNED=0
if [[ -f "$SIGN_KEYCHAIN" ]]; then
  security unlock-keychain -p "" "$SIGN_KEYCHAIN" 2>/dev/null || true
  security list-keychains -d user -s "$SIGN_KEYCHAIN" "$HOME/Library/Keychains/login.keychain-db" /Library/Keychains/System.keychain
  # Archive unsigned and sign at export. Command-line signing settings apply to every
  # target in the workspace, and Swift packages (RaTeX) refuse a provisioning profile —
  # `RaTeX_RaTeX does not support provisioning profiles`. The export step re-signs the
  # whole app (frames included) with the distribution identity and the profile.
  EXTRA_SIGN_ARGS=(
    CODE_SIGNING_ALLOWED=NO
    CODE_SIGNING_REQUIRED=NO
  )
  ARCHIVED_UNSIGNED=1
  echo "==> Signing keychain: $SIGN_KEYCHAIN"
fi

echo "==> Archiving Happypreview (Release) team=$DEVELOPMENT_TEAM bundle=$BUNDLE_ID version=$MARKETING_VERSION build=$BUILD_NUMBER"
xcodebuild -workspace Happypreview.xcworkspace -scheme Happypreview \
  -configuration Release \
  -destination "generic/platform=iOS" \
  -archivePath "$ARCHIVE_PATH" \
  -derivedDataPath build \
  -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$DEVELOPMENT_TEAM" \
  PRODUCT_BUNDLE_IDENTIFIER="$BUNDLE_ID" \
  CODE_SIGN_STYLE=Automatic \
  MARKETING_VERSION="$MARKETING_VERSION" \
  CURRENT_PROJECT_VERSION="$BUILD_NUMBER" \
  ${EXTRA_SIGN_ARGS[@]+"${EXTRA_SIGN_ARGS[@]}"} \
  archive

echo "==> Exporting App Store IPA"
# Manual signing: use the distribution certificate + App Store profile directly,
# bypassing Xcode's account credential lookup (which fails with "No Accounts" /
# "missing Xcode-Username" on Xcode 26 when the keychain session is incomplete).
cat > "$EXPORT_PLIST" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>method</key>
	<string>app-store-connect</string>
	<key>teamID</key>
	<string>$DEVELOPMENT_TEAM</string>
	<key>signingStyle</key>
	<string>manual</string>
	<key>signingCertificate</key>
	<string>Apple Distribution</string>
	<key>provisioningProfiles</key>
	<dict>
		<key>$BUNDLE_ID</key>
		<string>$PROFILE_NAME</string>
	</dict>
	<key>uploadSymbols</key>
	<true/>
	<key>destination</key>
	<string>export</string>
</dict>
</plist>
EOF

rm -rf "$EXPORT_DIR"
xcodebuild -exportArchive \
  -archivePath "$ARCHIVE_PATH" \
  -exportPath "$EXPORT_DIR" \
  -exportOptionsPlist "$EXPORT_PLIST"

IPA_PATH="$EXPORT_DIR/Happypreview.ipa"
[[ -f "$IPA_PATH" ]] || { echo "Error: IPA not found at $IPA_PATH"; exit 1; }

if [[ "$ARCHIVED_UNSIGNED" == "1" ]]; then
  # The archive carried no signature (see the signing-keychain block above), so
  # exportArchive built the entitlement set from an empty base: it keeps what the
  # profile grants generically but drops the capabilities the app declares itself
  # (aps-environment, associated-domains) — silently disabling push notifications.
  # Merge the app's entitlements file back in, re-sign with the same distribution
  # identity, and repack the IPA.
  echo "==> Re-applying app entitlements (unsigned archive)"
  # exportArchive leaves only the .ipa, so unpack it, re-sign the bundle, repack.
  WORK_DIR="$EXPORT_DIR/resigned"
  rm -rf "$WORK_DIR"
  mkdir -p "$WORK_DIR"
  ( cd "$WORK_DIR" && unzip -q "$IPA_PATH" )

  APP_BUNDLE="$WORK_DIR/Payload/Happypreview.app"
  [[ -d "$APP_BUNDLE" ]] || { echo "Error: exported app not found at $APP_BUNDLE"; exit 1; }
  DIST_IDENTITY="$(security find-identity -v -p codesigning "$SIGN_KEYCHAIN" | grep -oE '[A-F0-9]{40}' | head -1)"
  [[ -n "$DIST_IDENTITY" ]] || { echo "Error: no distribution identity in $SIGN_KEYCHAIN"; exit 1; }

  codesign -d --entitlements :- "$APP_BUNDLE" > "$WORK_DIR/entitlements-current.plist" 2>/dev/null || true
  python3 - "$WORK_DIR/entitlements-current.plist" "$IOS_DIR/Happypreview/Happypreview.entitlements" "$WORK_DIR/entitlements-merged.plist" <<'PY'
import plistlib, sys

current_path, declared_path, out_path = sys.argv[1:4]

def load(path):
    try:
        with open(path, 'rb') as f:
            data = plistlib.load(f)
            return data if isinstance(data, dict) else {}
    except Exception:
        return {}

merged = load(current_path)
# The declared file wins for the capabilities it names; anything the profile already
# put in the signature is kept.
for key, value in load(declared_path).items():
    merged[key] = value

with open(out_path, 'wb') as f:
    plistlib.dump(merged, f)
PY

  codesign --force --sign "$DIST_IDENTITY" \
    --entitlements "$WORK_DIR/entitlements-merged.plist" \
    --preserve-metadata=identifier,flags,runtime,launch-constraints,library-constraints \
    --generate-entitlement-der \
    "$APP_BUNDLE"

  # Repack so the uploaded IPA carries the re-signed bundle.
  rm -f "$IPA_PATH"
  ( cd "$WORK_DIR" && zip -qry "$IPA_PATH" Payload )

  if ! codesign -d --entitlements - "$APP_BUNDLE" 2>/dev/null | grep -q "aps-environment"; then
    echo "Error: aps-environment missing after re-sign — refusing to upload"
    exit 1
  fi
  echo "    aps-environment restored"
fi

echo "==> Uploading to TestFlight ($IPA_PATH)"
if [[ -n "$ASC_ISSUER_ID" ]]; then
  # Team key
  xcrun altool --upload-app -f "$IPA_PATH" -t ios \
    --apiKey "$ASC_API_KEY_ID" --apiIssuer "$ASC_ISSUER_ID"
else
  # Individual key (no issuer id): pass key id as placeholder issuer + subject user
  xcrun altool --upload-app -f "$IPA_PATH" -t ios \
    --apiKey "$ASC_API_KEY_ID" --apiIssuer "$ASC_API_KEY_ID" --api-key-subject user
fi

# Persist the build number only after a successful upload (set -e aborts on failure).
echo "$BUILD_NUMBER" > "$BUILD_NUMBER_FILE"

echo ""
echo "Done. Build $MARKETING_VERSION ($BUILD_NUMBER) uploaded to TestFlight for $BUNDLE_ID."
echo "It will appear in App Store Connect > TestFlight after processing (a few minutes)."
