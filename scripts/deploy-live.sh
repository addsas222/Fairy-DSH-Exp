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
#                            [--preserve LIST]
#
#   --home DIR        目标 DSH_HOME（默认 $DSH_HOME，再默认 ~/.dsh）
#   --from-worktree   用当前工作树部署（含未提交改动），而不是 git HEAD——
#                     开发回路里最常用；发布的干净形态请省略它
#   --evomap          显式同意执行第 5 步的 EvoMap 注册（见下方默认规则）
#   --skip-evomap     跳过第 5 步（EvoMap 接入）。CI/无人值守请一律带上：
#                     该步骤会向外网发一次 POST 并产生本机凭据
#
# 第 5 步的默认规则（防止"沙箱自测顺手注册了一个真节点"）：
#   --home 指向默认 $DSH_HOME（即真部署）→ 执行，失败不阻断；
#   --home 指向别处（探针/沙箱）        → 自动跳过并提示，需要真跑时加 --evomap。
#   --dry-run 永远只打印命令，不执行。
#   --skip-install    只落文件，不跑 pnpm（离线排障用）
#   --no-verify       不跑第 6 步的两道门禁
#   --dry-run         只打印将要执行的命令
#   --preserve LIST   逗号分隔的仓库相对路径：这些路径**保留镜像里的现有内容**，
#                     既不按提交覆盖也不参与清理，用于本机适配（例如未装 Chrome
#                     时 profiles/web/cordis.patch.yml 改用 msedge 通道）。
#                     默认取值见 fairy-system/image-manifest.js 的 LOCAL_ADAPTATIONS；
#                     传空串（--preserve ""）表示不保留任何本机适配。
#
# 退出码：0 成功；1 前置条件或某一步失败（EvoMap 步骤失败不算，见第 5 步）。
#
# 为什么第 1 步之前多了一次「对账」（step 1/6 的 prune）：落位只做新增/覆盖，
# 提交里删掉的文件会永远留在镜像里，于是镜像收敛不到提交（20260828 的两个
# 死客户端 bundle 就是这么留下来的）。对账把「受控路径下、清单里没有」的文件
# 删掉，重复部署才具备收敛语义；受控路径之外（settings.yaml、凭据等）一律不碰。
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
# 本机适配：逗号分隔的仓库相对路径，默认取 image-manifest.js 的 LOCAL_ADAPTATIONS。
# 这些路径保留镜像里的现有内容（见文件头 --preserve 说明）。用 sentinel 区分
# 「没传」与「显式传空」：后者表示不要任何本机适配。
PRESERVE_OVERRIDE='__default__'

while [ $# -gt 0 ]; do
  case "$1" in
    --home) DSH_HOME_TARGET="$2"; HOME_EXPLICIT=1; shift 2 ;;
    --evomap) FORCE_EVOMAP=1; shift ;;
    --from-worktree) FROM_WORKTREE=1; shift ;;
    --skip-evomap) SKIP_EVOMAP=1; shift ;;
    --skip-install) SKIP_INSTALL=1; shift ;;
    --no-verify) RUN_VERIFY=0; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --preserve) PRESERVE_OVERRIDE="$2"; shift 2 ;;
    # 帮助文本 = 文件头注释，直到 `set -eu` 为止：以前按行号切（sed -n '2,45p'），
    # 注释增减一行就切歪——实测切到过 `set -eu` 之后的代码。按标记切，并且
    # **不打印**那行标记（sed 的 `/re/q` 是先打印后退出，实测尾巴上会多一行
    # `set -eu`，所以这里用 awk 显式 exit）。
    -h|--help) awk 'NR>1 && /^set -eu$/ {exit} NR>1 {sub(/^# ?/, ""); print}' "$0"; exit 0 ;;
    *) echo "unknown option: $1 (try --help)" >&2; exit 1 ;;
  esac
done

# 日志与执行助手：必须在下面第一次用到之前定义——本脚本按 sh 执行且开头就是
# `set -eu`，先调用后定义等于「命令找不到」直接退出（PRESERVE 预解析那一步就会
# 踩到 warn）。
log()  { printf '\033[36m[deploy]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[deploy]\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[31m[deploy]\033[0m %s\n' "$*" >&2; exit 1; }
run()  { if [ "$DRY_RUN" = 1 ]; then printf '  would run: %s\n' "$*"; else "$@"; fi; }

