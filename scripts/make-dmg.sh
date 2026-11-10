#!/bin/sh
# Ramus.app 을 끌어다 놓아 설치하는 DMG 로 만든다: 창을 열면 왼쪽에 Ramus, 오른쪽에 Applications 바로가기,
# 그 사이 화살표 배경(assets/dmg/background.tiff, scripts/make-dmg-background.swift 로 그린다)이 보인다.
# macOS 전용(hdiutil·Finder AppleScript). 외부 도구는 쓰지 않는다.
# 사용: scripts/make-dmg.sh <Ramus.app 경로> [출력 .dmg 경로]
#   출력 기본값: <앱 폴더>/Ramus-<버전>-macos-arm64.dmg
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="${1:?사용: scripts/make-dmg.sh <Ramus.app 경로> [출력 .dmg 경로]}"
APP="$(cd "$(dirname "$APP")" && pwd)/$(basename "$APP")"
test -d "$APP/Contents" || { echo "앱 번들이 아닙니다: $APP" >&2; exit 1; }
VERSION="$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$APP/Contents/Info.plist")"
OUT="${2:-$(dirname "$APP")/Ramus-$VERSION-macos-arm64.dmg}"
VOLNAME="Ramus"
BG="$ROOT/assets/dmg/background.tiff"
# 창 안쪽 크기(pt)와 아이콘 가운데 좌표 — background.tiff 를 그린 좌표(화살표 y=190)와 같아야 한다.
WIN_W=660; WIN_H=400
APP_X=170; APP_Y=190
APPS_X=490; APPS_Y=190

if [ -d "/Volumes/$VOLNAME" ]; then
  echo "/Volumes/$VOLNAME 이 이미 마운트돼 있습니다. 먼저 꺼내 주세요(Finder 배치가 그 디스크를 가리키게 됩니다)." >&2
  exit 1
fi

TMP="$(mktemp -d)"
DEV=""
cleanup() {
  if [ -n "$DEV" ]; then hdiutil detach "$DEV" -force >/dev/null 2>&1 || true; fi
  rm -rf "$TMP"
}
trap cleanup EXIT

# 1) 디스크에 담을 내용: 앱, Applications 바로가기, 숨긴 배경(볼륨 아이콘은 Finder 배치 뒤에 넣는다).
STAGE="$TMP/stage"
mkdir -p "$STAGE/.background"
ditto "$APP" "$STAGE/Ramus.app"
ln -s /Applications "$STAGE/Applications"
cp "$BG" "$STAGE/.background/background.tiff"

# 2) 쓰기 가능한 이미지로 만들고 붙인다(Finder 가 창 설정을 .DS_Store 에 쓸 수 있게). 여유 공간을 넉넉히 둔다.
SIZE_MB=$(( $(du -sm "$STAGE" | cut -f1) + 40 ))
hdiutil create -quiet -srcfolder "$STAGE" -volname "$VOLNAME" -fs HFS+ -format UDRW -size "${SIZE_MB}m" "$TMP/rw.dmg"
DEV="$(hdiutil attach -readwrite -noverify -noautoopen "$TMP/rw.dmg" | awk '/Apple_HFS/ {print $1; exit}')"
MNT="/Volumes/$VOLNAME"
test -d "$MNT" || { echo "디스크를 붙이지 못했습니다" >&2; exit 1; }

# 3) Finder 로 창 모양을 잡는다: 도구 막대·상태 막대 없이, 아이콘 보기, 배경 그림, 아이콘 자리.
#    창 위치는 화면 왼쪽 위에서 (200,120). bounds 는 제목 막대를 뺀 안쪽이 WIN_W×WIN_H 가 되게 잡는다.
LEFT=200; TOP=120
if ! osascript <<APPLESCRIPT
tell application "Finder"
  tell disk "$VOLNAME"
    open
    set current view of container window to icon view
    set toolbar visible of container window to false
    set statusbar visible of container window to false
    try
      set pathbar visible of container window to false
    end try
    set the bounds of container window to {$LEFT, $TOP, $((LEFT + WIN_W)), $((TOP + WIN_H + 28))}
    set viewOptions to the icon view options of container window
    set arrangement of viewOptions to not arranged
    set icon size of viewOptions to 128
    set text size of viewOptions to 13
    set shows item info of viewOptions to false
    set shows icon preview of viewOptions to true
    set background picture of viewOptions to file ".background:background.tiff"
    set position of item "Ramus.app" of container window to {$APP_X, $APP_Y}
    set position of item "Applications" of container window to {$APPS_X, $APPS_Y}
    -- 숨김 파일을 보이게 해 둔 사람에게는 이 항목들이 보이므로 창 아래 밖으로 밀어 둔다.
    repeat with hiddenName in {".background", ".VolumeIcon.icns", ".fseventsd", ".Trashes"}
      try
        set position of item hiddenName of container window to {$APP_X, $((WIN_H + 300))}
      end try
    end repeat
    close
    open
    update without registering applications
    delay 2
    close
  end tell
end tell
APPLESCRIPT
then
  # 자동화 권한이 없거나 화면 세션이 없으면 배치 없이 기본 창으로 만든다(설치는 그대로 된다).
  echo "경고: Finder 로 DMG 창 배치를 하지 못했습니다(자동화 권한 확인). 기본 창 모양으로 만듭니다." >&2
  if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::warning::DMG 창 배치(Finder AppleScript)에 실패했습니다"; fi
fi

# Finder 가 .DS_Store 를 다 쓸 때까지 기다린다.
i=0
while [ ! -f "$MNT/.DS_Store" ] && [ $i -lt 10 ]; do sleep 1; i=$((i + 1)); done
rm -rf "$MNT/.fseventsd" 2>/dev/null || true
# 볼륨 아이콘과 숨김 표시는 Finder 배치가 끝난 뒤에 한다 — 그 전에 두면 Finder 가 .VolumeIcon.icns 를 지우고,
# 숨김 표시한 .background 의 배경 그림은 찾지 못한다. 숨김 표시는 숨김 파일을 보이게 해 둔 사람에게도 가리려는 것이다.
# 사용자 정의 아이콘 표시는 SetFile(Xcode 명령줄 도구)로 한다 — 없으면 기본 디스크 아이콘.
cp "$ROOT/assets/icon/Ramus.icns" "$MNT/.VolumeIcon.icns"
if command -v SetFile >/dev/null 2>&1; then SetFile -a C "$MNT" || true; fi
chflags hidden "$MNT/.background" "$MNT/.VolumeIcon.icns" 2>/dev/null || true
chmod -Rf go-w "$MNT" 2>/dev/null || true
sync
hdiutil detach "$DEV" -quiet || { sleep 2; hdiutil detach "$DEV" -force -quiet; }
DEV=""

# 4) 읽기 전용 압축 이미지로 바꾼다.
mkdir -p "$(dirname "$OUT")"
rm -f "$OUT"
hdiutil convert -quiet "$TMP/rw.dmg" -format UDZO -imagekey zlib-level=9 -o "$OUT"
echo "$OUT"
