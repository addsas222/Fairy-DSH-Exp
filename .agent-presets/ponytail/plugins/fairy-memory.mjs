/**
 * Ponytail preset 内 shim:dsh-fairy-memory 的 agent 面(记忆工具)在仓库
 * fairy-memory/ 下,由 DSH_FAIRY_REPO_ROOT 解析(与 ./plugins/fairy-modes.mjs
 * 同约定)。
 *
 * 为什么需要这一层:
 * - preset 行名必须是字面字符串,且相对路径按 preset 目录解析;
 * - preset 被复制进 $DSH_HOME 后,`../../` 逃逸不再指向仓库;
 * - 宿主面(路由 + 设置卡)由 profile 的 dsh-fairy-memory 行承担,这里只挂
 *   agent 面(memory_recall / memory_remember),两面共用同一份设置。
 */
const moduleUrl = new URL(
  'fairy-memory/dsh-fairy-memory/lib/engine.js',
  `file:///${String(process.env.DSH_FAIRY_REPO_ROOT ?? '').replace(/\\/g, '/').replace(/^\/+/, '')}/`,
);

let mod;
try {
  mod = await import(moduleUrl.href);
} catch (error) {
  throw new Error(
    `ponytail preset: cannot load dsh-fairy-memory from ${moduleUrl.href}. `
    + 'Set DSH_FAIRY_REPO_ROOT to the Fairy-DSH checkout before launching dsh. '
    + `Cause: ${String(error?.message ?? error)}`,
    { cause: error },
  );
}

export const apply = mod.apply;
