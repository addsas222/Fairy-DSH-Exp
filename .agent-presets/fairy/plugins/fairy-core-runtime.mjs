/**
 * Fairy voice core —— preset 内 shim。
 *
 * 为什么需要这一层（与 ponytail 的 _shim.mjs 同理）：
 * - preset 行名必须是**字面字符串**，而发现器的 entryListProblem 不接受 `!!js`；
 *   原写法 `name: !!js process.env.DSH_FAIRY_REPO_ROOT + '/runtime/index.js'` 因此
 *   会让整个 preset 判为 BROKEN（"row 2 names no plugin"）。
 * - 相对路径按 preset 目录解析；preset 被复制进 $DSH_HOME 后 `../../` 逃逸不再有效，
 *   所以真身地址用 DSH_FAIRY_REPO_ROOT 在**运行期**拼出来。
 *
 * 真身（仓库内的 runtime/index.js）**不在公开仓库里**，从未进过任何版本控制：
 * 本机、F: 检出、上游 Chengzhibense/Fairy-DSH 全历史都没有。所以这里做两件事：
 *   1) 真身存在 → 转发给它（私有部署机上的预期路径）；
 *   2) 真身缺失 → 缺省实现：把 preset 自带语料（behavior/personality/canon/style）
 *      编译成一段可注入的速查文本，让 preset 在**没有私有 runtime** 的机器上也能用，
 *      只是少了统计式语音选择（原 runtime 的职责）。
 *
 * 语料本身是随 preset 分发的（behavior_rules 334KB / personality 55KB / canon 12KB）。
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const repoRoot = String(process.env.DSH_FAIRY_REPO_ROOT ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
const presetDir = repoRoot ? `file:///${repoRoot}/.agent-presets/fairy/` : null;

async function loadPrivateRuntime() {
  if (!presetDir) return null;
  const url = `${presetDir}runtime/index.js`;
  try {
    const mod = await import(url);
    if (typeof mod.apply === 'function') return mod;
  } catch (error) {
    if (!/ERR_MODULE_NOT_FOUND|Cannot find module/.test(String(error?.message ?? error))) throw error;
  }
  return null;
}

function readCorpus(relative) {
  if (!repoRoot) return null;
  const file = path.join(repoRoot, '.agent-presets', 'fairy', relative);
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

/** 用现有语料拼一份紧凑的速查表（真身缺失时的降级路径）。 */
function compileCorpusBrief() {
  const rules = readCorpus('behavior/fairy_behavior_rules.json');
  const traits = readCorpus('personality/fairy_personality.json');
  const canon = readCorpus('canon/fairy_canon.json');
  const style = readCorpus('style/fairy_speech_style.json');
  const lines = ['【Fairy 语音核心（语料编译，降级模式：未加载私有 runtime）】'];
  if (style) {
    const s = style.sentence_length_chars;
    if (s) lines.push(`句长基线：${JSON.stringify(s)}`);
    if (style.sample_count) lines.push(`样本量：${style.sample_count}`);
  }
  if (traits) {
    const names = Object.keys(traits.traits ?? {}).slice(0, 12);
    if (names.length) lines.push(`人格维度：${names.join('、')}`);
  }
  if (canon) {
    const n = Array.isArray(canon.entries) ? canon.entries.length : 0;
    if (n) lines.push(`正典条目：${n} 条（canon/fairy_canon.json）`);
  }
  if (rules) {
    const n = Array.isArray(rules.rules) ? rules.rules.length : Object.keys(rules.rules ?? {}).length;
    if (n) lines.push(`行为规则：${n} 条（behavior/fairy_behavior_rules.json）`);
  }
  return lines.join('\n');
}

export async function apply(ctx, config = {}) {
  const real = await loadPrivateRuntime();
  if (real) return real.apply(ctx, config);

  // 降级：把语料速查注入系统提示（persona 行已提供主体人格文本）
  const brief = compileCorpusBrief();
  if (ctx?.systemPrompt?.section && brief) {
    ctx.systemPrompt.section('fairy-voice-core', brief);
  }
  return undefined;
}

export const inject = [];
