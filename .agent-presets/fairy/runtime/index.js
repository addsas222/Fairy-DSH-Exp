/**
 * Fairy 语音核心 —— 完整模式实现（消费 preset 语料，输出 order 47 的系统提示段）。
 *
 * 契约（由 preset 内 shim 与宿主共同约定，逐条照办）：
 *   - 具名导出 `apply(ctx, config)`，返回 dispose 函数；
 *   - `inject = ['systemPrompt']`（宿主只读 shim 那行的声明，这里保留是与另两个插件同形）；
 *   - config 来自 preset 那一行，**由本模块消费**：
 *       runtimePath  语料根（默认 `<preset>/runtime/`，其父目录即 .agent-presets/fairy/）
 *       enabled      false 则不挂任何段落（但仍返回 dispose）
 *       fidelity     'strict' 全量展开；'brief' 只出骨架
 *       exampleLimit 每个 profile 取多少条真实例句
 *
 * 这与"降级模式"的区别：降级只把语料压成 7 行摘要（样本量/句长/维度名/条目数），
 * 本实现把 voice_model 的 **principles + 9 个 profiles（when/action/shape/例句）**
 * 与 speech_style 的句长基线、antipatterns 的绝对禁区一并组装成可执行的语域手册。
 *
 * 纯读 + 纯拼字符串：没有网络、没有副作用；语料缺失时降级为自己的简明版，
 * 绝不抛错（抛错会让整个 preset 加载失败，比缺一段文字严重得多）。
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SECTION_NAME = 'fairy-voice-core';
const SECTION_ORDER = 47;
const HERE = path.dirname(fileURLToPath(import.meta.url));   // <preset>/runtime/

/**
 * 语料目录。两种摆法都要容忍：
 *   a) 语料在 preset 下（`<preset>/style/…`）——仓库现状；
 *   b) 语料被搬进 runtime 内（`<preset>/runtime/style/…`）——私有打包形态。
 * 优先 config.runtimePath 的所在目录（preset 已声明该值）。
 */
function corpusDirs(config) {
  const dirs = [];
  if (config?.runtimePath) dirs.push(path.dirname(String(config.runtimePath)));
  dirs.push(path.join(HERE, '..'), HERE);
  return [...new Set(dirs.filter(Boolean))];
}

/** 逐个候选目录找语料：`<dir>/style/<file>`。 */
function readCorpus(config, ...rel) {
  for (const dir of corpusDirs(config)) {
    const file = path.join(dir, ...rel);
    if (!existsSync(file)) continue;
    try { return JSON.parse(readFileSync(file, 'utf8')); } catch { /* 半写就跳过 */ }
  }
  return null;
}

/** 例句按 exampleLimit 截断；文本去空白，附带来源 turn_id 便于回溯（strict 才带）。 */
function renderExamples(profile, limit, strict) {
  const ex = Array.isArray(profile?.examples) ? profile.examples : [];
  return ex.slice(0, Math.max(0, limit)).map((e) => {
    const text = String(e?.text ?? '').trim();
    return strict && e?.turn_id ? `    · ${text}（${e.turn_id}）` : `    · ${text}`;
  });
}

