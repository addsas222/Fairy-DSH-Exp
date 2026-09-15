/**
 * Fairy Full preset 内所有 shim 的公共装载器。
 *
 * 为什么需要 shim 这一层（每个行都适用）：
 * - preset 行名必须是字面字符串，且相对路径按 preset 目录解析；
 * - preset 被复制进 `$DSH_HOME` 后，`../../` 逃逸不再指向仓库；
 * - 所以每个 shim 用 `DSH_FAIRY_REPO_ROOT` 拼出仓库内的真实模块地址再 import。
 *
 * 宿主面（路由 + 设置卡 + 设置命名空间）由 profile 的 host 行承担；shim 只挂
 * agent 面工具，两面读同一份 `$DSH_HOME` 下的配置。
 *
 * @param relativePath - 仓库内的模块相对路径，例如 `fairy-modes/dsh-fairy-modes/lib/index.js`。
 * @returns `{ apply, inject }`：`inject` 缺省为空数组，行就能直接挂。
 */
export async function loadEngine(relativePath) {
  const moduleUrl = new URL(
    relativePath,
    `file:///${String(process.env.DSH_FAIRY_REPO_ROOT ?? '').replace(/\\/g, '/').replace(/^\/+/, '')}/`,
  );
  try {
    const mod = await import(moduleUrl.href);
    return { apply: mod.apply, inject: mod.inject ?? [] };
  } catch (error) {
    throw new Error(
      `fairy-full preset: cannot load ${relativePath} from ${moduleUrl.href}. `
      + 'Set DSH_FAIRY_REPO_ROOT to the Fairy-DSH checkout before launching dsh. '
      + `Cause: ${String(error?.message ?? error)}`,
      { cause: error },
    );
  }
}
