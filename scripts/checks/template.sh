#!/bin/sh
# 检查脚本模板（POSIX sh 版）。复制到 scripts/checks/<id>.sh 后实现真实检查。
#
# 契约与 .mjs 版一致：参数 --check/--repo/--report-dir/--artifact，
# 末行输出 `<<<QUALITY-METRICS>>> {json}`，退出码 0/1/2/3。
# 约定：POSIX sh（不用 bash 专属语法）、不用 sudo / chmod / symlink / grep / sed / awk。
set -u
CHECK=""
REPO="."
REPORT_DIR=""
ARTIFACT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --report-dir) REPORT_DIR="$2"; shift 2 ;;
    --artifact) ARTIFACT="$2"; shift 2 ;;
    *) shift ;;
  esac
done
REPO_ROOT=$(CDPATH= cd -- "$REPO" && pwd)
if [ -z "$REPORT_DIR" ]; then REPORT_DIR="$REPO_ROOT/reports"; fi
if [ -z "$ARTIFACT" ]; then ARTIFACT="$REPORT_DIR/artifacts/check.json"; fi
mkdir -p "$(dirname -- "$ARTIFACT")"

# TODO: 替换成真实检查
printf '{"generated_at":"%s","repo":"%s","errors":[]}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$REPO_ROOT" > "$ARTIFACT"

printf 'template.sh：未实现真实检查（这是模板）\n'
printf '<<<QUALITY-METRICS>>> {"errors":0}\n'
exit 0
