/**
 * Fairy 安全闸门 —— preset 内 shim（与 fairy-core-runtime.mjs 同一套路）。
 *
 * 原写法用 `!!js` 拼运行期路径，违反"行名必须是字面字符串"的约束，会让 preset 判 BROKEN。
 *
 * 真身 runtime/safety-gate.js **不在公开仓库里**（本机、F: 检出、上游全历史皆无），
 * 所以这里：
 *   1) 真身存在 → 转发给它；
 *   2) 缺失 → 用一个保守的缺省闸门：对高风险动作（删除、外发、凭据、付款、关机等）
 *      要求先确认，与 AGENTS §6「风险第一句"警告。"」的既有约定一致。
 */
const repoRoot = String(process.env.DSH_FAIRY_REPO_ROOT ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
const presetDir = repoRoot ? `file:///${repoRoot}/.agent-presets/fairy/` : null;

async function loadPrivateGate() {
  if (!presetDir) return null;
  try {
    const mod = await import(`${presetDir}runtime/safety-gate.js`);
    if (typeof mod.apply === 'function') return mod;
  } catch (error) {
    if (!/ERR_MODULE_NOT_FOUND|Cannot find module/.test(String(error?.message ?? error))) throw error;
  }
  return null;
}

const RISKY = /(rm\s+-rf|del\s+\/[sq]|format\s+[a-z]:|清除|删除全部|shutdown|重启|格式化|撤销|revert\s+--hard|force[ -]?push|推送|publish|npm\s+publish|转账|付款|支付|密码|凭据|token|私钥)/i;

export async function apply(ctx) {
  const real = await loadPrivateGate();
  if (real) return real.apply(ctx);

  // 降级闸门：把风险清单作为一段常驻提示交给模型（不拦截工具，只约束措辞与确认）
  const brief = [
    '【Fairy 安全闸门（降级模式：未加载私有 safety-gate.js）】',
    '高风险动作（删除/覆盖/格式化、对外发送或发布、凭据与密钥、支付、关机重启、不可逆的 git 操作）',
    '必须先以「警告。」开头说明后果与不可逆性，给出可执行替代或备份方案，得到明确确认后再执行；',
    '风险未解除前不使用玩笑或叙事语域。仅提及风险关键词（例如讨论某段代码里出现 "删除"）不触发闸门。',
  ].join('\n');
  if (ctx?.systemPrompt?.section) ctx.systemPrompt.section('fairy-safety-gate', brief);
  return undefined;
}

export const inject = [];
export const riskyPattern = RISKY;
