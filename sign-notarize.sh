#!/bin/bash
# Sign and notarize CodeV for non-App Store distribution
# Prerequisites:
#   1. "Developer ID Application" certificate in Keychain
#   2. Environment variables or .env file: APPLE_ID, APPLE_APP_PASSWORD, APPLE_TEAM_ID

set -e

# Load env vars
if [ -f .env ]; then
  export $(grep -E '^(APPLE_ID|APPLE_APP_PASSWORD|APPLE_TEAM_ID)=' .env | xargs)
fi

if [ -z "$APPLE_ID" ] || [ -z "$APPLE_APP_PASSWORD" ] || [ -z "$APPLE_TEAM_ID" ]; then
  echo "Error: Missing APPLE_ID, APPLE_APP_PASSWORD, or APPLE_TEAM_ID in environment or .env"
  exit 1
fi

APP="CodeV"
APP_PATH="./out/CodeV-darwin-arm64/CodeV.app"
DMG_PATH="./out/CodeV.dmg"
SIGN_KEY="Developer ID Application: Kang Teng-Chieh ($APPLE_TEAM_ID)"
ENTITLEMENTS="./notarize-parent.plist"
CHILD_ENTITLEMENTS="./notarize-child.plist"
FRAMEWORKS_PATH="$APP_PATH/Contents/Frameworks"

if [ ! -d "$APP_PATH" ]; then
  echo "Error: $APP_PATH not found. Run 'yarn make' first."
  exit 1
fi

echo "=== Step 1: Signing app with Developer ID ==="

# Sign frameworks
codesign -s "$SIGN_KEY" -f --options runtime --entitlements "$CHILD_ENTITLEMENTS" "$FRAMEWORKS_PATH/Electron Framework.framework/Versions/A/Electron Framework"
codesign -s "$SIGN_KEY" -f --options runtime --entitlements "$CHILD_ENTITLEMENTS" "$FRAMEWORKS_PATH/Electron Framework.framework/Versions/A/Libraries/libffmpeg.dylib"
codesign -s "$SIGN_KEY" -f --options runtime --entitlements "$CHILD_ENTITLEMENTS" "$FRAMEWORKS_PATH/Electron Framework.framework/Versions/A/Libraries/libEGL.dylib"
codesign -s "$SIGN_KEY" -f --options runtime --entitlements "$CHILD_ENTITLEMENTS" "$FRAMEWORKS_PATH/Electron Framework.framework/Versions/A/Libraries/libGLESv2.dylib"
codesign -s "$SIGN_KEY" -f --options runtime --entitlements "$CHILD_ENTITLEMENTS" "$FRAMEWORKS_PATH/Electron Framework.framework/Versions/A/Libraries/libvk_swiftshader.dylib"
codesign -s "$SIGN_KEY" -f --options runtime --entitlements "$CHILD_ENTITLEMENTS" "$FRAMEWORKS_PATH/Electron Framework.framework/Versions/A/Helpers/chrome_crashpad_handler"
codesign -s "$SIGN_KEY" -f --options runtime --entitlements "$CHILD_ENTITLEMENTS" "$FRAMEWORKS_PATH/Electron Framework.framework"

# Sign non-MAS specific frameworks (Squirrel auto-updater)
if [ -d "$FRAMEWORKS_PATH/Mantle.framework" ]; then
  codesign -s "$SIGN_KEY" -f --options runtime --entitlements "$CHILD_ENTITLEMENTS" "$FRAMEWORKS_PATH/Mantle.framework/Versions/A/Mantle"
  codesign -s "$SIGN_KEY" -f --options runtime --entitlements "$CHILD_ENTITLEMENTS" "$FRAMEWORKS_PATH/Mantle.framework"
fi
if [ -d "$FRAMEWORKS_PATH/ReactiveObjC.framework" ]; then
  codesign -s "$SIGN_KEY" -f --options runtime --entitlements "$CHILD_ENTITLEMENTS" "$FRAMEWORKS_PATH/ReactiveObjC.framework/Versions/A/ReactiveObjC"
  codesign -s "$SIGN_KEY" -f --options runtime --entitlements "$CHILD_ENTITLEMENTS" "$FRAMEWORKS_PATH/ReactiveObjC.framework"
fi
if [ -d "$FRAMEWORKS_PATH/Squirrel.framework" ]; then
  codesign -s "$SIGN_KEY" -f --options runtime --entitlements "$CHILD_ENTITLEMENTS" "$FRAMEWORKS_PATH/Squirrel.framework/Versions/A/Squirrel"
  codesign -s "$SIGN_KEY" -f --options runtime --entitlements "$CHILD_ENTITLEMENTS" "$FRAMEWORKS_PATH/Squirrel.framework/Versions/A/Resources/ShipIt"
  codesign -s "$SIGN_KEY" -f --options runtime --entitlements "$CHILD_ENTITLEMENTS" "$FRAMEWORKS_PATH/Squirrel.framework"
