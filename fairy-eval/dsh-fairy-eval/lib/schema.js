/**
 * Schema 层：Noul / Choice / Score 三类问题的构造与校验。
 *
 * 字段形状以官方 API reference 为准（https://docs.typesafe.ai/api → Question types）：
 * - `noul`   ：`instructions` 必填；`criteria` 可选，`{ true, false }` 两句描述。
 * - `choice` ：`instructions` 必填；`criteria` 必填，`{ 选项名: 说明 | null }` 映射。
 * - `score`  ：`instructions` 必填；`criteria` 必填，**有序字符串数组，至少两级**。
 * 三类共用：问题 id 由调用方自取，响应里按同一个 id 返回。
 *
 * @module dsh-fairy-eval/schema
 */
import { invalidArgsError } from './error.js';

/** 官方支持的问题类型。 */
export const QUESTION_TYPES = Object.freeze(['noul', 'choice', 'score']);

/** 单次调用的问题条数上限：官方鼓励批量（fan-out），但工具调用需要防呆上限。 */
export const MAX_QUESTIONS = 64;

/** 单次评估的 state 字符上限（工具层与宿主路由共用）。 */
export const MAX_STATE_CHARS = 20_000;

/** @param {unknown} value */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** `instructions` 官方允许 string | object | array。 */
function describeInstructions(value) {
  if (typeof value === 'string') return value.trim() === '' ? 'instructions 不能是空字符串' : '';
  if (isPlainObject(value) || Array.isArray(value)) return '';
  return 'instructions 必须是字符串、对象或数组';
}

/**
 * Noul：是/否判断。返回值是「是」的概率（0～1）。
 *
 * @param {string | object | Array<unknown>} instructions 是/否问题本身。
 * @param {{true?: string, false?: string}} [criteria]    对「是」「否」的可选描述。
 * @returns {{type: 'noul', instructions: unknown, criteria?: Record<string, string>}}
 */
export function noul(instructions, criteria = undefined) {
  const question = { type: /** @type {const} */ ('noul'), instructions };
  if (criteria !== undefined) question.criteria = { ...criteria };
  return question;
}

/**
 * Choice：从自定义选项中选一个。返回选中项 + 全量概率分布 + confidence。
 *
 * @param {string | object | Array<unknown>} instructions
 * @param {Record<string, string | null>} criteria 选项 → 评分说明（无说明用 null）。
 * @returns {{type: 'choice', instructions: unknown, criteria: Record<string, string | null>}}
 */
export function choice(instructions, criteria) {
  return { type: /** @type {const} */ ('choice'), instructions, criteria: { ...criteria } };
}

/**
 * Score：按有序等级打分。返回分数 + 图例 + 概率分布 + confidence。
 *
 * @param {string | object | Array<unknown>} instructions
 * @param {Array<string>} criteria 有序等级描述，至少两级。
 * @returns {{type: 'score', instructions: unknown, criteria: Array<string>}}
 */
export function score(instructions, criteria) {
  return { type: /** @type {const} */ ('score'), instructions, criteria: [...criteria] };
}

/**
 * 校验单条问题，返回问题描述数组（空数组 = 合法）。
 *
 * @param {string} id
 * @param {unknown} question
 * @returns {string[]}
 */
export function validateQuestion(id, question) {
  const path = `questions.${id}`;
  if (!isPlainObject(question)) return [`${path} 必须是对象（含 type / instructions / criteria）`];
  const problems = [];
  if (!QUESTION_TYPES.includes(/** @type {string} */ (question.type))) {
    problems.push(`${path}.type 必须是 ${QUESTION_TYPES.join(' / ')} 之一`);
  }
  const instructionProblem = describeInstructions(question.instructions);
  if (instructionProblem !== '') problems.push(`${path}.${instructionProblem}`);
  if (question.type === 'choice') {
    if (!isPlainObject(question.criteria)) problems.push(`${path}.criteria 必须是「选项 → 说明」对象`);
    else {
      const options = Object.keys(question.criteria);
      if (options.length < 2) problems.push(`${path}.criteria 至少要有 2 个选项`);
      for (const [option, description] of Object.entries(question.criteria)) {
        if (description !== null && typeof description !== 'string') problems.push(`${path}.criteria.${option} 必须是字符串或 null`);
      }
    }
  }
  if (question.type === 'score') {
    if (!Array.isArray(question.criteria)) problems.push(`${path}.criteria 必须是有序字符串数组`);
    else {
      if (question.criteria.length < 2) problems.push(`${path}.criteria 至少要有 2 个等级`);
      question.criteria.forEach((level, index) => {
        if (typeof level !== 'string') problems.push(`${path}.criteria[${index}] 必须是字符串`);
      });
    }
  }
  if (question.type === 'noul' && question.criteria !== undefined) {
    if (!isPlainObject(question.criteria)) problems.push(`${path}.criteria 必须是 { true, false } 对象`);
    else {
      for (const key of Object.keys(question.criteria)) {
        if (key !== 'true' && key !== 'false') problems.push(`${path}.criteria 只接受 true / false 两个键`);
      }
    }
  }
  return problems;
}

/**
 * 归一化 `questions`：接受对象，或模型的 JSON 字符串（允许带 ```json 代码块）。
 *
 * @param {unknown} input
 * @returns {Record<string, unknown>}
 * @throws {TypeSafeError} code = INVALID_ARGS
 */
export function normalizeQuestions(input) {
  let value = input;
  if (typeof value === 'string') {
    const text = value.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    try {
      value = JSON.parse(text);
    } catch (cause) {
      throw invalidArgsError(`questions 不是合法 JSON：${cause instanceof Error ? cause.message : String(cause)}`,
        { cause });
    }
  }
  if (!isPlainObject(value)) throw invalidArgsError('questions 必须是「问题 id → 问题对象」的映射（或它的 JSON 文本）');
  const ids = Object.keys(value);
  if (ids.length === 0) throw invalidArgsError('questions 至少要有一个问题');
  if (ids.length > MAX_QUESTIONS) throw invalidArgsError(`questions 一次最多 ${MAX_QUESTIONS} 个问题（当前 ${ids.length} 个）`);
  const problems = ids.flatMap((id) => validateQuestion(id, value[id]));
  if (problems.length > 0) throw invalidArgsError(`questions 校验失败：${problems.join('；')}`);
  return /** @type {Record<string, unknown>} */ (value);
}

/**
 * 归一化 state：官方允许字符串、对象或数组（docs.typesafe.ai/api → state）。
 *
 * @param {unknown} state
 * @returns {string | object | Array<unknown>}
 * @throws {TypeSafeError} code = INVALID_ARGS
 */
export function normalizeState(state) {
  if (typeof state === 'string') {
    if (state.trim() === '') throw invalidArgsError('state 不能是空字符串');
    if (state.length > MAX_STATE_CHARS) throw invalidArgsError(`state 过长（${state.length} 字符，上限 ${MAX_STATE_CHARS}）`);
    return state;
  }
  if (isPlainObject(state) || Array.isArray(state)) {
    const text = JSON.stringify(state);
    if (text.length > MAX_STATE_CHARS) throw invalidArgsError(`state 过长（序列化后 ${text.length} 字符，上限 ${MAX_STATE_CHARS}）`);
    return state;
  }
  throw invalidArgsError('state 必须是字符串、对象或数组');
}
