#!/usr/bin/env node
/**
 * 最小可用示例：一次调用同时评「是否紧急(Noul) / 所属团队(Choice) / 沮丧程度(Score)」。
 *
 * 用法（在包目录下）：
 *   node examples/triage.mjs                 # 真实调用 TypeSafe（需要 TYPESAFE_API_KEY）
 *   node examples/triage.mjs --mock          # 用内置桩客户端演示完整输出结构，不需要 KEY
 *   node examples/triage.mjs --json          # 追加打印统一结构（answers / confidence / usage）
 *   node examples/triage.mjs --text "..."    # 换一段待评估文本
 *
 * @module dsh-fairy-eval/examples/triage
 */
import {
  MISSING_KEY_MESSAGE,
  TRIAGE_STATE,
  configFromEnvironment,
  createTypeSafeEvaluator,
  describeApiKeyPresence,
  renderReport,
  triageQuestions,
} from '../lib/index.js';
import { MOCK_RESPONSE, createStubClient } from './mock-response.mjs';

const argv = process.argv.slice(2);
const useMock = argv.includes('--mock');
const asJson = argv.includes('--json');
const textIndex = argv.indexOf('--text');
const state = textIndex >= 0 && typeof argv[textIndex + 1] === 'string' ? argv[textIndex + 1] : TRIAGE_STATE;
const questions = triageQuestions();
const config = configFromEnvironment();

if (!useMock && describeApiKeyPresence(config) === '不存在') {
  /* A.md #9：缺 KEY 时给可操作错误，而不是抛一个栈。 */
  console.error(MISSING_KEY_MESSAGE);
  process.exitCode = 2;
} else {
  const stub = useMock ? createStubClient(MOCK_RESPONSE) : null;
  const evaluator = stub === null
    ? createTypeSafeEvaluator({ config })
    : createTypeSafeEvaluator({ config, client: stub });

  console.log(`配置：模型 ${config.model} / 端点 ${config.endpoint} / TYPESAFE_API_KEY ${describeApiKeyPresence(config)}`
    + `${useMock ? '（--mock：桩客户端，未发出网络请求）' : ''}`);
  console.log(`请求体（state ${state.length} 字符，问题 ${Object.keys(questions).join(' / ')}）：`);
  console.log(JSON.stringify({ state, model: config.model, questions }, null, 2));
  console.log('');
  const output = await evaluator.evaluate(state, questions);
  if (stub !== null) {
    console.log(`实际发出请求 ${stub.calls.length} 次：${Object.keys(stub.calls[0].questions).length} 个问题在一次调用里问完。`);
  }
  console.log(renderReport(output));
  if (asJson) {
    console.log('');
    console.log(JSON.stringify({ model: output.model, answers: output.answers, confidence: output.confidence, usage: output.usage, raw: output.raw }, null, 2));
  }
}
