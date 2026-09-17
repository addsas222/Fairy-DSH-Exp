/**
 * Evaluator 层：`evaluate(state, questions)` —— 一次调用拿回多个结构化答案。
 *
 * 这一层只做三件事：校验入参（schema 层）→ 发一次请求（client 层）→ 整理输出（output 层）。
 * 刻意不拆成多次请求：官方 fan-out 口径下，多问一次调用比多次调用更便宜也更快。
 *
 * @module dsh-fairy-eval/evaluator
 */
import { createTypeSafeClient } from './client.js';
import { configFromEnvironment } from './config.js';
import { toEvaluationOutput } from './output.js';
import { normalizeQuestions, normalizeState } from './schema.js';

/**
 * 建立一个评估器实例（同一份配置 + 同一个客户端，可反复 evaluate）。
 *
 * @param {Object} [options]
 * @param {import('./config.js').TypeSafeConfig} [options.config]
 * @param {typeof fetch} [options.fetchImpl] 测试桩。
 * @param {(ms: number) => Promise<void>} [options.sleep] 测试桩。
 * @param {{ requestSystemOne: Function, describe: Function, config: object }} [options.client] 直接注入客户端。
 */
export function createTypeSafeEvaluator({ config, fetchImpl, sleep, client } = {}) {
  const resolvedConfig = config ?? client?.config ?? configFromEnvironment();
  const systemOne = client ?? createTypeSafeClient({ config: resolvedConfig, fetchImpl, sleep });

  /**
   * @param {unknown} state                       要评估的内容（字符串 / 对象 / 数组）。
   * @param {unknown} questions                   `{ id: Question }` 或它的 JSON 文本。
   * @param {{model?: string}} [options]
   * @returns {Promise<{model: string, endpoint: string, answers: Record<string, object>, confidence: Record<string, number | null>, usage: {inputTokens: number | null, outputTokens: number | null}, raw: object}>}
   */
  async function evaluate(state, questions, { model } = {}) {
    const normalizedState = normalizeState(state);
    const normalizedQuestions = normalizeQuestions(questions);
    const response = await systemOne.requestSystemOne({
      state: normalizedState,
      questions: normalizedQuestions,
      model: model === undefined ? resolvedConfig.model : model,
    });
    return toEvaluationOutput({ response, questions: normalizedQuestions, endpoint: resolvedConfig.endpoint });
  }

  return Object.freeze({
    config: resolvedConfig,
    /** 不含 KEY 原文的配置摘要。 */
    describe: () => systemOne.describe(),
    evaluate,
  });
}

/**
 * 便捷形式：单次评估。
 *
 * @param {unknown} state
 * @param {unknown} questions
 * @param {Object} [options] 同 `createTypeSafeEvaluator`，另可带 `model` 覆盖模型名。
 */
export async function evaluate(state, questions, options = {}) {
  return createTypeSafeEvaluator(options).evaluate(state, questions, options);
}
