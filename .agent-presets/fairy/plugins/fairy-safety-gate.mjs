/**
 * Fairy 安全闸门 —— preset 内 shim（与 fairy-core-runtime.mjs 同一套路）。
 *
 * 行名合规化同前：原 `!!js` 绝对路径会让 preset 判 BROKEN，改为 preset 内相对路径。
 * 真身优先私有同名实现；本仓的 runtime/safety-gate.js 是随仓分发的公开引擎：
 *   1) 存在 → 转发；
 *   2) 缺失 → 保守的缺省闸门：高风险动作要求先「警告。」并确认，与仓库既有约定一致。
 *
 * 挂载形状照既有约定：`systemPrompt.section({ name, order, text })`（单对象 + 显式
 * order + 返回 dispose）。order 取 49，与 persona(50 区间)/modes 的取值错开。
 */
const repoRoot = String(process.env.DSH_FAIRY_REPO_ROOT ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
const presetDir = repoRoot ? `file:///${repoRoot}/.agent-presets/fairy/` : null;

const SECTION_NAME = 'fairy-safety-gate';
const SECTION_ORDER = 49;

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

const FALLBACK_TEXT = [
  '【Fairy 安全闸门（降级模式：未加载私有 safety-gate.js）】',
  '高风险动作（删除/覆盖/格式化、对外发送或发布、凭据与密钥、支付、关机重启、不可逆的 git 操作）',
  '必须先以「警告。」开头说明后果与不可逆性，给出可执行替代或备份方案，得到明确确认后再执行；',
  '风险未解除前不使用玩笑或叙事语域。仅提及风险关键词（例如讨论某段代码里出现「删除」）不触发闸门。',
].join('\n');

export async function apply(ctx, config = {}) {
  const real = await loadPrivateGate();
  if (real) return real.apply(ctx, config);

  const disposers = [];
  if (typeof ctx?.systemPrompt?.section === 'function') {
    disposers.push(ctx.systemPrompt.section({ name: SECTION_NAME, order: SECTION_ORDER, text: FALLBACK_TEXT }));
  }
  return () => { for (const dispose of disposers.splice(0)) { try { dispose(); } catch {} } };
}

// 加载门控：systemPrompt 不可用时本行不加载（而不是加载后静默不挂段落）。
export const inject = ['systemPrompt'];