/** 组装段落正文。返回 null 表示语料不可用（由 shim 的降级分支兜底得更彻底）。 */
export function buildSectionText(config = {}) {
  const voice = readCorpus(config, 'style', 'fairy_voice_model.json');
  const style = readCorpus(config, 'style', 'fairy_speech_style.json');
  const anti = readCorpus(config, 'style', 'fairy_real_ai_antipatterns.json');
  if (!voice) return null;

  const strict = String(config.fidelity ?? 'strict').toLowerCase() !== 'brief';
  const limit = Number.isInteger(config.exampleLimit) ? config.exampleLimit : 2;
  const L = ['【Fairy 语音核心（完整模式 · 语料 v' + (voice.schema_version ?? '?') + '）】'];

  if (Number.isFinite(voice.turn_count)) L.push(`语料来源：${voice.source ?? 'voice model'}，${voice.turn_count} 轮`);

  // 两套语域：这是"操作播报"与"角色叙事"分离的根，先给判据再给细则
  const regs = voice.registers ?? {};
  if (Object.keys(regs).length) {
    L.push('', '【两套语域】');
    for (const [name, desc] of Object.entries(regs)) L.push(`- ${name}：${String(desc).trim()}`);
  }

  if (Array.isArray(voice.principles) && voice.principles.length) {
    L.push('', '【原则】');
    voice.principles.forEach((p, i) => L.push(`${i + 1}. ${p}`));
  }

  // profiles：按 when 触发的场景手册——真身与降级差距最大的地方
  const profiles = voice.profiles ?? {};
  const keys = Object.keys(profiles);
  if (keys.length) {
    L.push('', `【场景手册（${keys.length} 类）】`);
    for (const key of keys) {
      const p = profiles[key] ?? {};
      L.push(`- ${key}（register=${p.register ?? '?'}） 触发：${p.when ?? '?'}`);
      if (strict) {
        if (p.action) L.push(`    做法：${p.action}`);
        if (Array.isArray(p.shape) && p.shape.length) L.push(`    句型：${p.shape.join(' / ')}`);
        const ex = renderExamples(p, limit, strict);
        if (ex.length) L.push('    例句：', ...ex);
      }
    }
  }

  // 句长与标点：可直接约束生成的"手感"
  if (style) {
    const len = style.sentence_length_chars ?? {};
    L.push('', '【句感基线】');
    if (Number.isFinite(len.mean)) L.push(`- 句长：均值 ${len.mean} 字 / 中位 ${len.median} / p90 ${len.p90}（超出即偏长）`);
    if (Number.isFinite(style.sample_count)) L.push(`- 样本：${style.sample_count} 句`);
    if (Array.isArray(style.punctuation)) L.push(`- 标点：${style.punctuation.join(' ')}`);
    if (Array.isArray(style.high_frequency_terms) && style.high_frequency_terms.length) {
      const terms = style.high_frequency_terms.slice(0, strict ? 24 : 10).map((t) => (typeof t === 'string' ? t : t?.term)).filter(Boolean);
      if (terms.length) L.push(`- 高频词：${terms.join('、')}`);
    }
  }

  if (anti && Array.isArray(anti.absolute_avoid) && anti.absolute_avoid.length) {
    L.push('', '【绝对禁区（一出现即不合格）】');
    for (const a of anti.absolute_avoid) {
      const pats = (a.patterns ?? []).slice(0, strict ? 8 : 3).join(' / ');
      L.push(`- ${a.id ?? '?'}：${pats}`);
      if (strict && a.reason) L.push(`    原因：${a.reason}`);
    }
  }
  return L.join('\n');
}

export async function apply(ctx, config = {}) {
  if (config.enabled === false) return () => {};
  const disposers = [];
  if (typeof ctx?.systemPrompt?.section === 'function') {
    const text = buildSectionText(config);
    if (text) disposers.push(ctx.systemPrompt.section({ name: SECTION_NAME, order: SECTION_ORDER, text }));
  }
  return () => { for (const d of disposers.splice(0)) { try { d(); } catch {} } };
}

export const inject = ['systemPrompt'];

// 自检：`node index.js` 直接打印段落，人眼可核（也是本模块唯一的"测试"）。
// 判据必须是"**本文件**是入口"——不能用 `argv[1].endsWith('index.js')`：那样任何
// `import()` 到本文件的进程都会命中（`node -e 'import(...)'` 的 argv[1] 就是本文件），
// 自检正文会污染调用方的 stdout。
// 判据用**路径比较**（不靠 URL 形态）：任何 import 到本模块的进程都不能触发自检分支。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const text = buildSectionText({ fidelity: 'strict', exampleLimit: 2 }) ?? '(语料不可用)';
  process.stdout.write(`${text}\n`);
  const checks = [
    ['含两套语域', /【两套语域】/.test(text)],
    ['含场景手册', /【场景手册/.test(text)],
    ['含禁区', /【绝对禁区/.test(text)],
    ['含句感基线', /【句感基线】/.test(text)],
    ['限制了例句条数', (text.match(/^    · /gm) ?? []).length > 0],
  ];
  for (const [name, ok] of checks) process.stdout.write(`  ${ok ? '✅' : '❌'} ${name}\n`);
  process.exitCode = checks.every(([, ok]) => ok) ? 0 : 1;
}
