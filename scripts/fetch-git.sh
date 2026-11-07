#!/bin/sh
# 앱에 넣어 배포할 내장 git(GitHub Desktop 의 dugite-native: git + git-lfs + 자격 증명 도우미)을 받아
# vendor/git/<플랫폼> 에 푼다. 이미 같은 버전이 있으면 받지 않는다. 사용: scripts/fetch-git.sh [macos-arm64|windows-x64]
#
# git 을 올리려면: https://github.com/desktop/dugite-native/releases 의 새 릴리스로 TAG·BUILD 와 두 SHA256
# (각 자산의 .sha256 파일 내용)을 바꾸고 ChangeLog.md 에 적는다.
set -e
TAG="v2.56.0-2"
BUILD="v2.56.0-a44aeca"
SHA_MACOS_ARM64="1110de343de11cc6f469b782b60f36217b9199b5e06875dd65baa26dd60563c7"
SHA_WINDOWS_X64="f1e17876337d7be143e5d51976da36643d65528125cfbc14d57f171de0fd5f14"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLATFORM="${1:-macos-arm64}"
case "$PLATFORM" in
  macos-arm64) ASSET="macOS-arm64"; SHA="$SHA_MACOS_ARM64" ;;
  windows-x64) ASSET="windows-x64"; SHA="$SHA_WINDOWS_X64" ;;
  *) echo "모르는 플랫폼: $PLATFORM (macos-arm64 | windows-x64)" >&2; exit 1 ;;
esac

DEST="$ROOT/vendor/git/$PLATFORM"
if [ -f "$DEST/.ramus-git" ] && [ "$(cat "$DEST/.ramus-git")" = "$TAG" ]; then
  echo "$DEST"
  exit 0
fi

URL="https://github.com/desktop/dugite-native/releases/download/$TAG/dugite-native-$BUILD-$ASSET.tar.gz"
TMP="$ROOT/vendor/git/.download-$PLATFORM.tar.gz"
mkdir -p "$ROOT/vendor/git"
echo "내장 git 받는 중: $URL" >&2
curl -fL --retry 3 -o "$TMP" "$URL"
if command -v shasum >/dev/null 2>&1; then GOT="$(shasum -a 256 "$TMP" | cut -d' ' -f1)"; else GOT="$(sha256sum "$TMP" | cut -d' ' -f1)"; fi
if [ "$GOT" != "$SHA" ]; then
  rm -f "$TMP"
  echo "내장 git 의 SHA256 이 맞지 않습니다: $GOT (기대 $SHA)" >&2
  exit 1
fi
rm -rf "$DEST"
mkdir -p "$DEST"
tar -xzf "$TMP" -C "$DEST"
rm -f "$TMP"
echo "$TAG" > "$DEST/.ramus-git"
echo "$DEST"
