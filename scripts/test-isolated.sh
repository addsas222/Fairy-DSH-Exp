#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
test_home=${DSH_HOME:-"$repo_root/.dsh-test-home"}
export DSH_HOME="$test_home"
export DSH_WORKSPACE_ROOT="$repo_root/fairy-voice"
export DSH_FAIRY_REPO_ROOT="$repo_root"
export DSH_FAIRY_TEST_HOME="$test_home"
export DSH_FAIRY_PROFILE_ROOT="$repo_root/profiles/web"
export DSH_ACCEPTED_BASELINE_ROOT="$test_home/accepted-baselines"

mkdir -p "$DSH_HOME"
mkdir -p "$DSH_HOME/.agent-presets/fairy-lite" "$DSH_HOME/accepted-baselines"
# ponytail preset 复制进用户根:readdir 的 Dirent.isDirectory() 对链接/junction
# 为假,链接形态会被发现器跳过,必须复制为真实目录。preset 内的插件 shim
# (./plugins/fairy-modes.mjs)以 DSH_FAIRY_REPO_ROOT 解析真身,复制无损。
if [ -e "$DSH_HOME/.agent-presets/fairy-full" ]; then
  rm -rf "$DSH_HOME/.agent-presets/fairy-full"
fi
cp -R "$repo_root/.agent-presets/fairy-full" "$DSH_HOME/.agent-presets/fairy-full"
for asset in runtime personality style canon behavior; do
  # runtime/ 是私有资产,公开仓库不含;只复制存在的目录。
  if [ ! -e "$repo_root/.agent-presets/fairy-lite/$asset" ]; then
    continue
  fi
  if [ -e "$DSH_HOME/.agent-presets/fairy-lite/$asset" ]; then
    mv "$DSH_HOME/.agent-presets/fairy-lite/$asset" "$DSH_HOME/.agent-presets/fairy-lite/$asset.previous.$$"
  fi
  cp -R "$repo_root/.agent-presets/fairy-lite/$asset" "$DSH_HOME/.agent-presets/fairy-lite/$asset"
done

# Keep the profile in the candidate repository while presenting it at the
# location expected by the DSH CLI. The symlink makes package link: entries
# resolve back to this repository, never to the production checkout.
mkdir -p "$DSH_HOME/profiles"
if [ -e "$DSH_HOME/profiles/web" ] && [ ! -L "$DSH_HOME/profiles/web" ]; then
  mv "$DSH_HOME/profiles/web" "$DSH_HOME/profiles/web.previous.$$"
fi
if [ ! -L "$DSH_HOME/profiles/web" ]; then
  ln -s "$repo_root/profiles/web" "$DSH_HOME/profiles/web"
fi

# The fairy-system gate tests compare a candidate against the installed layout,
# so they need the official 0.1.1-rc.2 paths. Derive them from the environment
# when the caller exported them; otherwise say exactly what is missing instead
# of reporting 13 unexplained failures.
if [ -n "${DSH_OFFICIAL_PACKAGE:-}" ] && [ -n "${DSH_OFFICIAL_RUNTIME:-}" ]; then
  :
elif [ -f "$HOME/.local/lib/node_modules/@deepseek-ai/dsh/package.json" ]; then
  DSH_OFFICIAL_PACKAGE="$HOME/.local/lib/node_modules/@deepseek-ai/dsh/package.json"
  DSH_OFFICIAL_RUNTIME="$HOME/.local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-runtime/lib/client.js"
else
  echo "note: set DSH_OFFICIAL_PACKAGE and DSH_OFFICIAL_RUNTIME to your installed" >&2
  echo "      DSH 0.1.1-rc.2 before running fairy-system/test (live-layout gate)." >&2
fi
export DSH_OFFICIAL_PACKAGE DSH_OFFICIAL_RUNTIME
export DSH_CAPABILITY_MATRIX="$repo_root/fairy-system/capability-matrix.json"

# ── 包清单的唯一真源 ────────────────────────────────────────────────────────
# 包名只写在 scripts/deploy-live.sh 的 PACKAGES 里（落位动作实际用的那份清单，
# fairy-system/image-manifest.js:59-92 也解析同一处）。这里按同一条规则从它派生：
# 行首 `^PACKAGES="` 打头、一路吃到下一个引号（清单跨行），再按空白切分——而不是
# 再抄一份，抄一份就会漂：本脚本原来抄的那 8 个包已经和仓库的 11 个对不上。
# 解析失败一律硬失败：清单为空时下面两个循环会「一个包都没测」还报绿。
deploy_script="$repo_root/scripts/deploy-live.sh"
[ -f "$deploy_script" ] || { echo "missing $deploy_script: the package list lives there" >&2; exit 1; }
package_hits=$(grep -c '^PACKAGES="' "$deploy_script" || true)
# 值可能收口在同一行、也可能跨行，所以先取「从 `PACKAGES="` 到下一个引号为止」的
# 整段文本再切片——与 image-manifest.js 的 `^PACKAGES="([^"]*)"` 同义。
block=$(sed -n '/^PACKAGES="/,/"/p' "$deploy_script")
block=${block#*PACKAGES=\"}        # 去掉 `PACKAGES="` 及其之前
case $block in
  *\"*) packages=${block%%\"*} ;;  # 截到收口引号（引号之后的内容一概不算）
  *)   packages="" ;;              # 值没收口 = 清单解析不出来
