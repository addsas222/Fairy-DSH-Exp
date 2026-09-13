/**
 * Ponytail preset 行：`dsh-fairy-modes` 的 agent 面（模式服务 + `fairy:pipeline`
 * 段落 + `mode_pipeline` / `session_recall` 工具）在仓库 fairy-modes/ 下，经
 * 公共装载器按 `DSH_FAIRY_REPO_ROOT` 解析。宿主面（`/fairy-modes/*` 路由 +
 * 模式 chip 的客户端 bundle）由 profile 的 `dsh-fairy-modes` 行承担。
 */
import { loadEngine } from './_shim.mjs';

export const { apply, inject } = await loadEngine('fairy-modes/dsh-fairy-modes/lib/index.js');
