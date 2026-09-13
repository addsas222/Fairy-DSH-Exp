#!/bin/sh
#
# deploy-live.sh — 把仓库部署成 DSH 的 live 布局（AGENTS.md §1 的可执行版本）。
#
# 为什么要有这个脚本：AGENTS.md 里的部署步骤此前只能手工逐条粘贴，而其中
# 有三处"顺序错了就白跑"的细节——预设必须复制、profile 的 link 依赖要各自
# 安装、`DSH_FAIRY_REPO_ROOT` 必须导出。把它们写进一个脚本，部署就从"照着
# 文档抄"变成"跑一条命令"。
#
# 它只写两处：$DSH_HOME 与（执行 EvoMap 步骤时）~/.evomap。仓库本身只读。
#
# 用法：
#   ./scripts/deploy-live.sh [--home DIR] [--from-worktree] [--skip-evomap]
#                            [--skip-install] [--no-verify] [--dry-run]
#
#   --home DIR        目标 DSH_HOME（默认 $DSH_HOME，再默认 ~/.dsh）
#   --from-worktree   用当前工作树部署（含未提交改动），而不是 git HEAD——
#                     开发回路里最常用；发布的干净形态请省略它
#   --evomap          显式同意执行第 4 步的 EvoMap 注册（见下方默认规则）
#   --skip-evomap     跳过第 4 步（EvoMap 接入）。CI/无人值守请一律带上：
#                     该步骤会向外网注册节点并产生本机凭据
#
# 第 4 步的默认规则（防止"沙箱自测顺手注册了一个真节点"）：
#   --home 指向默认 $DSH_HOME（即真部署）→ 执行，失败不阻断；
#   --home 指向别处（探针/沙箱）        → 自动跳过并提示，需要真跑时加 --evomap。
#   --dry-run 永远只打印命令，不执行。
#   --skip-install    只落文件，不跑 pnpm（离线排障用）
#   --no-verify       不跑 verify-build 契约检查
#   --dry-run         只打印将要执行的命令
#
# 退出码：0 成功；1 前置条件或某一步失败（EvoMap 步骤失败不算，见第 4 步）。
set -eu

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"   # 用 $0 而非 BASH_SOURCE：dash 下后者为空
# （按 sh 执行；source 本脚本不受支持）
DSH_HOME_TARGET="${DSH_HOME:-$HOME/.dsh}"
FROM_WORKTREE=0
SKIP_EVOMAP=0
FORCE_EVOMAP=0
HOME_EXPLICIT=0
SKIP_INSTALL=0
RUN_VERIFY=1
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --home) DSH_HOME_TARGET="$2"; HOME_EXPLICIT=1; shift 2 ;;
    --evomap) FORCE_EVOMAP=1; shift ;;
    --from-worktree) FROM_WORKTREE=1; shift ;;
    --skip-evomap) SKIP_EVOMAP=1; shift ;;
    --skip-install) SKIP_INSTALL=1; shift ;;
    --no-verify) RUN_VERIFY=0; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1 (try --help)" >&2; exit 1 ;;
  esac
done

# 9 个插件包；顺序按依赖面排列（fairy-contracts 先落，其余各自 link 它）。
# POSIX sh 没有数组：用空格分隔的列表逐项遍历（本仓 test-isolated.sh 同约定，
# 这样在 dash/debian 的 /bin/sh 下也能跑，而不只是 macOS 的 bash）。
PACKAGES="browser-dock/dsh-browser-dock
balance-meter/dsh-balance-meter
fairy-startup/dsh-fairy-startup
fairy-visual/dsh-fairy-visual
fairy-voice/dsh-fairy-voice
fairy-persona/dsh-fairy-persona
fairy-modes/dsh-fairy-modes
fairy-search/dsh-fairy-search
fairy-memory/dsh-fairy-memory"
$0"
PACKAGE_COUNT=10
# 非包但必须落位的受控目录：契约、验证工具、人格包、两个 preset、web profile。
EXTRA_PATHS="fairy-contracts fairy-system persona-packs .agent-presets/ponytail .agent-presets/fairy profiles/web"
EXTRA_COUNT=6

log()  { printf '\033[36m[deploy]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[deploy]\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[31m[deploy]\033[0m %s\n' "$*" >&2; exit 1; }
run()  { if [ "$DRY_RUN" = 1 ]; then printf '  would run: %s\n' "$*"; else "$@"; fi; }

# ── 0) 前置条件 ───────────────────────────────────────────────────────────
command -v node >/dev/null 2>&1 || fail "node not found on PATH"
command -v pnpm >/dev/null 2>&1 || warn "pnpm not found: 加 --skip-install 或者先装 pnpm ≥ 11"
[ -f "$REPO_ROOT/fairy-system/verify-build.js" ] || fail "run this from the Fairy-DSH checkout (expected fairy-system/verify-build.js)"

log "repo      : $REPO_ROOT"
log "DSH_HOME  : $DSH_HOME_TARGET"
log "source    : $([ "$FROM_WORKTREE" = 1 ] && echo 'working tree (含未提交改动)' || echo 'git HEAD')"