# 本机适配清单：默认取模块自己的 LOCAL_ADAPTATIONS（唯一副本在 image-manifest.js），
# `--preserve` 可覆盖。`policy --lines` 一次调用直接给出路径清单——不解析 JSON、
# 不起第二个进程。
MANIFEST_TOOL="$REPO_ROOT/fairy-system/image-manifest.js"
PRESERVE_LIST=""
if [ "$PRESERVE_OVERRIDE" = '__default__' ]; then
  if [ -f "$MANIFEST_TOOL" ]; then
    PRESERVE_LIST="$(node "$MANIFEST_TOOL" policy --lines 2>/dev/null || true)"
  fi
  if [ -z "$PRESERVE_LIST" ]; then
    warn "cannot read LOCAL_ADAPTATIONS from image-manifest.js; 本机适配将不会被保留"
  fi
else
  PRESERVE_LIST="$(printf '%s' "$PRESERVE_OVERRIDE" | tr ',' '\n')"
fi
# 逗号/换行分隔 → 重复的 --preserve 参数（POSIX sh 没有数组）。
PRESERVE_ARGS=""
old_ifs=$IFS; IFS='
'
for item in $PRESERVE_LIST; do
  [ -n "$item" ] && PRESERVE_ARGS="$PRESERVE_ARGS --preserve $item"
done
IFS=$old_ifs

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
fairy-memory/dsh-fairy-memory
fairy-roleplay/dsh-fairy-roleplay"
PACKAGE_COUNT=10
# 非包但必须落位的受控目录：契约、验证工具、人格包、两个 preset、web profile。
EXTRA_PATHS="fairy-contracts fairy-system persona-packs .agent-presets/ponytail .agent-presets/fairy profiles/web"
EXTRA_COUNT=6

# ── 0) 前置条件 ───────────────────────────────────────────────────────────
command -v node >/dev/null 2>&1 || fail "node not found on PATH"
command -v pnpm >/dev/null 2>&1 || warn "pnpm not found: 加 --skip-install 或者先装 pnpm ≥ 11"
[ -f "$REPO_ROOT/fairy-system/verify-build.js" ] || fail "run this from the Fairy-DSH checkout (expected fairy-system/verify-build.js)"

log "repo      : $REPO_ROOT"
log "DSH_HOME  : $DSH_HOME_TARGET"
log "source    : $([ "$FROM_WORKTREE" = 1 ] && echo 'working tree (含未提交改动)' || echo 'git HEAD')"

# 对账必须与落位取同一个源：发布形态对 git HEAD，开发形态对工作树。否则
# --from-worktree 部署会因为「清单来自 HEAD、落的是工作树」而把未提交的改动删掉。
SOURCE_MODE=git
if [ "$FROM_WORKTREE" = 1 ]; then SOURCE_MODE=worktree; fi

# 1pre) ponytail 规则技能：不随仓库分发（第三方 MIT 文本），部署时从**本机**安装源同步进
# preset 的 skills/ 槽位（该槽位在 image-manifest 的跳过策略里，不参与对账/prune）。
# 安装源：$DSH_FAIRY_SKILLS_DIR（显式指定，指向某个含 ponytail* 的目录）
#         > ~/.omp/agent/skills/_ponytail-vendor（本机留存处）
#         > ~/.omp/agent/skills（harness 技能根，含主技能 ponytail）。
# 只取 `ponytail*` 这几个目录，**不要**整目录 cp：技能根里还有十几个与本 preset 无关的
# 私人技能（以及 _ponytail-vendor 自身），整拷会把它们塞进 DSH 会话、并与 harness 自带重名。
# 主技能 ponytail/ 在留存处没有（它与 harness 自带那份内容相同、当时被去重删掉），
# 需要时从技能根补；缺少它的目录集是 5 个附属技能，不是完整规则集。
# 找不到就跳过（preset 仍可用，只是没有这套技能）——无网络依赖、可重复执行。
SKILLS_DEST="$DSH_HOME_TARGET/.agent-presets/ponytail/skills"
if [ "$DRY_RUN" = 1 ]; then
  printf '  would sync ponytail skills (ponytail*) → %s\n' "$SKILLS_DEST"
