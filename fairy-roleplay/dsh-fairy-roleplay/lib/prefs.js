/**
 * 角色扮演偏好 → 提示词：把设置卡上的开关翻译成模型能读到的约束。
 *
 * 这是那些开关的**唯一消费者**：设置卡写、这里读，动态段落每轮按当前设置渲染。
 * 纯函数，没有 IO —— 单测直接断言「开关变化 → 文本变化」，不必起服务。
 *
 * 每个开关**两个分支都会说话**：只说 on 的状态等于没接线（基础段落已经写了默认行为，
 * 关掉开关必须能覆盖它），所以 off 分支给出显式的反向指令。
 *
 * @module dsh-fairy-roleplay/prefs
 */
import { HUMANIZER_LEVELS } from './rules.js';
import { renderStyleBlock } from './style.js';

/** 去AI味档位 → 自检指令。 */
const LEVEL_LINES = {
  off: '去AI味自检：关闭，照常说话即可。',
  l1: '去AI味自检 L1：套话、元话术、行业黑话、对比壳与序列壳一律不许出现。',
  l2: '去AI味自检 L2：在 L1 之上还要长短句交错，段落别一样长。',
  l3: '去AI味自检 L3：在 L2 之上，评价句后面要有具体事实，比喻要有可验证的相似性。',
  l4: '去AI味自检 L4：自动检查通过后还要通读一遍，确认像真人说话再发出。',
};

/**
 * 渲染角色扮演偏好段落。
 *
 * @param settings - 解析后的 `fairy-roleplay` 设置段。
 * @param styleEntries - 风格库条目（`styleEnabled` 打开时才会用到）。
 * @returns 多行文本；永不返回空串（开关总有一个状态要说明）。
 */
export function buildRoleplayPrefsText(settings, styleEntries) {
  const level = HUMANIZER_LEVELS.includes(settings?.humanizerLevel) ? settings.humanizerLevel : 'l1';
  const lines = [
    settings?.timingGate === false
      ? '时机门已关闭：按用户节奏正常回应，不要为了“不刷存在感”而沉默。'
      : '时机门开启：只在被点名、被提问或话题明显指向角色时开口，其余情况保持沉默，不产出占位回复。',
  ];
  const style = settings?.styleEnabled === false ? '' : renderStyleBlock(styleEntries);
  if (settings?.styleEnabled === false) lines.push('风格库已关闭：忽略既有习惯，用你自己的说法。');
  else if (style !== '') lines.push(style);
  lines.push(LEVEL_LINES[level]);
  if (level !== 'off') {
    lines.push(settings?.autoCheck === false
      ? '发出前自检已关闭：不必调用 roleplay_check。'
      : '发出前用 roleplay_check 跑一遍去AI味检查，命中项改完再发。');
  }
  lines.push(settings?.memoryImpression === false
    ? '不要为这段对话写长期记忆（不使用 memory_remember）。'
    : '值得长期记住的设定、称呼与约定用 memory_remember 落盘；需要回顾过去互动时先用 memory_recall。');
  const body = lines.flatMap((line) => (line.includes('\n') ? [line] : [`- ${line}`]));
  return [`## 角色扮演偏好（设置卡）`, ...body].join('\n');
}
