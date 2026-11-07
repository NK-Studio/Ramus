#!/bin/sh
# SVG 에서 macOS 용 .icns 와 Windows 용 .ico 를 만든다(macOS 전용: qlmanage·sips·iconutil 사용).
# 사용: scripts/make-icons.sh [SVG] [출력 폴더]
#   기본: assets/icon/ramus.svg → assets/icon/Ramus.icns, ramus.ico, ramus-1024.png
#   다른 SVG(비교용 시안 등)를 주면 같은 이름 규칙(파일 이름 기준)으로 출력 폴더에 만든다.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SVG="${1:-$ROOT/assets/icon/ramus.svg}"
DIR="${2:-$ROOT/assets/icon}"
BASE="$(basename "$SVG" .svg)"
ICNS="$([ "$BASE" = ramus ] && echo Ramus || echo "$BASE").icns"
mkdir -p "$DIR"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# 1) SVG → 1024px PNG(QuickLook 의 WebKit 렌더러).
qlmanage -t -s 1024 -o "$TMP" "$SVG" >/dev/null 2>&1
mv "$TMP/$BASE.svg.png" "$DIR/$BASE-1024.png"

# 2) iconset(각 크기와 @2x) → icns
SET="$TMP/Ramus.iconset"
mkdir -p "$SET"
for s in 16 32 128 256 512; do
  sips -z $s $s "$DIR/$BASE-1024.png" --out "$SET/icon_${s}x${s}.png" >/dev/null
  d=$((s * 2))
  sips -z $d $d "$DIR/$BASE-1024.png" --out "$SET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$SET" -o "$DIR/$ICNS"

# 3) ico: PNG 를 그대로 담는 ICO(Vista 이후 지원). 16·24·32·48·64·128·256.
for s in 16 24 32 48 64 128 256; do
  sips -z $s $s "$DIR/$BASE-1024.png" --out "$TMP/ico_$s.png" >/dev/null
done
python3 - "$TMP" "$DIR/$BASE.ico" <<'PY'
import struct, sys, os
tmp, out = sys.argv[1], sys.argv[2]
sizes = [16, 24, 32, 48, 64, 128, 256]
blobs = [open(os.path.join(tmp, f"ico_{s}.png"), "rb").read() for s in sizes]
header = struct.pack("<HHH", 0, 1, len(sizes))
offset = 6 + 16 * len(sizes)
entries = b""
for s, b in zip(sizes, blobs):
    w = 0 if s >= 256 else s
    entries += struct.pack("<BBBBHHII", w, w, 0, 0, 1, 32, len(b), offset)
    offset += len(b)
with open(out, "wb") as f:
    f.write(header + entries + b"".join(blobs))
PY
echo "$DIR/$ICNS"
echo "$DIR/$BASE.ico"
