/**
 * 角色扮演的提示词装配：把规则、人格、风格库合成一段可直接放进系统提示词的
 * 文本，并对候选回复做一次去AI味自检。纯函数，无 IO —— 便于单测，也让宿主、
 * agent 工具、设置卡三处看到同一套规则。
 *
 * 装配顺序（越靠前越优先）：
 * 1. 角色身份（人格包）——决定“是谁在说话”。
 * 2. 语言习惯（风格库）——角色自己的固定表达。
 * 3. 时机 → 回复 → 规划规则——决定“什么时候说、怎么说”。
 * 4. 去AI味档位说明——最后一道闸门。
 *
 * @module dsh-fairy-roleplay/pipeline
 */
import { check, renderReport } from './humanizer.js';
import {
  PLANNER_RULES,
  REPLY_RULES,
  TIMING_RULES,
  renderRuleBlock,
} from './rules.js';
import { renderStyleBlock } from './style.js';

const LEVEL_NOTE = {
  off: '去AI味检查已关闭：照常说话即可。',
  l1: '写完后自检 L1：套话、元话术、行业黑话、对比壳与序列壳一律不许出现。',
  l2: '写完后自检 L2：在 L1 之上还要有长短句交错，段落别一样长。',
  l3: '写完后自检 L3：在 L2 之上，评价句后面要有具体事实，比喻要有可验证的相似性。',
  l4: '写完后自检 L4：自动检查通过后，还要通读一遍，确认像真人说话再发出。',
};

/**
 * 组装角色扮演提示词块。
 *
 * @param options.persona - `{ name, description, tone }`，来自人格包；缺省时不注入身份段。
 * @param options.styleEntries - 风格库条目。
 * @param options.settings - `{ humanizerLevel, timingGate, styleEnabled }`。
 * @returns 多行提示词文本。
 */
export function buildRoleplayBrief({ persona, styleEntries, settings } = {}) {
  const level = typeof settings?.humanizerLevel === 'string' ? settings.humanizerLevel : 'l1';
  const blocks = [];
  const name = typeof persona?.name === 'string' ? persona.name.trim() : '';
  if (name !== '') {
    const description = typeof persona?.description === 'string' ? persona.description.trim() : '';
    blocks.push(['## 角色身份', `你扮演「${name}」。${description}`, '用第一人称说话，用户名不是角色名，不要把角色台词说成旁白。'].join('\n'));
  }
  if (settings?.styleEnabled !== false) {
    const style = renderStyleBlock(styleEntries);
    if (style !== '') blocks.push(style);
  }
  blocks.push(renderRuleBlock('时机', TIMING_RULES));
  if (settings?.timingGate === false) blocks.push('（本轮时机门已关闭：按用户节奏正常回应，不再主动沉默。）');
  blocks.push(renderRuleBlock('怎么说话', REPLY_RULES));
  blocks.push(renderRuleBlock('先想后说', PLANNER_RULES));
  blocks.push(`## 去AI味\n${LEVEL_NOTE[level] ?? LEVEL_NOTE.l1}`);
  return blocks.join('\n\n');
}

/**
 * 对一条候选回复跑自检，返回结果与给模型的报告。
 *
 * @param text - 候选回复。
 * @param options.settings - `{ humanizerLevel }`。
 * @returns `{ check, passed, report }`。
 */
export function assessReply(text, { settings } = {}) {
  const level = typeof settings?.humanizerLevel === 'string' ? settings.humanizerLevel : 'l1';
  const result = check(text, { level });
  return { check: result, passed: result.hits.length === 0, report: renderReport(result) };
}
