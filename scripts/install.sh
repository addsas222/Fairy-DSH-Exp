#!/bin/sh
# 由 scripts/verify.mjs --generate-install 依据 .agent/checks/*.yaml 的 requires/install 生成；请勿手改，改配置后重新生成。
#
# 用法：sh scripts/install.sh [--dry-run]
# 约定：只做项目本地依赖与免提权安装；需要提权的步骤只打印手动命令（永不 sudo）。
set -u
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    *) printf '未知参数：%s\n' "$arg" ;;
  esac
done
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
LOG_DIR="$REPO_ROOT/reports"
LOG_FILE="$LOG_DIR/install.log"
mkdir -p "$LOG_DIR"
log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" | tee -a "$LOG_FILE"
}
have() { command -v "$1" >/dev/null 2>&1; }
run() {
  if [ "$DRY_RUN" = "1" ]; then log "dry-run：$1"; return 0; fi
  log "执行：$1"
  sh -c "$1" >>"$LOG_FILE" 2>&1 || log "失败（继续）：$1"
}
log "== Fairy-DSH 质量体系安装脚本（POSIX sh）=="

# ---- [1/4] tool:node —— 质量体系的检查脚本全部用 Node 内建能力（CI 固定 Node 22）
# 使用方检查项：coverage, e2e, format, gherkin, integration, lint, mutation, repo-contracts, secret-scan, typecheck, unit
# 探测：node --version
if have node; then
  log "tool:node 已就绪，跳过"
else
  if have winget; then
    run "winget install --id OpenJS.NodeJS.LTS --source winget --accept-source-agreements --accept-package-agreements --scope user"
  elif have winget; then
    run "winget install --id OpenJS.NodeJS.LTS --source winget --accept-source-agreements --accept-package-agreements --scope user"
  elif have winget; then
    run "winget install --id OpenJS.NodeJS.LTS --source winget --accept-source-agreements --accept-package-agreements --scope user"
  elif have winget; then
    run "winget install --id OpenJS.NodeJS.LTS --source winget --accept-source-agreements --accept-package-agreements --scope user"
  elif have winget; then
    run "winget install --id OpenJS.NodeJS.LTS --source winget --accept-source-agreements --accept-package-agreements --scope user"
  elif have winget; then
    run "winget install --id OpenJS.NodeJS.LTS --source winget --accept-source-agreements --accept-package-agreements --scope user"
  elif have winget; then
    run "winget install --id OpenJS.NodeJS.LTS --source winget --accept-source-agreements --accept-package-agreements --scope user"
  elif have winget; then
    run "winget install --id OpenJS.NodeJS.LTS --source winget --accept-source-agreements --accept-package-agreements --scope user"
  elif have winget; then
    run "winget install --id OpenJS.NodeJS.LTS --source winget --accept-source-agreements --accept-package-agreements --scope user"
  elif have winget; then
    run "winget install --id OpenJS.NodeJS.LTS --source winget --accept-source-agreements --accept-package-agreements --scope user"
  elif have winget; then
    run "winget install --id OpenJS.NodeJS.LTS --source winget --accept-source-agreements --accept-package-agreements --scope user"
  elif have scoop; then
    run "scoop install nodejs-lts"
  elif have scoop; then
    run "scoop install nodejs-lts"
  elif have scoop; then
    run "scoop install nodejs-lts"
  elif have scoop; then
    run "scoop install nodejs-lts"
  elif have scoop; then
    run "scoop install nodejs-lts"
  elif have scoop; then
    run "scoop install nodejs-lts"
  elif have scoop; then
    run "scoop install nodejs-lts"
  elif have scoop; then
    run "scoop install nodejs-lts"
  elif have scoop; then
    run "scoop install nodejs-lts"
  elif have scoop; then
    run "scoop install nodejs-lts"
  elif have scoop; then
    run "scoop install nodejs-lts"
  else
    log "无法自动安装 tool:node：没有可用的安装器"
  fi
fi
# 需人工执行（choco，需要管理员权限）：choco install nodejs-lts -y
#   原因：需要管理员权限：只写文档，不自动执行
# 需人工执行（choco，需要管理员权限）：choco install nodejs-lts -y
#   原因：需要管理员权限：只写文档，不自动执行
# 需人工执行（choco，需要管理员权限）：choco install nodejs-lts -y
#   原因：需要管理员权限：只写文档，不自动执行
# 需人工执行（choco，需要管理员权限）：choco install nodejs-lts -y
#   原因：需要管理员权限：只写文档，不自动执行
# 需人工执行（choco，需要管理员权限）：choco install nodejs-lts -y
#   原因：需要管理员权限：只写文档，不自动执行
# 需人工执行（choco，需要管理员权限）：choco install nodejs-lts -y
#   原因：需要管理员权限：只写文档，不自动执行
# 需人工执行（choco，需要管理员权限）：choco install nodejs-lts -y
#   原因：需要管理员权限：只写文档，不自动执行
# 需人工执行（choco，需要管理员权限）：choco install nodejs-lts -y
#   原因：需要管理员权限：只写文档，不自动执行
# 需人工执行（choco，需要管理员权限）：choco install nodejs-lts -y
#   原因：需要管理员权限：只写文档，不自动执行
# 需人工执行（choco，需要管理员权限）：choco install nodejs-lts -y
#   原因：需要管理员权限：只写文档，不自动执行
# 需人工执行（choco，需要管理员权限）：choco install nodejs-lts -y
#   原因：需要管理员权限：只写文档，不自动执行
# 手动命令：手动安装 Node 22+（nodejs.org 安装包，或 winget install OpenJS.NodeJS.LTS --scope user）

