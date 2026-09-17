/**
 * Host half of dsh-fairy-eval：两个 HTTP 路由 + 包内公共 API 的再导出。
 *
 * - `GET  /fairy-eval/status`  ：配置体检（模型、端点、KEY 是否存在——**只报存在/不存在**）。
 * - `POST /fairy-eval/evaluate`：不经模型直接跑一次评估，body 为
 *   `{ state: string, questions?: object|string, model?: string }`。
 *
 * 端点风格与 fairy-roleplay / fairy-memory 一致（`ctx.inject(['webServer'], …)` +
 * `kind: 'exact'`）。这里没有客户端 bundle，也没有设置卡：配置只走环境变量。
 *
 * @module dsh-fairy-eval
 */
import { createFairyDiagnostics } from 'dsh-fairy-contracts/diagnostics';
import { configFromEnvironment, configSummary } from './config.js';
import { MISSING_KEY_MESSAGE, isTypeSafeError } from './error.js';
import { evaluate } from './evaluator.js';
import { TRIAGE_QUESTIONS, TRIAGE_STATE } from './examples.js';

export const NAME = 'dsh-fairy-eval';

/** 本包注册的宿主路由（部署/排障时按它核对）。 */
export const ROUTES = Object.freeze(['/fairy-eval/status', '/fairy-eval/evaluate']);

const diagnostics = createFairyDiagnostics(NAME);
const MAX_BODY_BYTES = 64 * 1024;

/** code → HTTP 状态：缺 KEY 与参数错误是调用方问题（4xx），上游/超时是网关问题（5xx）。 */
const STATUS_BY_CODE = Object.freeze({
  MISSING_API_KEY: 400,
  INVALID_ARGS: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  INVALID_REQUEST: 422,
  RATE_LIMITED: 429,
  OVERLOADED: 529,
  TIMEOUT: 504,
  NETWORK: 502,
  INVALID_JSON: 502,
  INVALID_RESPONSE: 502,
  SERVER_ERROR: 502,
  HTTP_ERROR: 502,
});

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(body);
}

function readJson(req, limit) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        rejectPromise(Object.assign(new Error('payload-too-large'), { code: 'payload-too-large' }));
        req.destroy?.();
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', rejectPromise);
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.trim() === '') {
        resolvePromise(undefined);
        return;
      }
      try {
        resolvePromise(JSON.parse(text));
      } catch (cause) {
        rejectPromise(Object.assign(new Error('bad-json'), { code: 'bad-json', cause }));
      }
    });
  });
}

