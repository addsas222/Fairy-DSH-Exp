/**
 * Ponytail preset 行：`dsh-fairy-roleplay` 的 agent 面（`roleplay_check` /
 * `roleplay_style` 工具）在仓库 fairy-roleplay/ 下，经公共装载器按
 * `DSH_FAIRY_REPO_ROOT` 解析。宿主面（设置命名空间 + `/fairy-roleplay/*` 路由
 * + 设置卡）由 profile 的 `dsh-fairy-roleplay` 行承担；角色扮演模式的规则段落
 * 由 `dsh-fairy-modes` 的 `fairy:mode-roleplay` 注入。
 */
import { loadEngine } from './_shim.mjs';

export const { apply, inject } = await loadEngine('fairy-roleplay/dsh-fairy-roleplay/lib/engine.js');