fi

# Sign helpers
codesign -s "$SIGN_KEY" -f --options runtime --entitlements "$CHILD_ENTITLEMENTS" "$FRAMEWORKS_PATH/$APP Helper.app/Contents/MacOS/$APP Helper"
codesign -s "$SIGN_KEY" -f --options runtime --entitlements "$CHILD_ENTITLEMENTS" "$FRAMEWORKS_PATH/$APP Helper.app/"
codesign -s "$SIGN_KEY" -f --options runtime --entitlements "$CHILD_ENTITLEMENTS" "$FRAMEWORKS_PATH/$APP Helper (GPU).app/Contents/MacOS/$APP Helper (GPU)"
codesign -s "$SIGN_KEY" -f --options runtime --entitlements "$CHILD_ENTITLEMENTS" "$FRAMEWORKS_PATH/$APP Helper (GPU).app/"
codesign -s "$SIGN_KEY" -f --options runtime --entitlements "$CHILD_ENTITLEMENTS" "$FRAMEWORKS_PATH/$APP Helper (Plugin).app/Contents/MacOS/$APP Helper (Plugin)"
codesign -s "$SIGN_KEY" -f --options runtime --entitlements "$CHILD_ENTITLEMENTS" "$FRAMEWORKS_PATH/$APP Helper (Plugin).app/"
codesign -s "$SIGN_KEY" -f --options runtime --entitlements "$CHILD_ENTITLEMENTS" "$FRAMEWORKS_PATH/$APP Helper (Renderer).app/Contents/MacOS/$APP Helper (Renderer)"
codesign -s "$SIGN_KEY" -f --options runtime --entitlements "$CHILD_ENTITLEMENTS" "$FRAMEWORKS_PATH/$APP Helper (Renderer).app/"

# Sign Login Helper (may not exist in non-MAS builds)
if [ -d "$APP_PATH/Contents/Library/LoginItems/$APP Login Helper.app" ]; then
  codesign -s "$SIGN_KEY" -f --options runtime --entitlements "$CHILD_ENTITLEMENTS" "$APP_PATH/Contents/Library/LoginItems/$APP Login Helper.app/Contents/MacOS/$APP Login Helper"
  codesign -s "$SIGN_KEY" -f --options runtime --entitlements "$CHILD_ENTITLEMENTS" "$APP_PATH/Contents/Library/LoginItems/$APP Login Helper.app/"
fi

# Sign native modules / resources (skip if not found)
for f in \
  "$APP_PATH/Contents/Resources/migration-engine-darwin" \
  "$APP_PATH/Contents/Resources/prisma/build/index.js" \
  "$APP_PATH/Contents/Resources/prisma/libquery_engine-darwin-arm64.dylib.node" \
  "$APP_PATH/Contents/Resources/app/.webpack/main/native_modules/client/libquery_engine-darwin-arm64.dylib.node" \
  "$APP_PATH/Contents/Resources/app/.webpack/main/native_modules/build/Release/better_sqlite3.node"; do
  if [ -f "$f" ]; then
    codesign -s "$SIGN_KEY" -f --options runtime --entitlements "$CHILD_ENTITLEMENTS" "$f"
  else
    echo "Warning: $f not found, skipping"
  fi
done

# Sign main binary and app bundle
codesign -s "$SIGN_KEY" -f --options runtime --entitlements "$CHILD_ENTITLEMENTS" "$APP_PATH/Contents/MacOS/$APP"
codesign -s "$SIGN_KEY" -f --options runtime --entitlements "$ENTITLEMENTS" "$APP_PATH"

echo "=== Step 2: Verifying signature ==="
codesign --verify --deep --strict "$APP_PATH"
echo "Signature verified OK"

echo "=== Step 3: Creating DMG ==="
rm -f "$DMG_PATH"
create-dmg \
  --volname "$APP" \
  --window-pos 200 120 \
  --window-size 600 400 \
  --icon-size 128 \
  --icon "$APP.app" 150 185 \
  --app-drop-link 450 185 \
  "$DMG_PATH" \
  "$APP_PATH"
codesign -s "$SIGN_KEY" "$DMG_PATH"
echo "DMG created at $DMG_PATH"

echo "=== Step 4: Submitting for notarization ==="
xcrun notarytool submit "$DMG_PATH" \
  --apple-id "$APPLE_ID" \
  --team-id "$APPLE_TEAM_ID" \
  --password "$APPLE_APP_PASSWORD" \
  --wait

echo "=== Step 5: Stapling ticket ==="
xcrun stapler staple "$DMG_PATH"

echo "=== Done! ==="
echo "Notarized DMG: $DMG_PATH"