/** TypeSafeError（或任何异常）→ `{ status, payload }`，payload 里带中文可操作文案。 */
export function httpFailureFor(error) {
  if (isTypeSafeError(error)) {
    return {
      status: STATUS_BY_CODE[error.code] ?? 502,
      payload: { ok: false, code: error.code, error: error.message },
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (error?.code === 'payload-too-large') return { status: 413, payload: { ok: false, code: 'PAYLOAD_TOO_LARGE', error: '请求体过大。' } };
  if (error?.code === 'bad-json') return { status: 400, payload: { ok: false, code: 'BAD_JSON', error: '请求体不是合法 JSON。' } };
  return { status: 502, payload: { ok: false, code: 'UNEXPECTED', error: `评估失败：${message}` } };
}

/**
 * 两个路由的处理器表。与 agent 工具跑的是同一份 `evaluate` 实现。
 *
 * @param {Object} [options]
 * @param {() => import('./config.js').TypeSafeConfig} [options.readConfig] 每次请求重读配置（改 `.env` 后重启或重开路由即生效）。
 * @param {typeof evaluate} [options.evaluateFn] 测试可注入。
 * @param {typeof fetch} [options.fetchImpl] 测试可注入。
 * @param {(ms: number) => Promise<void>} [options.sleep] 测试可注入。
 * @param {ReturnType<typeof createFairyDiagnostics>} [options.logger] 测试可注入的诊断桩。
 */
export function createTypeSafeHandlers({ readConfig = configFromEnvironment, evaluateFn = evaluate, fetchImpl, sleep, logger = diagnostics } = {}) {
  /** GET /fairy-eval/status */
  const status = (_req, res) => {
    try {
      const summary = configSummary(readConfig());
      sendJson(res, 200, {
        ok: true,
        ...summary,
        questionIds: Object.keys(TRIAGE_QUESTIONS),
        ...(summary.apiKey === '不存在' ? { help: MISSING_KEY_MESSAGE } : {}),
      });
    } catch (error) {
      logger.warn('typesafe.status', {}, error);
      sendJson(res, 502, { ok: false, code: 'CONFIG_FAILED', error: '读取 TypeSafe 配置失败。' });
    }
  };

  /** POST /fairy-eval/evaluate */
  const evaluateRoute = async (req, res) => {
    try {
      const body = await readJson(req, MAX_BODY_BYTES);
      const state = typeof body?.state === 'string' ? body.state : '';
      if (state.trim() === '') {
        sendJson(res, 400, { ok: false, code: 'INVALID_ARGS', error: '缺少 state 文本。', exampleState: TRIAGE_STATE });
        return;
      }
      const questions = body?.questions === undefined || body?.questions === null ? TRIAGE_QUESTIONS : body.questions;
      const output = await evaluateFn(state, questions, {
        config: readConfig(),
        model: typeof body?.model === 'string' && body.model.trim() !== '' ? body.model.trim() : undefined,
        fetchImpl,
        sleep,
      });
      sendJson(res, 200, { ok: true, ...output });
    } catch (error) {
      const failure = httpFailureFor(error);
      logger.warn('typesafe.evaluate', { status: failure.status, code: failure.payload.code }, error);
      sendJson(res, failure.status, failure.payload);
    }
  };

  return { status, evaluate: evaluateRoute };
}

/**
 * Mount the host half：两个路由。
 *
 * @param {Object} ctx host 作用域上下文。
 * @param {Object} [options]
 * @param {ReturnType<typeof createFairyDiagnostics>} [options.diagnostics] 测试可注入的诊断桩。
 */
export function apply(ctx, { diagnostics: sink = diagnostics } = {}) {
  return sink.guard('apply', () => {
    const handlers = createTypeSafeHandlers();
    ctx.inject(['webServer'], (ws) => {
      ws.effect(() => ws.webServer.register({ kind: 'exact', path: ROUTES[0], handler: handlers.status }), 'dsh-fairy-eval: status');
      ws.effect(() => ws.webServer.register({ kind: 'exact', path: ROUTES[1], handler: handlers.evaluate }), 'dsh-fairy-eval: evaluate');
    }, { surface: 'host' });
  }, { surface: 'host' });
}

/* ---- 公共 API（示例脚本、其它插件与测试从这里取） ---- */
export { configFromEnvironment, configSummary, describeApiKeyPresence, ENV_NAMES, readTypeSafeConfig } from './config.js';
export {
  INVALID_KEY_MESSAGE,
  MISSING_KEY_MESSAGE,
  TYPESAFE_CONSOLE_URL,
  TypeSafeError,
  isTypeSafeError,
  keyHint,
  maskKey,
} from './error.js';
export { createTypeSafeEvaluator, evaluate } from './evaluator.js';
export { TRIAGE_QUESTIONS, TRIAGE_STATE, triageQuestions } from './examples.js';
export { collectConfidence, renderAnswer, renderReport, toEvaluationOutput } from './output.js';
export { MAX_QUESTIONS, MAX_STATE_CHARS, QUESTION_TYPES, choice, normalizeQuestions, noul, score, validateQuestion } from './schema.js';
export { createTypeSafeClient, readRetryAfterMs, retryDelayMs } from './client.js';
export { EVAL_TOOL_NAME, createTypeSafeEvalTool } from './tool.js';