# ── 1) 落位受控文件 ───────────────────────────────────────────────────────
# 发布形态用 `git archive HEAD` 取受控文件（避免把 node_modules、.git 带过去）；
# 开发形态直接从工作树 tar（--exclude 掉 node_modules/.git），否则未提交的改动
# 不会出现在目标里——这一点在本仓的迭代里踩过，所以留成显式开关。
log "step 1/5: staging controlled files"
run mkdir -p "$DSH_HOME_TARGET"
stage() {
  if [ "$DRY_RUN" = 1 ]; then printf '  would stage: %s\n' "$*"; return; fi
  if [ "$FROM_WORKTREE" = 1 ]; then
    (cd "$REPO_ROOT" && tar -cf - --exclude=node_modules --exclude=.git "$@") | tar -xf - -C "$DSH_HOME_TARGET"
  else
    git -C "$REPO_ROOT" archive HEAD -- "$@" | tar -x -C "$DSH_HOME_TARGET"
  fi
}
stage $PACKAGES
stage $EXTRA_PATHS
# preset 必须**复制**（readdir 的 isDirectory() 对 symlink/junction 为假，
# 链接形态不会被发现器看到，表现为"preset 凭空消失"）。
log "  staged $PACKAGE_COUNT packages + $EXTRA_COUNT extra paths"

# ── 2) 逐包安装依赖 ───────────────────────────────────────────────────────
# 每个包自带 lockfile；link: 依赖（dsh-fairy-contracts）要求各自装 node_modules，
# 所以这里逐个装而不是在仓库根装一次。
if [ "$SKIP_INSTALL" = 1 ]; then
  warn "step 2/5: skipped (--skip-install)"
else
  log "step 2/5: installing per-package dependencies"
  for area in $PACKAGES; do
    if [ "$DRY_RUN" = 1 ]; then printf '  would install: %s\n' "$area"; continue; fi
    if (cd "$DSH_HOME_TARGET/$area" && pnpm install --ignore-scripts >/dev/null 2>&1); then
      printf '  ok   %s\n' "$area"
    else
      fail "pnpm install failed in $DSH_HOME_TARGET/$area"
    fi
  done
fi

# ── 3) profile 安装 ───────────────────────────────────────────────────────
# 首次安装需要 --no-frozen-lockfile：新增 link 依赖后锁文件要重生成。
if [ "$SKIP_INSTALL" = 1 ]; then
  warn "step 3/5: skipped (--skip-install)"
else
  log "step 3/5: installing profiles/web"
  if [ "$DRY_RUN" = 1 ]; then
    printf '  would install: profiles/web\n'
  else
    (cd "$DSH_HOME_TARGET/profiles/web" && pnpm install --no-frozen-lockfile --ignore-scripts >/dev/null 2>&1) \
      || fail "pnpm install failed in $DSH_HOME_TARGET/profiles/web"
    log "  ok   profiles/web"
  fi
fi

# ── 4) EvoMap 接入（Layer 1，可跳过） ─────────────────────────────────────
# 只做该服务分层设计里的 Layer 1：恢复或注册节点，打印 claim_url 由操作者打开
# 完成绑定；凭据以 0600 落在 ~/.evomap（EVOMAP_HOME 可换目录）。**失败不阻断
# 部署**——离线机器不该因为第三方 Hub 不可达而装不上。无人值守/CI 请带
# --skip-evomap：这一步会向外网发一次 POST 并产生本机凭据。
EVOMAP_CLI="$DSH_HOME_TARGET/fairy-memory/dsh-fairy-memory/lib/memory-cli.js"
if [ "$SKIP_EVOMAP" = 1 ]; then
  warn "step 4/5: skipped (--skip-evomap)"
elif [ "$HOME_EXPLICIT" = 1 ] && [ "$FORCE_EVOMAP" != 1 ]; then
  # A non-default home means someone is probing the deploy (or building a
  # sandbox); registering a real node from there is never what they meant.
  warn "step 4/5: skipped (--home 指向非默认目录；EvoMap 注册只针对真实部署)"
  warn "  确实要在这里注册就加 --evomap；只想看命令形态用 --dry-run。"
elif [ ! -f "$EVOMAP_CLI" ]; then
  warn "step 4/5: skipped (memory package not staged)"
elif [ "$DRY_RUN" = 1 ]; then
  printf '  would run: node %s evomap join --name "Fairy DSH"\n' "$EVOMAP_CLI"
else
  log "step 4/5: EvoMap join (Layer 1: register or recover, then print claim_url)"
  if node "$EVOMAP_CLI" evomap join --name "Fairy DSH"; then
    log "  EvoMap: 已恢复或注册节点；若输出里有 claim_url，打开它完成绑定"
  else
    warn "  EvoMap: 未完成（离线或 Hub 不可达）——部署继续，稍后重跑同一条命令即可："
    warn "    node $EVOMAP_CLI evomap join"
  fi
fi

# ── 5) 契约检查 + 启动提示 ────────────────────────────────────────────────
if [ "$RUN_VERIFY" = 1 ] && [ "$DRY_RUN" != 1 ] && [ "$SKIP_INSTALL" != 1 ]; then
  log "step 5/5: build contract"
  if ! DSH_HOME="$DSH_HOME_TARGET" node "$DSH_HOME_TARGET/fairy-system/verify-build.js"; then
    fail "build contract failed (see above); the deployment is incomplete"
  fi
else
  warn "step 5/5: skipped (--no-verify / --skip-install / --dry-run)"
fi

log "done. 启动："
printf '\n  export DSH_HOME="%s"\n  export DSH_FAIRY_REPO_ROOT="%s"\n  dsh --profile web --no-open\n\n' \
  "$DSH_HOME_TARGET" "$DSH_HOME_TARGET"
log "验证链（可选）：node $DSH_HOME_TARGET/fairy-system/verify.js；（macOS live 部署再用 check.sh）"