else
  SKILLS_SRC="${DSH_FAIRY_SKILLS_DIR:-}"
  if [ -z "$SKILLS_SRC" ]; then
    for cand in "$HOME/.omp/agent/skills/_ponytail-vendor" "$HOME/.omp/agent/skills"; do
      if [ -d "$cand/ponytail-audit" ] || [ -f "$cand/ponytail/SKILL.md" ]; then SKILLS_SRC="$cand"; break; fi
    done
  fi
  if [ -n "$SKILLS_SRC" ] && [ -d "$SKILLS_SRC" ]; then
    mkdir -p "$SKILLS_DEST"
    synced=0
    for dir in "$SKILLS_SRC"/ponytail*; do
      [ -d "$dir" ] || continue
      cp -R "$dir" "$SKILLS_DEST/" 2>/dev/null && synced=$((synced + 1))
    done
    for file in NOTICE ponytail.LICENSE; do
      [ -f "$SKILLS_SRC/$file" ] && cp "$SKILLS_SRC/$file" "$SKILLS_DEST/" 2>/dev/null
    done
    # 留存处缺主技能时从 harness 技能根补一次（内容与仓库版逐字节相同，仅行尾不同）
    if [ ! -f "$SKILLS_DEST/ponytail/SKILL.md" ] && [ -f "$HOME/.omp/agent/skills/ponytail/SKILL.md" ]; then
      mkdir -p "$SKILLS_DEST/ponytail" && cp "$HOME/.omp/agent/skills/ponytail/SKILL.md" "$SKILLS_DEST/ponytail/" 2>/dev/null
    fi
    if [ "$synced" -gt 0 ]; then
      log "  synced $synced ponytail skill dir(s) from $SKILLS_SRC"
    else
      warn "ponytail 技能同步失败（不影响部署）：$SKILLS_SRC 下没有 ponytail* 目录"
    fi
  else
    warn "ponytail 技能未找到安装源（本机技能根为空）；preset 仍可用，只是没有这套技能"
  fi
fi

# ── 1) 与源对账（收敛语义：先删多余，再落位） ─────────────────────────────
# 落位只会新增/覆盖，从不删除；上游删过的文件因此会永远留在镜像里，镜像永远
# 收敛不到提交。这一步按同一份清单（fairy-system/image-manifest.js，与落位用
# 的 PACKAGES/EXTRA_PATHS 同源）删掉「受控路径下、清单里没有」的文件。
# 先删后落，所以最终状态与顺序无关；node_modules、运行期产物、以及 --preserve
# 声明的本机适配都在跳过策略/保留清单里，不会被删。
log "step 1/6: reconciling with $([ "$FROM_WORKTREE" = 1 ] && echo 'the working tree' || echo 'git HEAD')"
if [ ! -f "$MANIFEST_TOOL" ]; then
  warn "  image-manifest.js not found in the checkout; 跳过对账（镜像可能残留提交里已删的文件）"
elif [ "$DRY_RUN" = 1 ]; then
  node "$MANIFEST_TOOL" prune --repo "$REPO_ROOT" --source "$SOURCE_MODE" --home "$DSH_HOME_TARGET" \
    $PRESERVE_ARGS --dry-run || warn "  prune --dry-run failed; 见上方输出"
else
  run mkdir -p "$DSH_HOME_TARGET"
  if node "$MANIFEST_TOOL" prune --repo "$REPO_ROOT" --source "$SOURCE_MODE" --home "$DSH_HOME_TARGET" $PRESERVE_ARGS; then
    :
  else
    fail "对账失败：镜像里有多余文件且删除未完成（见上方输出）；部署中止以免留下半成品镜像"
  fi
fi

# ── 2) 落位受控文件 ───────────────────────────────────────────────────────
# 发布形态用 `git archive HEAD` 取受控文件（避免把 node_modules、.git 带过去）；
# 开发形态直接从工作树 tar（--exclude 掉 node_modules/.git），否则未提交的改动
# 不会出现在目标里——这一点在本仓的迭代里踩过，所以留成显式开关。
log "step 2/6: staging controlled files"
run mkdir -p "$DSH_HOME_TARGET"