esac
if [ "$package_hits" != 1 ] || [ -z "$packages" ]; then
  echo "cannot read PACKAGES from $deploy_script (found $package_hits definitions)" >&2
  exit 1
fi
package_count=$(printf '%s\n' $packages | wc -l | tr -d ' ')

# 包声明的 test 脚本（有则原样输出、没有则空）。用 node 读 package.json 而不是
# grep：要回答的是「npm test 会不会跑起来」，不是「文件里有没有 test 这个词」。
package_test_script() {
  node -e 'const p = require(process.argv[1]); process.stdout.write((p.scripts && p.scripts.test) || "")' "$1"
}

echo "[1/4] package dependency install ($package_count packages, per deploy-live.sh PACKAGES)"
# 从仓库根跑包测试的默认失败模式是 `ERR_MODULE_NOT_FOUND: dsh-fairy-contracts`：
# clone 里没有 node_modules，而各包的 link: 依赖必须各自安装（与 deploy-live.sh
# 第 3 步同一做法、与 CI 的 --frozen-lockfile 同一约定）。已装过的包直接跳过，
# 所以重复跑不会变慢。
if command -v pnpm >/dev/null 2>&1; then
  for area in $packages; do
    if [ -d "$repo_root/$area/node_modules" ]; then
      echo "  ok   $area (already installed)"
    elif (cd "$repo_root/$area" && pnpm install --frozen-lockfile --ignore-scripts >/dev/null 2>&1); then
      echo "  ok   $area (installed)"
    else
      echo "pnpm install failed in $area" >&2
      exit 1
    fi
  done
else
  echo "pnpm is required to install package dependencies" >&2
  exit 1
fi

echo "[2/4] package tests"
# 同一份派生清单：新增的包会自动进这两个循环，不必在这里补第三处名单。
for area in $packages; do
  if [ -n "$(package_test_script "$repo_root/$area/package.json")" ]; then
    (cd "$repo_root/$area" && npm test)
  elif [ -d "$repo_root/$area/test" ]; then
    # 包没有声明 test 脚本（fairy-startup 就是：test/ 里的用例是真的，只是没有
    # scripts.test）→ 走 check.sh / checks/unit.mjs 同一条通道，免得整包漏测。
    echo "  note $area declares no test script; running its test/ files with node --test"
    (cd "$repo_root/$area" && node --test test/*.test.js)
  else
    echo "  skip $area (no test script and no test/ directory)"
  fi
done
if [ -n "$DSH_OFFICIAL_PACKAGE" ] && [ -n "$DSH_OFFICIAL_RUNTIME" ]; then
  # Live-layout gate suite: it compares candidates against the installed
  # 0.1.1-rc.2, so it runs only when that comparison target exists.
  node --test --test-timeout=45000 "$repo_root"/fairy-system/test/*.test.js
fi

echo "[3/4] profile dependency check"
if command -v pnpm >/dev/null 2>&1; then
  (cd "$repo_root/profiles/web" && pnpm install --frozen-lockfile --ignore-scripts)
else
  echo "pnpm is required for profile installation" >&2
  exit 1
fi

echo "[4/4] isolated profile smoke test"
if command -v dsh >/dev/null 2>&1; then
  if command -v gtimeout >/dev/null 2>&1; then
    gtimeout 8 dsh --profile web --no-open --port 0 || test $? -eq 124
  else
    smoke_log="$DSH_HOME/dsh-smoke.log"
    dsh --profile web --no-open --port 0 >"$smoke_log" 2>&1 &
    smoke_pid=$!
    trap 'kill "$smoke_pid" 2>/dev/null || true' EXIT INT TERM
    sleep 6
    if ! kill -0 "$smoke_pid" 2>/dev/null; then
      echo "DSH exited during isolated smoke test" >&2
      sed -n '1,160p' "$smoke_log" >&2
      exit 1
    fi
    grep -Eq '^dsh web: http://127\.0\.0\.1:[0-9]+' "$smoke_log"
    kill "$smoke_pid" 2>/dev/null || true
    wait "$smoke_pid" 2>/dev/null || true
    trap - EXIT INT TERM
  fi
else
  echo "dsh CLI is required for the live smoke test" >&2
  exit 1
fi
