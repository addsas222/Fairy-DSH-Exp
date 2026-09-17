/**
 * Client 层：只用 Node 18+ 内置 `fetch` 调官方 REST 端点，负责鉴权头、超时、退避重试
 * 与响应解析。端点、请求体、响应体、错误码全部来自官方文档：
 * https://docs.typesafe.ai/introduction/quickstart + https://docs.typesafe.ai/api
 *
 * 不引入任何第三方 HTTP 客户端，也不读 `.env` 以外的隐式状态；`fetchImpl` 可注入，
 * 测试用桩函数即可覆盖全部失败路径。
 *
 * @module dsh-fairy-eval/client
 */
import { RETRY_AFTER_MAX_MS, configFromEnvironment, configSummary } from './config.js';
import {
  TypeSafeError,
  classifyResponseError,
  invalidArgsError,
  invalidResponseError,
  jsonParseError,
  missingKeyError,
  networkError,
  timeoutError,
} from './error.js';

/** Node 18+ 全局 fetch；包一层箭头函数，避免 `fetch` 被解构后丢失 this 绑定的历史坑。 */
const defaultFetch = (input, init) => globalThis.fetch(input, init);

/** 默认真等待；测试注入桩函数即可断言退避节奏，不必真的等。 */
const defaultSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** 可重试的状态码：408 / 429 / 5xx（含官方文档的 529 Overloaded）。 */
export const RETRYABLE_STATUSES = Object.freeze([408, 429]);

/** 官方 `Retry-After` / `retry-after-ms` 响应头 → 等待毫秒数（封顶 RETRY_AFTER_MAX_MS）。 */
export function readRetryAfterMs(headers) {
  if (headers === undefined || headers === null) return undefined;
  const read = (name) => {
    const value = typeof headers.get === 'function' ? headers.get(name) : headers[name];
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
  };
  const milliseconds = read('retry-after-ms');
  if (milliseconds !== undefined) {
    const value = Number(milliseconds);
    if (Number.isFinite(value) && value >= 0) return Math.min(value, RETRY_AFTER_MAX_MS);
  }
  const seconds = read('retry-after');
  if (seconds !== undefined) {
    const value = Number(seconds);
    if (Number.isFinite(value) && value >= 0) return Math.min(value * 1000, RETRY_AFTER_MAX_MS);
  }
  return undefined;
}

/**
 * 第 `attemptIndex` 次重试前的等待毫秒数：
 * 服务端给了 `Retry-After` 就用它，否则 500ms 起、每次翻倍、封顶 5s（对齐官方 SDK）。
 * 刻意不加抖动，换取可断言的重试节奏；要抖动就在注入的 `sleep` 里加。
 */
export function retryDelayMs(failure, attemptIndex, config) {
  if (Number.isFinite(failure?.retryAfterMs)) return failure.retryAfterMs;
  const base = Math.max(0, config.retryBackoffMs) * 2 ** attemptIndex;
  return Math.min(base, Math.max(0, config.retryBackoffMaxMs));
}

/** 尽力解析错误响应体；解析不动就把原文当详情交出去。 */
function parseMaybeJson(text) {
  if (typeof text !== 'string' || text.trim() === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** fetch 抛出的任何异常 → TypeSafeError（超时 vs 网络）。 */
function asTypeSafeError(error, config) {
  if (error instanceof TypeSafeError) return error;
  const name = error !== null && typeof error === 'object' ? error.name : undefined;
  if (name === 'AbortError' || name === 'TimeoutError') return timeoutError(config.timeoutMs);
  return networkError(error);
}

/** 读响应体并解析；成功路径校验 `answers` 是否存在（官方 Response body 必填字段）。 */
async function readResponse(response, { apiKey }) {
  let text;
  try {
    text = await response.text();
  } catch (cause) {
    throw networkError(cause);
  }
  if (response.ok !== true) {
    throw classifyResponseError(response.status, {
      body: parseMaybeJson(text),
      raw: text,
      retryAfterMs: readRetryAfterMs(response.headers),
      apiKey,
    });
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw jsonParseError(cause, text);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || typeof parsed.answers !== 'object' || parsed.answers === null) {
    throw invalidResponseError(text);
  }
  return parsed;
}

/**
 * 建立客户端。一次调用只发一个请求——多维度评估靠 `questions` 里的多个问题，
 * 不拆成多次请求（官方 fan-out 口径）。
 *
 * @param {Object} [options]
 * @param {import('./config.js').TypeSafeConfig} [options.config] 配置（默认从环境 + `.env` 读）。
 * @param {typeof fetch} [options.fetchImpl] 可注入的 fetch（测试桩）。
 * @param {(ms: number) => Promise<void>} [options.sleep] 可注入的等待函数。
 */
export function createTypeSafeClient({ config = configFromEnvironment(), fetchImpl = defaultFetch, sleep = defaultSleep } = {}) {
  if (typeof fetchImpl !== 'function') throw invalidArgsError('fetchImpl 必须是函数（Node 18+ 内置 fetch，或测试桩）');

  /**
   * 调 `POST {baseUrl}/v1/systemone`。
   *
   * @param {{state: unknown, questions: Record<string, unknown>, model?: string}} request
   * @returns {Promise<Record<string, unknown>>} 官方响应体原文。
   * @throws {TypeSafeError} MISSING_API_KEY / UNAUTHORIZED / FORBIDDEN / RATE_LIMITED /
   *   OVERLOADED / SERVER_ERROR / TIMEOUT / NETWORK / INVALID_JSON / INVALID_RESPONSE / INVALID_REQUEST
   */
  async function requestSystemOne({ state, questions, model = config.model }) {
    if (config.apiKey === '') throw missingKeyError();
    const body = JSON.stringify({ state, model, questions });
    const attempts = Math.max(0, config.maxRetries) + 1;
    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        const response = await fetchImpl(config.endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            'Content-Type': 'application/json',
          },
          body,
          ...(config.timeoutMs > 0 ? { signal: AbortSignal.timeout(config.timeoutMs) } : {}),
        });
        return await readResponse(response, { apiKey: config.apiKey });
      } catch (error) {
        const failure = asTypeSafeError(error, config);
        if (failure.retryable !== true || attempt >= attempts) throw failure;
        await sleep(retryDelayMs(failure, attempt - 1, config));
      }
    }
  }

  return Object.freeze({
    config,
    requestSystemOne,
    /** 不含 KEY 原文的配置摘要，供路由/日志用。 */
    describe: () => configSummary(config),
  });
}