# 2a) 本机适配：**落位会覆盖一切**，包括 --preserve 声明的路径——只保护它不被
# 清理是不够的（实测：不还原的话，重部署会把 msedge 换回提交里的 chrome，
# 这台没装 Chrome 的机器上浏览器 Dock 直接起不来）。所以先快照、再落位、然后
# 覆盖回去，最后交给第 6 步的门禁按 --preserve 核验（那里它会以 allowed 列出）。
# $PRESERVE_LIST 是换行分隔清单；按行遍历（set -f 关掉 glob，免得路径里带通配符）。
preserve_walk() {
  # $1 = 对每个条目调用的函数名；切 IFS 只发生在这里，被调用者不必再管。
  old_ifs=$IFS; IFS='
'
  set -f
  for item in $PRESERVE_LIST; do
    [ -n "$item" ] && "$1" "$item"
  done
  set +f
  IFS=$old_ifs
}
snapshot_adaptation() {
  if [ -f "$DSH_HOME_TARGET/$1" ]; then
    mkdir -p "$PRESERVE_SAVE/$(dirname "$1")"
    cp "$DSH_HOME_TARGET/$1" "$PRESERVE_SAVE/$1" || fail "无法快照本机适配：$1"
  fi
}
restore_adaptation() {
  if [ -f "$PRESERVE_SAVE/$1" ]; then
    mkdir -p "$DSH_HOME_TARGET/$(dirname "$1")"
    cp "$PRESERVE_SAVE/$1" "$DSH_HOME_TARGET/$1" || fail "无法还原本机适配：$1"
    restored=$((restored + 1))
  fi
}

PRESERVE_SAVE=""
restored=0
# --from-worktree 的忽略清单与 --preserve 的快照都需要一个临时目录；先把它准备好，
# 这样「传了 --preserve ""（不要本机适配）又要 --from-worktree」时也会有目录可用
# ——两个分支各自 mktemp 会漏掉这种组合（stage 里就变成写向空路径）。
if [ "$DRY_RUN" != 1 ] && { [ -n "$PRESERVE_LIST" ] || [ "$FROM_WORKTREE" = 1 ]; }; then
  STAGE_TMP="$(mktemp -d 2>/dev/null || echo "${TMPDIR:-/tmp}/fairy-stage.$$")"
  mkdir -p "$STAGE_TMP"
  trap 'rm -rf "$STAGE_TMP"' EXIT INT TERM
else
  STAGE_TMP=""
fi
if [ -n "$PRESERVE_LIST" ] && [ "$DRY_RUN" != 1 ]; then
  PRESERVE_SAVE="$STAGE_TMP"
  preserve_walk snapshot_adaptation
fi

# tar 的目标路径要归一化成正斜杠：Git for Windows 的 tar 把 `C:\...` 里的冒号
# 读成「远端主机」语法（`tar: C\:\\... : Cannot open: No such file or directory`），
# 而 `C:/...` 正常。macOS/Linux 上路径本就没有反斜杠，sed 是空操作，所以这行
# 在两个平台都对（此前 --from-worktree 在 Windows 上必失败）。
STAGE_DEST="$(printf '%s' "$DSH_HOME_TARGET" | sed 's|\\|/|g')"
# stage() 每次调用要一个独立的排除清单文件名（见该函数内注释）。
stage_seq=0

