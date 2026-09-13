#!/usr/bin/env zsh
# Full non-mutating verification entrypoint for all Fairy subsystems.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
DSH_ROOT="$(cd "$ROOT/.." && pwd)"

# Browser client modules are shipped as source strings, so syntax validation is
# an explicit build gate rather than an incidental side effect of unit tests.
node --check "$DSH_ROOT/fairy-contracts/index.js"
node --check "$DSH_ROOT/fairy-contracts/diagnostics.js"
node --check "$DSH_ROOT/fairy-contracts/client-diagnostics.cjs"
node --check "$DSH_ROOT/balance-meter/dsh-balance-meter/lib/index.js"
node --check "$DSH_ROOT/balance-meter/dsh-balance-meter/lib/client.js"
node --check "$DSH_ROOT/browser-dock/dsh-browser-dock/proxy.cjs"
node --check "$DSH_ROOT/browser-dock/dsh-browser-dock/lib/index.js"
node --check "$DSH_ROOT/browser-dock/dsh-browser-dock/lib/client.js"
node --check "$DSH_ROOT/browser-dock/dsh-browser-dock/src/index.js"
node --check "$DSH_ROOT/browser-dock/dsh-browser-dock/src/client/index.js"
node --check "$DSH_ROOT/fairy-visual/dsh-fairy-visual/lib/index.js"
node --check "$DSH_ROOT/fairy-visual/dsh-fairy-visual/lib/client.js"
node --check "$DSH_ROOT/fairy-visual/dsh-fairy-visual/src/index.js"
node --check "$DSH_ROOT/fairy-visual/dsh-fairy-visual/src/client/constants.js"
node --check "$DSH_ROOT/fairy-visual/dsh-fairy-visual/src/client/utils.js"
node --check "$DSH_ROOT/fairy-visual/dsh-fairy-visual/src/client/settings-write.js"
node --check "$DSH_ROOT/fairy-visual/dsh-fairy-visual/src/client/style.js"
node --check "$DSH_ROOT/fairy-visual/dsh-fairy-visual/src/client/surface-utils.js"
node --check "$DSH_ROOT/fairy-visual/dsh-fairy-visual/src/client/index.js"
node --check "$DSH_ROOT/fairy-visual/dsh-fairy-visual/src/client/settings-normalizer.cjs"
node --check "$DSH_ROOT/fairy-visual/dsh-fairy-visual/src/client/semantic-markers-manager.js"
node --check "$DSH_ROOT/fairy-visual/dsh-fairy-visual/src/client/sidebar-geometry-manager.js"
node --check "$DSH_ROOT/fairy-visual/dsh-fairy-visual/src/client/scrollbars-manager.js"
node --check "$DSH_ROOT/fairy-visual/dsh-fairy-visual/src/client/hero-projection-manager.js"
node --check "$DSH_ROOT/fairy-visual/dsh-fairy-visual/src/client/mascot-runtime.js"
node --check "$DSH_ROOT/fairy-visual/dsh-fairy-visual/src/client/visual-transitions.js"
node --check "$DSH_ROOT/fairy-startup/dsh-fairy-startup/lib/index.js"
node --check "$DSH_ROOT/fairy-startup/dsh-fairy-startup/lib/client.js"
node --check "$DSH_ROOT/fairy-voice/dsh-fairy-voice/lib/index.js"
node --check "$DSH_ROOT/fairy-voice/dsh-fairy-voice/lib/client.js"
for provider_file in "$DSH_ROOT/fairy-voice/dsh-fairy-voice/lib/providers"/*.js; do
  node --check "$provider_file"
done
node --check "$DSH_ROOT/fairy-persona/dsh-fairy-persona/lib/index.js"
node --check "$DSH_ROOT/fairy-persona/dsh-fairy-persona/lib/client.js"
node --check "$DSH_ROOT/fairy-modes/dsh-fairy-modes/lib/index.js"
node --check "$DSH_ROOT/fairy-modes/dsh-fairy-modes/lib/bridge.js"
node --check "$DSH_ROOT/fairy-modes/dsh-fairy-modes/lib/client.js"
node --check "$DSH_ROOT/fairy-search/dsh-fairy-search/lib/index.js"
node --check "$DSH_ROOT/fairy-search/dsh-fairy-search/lib/client.js"
node --check "$DSH_ROOT/fairy-memory/dsh-fairy-memory/lib/index.js"
node --check "$DSH_ROOT/fairy-memory/dsh-fairy-memory/lib/engine.js"
node --check "$DSH_ROOT/fairy-memory/dsh-fairy-memory/lib/memory-cli.js"
node --check "$DSH_ROOT/fairy-memory/dsh-fairy-memory/lib/client.js"
node --check "$ROOT/skill-audit.js"
node --check "$ROOT/scaffold-plugin.js"
# runtime/ 是私有资产,公开仓库不含;存在才检查。
for runtime_file in "$DSH_ROOT/.agent-presets/fairy/runtime/index.js" "$DSH_ROOT/.agent-presets/fairy/runtime/compiler.js"; do
  if [[ -f "$runtime_file" ]]; then
    node --check "$runtime_file"
  fi
done
node --check "$ROOT/preflight-build.js"
node --check "$ROOT/upgrade-preflight.js"
node --check "$ROOT/accepted-baseline.js"
node --check "$ROOT/log-triage.js"
if [[ -f "$DSH_ROOT/launchers/dsh-web-launcher.sh" ]]; then
  zsh -n "$DSH_ROOT/launchers/dsh-web-launcher.sh"
fi
node "$ROOT/preflight-build.js"
node "$ROOT/accepted-baseline.js"
node "$ROOT/log-triage.js" --require-healthy

# An upgrade candidate is opt-in and must live outside the active profile and
# runtime paths. Supplying only part of the candidate tuple fails closed.
if [[ -n "${DSH_UPGRADE_PROFILE:-}" || -n "${DSH_UPGRADE_RUNTIME:-}" || -n "${DSH_UPGRADE_VERSION:-}" || -n "${DSH_UPGRADE_SHA256:-}" ]]; then
  : "${DSH_UPGRADE_PROFILE:?DSH_UPGRADE_PROFILE is required for an upgrade candidate}"
  : "${DSH_UPGRADE_RUNTIME:?DSH_UPGRADE_RUNTIME is required for an upgrade candidate}"
  : "${DSH_UPGRADE_VERSION:?DSH_UPGRADE_VERSION is required for an upgrade candidate}"
  : "${DSH_UPGRADE_SHA256:?DSH_UPGRADE_SHA256 is required for an upgrade candidate}"
  node "$ROOT/upgrade-preflight.js" \
    --profile "$DSH_UPGRADE_PROFILE" \
    --runtime "$DSH_UPGRADE_RUNTIME" \
    --expected-version "$DSH_UPGRADE_VERSION" \
    --expected-sha256 "$DSH_UPGRADE_SHA256"
fi

# verify.js owns cross-module/static/live contracts only. Package tests run once
# below so the complete check has one deterministic owner for every test suite.
node "$ROOT/verify.js" --live
# 私有 runtime 的 Python/mjs 测试只在资产存在时运行(公开仓库不含 runtime/)。
if [[ -f "$DSH_ROOT/.agent-presets/fairy/runtime/test_fairy_core.py" ]]; then
  python3 "$DSH_ROOT/.agent-presets/fairy/runtime/test_fairy_core.py"
  node --test "$DSH_ROOT/.agent-presets/fairy/runtime"/test_*.mjs
fi
node --test "$DSH_ROOT/balance-meter/dsh-balance-meter/test"/*.test.js
node --test "$DSH_ROOT/browser-dock/dsh-browser-dock/test"/*.test.js
node --test "$DSH_ROOT/fairy-visual/dsh-fairy-visual/test"/*.test.js
node --test "$DSH_ROOT/fairy-startup/dsh-fairy-startup/test"/*.test.js
node --test "$DSH_ROOT/fairy-voice/dsh-fairy-voice/test"/*.test.js
node --test "$DSH_ROOT/fairy-persona/dsh-fairy-persona/test"/*.test.js
node --test "$DSH_ROOT/fairy-modes/dsh-fairy-modes/test"/*.test.js
node --test "$DSH_ROOT/fairy-search/dsh-fairy-search/test"/*.test.js
node --test "$DSH_ROOT/fairy-memory/dsh-fairy-memory/test"/*.test.js
node --test "$ROOT/test"/*.test.js