# ---- [2/4] tool:pnpm —— 各包自带 lockfile，依赖必须用 pnpm 逐包安装（AGENTS.md §1.1）
# 使用方检查项：coverage, unit
# 探测：pnpm --version
if have pnpm; then
  log "tool:pnpm 已就绪，跳过"
else
  if have winget; then
    run "winget install --id pnpm.pnpm --source winget --accept-source-agreements --accept-package-agreements --scope user"
  elif have winget; then
    run "winget install --id pnpm.pnpm --source winget --accept-source-agreements --accept-package-agreements --scope user"
  elif have scoop; then
    run "scoop install pnpm"
  elif have scoop; then
    run "scoop install pnpm"
  else
    log "无法自动安装 tool:pnpm：没有可用的安装器"
  fi
fi
# 手动命令：手动启用 pnpm：corepack enable pnpm（Node 自带 corepack）或 npm install -g pnpm

# ---- [3/4] tool:package-deps —— 各包通过 link: 依赖 dsh-fairy-contracts，必须先逐包安装依赖（否则 ERR_MODULE_NOT_FOUND）
# 使用方检查项：coverage, mutation, unit
# 探测：node "${repo}/scripts/checks/lib/deps-probe.mjs" --repo "${repo}"
if have package-deps; then
  log "tool:package-deps 已就绪，跳过"
else
  if true; then
    run "cd \"$REPO_ROOT\" && node \"scripts/checks/lib/deps-install.mjs\" --repo ."
  elif true; then
    run "cd \"$REPO_ROOT\" && node \"scripts/checks/lib/deps-install.mjs\" --repo ."
  elif true; then
    run "cd \"$REPO_ROOT\" && node \"scripts/checks/lib/deps-install.mjs\" --repo ."
  else
    log "无法自动安装 tool:package-deps：没有可用的安装器"
  fi
fi
# 手动命令：node scripts/checks/lib/deps-install.mjs --repo .

# ---- [4/4] tool:git —— 检查脚本用 git ls-files / git diff 判定跟踪文件与变更行（只读）
# 使用方检查项：format, gherkin, integration, lint, mutation, repo-contracts, secret-scan
# 探测：git --version
if have git; then
  log "tool:git 已就绪，跳过"
else
  if have winget; then
    run "winget install --id Git.Git --source winget --accept-source-agreements --accept-package-agreements --scope user"
  elif have winget; then
    run "winget install --id Git.Git --source winget --accept-source-agreements --accept-package-agreements --scope user"
  elif have winget; then
    run "winget install --id Git.Git --source winget --accept-source-agreements --accept-package-agreements --scope user"
  elif have winget; then
    run "winget install --id Git.Git --source winget --accept-source-agreements --accept-package-agreements --scope user"
  elif have winget; then
    run "winget install --id Git.Git --source winget --accept-source-agreements --accept-package-agreements --scope user"
  elif have winget; then
    run "winget install --id Git.Git --source winget --accept-source-agreements --accept-package-agreements --scope user"
  elif have winget; then
    run "winget install --id Git.Git --source winget --accept-source-agreements --accept-package-agreements --scope user"
  elif have scoop; then
    run "scoop install git"
  elif have scoop; then
    run "scoop install git"
  elif have scoop; then
    run "scoop install git"
  elif have scoop; then
    run "scoop install git"
  elif have scoop; then
    run "scoop install git"
  elif have scoop; then
    run "scoop install git"
  elif have scoop; then
    run "scoop install git"
  else
    log "无法自动安装 tool:git：没有可用的安装器"
  fi
fi
# 需人工执行（choco，需要管理员权限）：choco install git -y
#   原因：需要管理员权限：只写文档，不自动执行
# 需人工执行（choco，需要管理员权限）：choco install git -y
#   原因：需要管理员权限：只写文档，不自动执行
# 需人工执行（choco，需要管理员权限）：choco install git -y
#   原因：需要管理员权限：只写文档，不自动执行
# 需人工执行（choco，需要管理员权限）：choco install git -y
#   原因：需要管理员权限：只写文档，不自动执行
# 需人工执行（choco，需要管理员权限）：choco install git -y
#   原因：需要管理员权限：只写文档，不自动执行
# 需人工执行（choco，需要管理员权限）：choco install git -y
#   原因：需要管理员权限：只写文档，不自动执行
# 需人工执行（choco，需要管理员权限）：choco install git -y
#   原因：需要管理员权限：只写文档，不自动执行
# 手动命令：手动安装 Git（git-scm.com，或 winget install Git.Git --scope user）

log "== 安装脚本结束：需要人工确认的步骤见上方注释与 docs/QUALITY.md =="
exit 0
