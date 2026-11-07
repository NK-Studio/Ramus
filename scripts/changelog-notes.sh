#!/bin/sh
# ChangeLog.md 에서 한 버전의 항목만 뽑아 낸다. 사용: sh scripts/changelog-notes.sh 1.0.0
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VER="${1:?버전을 주세요 (예: 1.0.0)}"
awk -v v="$VER" '
  /^## \[/ { if (on) exit; on = index($0, "## [" v "]") == 1; next }
  on { print }
' "$ROOT/ChangeLog.md" | sed '/./,$!d'