stage() {
  if [ "$DRY_RUN" = 1 ]; then printf '  would stage: %s\n' "$*"; return; fi
  if [ "$FROM_WORKTREE" = 1 ]; then
    # 落位必须与清单**同一套忽略语义**：清单认 `git ls-files --exclude-standard`
    # （跟踪文件 + 未跟踪但未被忽略的文件），所以 tar 也要排除被忽略的文件。
    # 否则两条口径打架：tar 把 `alpha/.env`、`alpha/logs/` 这类被忽略文件落进镜像，
    # 第 6 步报成 extra，prune 删掉、下一次 stage 又加回来——永不收敛（实测复现）。
    # 排除项由 git 枚举（不做第二份模式表），但**先过一遍 image-manifest 的跳过
    # 策略**：策略里登记过的路径（如 .agent-presets/fairy/runtime 这类指定不进
    # 公开仓库、但确实该在镜像里的资产）必须保留落位资格——否则会出现
    # 「清单放过它、门禁放过它、落位却永远不落它」的分裂。过滤走模块自己的
    # isSkipped（Windows 路径先归一化成正斜杠），语义与门禁完全同源。
    # **不要**给路径补尾斜杠：GNU tar 1.35 会直接忽略带尾斜杠的 --exclude-from 条目。
    # 每次调用各用一个文件：stage 会被调用多次（PACKAGES 一轮、EXTRA_PATHS 一轮），
    # 复用同一个文件名会被后一轮覆盖/截断——实测表现为第一轮算好的排除项在第二轮
    # 变成空文件，于是被忽略的文件照样落进镜像（prune 删、stage 加，永不收敛）。
    stage_excludes="$STAGE_TMP/ignored.$$.$stage_seq.txt"
    stage_seq=$((stage_seq + 1))
    git -C "$REPO_ROOT" ls-files -z -o -i --exclude-standard -- "$@" \
      | MANIFEST_TOOL="$MANIFEST_TOOL" node -e '
          const { isSkipped } = require(process.env.MANIFEST_TOOL);
          const posix = (value) => value.replace(/\\/g, "/");
          let pending = "";
          process.stdin.on("data", (chunk) => {
            pending += chunk.toString("utf8");
            const parts = pending.split("\0");
            pending = parts.pop();
            for (const file of parts) if (file && !isSkipped(posix(file))) process.stdout.write(`${posix(file)}\n`);
          });
          process.stdin.on("end", () => {
            if (pending && !isSkipped(posix(pending))) process.stdout.write(`${posix(pending)}\n`);
          });
        ' > "$stage_excludes"
    (cd "$REPO_ROOT" && tar --exclude-from="$stage_excludes" --exclude=node_modules --exclude=.git -cf - -- "$@") \
      | tar -xf - -C "$STAGE_DEST"
  else
    git -C "$REPO_ROOT" archive HEAD -- "$@" | tar -x -C "$STAGE_DEST"
  fi
}
stage $PACKAGES
stage $EXTRA_PATHS
# preset 必须**复制**（readdir 的 isDirectory() 对 symlink/junction 为假，
# 链接形态不会被发现器看到，表现为"preset 凭空消失"）。
log "  staged $PACKAGE_COUNT packages + $EXTRA_COUNT extra paths"

# 2b) 落位完成，把快照里的本机适配覆盖回去。
if [ -n "$PRESERVE_SAVE" ]; then
  preserve_walk restore_adaptation
  [ "$restored" -gt 0 ] && log "  restored $restored local adaptation(s) declared by --preserve"
fi

# ── 3) 逐包安装依赖 ───────────────────────────────────────────────────────
# 每个包自带 lockfile；link: 依赖（dsh-fairy-contracts）要求各自装 node_modules，
# 所以这里逐个装而不是在仓库根装一次。
if [ "$SKIP_INSTALL" = 1 ]; then
  warn "step 3/6: skipped (--skip-install)"
else
  log "step 3/6: installing per-package dependencies"
  for area in $PACKAGES; do
    if [ "$DRY_RUN" = 1 ]; then printf '  would install: %s\n' "$area"; continue; fi
    if (cd "$DSH_HOME_TARGET/$area" && pnpm install --ignore-scripts >/dev/null 2>&1); then
      printf '  ok   %s\n' "$area"
    else
      fail "pnpm install failed in $DSH_HOME_TARGET/$area"
    fi
  done
fi

# ── 4) profile 安装 ───────────────────────────────────────────────────────
# 首次安装需要 --no-frozen-lockfile：新增 link 依赖后锁文件要重生成。
if [ "$SKIP_INSTALL" = 1 ]; then
  warn "step 4/6: skipped (--skip-install)"
else
  log "step 4/6: installing profiles/web"
  if [ "$DRY_RUN" = 1 ]; then
    printf '  would install: profiles/web\n'
  else
    (cd "$DSH_HOME_TARGET/profiles/web" && pnpm install --no-frozen-lockfile --ignore-scripts >/dev/null 2>&1) \
      || fail "pnpm install failed in $DSH_HOME_TARGET/profiles/web"
    log "  ok   profiles/web"
  fi
fi

