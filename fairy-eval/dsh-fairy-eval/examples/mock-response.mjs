/**
 * 示例与测试共用的桩响应。
 *
 * 形状严格照官方 Quickstart 的 Response body 示例：`model` + `answers` + `usage`；
 * noul 没有 confidence（官方如此），choice/score 有 confidence 与概率分布。
 *
 * @module dsh-fairy-eval/examples/mock-response
 */
/** 官方示例的答案值，只把 Score 图例换成示例里用的中文等级。 */
export const MOCK_RESPONSE = Object.freeze({
  model: 'jev-latest',
  answers: {
    is_urgent: { type: 'noul', noul: 0.999 },
    department: {
      type: 'choice',
      choice: 'technical',
      probabilities: { billing: 0.159, technical: 0.84, sales: 0.001 },
      confidence: 0.596,
    },
    frustration: {
      type: 'score',
      score: 1.035,
      legend: { 0: '平静，只是陈述事实', 1: '有些沮丧但保持礼貌', 2: '非常愤怒，措辞激烈' },
      probabilities: { 0: 0.05, 1: 0.87, 2: 0.08 },
      confidence: 0.842,
    },
  },
  usage: { input_tokens: 312, output_tokens: 48 },
});

/**
 * 桩客户端：接口与 `createTypeSafeClient` 的返回值一致，但不发网络请求。
 * `calls` 记录每次请求的入参，用来证明「多问题一次调用」。
 *
 * @param {Record<string, unknown>} [response]
 */
export function createStubClient(response = MOCK_RESPONSE) {
  const calls = [];
  return {
    calls,
    requestSystemOne: async (request) => {
      calls.push(request);
      return response;
    },
    describe: () => ({ apiKey: '不存在', model: 'jev-latest', endpoint: 'stub://typesafe' }),
  };
}
