/**
 * Ponytail preset 内 shim:dsh-fairy-modes 的实际代码在仓库 fairy-modes/ 下,
 * 由 DSH_FAIRY_REPO_ROOT 解析(与 fairy preset 引用私有 runtime 的约定一致)。
 *
 * 为什么需要这一层:
 * - preset 行名必须是字面字符串,且相对路径按 preset 目录解析;
 * - preset 被打包/复制进 $DSH_HOME 后,`../../` 逃逸不再指向仓库;
 * - 本 shim 位于 preset 内部,行名 './plugins/fairy-modes.js' 恒可解析,
 *   真实插件位置交给启动器导出的环境变量,两种部署形态行为一致。
 */
const moduleUrl = new URL(
  'fairy-modes/dsh-fairy-modes/lib/index.js',
  `file:///${String(process.env.DSH_FAIRY_REPO_ROOT ?? '').replace(/\\/g, '/').replace(/^\/+/, '')}/`,
);

let mod;
try {
  mod = await import(moduleUrl.href);
} catch (error) {
  throw new Error(
    `ponytail preset: cannot load dsh-fairy-modes from ${moduleUrl.href}. `
    + 'Set DSH_FAIRY_REPO_ROOT to the Fairy-DSH checkout before launching dsh. '
    + `Cause: ${String(error?.message ?? error)}`,
    { cause: error },
  );
}

export const apply = mod.apply;
export const inject = mod.inject;
export const fairyModeProjectionDefinition = mod.fairyModeProjectionDefinition;
export const FairyModeService = mod.FairyModeService;
