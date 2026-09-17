/**
 * 错误层：把「缺 KEY / 401 / 403 / 422 / 429 / 529 / 5xx / 超时 / 非 JSON」翻译成
 * 带 code、可重试标记与中文可操作文案的 `TypeSafeError`。
 *
 * 两条硬约束：
 * 1. 任何消息都不得包含 API Key 原文（需要展示时只用 `maskKey`）。
 * 2. 401/403 的文案按 A.md #10 原文口径；缺 KEY 的文案按 A.md #9 原文口径。
 *
 * @module dsh-fairy-eval/error
 */

/** 控制台地址：拿 Key、换 Key 的唯一出口。 */
export const TYPESAFE_CONSOLE_URL = 'https://console.typesafe.ai/';

/** A.md #9 原文口径：缺 KEY 时的可操作报错。 */
export const MISSING_KEY_MESSAGE = '缺少 TYPESAFE_API_KEY。请到 https://console.typesafe.ai/ 获取 API Key，'
  + '然后在项目根目录 .env 中添加 TYPESAFE_API_KEY=你的_api_key，或设置系统环境变量后重启插件。';

/** A.md #10 原文口径：401/403 的提示。 */
export const INVALID_KEY_MESSAGE = 'API Key 可能无效、过期或未设置。请到 https://console.typesafe.ai/ 重新获取，'
  + '并更新 TYPESAFE_API_KEY 后重启插件。';

/**
 * 掩码：保留前 3 位与后 4 位，形如 `sk-...abcd`（A.md #11 的示例形态）。
 * 短于 10 字符的输入一律返回 `…`——截断后可能露出全貌的，宁可不显示。
 *
 * @param {unknown} key
 * @returns {string} 空输入返回空串。
 */
export function maskKey(key) {
  const text = typeof key === 'string' ? key : '';
  if (text === '') return '';
  if (text.length < 10) return '…';
  return `${text.slice(0, 3)}...${text.slice(-4)}`;
}

/** 供消息拼接用的「（当前使用的 Key：sk-...abcd）」，KEY 为空时不加这一句。 */
export function keyHint(apiKey) {
  const masked = maskKey(apiKey);
  return masked === '' ? '' : `（当前使用的 Key：${masked}）`;
}

