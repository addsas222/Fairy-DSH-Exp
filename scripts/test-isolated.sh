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
mkdir -p "$DSH_HOME/.agent-presets/fairy" "$DSH_HOME/accepted-baselines"
# ponytail preset 复制进用户根:readdir 的 Dirent.isDirectory() 对链接/junction
# 为假,链接形态会被发现器跳过,必须复制为真实目录。preset 内的插件 shim
# (./plugins/fairy-modes.mjs)以 DSH_FAIRY_REPO_ROOT 解析真身,复制无损。
if [ -e "$DSH_HOME/.agent-presets/ponytail" ]; then
  rm -rf "$DSH_HOME/.agent-presets/ponytail"
fi
cp -R "$repo_root/.agent-presets/ponytail" "$DSH_HOME/.agent-presets/ponytail"
for asset in runtime personality style canon behavior; do
  # runtime/ 是私有资产,公开仓库不含;只复制存在的目录。
  if [ ! -e "$repo_root/.agent-presets/fairy/$asset" ]; then
    continue
  fi
  if [ -e "$DSH_HOME/.agent-presets/fairy/$asset" ]; then
    mv "$DSH_HOME/.agent-presets/fairy/$asset" "$DSH_HOME/.agent-presets/fairy/$asset.previous.$$"
  fi
  cp -R "$repo_root/.agent-presets/fairy/$asset" "$DSH_HOME/.agent-presets/fairy/$asset"
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

echo "[1/3] package tests"
(cd "$repo_root/fairy-visual/dsh-fairy-visual" && npm test)
(cd "$repo_root/fairy-voice/dsh-fairy-voice" && npm test)
(cd "$repo_root/fairy-persona/dsh-fairy-persona" && npm test)
(cd "$repo_root/fairy-modes/dsh-fairy-modes" && npm test)
(cd "$repo_root/fairy-search/dsh-fairy-search" && npm test)
if [ -n "$DSH_OFFICIAL_PACKAGE" ] && [ -n "$DSH_OFFICIAL_RUNTIME" ]; then
  # Live-layout gate suite: it compares candidates against the installed
  # 0.1.1-rc.2, so it runs only when that comparison target exists.
  node --test --test-timeout=45000 "$repo_root"/fairy-system/test/*.test.js
fi

echo "[2/3] profile dependency check"
if command -v pnpm >/dev/null 2>&1; then
  (cd "$repo_root/profiles/web" && pnpm install --frozen-lockfile --ignore-scripts)
else
  echo "pnpm is required for profile installation" >&2
  exit 1
fi

echo "[3/3] isolated profile smoke test"
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
