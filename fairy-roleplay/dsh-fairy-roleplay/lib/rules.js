/**
 * 角色扮演模式的语言规则数据：去AI味词表/句式、回复写作规则、时机门、以及
 * 风格库与记忆的提示词片段。
 *
 * 这些文本按 MaiBot（GPL-3.0，见仓库根 THIRD_PARTY_NOTICES.md）「规划器 → 回复器 →
 * 去AI味 → 记忆印象」流水线的结构重写，未复制其文本；规则本身是写作常识，
 * 词表按中文 AI 腔的高频模式自行归纳。
 *
 * 纯数据模块：无 IO、无依赖，供 humanizer/pipeline/engine 复用，也便于单测断言。
 *
 * @module dsh-fairy-roleplay/rules
 */

/** 去AI味强度档位，逐层加严；`off` 表示不检查。 */
export const HUMANIZER_LEVELS = Object.freeze(['off', 'l1', 'l2', 'l3', 'l4']);

/** 档位包含的层数：off=0、l1=1、l2=2、l3=3、l4=4。 */
export function levelDepth(level) {
  const index = HUMANIZER_LEVELS.indexOf(typeof level === 'string' ? level.trim().toLowerCase() : '');
  return index <= 0 ? 0 : index;
}

/**
 * L1 命中即删的套话与元话术。`meta` 类是“关于说话本身”的句子（路标词、互动式开场），
 * 它们不携带信息，只在提醒读者“接下来要说话了”。
 */
export const BANNED_PHRASES = Object.freeze([
  { text: '值得注意的是', kind: 'meta' },
  { text: '需要注意的是', kind: 'meta' },
  { text: '综上所述', kind: 'meta' },
  { text: '总而言之', kind: 'meta' },
  { text: '总的来说', kind: 'meta' },
  { text: '让我们来看看', kind: 'meta' },
  { text: '接下来我们来看', kind: 'meta' },
  { text: '在当今', kind: 'meta' },
  { text: '在这个快节奏的时代', kind: 'meta' },
  { text: '众所周知', kind: 'meta' },
  { text: '不言而喻', kind: 'meta' },
  { text: '换句话说', kind: 'meta' },
  { text: '某种意义上', kind: 'empty' },
  { text: '某种程度上', kind: 'empty' },
  { text: '可以说', kind: 'empty' },
  { text: '毋庸置疑', kind: 'empty' },
  { text: '不可或缺', kind: 'empty' },
  { text: '至关重要', kind: 'empty' },
  { text: '非常关键', kind: 'empty' },
  { text: '赋能', kind: 'jargon' },
  { text: '抓手', kind: 'jargon' },
  { text: '闭环', kind: 'jargon' },
  { text: '顶层设计', kind: 'jargon' },
  { text: '底层逻辑', kind: 'jargon' },
  { text: '拉通', kind: 'jargon' },
  { text: '对齐颗粒度', kind: 'jargon' },
  { text: '组合拳', kind: 'jargon' },
  { text: '生态化布局', kind: 'jargon' },
  { text: '智能化升级', kind: 'jargon' },
  { text: '数字化转型', kind: 'jargon' },
  { text: '深入浅出', kind: 'empty' },
  { text: '一针见血', kind: 'empty' },
  { text: '醍醐灌顶', kind: 'empty' },
  { text: '狠狠地', kind: 'empty' },
  { text: '稳稳地接住', kind: 'empty' },
  { text: '深深地', kind: 'empty' },
  { text: '轻轻地', kind: 'empty' },
  { text: '缓缓地', kind: 'empty' },
  { text: '瞬间', kind: 'empty' },
  { text: '仿佛', kind: 'empty' },
]);

/** 英文回复额外扫描的 AI 高频词（中文文本不触发）。 */
export const ENGLISH_SLOP = Object.freeze([
  'delve into', 'navigate', 'leverage', 'utilize', 'robust', 'seamless',
  'cutting-edge', 'game-changer', 'paradigm shift', "it's worth noting",
  "in today's world", 'at the end of the day', 'in conclusion', 'it is important to note',
]);

/** 命中即改写的句式壳：正则 + 改法。 */
export const SHELL_PATTERNS = Object.freeze([
  { rule: 'contrast-shell', pattern: /不是[^。！？\n]{1,24}而是/g, fix: '删掉对比壳，直接说后半句' },
  { rule: 'sequence-shell', pattern: /首先[^。！？\n]{0,30}其次/g, fix: '拆掉序列结构，改成自然段落顺序' },
  { rule: 'not-only-shell', pattern: /不仅[^。！？\n]{1,24}而且/g, fix: '拆成两句，各自说清一件事' },
  { rule: 'meta-shell', pattern: /如果你(愿意|想)[^。！？\n]{0,20}(的话)?[，,]?$/gm, fix: '删掉征求许可的尾巴，直接把话说完' },
  { rule: 'passive-shell', pattern: /被[^。！？\n]{1,12}(所)?(进行|实施|完成)/g, fix: '改主动语态：谁做了什么' },
  { rule: 'nominal-shell', pattern: /(进行|实施|开展)了[^。！？\n]{0,10}(的)?(讨论|检查|分析|优化)/g, fix: '动词直用：讨论/检查/分析/优化' },
  { rule: 'existence-shell', pattern: /[^。！？\n]{2,12}的存在/g, fix: '删掉“的存在”，直接说这个事物做了什么' },
  { rule: 'process-shell', pattern: /[^。！？\n]{2,12}的过程中/g, fix: '删掉“的过程中”' },
]);

/** L2 节奏阈值：句长分布与段落同构。 */
export const RHYTHM = Object.freeze({
  /** 连续等长句（±该字数）视为节奏单一。 */
  equalLengthTolerance: 5,
  /** 连续多少句等长即命中。 */
  equalRunLength: 3,
  /** 短句阈值（不足即算短句）。 */
  shortSentenceChars: 10,
  /** 单段破折号上限。 */
  dashesPerParagraph: 2,
});
