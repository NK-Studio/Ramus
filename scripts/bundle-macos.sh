#!/bin/sh
# target/<profile>/ramus 를 macOS 앱 번들(Ramus.app)로 감싼다(내장 git 포함). 사용: scripts/bundle-macos.sh [debug|release]
set -e
PROFILE="${1:-debug}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ "$PROFILE" = "release" ]; then cargo build --release --manifest-path "$ROOT/Cargo.toml"; else cargo build --manifest-path "$ROOT/Cargo.toml"; fi
VERSION="$(sed -n 's/^version = "\(.*\)"/\1/p' "$ROOT/Cargo.toml" | head -1)"
APP="$ROOT/target/$PROFILE/Ramus.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$ROOT/target/$PROFILE/ramus" "$APP/Contents/MacOS/ramus"
cp "$ROOT/assets/icon/Ramus.icns" "$APP/Contents/Resources/Ramus.icns"
# 내장 git(scripts/fetch-git.sh, 처음 한 번 받는다). RAMUS_NO_BUNDLED_GIT=1 이면 넣지 않는다(시스템 git 을 쓴다).
if [ "${RAMUS_NO_BUNDLED_GIT:-0}" != "1" ]; then
  GIT_DIR_SRC="$(sh "$ROOT/scripts/fetch-git.sh" macos-arm64)"
  ditto "$GIT_DIR_SRC" "$APP/Contents/Resources/git"
  rm -f "$APP/Contents/Resources/git/.ramus-git"
  # 내장 git 에는 macOS 키체인 도우미가 없다 — Apple git 처럼 osxkeychain 을 넣고 기본 도우미로 둔다
  # (앱 GitHub 로그인·https 계정이 키체인에 들어간다). 사용자 ~/.gitconfig 의 도우미가 그 위에 더해진다.
  # 한 번 컴파일한 것을 vendor 에 두고 다시 쓴다 — 빌드마다 바이너리가 바뀌면 키체인이 매번 접근을 다시 묻는다.
  HELPER="$ROOT/vendor/git/git-credential-osxkeychain"
  if [ ! -x "$HELPER" ] || [ "$ROOT/assets/git/git-credential-osxkeychain.c" -nt "$HELPER" ]; then
    cc -O2 -arch arm64 -mmacosx-version-min=12.0 -o "$HELPER" "$ROOT/assets/git/git-credential-osxkeychain.c" -framework Security -framework CoreFoundation
  fi
  cp "$HELPER" "$APP/Contents/Resources/git/libexec/git-core/git-credential-osxkeychain"
  printf '\n# Ramus: Apple git 과 같이 macOS 키체인에 자격 증명을 둔다.\n[credential]\n\thelper = osxkeychain\n' >> "$APP/Contents/Resources/git/etc/gitconfig"
fi
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Ramus</string>
  <key>CFBundleDisplayName</key><string>Ramus</string>
  <key>CFBundleIdentifier</key><string>com.nkstudio.ramus</string>
  <key>CFBundleExecutable</key><string>ramus</string>
  <key>CFBundleIconFile</key><string>Ramus</string>
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
