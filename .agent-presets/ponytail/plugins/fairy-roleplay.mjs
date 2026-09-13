/**
 * Ponytail preset 内 shim:dsh-fairy-roleplay 的 agent 面(roleplay_check /
 * roleplay_style 两个工具)在仓库 fairy-roleplay/ 下,由 DSH_FAIRY_REPO_ROOT
 * 解析(与 ./plugins/fairy-modes.mjs / ./plugins/fairy-memory.mjs 同约定)。
 *
 * 为什么需要这一层:
 * - preset 行名必须是字面字符串,且相对路径按 preset 目录解析;
 * - preset 被复制进 $DSH_HOME 后,`../../` 逃逸不再指向仓库;
 * - 宿主面(设置命名空间 fairy-roleplay + /fairy-roleplay/* 路由 + 设置卡)由
 *   profile 的 dsh-fairy-roleplay 行承担,这里只挂 agent 面(去AI味自检与风格库),
 *   两面读同一份 $DSH_HOME/fairy-roleplay/ 下的配置与风格文件。
 * - 角色扮演模式本身的规则段落由 dsh-fairy-modes 的 `fairy:mode-roleplay`
 *   提示词段注入;本 shim 只提供该段落点名的工具。
 */
const moduleUrl = new URL(
  'fairy-roleplay/dsh-fairy-roleplay/lib/engine.js',
  `file:///${String(process.env.DSH_FAIRY_REPO_ROOT ?? '').replace(/\\/g, '/').replace(/^\/+/, '')}/`,
);

let mod;
try {
  mod = await import(moduleUrl.href);
} catch (error) {
  throw new Error(
    `ponytail preset: cannot load dsh-fairy-roleplay from ${moduleUrl.href}. `
    + 'Set DSH_FAIRY_REPO_ROOT to the Fairy-DSH checkout before launching dsh. '
    + `Cause: ${String(error?.message ?? error)}`,
    { cause: error },
  );
}

export const apply = mod.apply;
export const inject = mod.inject;
