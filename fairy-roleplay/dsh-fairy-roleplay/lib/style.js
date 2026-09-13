/**
 * 风格库：角色自己的语言习惯，条目是「情境 → 可用表达」。
 *
 * 储存形态是一个 JSON 文件（宿主与 agent 工具读同一路径，没有跨面服务查找）：
 * `{ version: 1, entries: [{ situation, style, source, learnedAt }] }`。
 *
 * 合并规则（确定性）：同 (situation, style) 视为重复，只保留较早的 learnedAt
 * 并把 `weight` 累加（出现得多说明常用）；超出上限时按 weight 降序、同权重按
 * 最近学习时间保留。渲染给模型时只取前 `limit` 条，避免提示词无限增长。
 *
 * @module dsh-fairy-roleplay/style
 */

/** 单条情境与表达的字数上限，超出的条目在学习阶段就截断。 */
export const STYLE_FIELD_LIMIT = 20;

/** 风格库条目上限。 */
export const STYLE_ENTRY_LIMIT = 200;

/** 渲染给模型的默认条数。 */
export const STYLE_RENDER_LIMIT = 24;

function normalizeField(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, STYLE_FIELD_LIMIT) : '';
}

/**
 * 解析模型输出的风格条目（容忍代码块、前后解释、多余字段）。
 *
 * @param text - 模型输出的 JSON 数组文本（可含 ``` 代码块）。
 * @returns 规范化后的条目数组；解析失败返回空数组。
 */
export function parseStyleEntries(text) {
  if (typeof text !== 'string') return [];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced ? fenced[1] : text).trim();
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  let parsed;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const entries = [];
  for (const item of parsed) {
    const situation = normalizeField(item?.situation);
    const style = normalizeField(item?.style);
    if (situation === '' || style === '') continue;
    entries.push({ situation, style, source: normalizeField(item?.source), weight: 1 });
  }
  return entries;
}

/**
 * 合并新旧条目，返回新的条目数组（不改写输入）。
 *
 * @param existing - 已有条目（来自磁盘或上一次合并）。
 * @param incoming - 新学到的条目。
 * @param options.limit - 条目上限，默认 {@link STYLE_ENTRY_LIMIT}。
 * @returns 去重、按 weight 与学习时间排序后的条目数组。
 */
export function mergeStyleEntries(existing, incoming, { limit = STYLE_ENTRY_LIMIT } = {}) {
  const merged = [];
  const index = new Map();
  const consider = (entry) => {
    const situation = normalizeField(entry?.situation);
    const style = normalizeField(entry?.style);
    if (situation === '' || style === '') return;
    const key = `${situation}\u0000${style}`;
    const seen = index.get(key);
    if (seen !== undefined) {
      seen.weight = (Number(seen.weight) || 1) + 1;
      return;
    }
    const row = {
      situation,
      style,
      source: normalizeField(entry?.source),
      weight: Number.isFinite(Number(entry?.weight)) ? Math.max(1, Number(entry.weight)) : 1,
      learnedAt: typeof entry?.learnedAt === 'string' && entry.learnedAt !== '' ? entry.learnedAt : new Date().toISOString(),
    };
    index.set(key, row);
    merged.push(row);
  };
  for (const entry of Array.isArray(existing) ? existing : []) consider(entry);
  for (const entry of Array.isArray(incoming) ? incoming : []) consider(entry);
  merged.sort((left, right) => (right.weight - left.weight) || right.learnedAt.localeCompare(left.learnedAt));
  return merged.slice(0, Math.max(1, limit));
}

/**
 * 从磁盘内容解析风格库；损坏或空文件降级为空库（不抛错）。
 *
 * @param text - 文件文本。
 * @returns `{ version, entries }`。
 */
export function parseStyleFile(text) {
  try {
    const value = JSON.parse(typeof text === 'string' ? text : '');
    return { version: 1, entries: Array.isArray(value?.entries) ? mergeStyleEntries(value.entries, [], {}) : [] };
  } catch {
    return { version: 1, entries: [] };
  }
}

/**
 * 渲染成提示词块：情境 → 表达。空库返回空串，调用方据此跳过注入。
 *
 * @param entries - 风格条目。
 * @param options.limit - 最多渲染多少条。
 * @returns 多行文本，或空串。
 */
export function renderStyleBlock(entries, { limit = STYLE_RENDER_LIMIT } = {}) {
  const rows = (Array.isArray(entries) ? entries : []).slice(0, Math.max(1, limit));
  if (rows.length === 0) return '';
  return [
    '## 语言习惯（角色自己的表达，优先于通用文风）',
    ...rows.map((entry) => `- 当${entry.situation}时，可以用「${entry.style}」`),
  ].join('\n');
}
