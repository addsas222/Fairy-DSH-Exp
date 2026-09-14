/**
 * Fairy 安全闸门 —— 完整模式实现（消费 preset 语料，输出 order 49 的系统提示段）。
 *
 * 与 core 同一套契约：具名 `apply(ctx, config) → dispose`，`inject = ['systemPrompt']`，
 * config 含 `enabled` / `fidelity` / `limit`。
 *
 * 输入（preset 语料，语料缺失时用内置简明版兜底，绝不抛错）：
 *   style/fairy_real_ai_antipatterns.json   absolute_avoid / contextual_review /
 *                                           fairy_native_allowed / review_rule
 *   behavior/fairy_behavior_rules.json      与风险、确认、不可逆相关的规则
 *
 * 与降级模式的差别：降级只给一段通用风险条款；这里给出**逐条可判的禁区清单**
 * （每条带 id、触发串、原因）与"评审信号不是自动失败"的判据，让闸门可执行而不只是姿态。
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SECTION_NAME = 'fairy-safety-gate';
const SECTION_ORDER = 49;
const HERE = path.dirname(fileURLToPath(import.meta.url));

function corpusDirs(config) {
  const dirs = [];
  if (config?.runtimePath) dirs.push(path.dirname(String(config.runtimePath)));
  dirs.push(path.join(HERE, '..'), HERE);
  return [...new Set(dirs.filter(Boolean))];
}

function readCorpus(config, ...rel) {
  for (const dir of corpusDirs(config)) {
    const file = path.join(dir, ...rel);
    if (!existsSync(file)) continue;
    try { return JSON.parse(readFileSync(file, 'utf8')); } catch { /* 半写跳过 */ }
  }
  return null;
}

/** 内置兜底：语料不可用（或未勾选相关文件）时也得有闸门。 */
const INLINE_FALLBACK = [
  '【Fairy 安全闸门（内置简明版）】',
  '高风险动作（删除/覆盖/格式化、对外发送或发布、凭据与密钥、支付、关机重启、不可逆 git 操作）',
  '必须先以「警告。」开头说明后果与不可逆性，给出替代或备份方案，得到明确确认后再执行；',
  '风险未解除前不使用玩笑或叙事语域。',
].join('\n');

export function buildSectionText(config = {}) {
  const anti = readCorpus(config, 'style', 'fairy_real_ai_antipatterns.json');
  const behavior = readCorpus(config, 'behavior', 'fairy_behavior_rules.json');
  const strict = String(config.fidelity ?? 'strict').toLowerCase() !== 'brief';
  // 预设那行给的是 `exampleLimit`；`limit` 作为同义键也接受（脚本化调用时更短）。
  const limit = Number.isInteger(config.exampleLimit) ? config.exampleLimit
    : Number.isInteger(config.limit) ? config.limit : 8;
  if (!anti && !behavior) return INLINE_FALLBACK;

  const L = ['【Fairy 安全闸门（完整模式）】'];

  if (anti) {
    if (Array.isArray(anti.absolute_avoid) && anti.absolute_avoid.length) {
      L.push('', '【绝对禁区】一出现即不合格（不是风格偏好）：');
      for (const a of anti.absolute_avoid) {
        L.push(`- ${a.id}：${(a.patterns ?? []).join(' / ')}`);
        if (strict && a.reason) L.push(`    原因：${a.reason}`);
      }
    }
    if (Array.isArray(anti.contextual_review) && anti.contextual_review.length) {
      L.push('', `【需结合语境复核（${anti.contextual_review.length} 条，非自动失败）】：`);
      for (const c of anti.contextual_review.slice(0, limit)) {
        const pats = (c.patterns ?? []).join(' / ');
        L.push(`- ${c.id ?? '?'}：${pats}${strict && c.reason ? `（${c.reason}）` : ''}`);
      }
    }
    if (Array.isArray(anti.fairy_native_allowed) && anti.fairy_native_allowed.length) {
      L.push('', '【Fairy 语境下允许（不要据此判违规）】：');
      const items = anti.fairy_native_allowed.slice(0, strict ? 7 : 3)
        .map((x) => (typeof x === 'string' ? x : x?.id ?? x?.pattern ?? JSON.stringify(x)));
      L.push(`- ${items.join(' / ')}`);
    }
    if (anti.review_rule) L.push('', `【评审判据】${anti.review_rule}`);
  }

  // 行为规则里与风险/确认/不可逆直接相关的，是闸门的第二道：挑出来给判据与倾向
  const rules = Array.isArray(behavior?.rules) ? behavior.rules : [];
  const risky = rules.filter((r) => /风险|危险|不可逆|确认|权限|删除|凭据|密钥|支付|发布/i
    .test(`${r?.situation ?? ''} ${r?.response_strategy ?? ''} ${r?.decision_tendency ?? ''}`));
  if (risky.length) {
    L.push('', `【风险相关行为规则（${risky.length} 条）】：`);
    for (const r of risky) {
      L.push(`- ${r.rule_id}｜当：${r.situation}`);
      if (strict) {
        if (r.response_strategy) L.push(`    应对：${r.response_strategy}`);
        if (r.decision_tendency) L.push(`    倾向：${r.decision_tendency}`);
      }
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

// 同 index.js：必须判"本文件是入口"，否则 import 本文件的进程会被自检输出污染 stdout。
// 同 index.js：路径比较，避免 import 本模块的进程触发自检、污染其 stdout。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const text = buildSectionText({ fidelity: 'strict' });
  process.stdout.write(`${text}\n`);
  const checks = [
    ['含绝对禁区', /【绝对禁区】/.test(text)],
    ['含语境复核', /【需结合语境复核/.test(text)],
    ['含评审判据', /【评审判据】/.test(text)],
  ];
  for (const [name, ok] of checks) process.stdout.write(`  ${ok ? '✅' : '❌'} ${name}\n`);
  process.exitCode = checks.every(([, ok]) => ok) ? 0 : 1;
}