/** 带 code 的错误；`retryable` 决定 client 层是否退避重试。 */
export class TypeSafeError extends Error {
  /**
   * @param {string} message 面向用户的中文文案（不得含 KEY 原文）。
   * @param {Object} [options]
   * @param {string} [options.code]        机器可读错误码。
   * @param {number} [options.status]      HTTP 状态码（若有）。
   * @param {boolean} [options.retryable]  是否可重试。
   * @param {number} [options.retryAfterMs] 服务端要求的等待毫秒数。
   * @param {unknown} [options.detail]     服务端返回的错误详情摘要。
   * @param {unknown} [options.cause]
   */
  constructor(message, { code = 'typesafe-error', status, retryable = false, retryAfterMs, detail, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'TypeSafeError';
    this.code = code;
    this.retryable = retryable;
    if (status !== undefined) this.status = status;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
    if (detail !== undefined) this.detail = detail;
  }
}

/** @returns {boolean} */
export function isTypeSafeError(value) {
  return value instanceof TypeSafeError;
}

/** 缺 KEY（A.md #9）。 */
export function missingKeyError() {
  return new TypeSafeError(MISSING_KEY_MESSAGE, { code: 'MISSING_API_KEY' });
}

/** 401/403（A.md #10）；带上掩码后的 KEY，方便用户确认用的是哪一把。 */
export function invalidKeyError({ status, apiKey, detail } = {}) {
  return new TypeSafeError(`${INVALID_KEY_MESSAGE}${keyHint(apiKey)}`, {
    code: status === 403 ? 'FORBIDDEN' : 'UNAUTHORIZED',
    status,
    retryable: false,
    detail,
  });
}

/**
 * 官方错误表（https://docs.typesafe.ai/api → Errors）：
 * 401 未授权 / 422 请求体校验失败 / 429 限流 / 529 过载。
 * 403 未在官方表中列出，但 A.md #3 要求处理，按同一文案归类为 FORBIDDEN。
 * 其余 5xx 归为 SERVER_ERROR；408 与 429/5xx 一起进入重试。
 *
 * @param {number} status
 * @param {Object} [options]
 * @param {unknown} [options.body]         已尽力解析的响应体。
 * @param {string} [options.raw]           原始响应文本（截断后仅作详情）。
 * @param {number} [options.retryAfterMs]
 * @param {string} [options.apiKey]
 */
export function classifyResponseError(status, { body, raw, retryAfterMs, apiKey } = {}) {
  const detail = extractDetail(body, raw);
  if (status === 401 || status === 403) return invalidKeyError({ status, apiKey, detail });
  if (status === 429) {
    return new TypeSafeError('TypeSafe 触发了限流（429 Too Many Requests）。已按退避策略重试；'
      + '如果持续失败，请降低调用频率或到 https://console.typesafe.ai/ 检查配额。', {
      code: 'RATE_LIMITED', status, retryable: true, retryAfterMs, detail,
    });
  }
  if (status === 529) {
    return new TypeSafeError('TypeSafe 当前过载（529 Overloaded）。已按退避策略重试；稍后重试通常即可恢复。', {
      code: 'OVERLOADED', status, retryable: true, retryAfterMs, detail,
    });
  }
  if (status === 422) {
    return new TypeSafeError(`请求体未通过 TypeSafe 校验（422）：${detail ?? '服务端未给出字段详情。'}`
      + '请检查 questions 的 type / instructions / criteria（Noul 与 Choice 用对象、Score 用至少两级的数组）。', {
      code: 'INVALID_REQUEST', status, retryable: false, detail,
    });
  }
  if (status === 408) {
    return new TypeSafeError('TypeSafe 请求超时（408）。已按退避策略重试。', {
      code: 'REQUEST_TIMEOUT', status, retryable: true, retryAfterMs, detail,
    });
  }
  if (status >= 500) {
    return new TypeSafeError(`TypeSafe 服务端错误（${status}）。已按退避策略重试；仍失败时稍后再试。`, {
      code: 'SERVER_ERROR', status, retryable: true, retryAfterMs, detail,
    });
  }
  return new TypeSafeError(`TypeSafe 返回了未预期的状态码（${status}）${detail === undefined ? '' : `：${detail}`}`, {
    code: 'HTTP_ERROR', status, retryable: false, detail,
  });
}

/** 网络层失败（DNS / 连接中断 / fetch 抛错）。 */
export function networkError(cause) {
  return new TypeSafeError('无法连接 TypeSafe（网络错误）。请检查网络或代理设置后重试。', {
    code: 'NETWORK', retryable: true, cause,
  });
}

/** 超时（AbortSignal.timeout 触发，或 fetch 抛 TimeoutError）。 */
export function timeoutError(timeoutMs) {
  const seconds = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.round(timeoutMs / 1000) : null;
  return new TypeSafeError(`TypeSafe 请求超时（${seconds === null ? '未设超时' : `超过 ${seconds} 秒`}）。`
    + '可用 TYPESAFE_TIMEOUT_MS 调大超时，或稍后重试。', { code: 'TIMEOUT', retryable: true });
}

/** 成功响应不是合法 JSON。 */
export function jsonParseError(cause, raw) {
  const preview = previewOf(raw);
  return new TypeSafeError(`TypeSafe 返回的响应不是合法 JSON${preview === '' ? '' : `：${preview}`}`, {
    code: 'INVALID_JSON', retryable: false, cause,
  });
}

/** JSON 合法但结构不符合官方 Response body（缺 answers 等）。 */
export function invalidResponseError(raw) {
  const preview = previewOf(raw);
  return new TypeSafeError(`TypeSafe 响应缺少 answers 字段${preview === '' ? '' : `：${preview}`}`, {
    code: 'INVALID_RESPONSE', retryable: false,
  });
}

/** 调用方参数错误（工具层与 evaluator 层共用）。 */
export function invalidArgsError(message, { cause } = {}) {
  return new TypeSafeError(message, { code: 'INVALID_ARGS', cause });
}

/** 从服务端错误体里挖出人能看懂的详情：`error.message` / `message` / `detail` / 原始文本。 */
function extractDetail(body, raw) {
  if (body !== null && typeof body === 'object') {
    const record = /** @type {Record<string, unknown>} */ (body);
    const nested = record.error !== null && typeof record.error === 'object' ? record.error : undefined;
    for (const candidate of [nested?.message, record.message, record.detail, nested?.type]) {
      if (typeof candidate === 'string' && candidate.trim() !== '') return truncate(candidate.trim(), 200);
    }
  }
  if (typeof body === 'string' && body.trim() !== '') return truncate(body.trim(), 200);
  return previewOf(raw) || undefined;
}

/** 响应体预览：截断 + 压平空白，绝无可能带入请求头。 */
function previewOf(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return '';
  return truncate(raw.replace(/\s+/g, ' ').trim(), 200);
}

function truncate(text, limit) {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
