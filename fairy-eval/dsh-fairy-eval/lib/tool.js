/**
 * Tool 层：把评估器注册成 dsh agent 工具 `typesafe_eval`。
 *
 * 与仓库其它插件的工具同形（见 fairy-roleplay/lib/engine.js）：`parameters` 是给模型的
 * JSON Schema，`output.schema` + `render` 决定工具卡片里显示什么，`execute` 里做参数校验
 * 与错误翻译。参数错误按仓库惯例抛出（code = INVALID_ARGS），上游 API 失败则返回
 * `ok: false` + 中文可操作文案——让模型读得到「怎么办」，而不是只看到一句异常。
 *
 * @module dsh-fairy-eval/tool
 */
import { createTypeSafeEvaluator } from './evaluator.js';
import { TRIAGE_QUESTIONS, TRIAGE_STATE } from './examples.js';
import { TypeSafeError, isTypeSafeError } from './error.js';
import { renderReport } from './output.js';
import { MAX_QUESTIONS, MAX_STATE_CHARS } from './schema.js';

/** 工具名：agent 面唯一入口。 */
export const EVAL_TOOL_NAME = 'typesafe_eval';

/** 工具整体超时（含重试）。比单次请求超时宽，避免重试被工具层先掐掉。 */
export const TOOL_TIMEOUT_MS = 45_000;

/**
 * @param {Object} [options]
 * @param {import('./config.js').TypeSafeConfig} [options.config]
 * @param {typeof fetch} [options.fetchImpl] 测试桩。
 * @param {(ms: number) => Promise<void>} [options.sleep] 测试桩。
 * @param {ReturnType<typeof createTypeSafeEvaluator>} [options.evaluator]
 */
export function createTypeSafeEvalTool({ config, fetchImpl, sleep, evaluator } = {}) {
  const runtime = evaluator ?? createTypeSafeEvaluator({ config, fetchImpl, sleep });

  return {
    name: EVAL_TOOL_NAME,
    description: '用 TypeSafe（System One / jev-latest）对一段文本做结构化评估：问一批问题，一次调用拿回全部答案。'
      + '支持三类问题：noul（是/否，返回 0～1 的是概率）、choice（多选一，返回选项 + 概率分布 + confidence）、'
      + 'score（连续评分，返回分数 + 图例 + confidence）。questions 传 JSON 对象文本，键名任取、响应按同名回传；'
      + '省略 questions 时使用内置三问示例（是否紧急 / 所属团队 / 沮丧程度）。'
      + `需要 TYPESAFE_API_KEY（缺失时会返回可操作提示）。state 上限 ${MAX_STATE_CHARS} 字符、一次最多 ${MAX_QUESTIONS} 个问题。`,
    parameters: {
      type: 'object',
      properties: {
        state: {
          type: 'string',
          description: `要评估的文本（客户消息、日志片段、文档段落等），上限 ${MAX_STATE_CHARS} 字符。`,
        },
        questions: {
          type: 'string',
          description: '问题映射的 JSON 对象文本，例如 {"is_urgent":{"type":"noul","instructions":"是否紧急？"},'
            + '"department":{"type":"choice","instructions":"哪个团队处理？","criteria":{"billing":"支付","technical":"技术"}},'
            + '"frustration":{"type":"score","instructions":"沮丧程度？","criteria":["平静","有些沮丧","非常愤怒"]}}。'
            + '省略时用内置三问示例。',
        },
        model: {
          type: 'string',
          description: '覆盖模型名（默认取 TYPESAFE_MODEL，未设时为 jev-latest）。',
        },
      },
      required: ['state'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          code: { type: 'string' },
          model: { type: 'string' },
          count: { type: 'number' },
          answers: { type: 'object', additionalProperties: true },
          confidence: { type: 'object', additionalProperties: true },
          report: { type: 'string' },
        },
        required: ['ok', 'report'],
      },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    /**
     * @param {{state?: unknown, questions?: unknown, model?: unknown}} args
     */
    async execute(args) {
      const state = typeof args?.state === 'string' ? args.state : '';
      if (state.trim() === '') {
        throw withCode(new Error(`${EVAL_TOOL_NAME} 需要非空的 state 文本。示例：${TRIAGE_STATE}`), 'INVALID_ARGS');
      }
      const questions = args?.questions === undefined || args?.questions === null || args?.questions === ''
        ? TRIAGE_QUESTIONS
        : args.questions;
      const model = typeof args?.model === 'string' && args.model.trim() !== '' ? args.model.trim() : undefined;
      try {
        const output = await runtime.evaluate(state, questions, { model });
        const count = Object.keys(output.answers).length;
        return {
          ok: true,
          model: output.model,
          count,
          answers: output.answers,
          confidence: output.confidence,
          report: renderToolReport(output),
        };
      } catch (error) {
        // 参数错误按仓库惯例抛给调用方；上游失败（缺 KEY / 401 / 429 / 超时…）走返回值，
        // 这样模型一定能看到中文可操作文案。
        if (isTypeSafeError(error)) {
          if (error.code === 'INVALID_ARGS') throw error;
          return {
            ok: false,
            code: error.code,
            model: runtime.config.model,
            count: 0,
            answers: {},
            confidence: {},
            report: `TypeSafe 评估失败（${error.code}）：${error.message}`,
          };
        }
        const fallback = new TypeSafeError(`TypeSafe 评估失败：${error instanceof Error ? error.message : String(error)}`,
          { code: 'UNEXPECTED', cause: error });
        return {
          ok: false,
          code: fallback.code,
          model: runtime.config.model,
          count: 0,
          answers: {},
          confidence: {},
          report: fallback.message,
        };
      }
    },
  };
}

/** 工具报告 = output 层报告 + 用法一行（token 用量便于判断成本）。 */
function renderToolReport(output) {
  const lines = [renderReport(output)];
  if (output.usage.inputTokens !== null || output.usage.outputTokens !== null) {
    lines.push(`用量：input ${output.usage.inputTokens ?? '?'} / output ${output.usage.outputTokens ?? '?'} tokens`);
  }
  return lines.join('\n');
}

/** 给普通 Error 挂上仓库约定的 code（工具层的 INVALID_ARGS 约定）。 */
function withCode(error, code) {
  error.code = code;
  return error;
}
