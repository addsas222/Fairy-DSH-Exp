/**
 * Agent half of dsh-fairy-eval：把 TypeSafe 评估注册成 dsh 工具 `typesafe_eval`。
 *
 * 配置在 apply 时读一次（进程环境变量 + 项目根 `.env`）；缺 KEY 只报「不存在」并给出
 * 可操作告警，KEY 原文不进入任何日志。改环境变量后需重启 dsh。
 *
 * @module dsh-fairy-eval/engine
 */
import { createFairyDiagnostics } from 'dsh-fairy-contracts/diagnostics';
import { configFromEnvironment, describeApiKeyPresence } from './config.js';
import { MISSING_KEY_MESSAGE } from './error.js';
import { createTypeSafeEvalTool } from './tool.js';

export const NAME = 'dsh-fairy-eval';

const diagnostics = createFairyDiagnostics(NAME);

/** 只依赖工具面；不需要 systemPrompt / 命令面。 */
export const inject = ['tools'];

/**
 * Mount the agent half.
 *
 * @param {import('dsh-fairy-contracts/types').AgentContext} ctx agent 作用域上下文。
 * @param {Object} [options]
 * @param {ReturnType<typeof createFairyDiagnostics>} [options.diagnostics] 测试可注入的诊断桩。
 * @param {Record<string, string | undefined>} [options.env] 测试可注入的环境变量。
 * @param {import('./config.js').TypeSafeConfig} [options.config] 直接给配置（跳过环境读取）。
 */
export function apply(ctx, { diagnostics: sink = diagnostics, env = process.env, config } = {}) {
  return sink.guard('apply', () => {
    const resolved = config ?? configFromEnvironment({ env });
    if (describeApiKeyPresence(resolved) === '不存在') {
      /* 启动即检查一次：缺 KEY 时把 A.md #9 的可操作文案交给诊断通道（只报存在性，不含 KEY）。 */
      sink.warn('typesafe.config', {
        apiKey: '不存在',
        apiKeyEnv: 'TYPESAFE_API_KEY',
        model: resolved.model,
        endpoint: resolved.endpoint,
      }, new Error(MISSING_KEY_MESSAGE));
    }
    ctx.tools.register(createTypeSafeEvalTool({ config: resolved }));
  }, { surface: 'agent' });
}
