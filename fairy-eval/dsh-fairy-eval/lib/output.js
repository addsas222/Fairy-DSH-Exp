/**
 * Output 层：把官方响应统一成一份「answers + confidence + raw」结构，
 * 并渲染成给模型看的中文报告。
 *
 * 官方答案形状（https://docs.typesafe.ai/api → Answer types）：
 * - noul  ：`{ type: 'noul', noul: 0～1 }`——**没有 confidence 字段**，`noul` 本身就是「是」的概率。
 * - choice：`{ type:'choice', choice, probabilities, confidence }`。
 * - score ：`{ type:'score', score, legend, probabilities, confidence }`。
 *
 * @module dsh-fairy-eval/output
 */

/** @param {unknown} value */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 数值化；非有限数返回 null。 */
function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** 保留 3 位小数的展示形态，避免报告里出现 0.5960000000000001。 */
function round(value) {
  return Number.isFinite(value) ? Number(value.toFixed(3)) : null;
}

/**
 * 归一化单条答案。
 *
 * @param {string} id
 * @param {unknown} answer
 */
export function normalizeAnswer(id, answer) {
  if (!isPlainObject(answer)) return { id, type: 'unknown', raw: answer, confidence: null };
  const confidence = numberOrNull(answer.confidence);
  if (answer.type === 'noul') {
    const value = numberOrNull(answer.noul);
    return { id, type: 'noul', noul: value, yes: value === null ? null : value >= 0.5, confidence: null };
  }
  if (answer.type === 'choice') {
    return {
      id,
      type: 'choice',
      choice: typeof answer.choice === 'string' ? answer.choice : null,
      probabilities: isPlainObject(answer.probabilities) ? answer.probabilities : {},
      confidence,
    };
  }
  if (answer.type === 'score') {
    return {
      id,
      type: 'score',
      score: numberOrNull(answer.score),
      legend: isPlainObject(answer.legend) ? answer.legend : {},
      probabilities: isPlainObject(answer.probabilities) ? answer.probabilities : {},
      confidence,
    };
  }
  return { id, type: typeof answer.type === 'string' ? answer.type : 'unknown', raw: answer, confidence };
}

/**
 * 归一化整份答案表。
 *
 * @param {unknown} answers      官方响应里的 `answers`。
 * @param {Record<string, unknown>} [questions] 请求里发出去的问题（用于标记「问题发了但没答」）。
 */
export function normalizeAnswers(answers, questions = {}) {
  /** @type {Record<string, ReturnType<typeof normalizeAnswer>>} */
  const normalized = {};
  for (const [id, answer] of Object.entries(isPlainObject(answers) ? answers : {})) {
    normalized[id] = normalizeAnswer(id, answer);
  }
  for (const id of Object.keys(questions)) {
    if (!(id in normalized)) normalized[id] = { id, type: 'missing', confidence: null };
  }
  return normalized;
}

/**
 * `{ 问题 id: confidence | null }`——Noul 在官方响应里没有 confidence，这里如实给 null。
 *
 * @param {Record<string, ReturnType<typeof normalizeAnswer>>} answers
 */
export function collectConfidence(answers) {
  /** @type {Record<string, number | null>} */
  const table = {};
  for (const [id, answer] of Object.entries(answers)) table[id] = answer.confidence ?? null;
  return table;
}

/**
 * 组装统一输出。一次调用只发一个请求，这里把它的结果整理成稳定结构。
 *
 * @param {Object} options
 * @param {Record<string, unknown>} options.response  官方响应体。
 * @param {Record<string, unknown>} options.questions 请求里的问题映射。
 * @param {string} options.endpoint
 * @returns {{model: string, endpoint: string, answers: Record<string, unknown>, confidence: Record<string, number | null>, usage: {inputTokens: number|null, outputTokens: number|null}, raw: Record<string, unknown>}}
 */
export function toEvaluationOutput({ response, questions, endpoint }) {
  const answers = normalizeAnswers(response?.answers, questions);
  const usage = isPlainObject(response?.usage) ? response.usage : {};
  return {
    model: typeof response?.model === 'string' ? response.model : '',
    endpoint,
    answers,
    confidence: collectConfidence(answers),
    usage: {
      inputTokens: numberOrNull(usage.input_tokens),
      outputTokens: numberOrNull(usage.output_tokens),
    },
    raw: response,
  };
}

/** 概率分布的排序展示：`billing 0.159 / technical 0.84`。 */
function renderProbabilities(probabilities, limit = 8) {
  return Object.entries(probabilities)
    .map(([label, value]) => [label, numberOrNull(value)])
    .filter(([, value]) => value !== null)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([label, value]) => `${label} ${value}`)
    .join(' / ');
}

/** 等级图例：`0=平静 / 1=有些沮丧 / 2=非常愤怒`。 */
function renderLegend(legend) {
  return Object.entries(legend)
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([level, description]) => `${level}=${description}`)
    .join(' / ');
}

/** 单条答案的中文一行摘要。 */
export function renderAnswer(answer) {
  if (answer.type === 'noul') {
    if (answer.noul === null) return `${answer.id}（noul）：服务端未返回 noul 值`;
    return `${answer.id}（noul）：${answer.yes ? '是' : '否'}（${round(answer.noul)}；≥0.5 判为「是」，官方不给 confidence）`;
  }
  if (answer.type === 'choice') {
    const distribution = renderProbabilities(answer.probabilities);
    const confidence = answer.confidence === null ? '未给出' : round(answer.confidence);
    return `${answer.id}（choice）：${answer.choice ?? '未返回选项'}（confidence ${confidence}`
      + `${distribution === '' ? '' : `；${distribution}`}）`;
  }
  if (answer.type === 'score') {
    const legend = renderLegend(answer.legend);
    const confidence = answer.confidence === null ? '未给出' : round(answer.confidence);
    return `${answer.id}（score）：${answer.score === null ? '未返回分数' : round(answer.score)}（confidence ${confidence}`
      + `${legend === '' ? '' : `；${legend}`}）`;
  }
  if (answer.type === 'missing') return `${answer.id}：请求了但没有收到答案（服务端异常）`;
  return `${answer.id}（${answer.type}）：无法识别的答案类型，原文见 raw`;
}

/**
 * 渲染整份评估报告（工具层 `render` 与示例脚本共用）。
 *
 * @param {ReturnType<typeof toEvaluationOutput>} output
 */
export function renderReport(output) {
  const ids = Object.keys(output.answers);
  const lines = [`已评估 ${ids.length} 个问题（模型 ${output.model || '未知'}）`];
  for (const id of ids) lines.push(`- ${renderAnswer(output.answers[id])}`);
  const confidences = Object.values(output.confidence).filter((value) => value !== null);
  if (confidences.length > 0) lines.push(`置信度：${confidences.length} 项有值，最低 ${round(Math.min(...confidences))}`);
  if (ids.length === 0) lines.push('- 服务端返回了空的 answers。');
  return lines.join('\n');
}
