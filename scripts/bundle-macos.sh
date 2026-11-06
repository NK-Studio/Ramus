#!/bin/sh
# target/<profile>/ramus 를 macOS 앱 번들(Ramus.app)로 감싼다. 사용: scripts/bundle-macos.sh [debug|release]
set -e
PROFILE="${1:-debug}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ "$PROFILE" = "release" ]; then cargo build --release --manifest-path "$ROOT/Cargo.toml"; else cargo build --manifest-path "$ROOT/Cargo.toml"; fi
VERSION="$(sed -n 's/^version = "\(.*\)"/\1/p' "$ROOT/Cargo.toml" | head -1)"
APP="$ROOT/target/$PROFILE/Ramus.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$ROOT/target/$PROFILE/ramus" "$APP/Contents/MacOS/ramus"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Ramus</string>
  <key>CFBundleDisplayName</key><string>Ramus</string>
  <key>CFBundleIdentifier</key><string>com.nkstudio.ramus</string>
  <key>CFBundleExecutable</key><string>ramus</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSArchitecturePriority</key><array><string>arm64</string></array>
</dict>
</plist>
PLIST
codesign --force --sign - "$APP" >/dev/null 2>&1 || true
echo "$APP"
