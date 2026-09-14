/**
 * Fairy voice core —— preset 内 shim。
 *
 * 两层职责：
 *  1) 行名合规：preset 行名必须是**字面字符串**（相对路径按 preset 目录解析），
 *     而原写法用 `!!js` 拼绝对路径 —— 发现器的 entryListProblem 要求 name 是字符串，
 *     整个 preset 因此判 BROKEN。这里用 preset 内相对路径 shim 顶替。
 *  2) 真身缺失时的降级：仓库内的 runtime/index.js **从未进过任何公开仓库**
 *     （本仓与上游 Chengzhibense/Fairy-DSH 全历史、工作树、两个 home 皆无）。
 *     存在则转发给它；缺失则把随 preset 分发的语料编译成系统提示速查段。
 *
 * 系统提示的挂载形状照本仓既有约定（fairy-persona / fairy-modes 同款）：
 * `ctx.systemPrompt.section({ name, order, text })` **单对象、显式 order、返回 dispose**。
 * order 与 persona/modes 的取值区间错开（这里取 47），避免与既有段落互相覆盖。
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const repoRoot = String(process.env.DSH_FAIRY_REPO_ROOT ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
const presetDir = repoRoot ? `file:///${repoRoot}/.agent-presets/fairy/` : null;

const SECTION_NAME = 'fairy-voice-core';
const SECTION_ORDER = 47;

async function loadPrivateRuntime() {
  if (!presetDir) return null;
  try {
    const mod = await import(`${presetDir}runtime/index.js`);
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

/** 用现有语料拼一份紧凑速查（真身缺失时的降级内容）。 */
function compileCorpusBrief() {
  const rules = readCorpus('behavior/fairy_behavior_rules.json');
  const traits = readCorpus('personality/fairy_personality.json');
  const canon = readCorpus('canon/fairy_canon.json');
  const style = readCorpus('style/fairy_speech_style.json');
  const lines = ['【Fairy 语音核心（语料编译 · 降级模式：未加载私有 runtime）】'];
  if (style?.sample_count) lines.push(`句感样本量：${style.sample_count}`);
  if (style?.sentence_length_chars) lines.push(`句长基线：${JSON.stringify(style.sentence_length_chars)}`);
  const traitNames = Object.keys(traits?.traits ?? {}).slice(0, 12);
  if (traitNames.length) lines.push(`人格维度：${traitNames.join('、')}`);
  const canonCount = Array.isArray(canon?.entries) ? canon.entries.length : 0;
  if (canonCount) lines.push(`正典条目：${canonCount} 条（canon/fairy_canon.json）`);
  const ruleCount = Array.isArray(rules?.rules) ? rules.rules.length : Object.keys(rules?.rules ?? {}).length;
  if (ruleCount) lines.push(`行为规则：${ruleCount} 条（behavior/fairy_behavior_rules.json）`);
  return lines.join('\n');
}

export async function apply(ctx, config = {}) {
  const real = await loadPrivateRuntime();
  if (real) return real.apply(ctx, config);

  const brief = compileCorpusBrief();
  const disposers = [];
  if (typeof ctx?.systemPrompt?.section === 'function' && brief) {
    disposers.push(ctx.systemPrompt.section({ name: SECTION_NAME, order: SECTION_ORDER, text: brief }));
  }
  // 与 persona/modes 一致：返回 dispose，宿主卸载时清理已挂段落
  return () => { for (const dispose of disposers.splice(0)) { try { dispose(); } catch {} } };
}

export const inject = [];
