#!/bin/sh
# Fairy-DSH 一键安装/部署（macOS / Linux）。真正的逻辑在 scripts/install.mjs —— 跨平台同一份。
# 用法：./install.sh [--home DIR] [--from-worktree] …（macOS 上双击 .command 同效，见 install.command）
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
command -v node >/dev/null 2>&1 || {
  echo "[install] 需要 Node.js（22+）：https://nodejs.org" >&2
  exit 1
}
exec node "$HERE/scripts/install.mjs" "$@"