# ── 5) EvoMap 接入（Layer 1，可跳过） ─────────────────────────────────────
# 只做该服务分层设计里的 Layer 1：恢复或注册节点，打印 claim_url 由操作者打开
# 完成绑定；凭据以 0600 落在 ~/.evomap（EVOMAP_HOME 可换目录）。**失败不阻断
# 部署**——离线机器不该因为第三方 Hub 不可达而装不上。无人值守/CI 请带
# --skip-evomap：这一步会向外网发一次 POST 并产生本机凭据。
EVOMAP_CLI="$DSH_HOME_TARGET/fairy-memory/dsh-fairy-memory/lib/memory-cli.js"
if [ "$SKIP_EVOMAP" = 1 ]; then
  warn "step 5/6: skipped (--skip-evomap)"
elif [ "$HOME_EXPLICIT" = 1 ] && [ "$FORCE_EVOMAP" != 1 ]; then
  # A non-default home means someone is probing the deploy (or building a
  # sandbox); registering a real node from there is never what they meant.
  warn "step 5/6: skipped (--home 指向非默认目录；EvoMap 注册只针对真实部署)"
  warn "  确实要在这里注册就加 --evomap；只想看命令形态用 --dry-run。"
elif [ ! -f "$EVOMAP_CLI" ]; then
  warn "step 5/6: skipped (memory package not staged)"
elif [ "$DRY_RUN" = 1 ]; then
  printf '  would run: node %s evomap join --name "Fairy DSH"\n' "$EVOMAP_CLI"
else
  log "step 5/6: EvoMap join (Layer 1: register or recover, then print claim_url)"
  if node "$EVOMAP_CLI" evomap join --name "Fairy DSH"; then
    log "  EvoMap: 已恢复或注册节点；若输出里有 claim_url，打开它完成绑定"
  else
    warn "  EvoMap: 未完成（离线或 Hub 不可达）——部署继续，稍后重跑同一条命令即可："
    warn "    node $EVOMAP_CLI evomap join"
  fi
fi

# ── 6) 契约检查 + 镜像对账 + 启动提示 ─────────────────────────────────────
# 两道门禁，缺一不可：
#   verify-build.js  —— manifest / 产物新鲜度 / 禁用字符串（只查「该有的在不在」）
#   image-manifest.js check —— 镜像 vs 源的三类差异（多 / 缺 / 漂移），
#                        这道才是 20260828 那次半成品镜像本该撞上的门禁：
#                        verify-build 当时全绿，因为多出来的死 bundle 不在它的
#                        检查范围里。
# 后者的源与落位一致（--from-worktree → 工作树），--preserve 声明的本机适配
# 会以 allowed 列出而不计差异；其余任何差异都判失败，不靠放宽断言变绿。
#
# 这两道门禁与依赖安装无关（verify-build 只读 manifest/产物/禁用字符串，
# image check 只读清单与文件），所以**只有 --no-verify 能关掉它们**：
# --skip-install（离线排障）也要过门禁——实测在刚落位、未装依赖的镜像上同样通过。
if [ "$RUN_VERIFY" = 1 ] && [ "$DRY_RUN" != 1 ]; then
  log "step 6/6: build contract"
  if ! DSH_HOME="$DSH_HOME_TARGET" node "$DSH_HOME_TARGET/fairy-system/verify-build.js"; then
    fail "build contract failed (see above); the deployment is incomplete"
  fi
  log "step 6/6: image vs source reconciliation"
  if ! node "$MANIFEST_TOOL" check --repo "$REPO_ROOT" --source "$SOURCE_MODE" --home "$DSH_HOME_TARGET" $PRESERVE_ARGS; then
    fail "镜像与源不一致（见上方 extra / missing / drifted 三类清单）；这是半成品镜像，不是可用部署"
  fi
else
  warn "step 6/6: skipped (--no-verify / --dry-run)"
fi

log "done. 启动："
printf '\n  export DSH_HOME="%s"\n  export DSH_FAIRY_REPO_ROOT="%s"\n  dsh --profile web --no-open\n\n' \
  "$DSH_HOME_TARGET" "$DSH_HOME_TARGET"
log "验证链（可选）：node $DSH_HOME_TARGET/fairy-system/verify.js；（macOS live 部署再用 check.sh）"
log "镜像对账（只读，可随时重跑）：node $MANIFEST_TOOL check --repo $REPO_ROOT --home $DSH_HOME_TARGET$PRESERVE_ARGS"
