/**
 * 最小可用示例：一次调用同时评「是否紧急(Noul) / 所属团队(Choice) / 沮丧程度(Score)」。
 *
 * 示例 state 取自官方 Quickstart，问题覆盖三类问题各一条；`questions` 的键名就是
 * 响应里 `answers` 的键名（官方约定：键不参与推理，只用于回传）。
 *
 * @module dsh-fairy-eval/examples
 */
import { choice, noul, score } from './schema.js';

/** 官方 Quickstart 的示例文本（Stripe 接入失败、正在丢单的客户消息）。 */
export const TRIAGE_STATE = "Hi, I've been trying to connect my Stripe account for 3 days and it keeps failing. "
  + "I'm losing sales. Please help ASAP.";

/**
 * 三问示例：Noul 判紧急、Choice 分派团队、Score 量沮丧程度。
 * 每次调用返回新对象，调用方可以安全改键名/文案。
 *
 * @returns {Record<string, ReturnType<typeof noul> | ReturnType<typeof choice> | ReturnType<typeof score>>}
 */
export function triageQuestions() {
  return {
    is_urgent: noul('这条消息是否表达出紧急或时间敏感？', {
      true: '有明确的紧迫诉求或时间压力',
      false: '只是陈述事实，没有时间压力',
    }),
    department: choice('这条工单应该分派给哪个团队？', {
      billing: '支付、发票、退款',
      technical: '缺陷、故障、集成问题',
      sales: '报价、升级、新账号',
    }),
    frustration: score('客户表现出来的沮丧程度有多高？', [
      '平静，只是陈述事实',
      '有些沮丧但保持礼貌',
      '非常愤怒，措辞激烈',
    ]),
  };
}

/** 只读版本，供工具默认值与宿主路由复用。 */
export const TRIAGE_QUESTIONS = Object.freeze(triageQuestions());
