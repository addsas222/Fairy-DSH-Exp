#!/bin/sh
# Fairy-DSH 质量体系入口（POSIX sh 包装；CI 的 ubuntu-latest 跑这个）。
#
# 用法：
#   sh scripts/verify.sh                # 全量
#   sh scripts/verify.sh --stage static
#   sh scripts/verify.sh --list
# 约定：不用 bash 专属语法（Windows 上 bash 可能被 WSL 抢占）、不用 sudo、不用 grep/sed/awk。
set -u
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
VERIFY="$SCRIPT_DIR/verify.mjs"

if [ ! -f "$VERIFY" ]; then
  printf '找不到主入口：%s\n' "$VERIFY"
  exit 2
fi
if ! command -v node >/dev/null 2>&1; then
  printf '找不到 node：请先安装 Node.js 22+（步骤见 docs/QUALITY.md）\n'
  exit 2
fi
exec node "$VERIFY" --repo "$REPO_ROOT" "$@"
