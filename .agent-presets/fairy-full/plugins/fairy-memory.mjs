/**
 * Fairy Full preset 行：`dsh-fairy-memory` 的 agent 面（`memory_recall` /
 * `memory_remember` 工具）在仓库 fairy-memory/ 下，经公共装载器按
 * `DSH_FAIRY_REPO_ROOT` 解析。宿主面（`/fairy-memory/*` 路由 + 设置卡）由
 * profile 的 `dsh-fairy-memory` 行承担，两面读同一份设置。
 */
import { loadEngine } from './_shim.mjs';

export const { apply, inject } = await loadEngine('fairy-memory/dsh-fairy-memory/lib/engine.js');
