/**
 * Fairy Full preset 行：`dsh-fairy-eval` 的 agent 面（`typesafe_eval` 工具）
 * 在仓库 fairy-eval/ 下，经公共装载器按 `DSH_FAIRY_REPO_ROOT` 解析。
 * 宿主面（两个 exact 路由）由 profile 的 `dsh-fairy-eval` 行承担；
 * 配置只走环境变量（TYPESAFE_API_KEY / TYPESAFE_MODEL），无设置卡、无客户端 bundle。
 */
import { loadEngine } from './_shim.mjs';

export const { apply, inject } = await loadEngine('fairy-eval/dsh-fairy-eval/lib/engine.js');
