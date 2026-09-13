/**
 * 去AI味检查器：对一段文本给出确定性的命中项与改法，不做改写、不调用模型。
 *
 * 分层与规则对应：
 * - L1 词表与句式壳（`BANNED_PHRASES` / `SHELL_PATTERNS` / 标点滥用）——零容忍。
 * - L2 节奏（等长句连发、全篇无短句、段落同构）——可计算的结构问题。
 * - L3 内容（空泛大词、悬浮比喻）——启发式标记，供模型自查。
 * - L4 终审：自动检查全部通过时才置 `requiresReading`，提醒必须通读一遍。
 *
 * 引用保护：引号包裹的内容（"…"、'…'、「…」、“…”）不参与词表替换判断，
 * 这是 MaiBot 类规则里优先级最高的一条，这里同样优先。
 *
 * @module dsh-fairy-roleplay/humanizer
 */
import {
  BANNED_PHRASES,
  ENGLISH_SLOP,
  RHYTHM,
  SHELL_PATTERNS,
  levelDepth,
} from './rules.js';

/** 引号内的引用片段：只用于豁免，不改变返回值。 */
const QUOTED = /["'“”‘’「」『』][^"'“”‘’「」『』\n]{1,60}["'“”‘’「」『』]/g;

/** 拆句：中英文句末标点与换行都算边界。 */
function splitSentences(text) {
  return text
    .split(/[。！？!?；;\n]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** 段落：连续非空行。 */
function splitParagraphs(text) {
  return text.split(/\n{2,}/).map((part) => part.trim()).filter((part) => part.length > 0);
}

/** 用等长的遮蔽串替换引号内容，保持下标对齐。 */
function maskQuoted(text) {
  return text.replace(QUOTED, (match) => match[0] + '口'.repeat(Math.max(0, match.length - 2)) + match[match.length - 1]);
}

function excerptOf(text, index, span) {
  const start = Math.max(0, index - 8);
  const end = Math.min(text.length, index + span + 8);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

/**
 * 检查文本，返回命中项与分数。
 *
 * @param text - 待检查文本。
 * @param options.level - 去AI味强度（`off`…`l4`，默认 `l1`）。
 * @param options.locale - `'zh'`（默认）或 `'en'`：英文词表只在 `en` 或文本几乎全英文时触发。
 * @returns `{ level, depth, score, hits, requiresReading }`；`off` 时 `hits` 恒为空。
 */
export function check(text, { level = 'l1', locale } = {}) {
  const source = typeof text === 'string' ? text : '';
  const depth = levelDepth(level);
  const hits = [];
  if (source === '' || depth === 0) {
    return { level, depth, score: 100, hits, requiresReading: false };
  }
  const masked = maskQuoted(source);
  // ---- L1：词表 + 句式壳 + 标点
  for (const entry of BANNED_PHRASES) {
    let index = masked.indexOf(entry.text);
    while (index >= 0) {
      hits.push({ layer: 1, rule: `banned:${entry.kind}`, term: entry.text, index, excerpt: excerptOf(source, index, entry.text.length), fix: '删掉或换成具体说法' });
      index = masked.indexOf(entry.text, index + entry.text.length);
    }
  }
  const english = locale === 'en' || (locale === undefined && !/[\u4e00-\u9fff]/.test(source));
  if (english) {
    for (const term of ENGLISH_SLOP) {
      const index = masked.toLowerCase().indexOf(term);
      if (index >= 0) hits.push({ layer: 1, rule: 'banned:en', term, index, excerpt: excerptOf(source, index, term.length), fix: '换成日常动词或直接删除' });
    }
  }
  for (const shell of SHELL_PATTERNS) {
    shell.pattern.lastIndex = 0;
    let match = shell.pattern.exec(masked);
    while (match !== null) {
      hits.push({ layer: 1, rule: shell.rule, term: match[0].trim(), index: match.index, excerpt: excerptOf(source, match.index, match[0].length), fix: shell.fix });
      if (shell.pattern.lastIndex === match.index) shell.pattern.lastIndex += 1;
      match = shell.pattern.exec(masked);
    }
  }
  for (const paragraph of splitParagraphs(source)) {
    const dashes = (paragraph.match(/——/g) || []).length;
    if (dashes > RHYTHM.dashesPerParagraph) {
      hits.push({ layer: 1, rule: 'punctuation:dash', term: '——', index: source.indexOf(paragraph), excerpt: paragraph.slice(0, 24), fix: `单段破折号不超过 ${RHYTHM.dashesPerParagraph} 个，改成逗号或句号` });
    }
    if (/……[^\n]{0,4}(！|!)$/.test(paragraph.trim())) {
      hits.push({ layer: 1, rule: 'punctuation:ellipsis', term: '……', index: source.indexOf(paragraph), excerpt: paragraph.slice(0, 24), fix: '省略号只表示省略，不用于强调' });
    }
  }
  // ---- L2：节奏
  if (depth >= 2) {
    const sentences = splitSentences(source);
    const lengths = sentences.map((sentence) => sentence.replace(/\s/g, '').length);
    let run = 1;
    for (let i = 1; i < lengths.length; i++) {
      if (Math.abs(lengths[i] - lengths[i - 1]) <= RHYTHM.equalLengthTolerance) {
        run += 1;
        if (run === RHYTHM.equalRunLength) {
          hits.push({ layer: 2, rule: 'rhythm:equal-run', term: String(RHYTHM.equalRunLength), index: 0, excerpt: sentences.slice(Math.max(0, i - 2), i + 1).join('。').slice(0, 40), fix: '连续等长句，打断节奏：其中一句压到 10 字内' });
        }
      } else {
        run = 1;
      }
    }
    if (lengths.length >= 4 && !lengths.some((length) => length <= RHYTHM.shortSentenceChars)) {
      hits.push({ layer: 2, rule: 'rhythm:no-short', term: String(RHYTHM.shortSentenceChars), index: 0, excerpt: sentences[0]?.slice(0, 24) ?? '', fix: '全篇没有短句，插一句 10 字以内的' });
    }
    const paragraphs = splitParagraphs(source);
    if (paragraphs.length >= 3) {
      const sizes = paragraphs.map((paragraph) => paragraph.replace(/\s/g, '').length);
      const spread = Math.max(...sizes) - Math.min(...sizes);
      if (spread <= 10) {
        hits.push({ layer: 2, rule: 'rhythm:uniform-paragraphs', term: String(spread), index: 0, excerpt: paragraphs[0].slice(0, 24), fix: '段落长度几乎一致，打破同构：让某段只有一句话' });
      }
    }
  }
  // ---- L3：内容
  if (depth >= 3) {
    if (/就像|如同|仿佛/.test(masked)) {
      const index = masked.search(/就像|如同|仿佛/);
      hits.push({ layer: 3, rule: 'content:figurative', term: masked.slice(index, index + 2), index, excerpt: excerptOf(source, index, 6), fix: '比喻要有可验证的相似性；牵强就删' });
    }
    const evaluative = /(很重要|非常关键|不可或缺|意义重大)(?![^。！？\n]{0,20}[，,][^。！？\n]{0,40}(因为|例如|比如|具体))/.exec(masked);
    if (evaluative !== null) {
      hits.push({ layer: 3, rule: 'content:unsupported-claim', term: evaluative[0], index: evaluative.index, excerpt: excerptOf(source, evaluative.index, evaluative[0].length), fix: '评价句后面补具体事实或例子，否则删掉评价' });
    }
  }
  const score = Math.max(0, 100 - hits.reduce((sum, hit) => sum + (hit.layer === 1 ? 12 : hit.layer === 2 ? 6 : 4), 0));
  return { level, depth, score, hits, requiresReading: depth >= 4 && hits.length === 0 };
}

/**
 * 按档位给出是否放行：L4 档要求「自动检查无命中」。模型侧仍需通读一遍。
 *
 * @param result - {@link check} 的返回值。
 * @returns 是否可以按当前档位发出。
 */
export function passes(result) {
  return (result?.hits?.length ?? 0) === 0;
}

/** 把命中项渲染成给模型的自检报告（人话、可执行）。 */
export function renderReport(result) {
  if (result === undefined || result.depth === 0) return '去AI味检查已关闭。';
  if (result.hits.length === 0) {
    return result.requiresReading
      ? '自动检查通过（L1-L3 无命中）。发出前通读一遍：像不像真人在说话、有没有一句读着别扭。'
      : '自动检查通过。';
  }
  const lines = result.hits.map((hit, index) => `${index + 1}. [L${hit.layer} ${hit.rule}] “${hit.term}” → ${hit.fix}｜上下文：${hit.excerpt}`);
  return [`命中 ${result.hits.length} 处（分数 ${result.score}）：`, ...lines].join('\n');
}
