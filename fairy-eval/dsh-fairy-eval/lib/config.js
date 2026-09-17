/**
 * 配置层：TypeSafe 评估的全部旋钮只从这里读取。
 *
 * 取值优先级：显式 overrides > 进程环境变量 > `.env` 文件 > 默认值。
 * 本模块只回答「KEY 是否存在」（`apiKeyPresence` / `describeApiKeyPresence`），
 * 返回值永远是 `'存在' | '不存在'`；KEY 原文不得进入任何日志、错误或返回值。
 *
 * 官方依据：https://docs.typesafe.ai/introduction/quickstart（端点、模型名、鉴权）
 * 与 https://docs.typesafe.ai/sdk/javascript/api/variables/ENV（环境变量名）。
 *
 * @module dsh-fairy-eval/config
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** 官方文档确认的默认模型。 */
export const DEFAULT_MODEL = 'jev-latest';

/** 官方 REST 根地址；评估端点 = `${baseUrl}${SYSTEM_ONE_PATH}`。 */
export const DEFAULT_BASE_URL = 'https://api.typesafe.ai';

/** 官方评估端点路径（文档 API reference）。 */
export const SYSTEM_ONE_PATH = '/v1/systemone';

/** 单次 HTTP 请求的超时；0 表示不设超时（工具层另有整体上限）。 */
export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * 与官方 Python SDK 的 `RetryPolicy.max_retries=2` 对齐（重试 2 次 = 最多 3 次请求）。
 * 可重试的状态码见 `lib/error.js`：408 / 429 / 5xx（含官方文档的 529 Overloaded）。
 */
export const DEFAULT_MAX_RETRIES = 2;

/** 首次退避 500ms、每次翻倍至 5s；与官方 SDK 的 backoff_initial/backoff_max 一致。 */
export const DEFAULT_RETRY_BACKOFF_MS = 500;
export const RETRY_BACKOFF_MAX_MS = 5_000;

/** 单条 `Retry-After` 的采纳上限，避免服务端给一个超长等待拖死工具调用。 */
export const RETRY_AFTER_MAX_MS = 30_000;

/** 环境变量名。`model` 主用 A.md 指定的 `TYPESAFE_MODEL`，并接受官方 JS SDK 的 `TYPESAFE_DEFAULT_MODEL` 作回退。 */
export const ENV_NAMES = Object.freeze({
  apiKey: 'TYPESAFE_API_KEY',
  model: 'TYPESAFE_MODEL',
  officialModel: 'TYPESAFE_DEFAULT_MODEL',
  baseUrl: 'TYPESAFE_BASE_URL',
  timeoutMs: 'TYPESAFE_TIMEOUT_MS',
  maxRetries: 'TYPESAFE_MAX_RETRIES',
});

/**
 * @typedef {Object} TypeSafeConfig
 * @property {string} apiKey        API Key 原文（只在本对象里存在；不得外泄）。
 * @property {string} model         模型名，默认 `jev-latest`。
 * @property {string} baseUrl       REST 根地址，末尾无 `/`。
 * @property {string} endpoint      完整的评估端点 URL。
 * @property {number} timeoutMs     单次请求超时毫秒数，0 = 不设超时。
 * @property {number} maxRetries    失败后的重试次数（0 = 不重试）。
 * @property {number} retryBackoffMs    首次退避毫秒数。
 * @property {number} retryBackoffMaxMs 退避上限毫秒数。
 * @property {string} dotenvPath    读取过（或将要读取）的 `.env` 路径，便于排障。
 */

/** @param {unknown} value */
function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** 解析正整数；非法输入退回 fallback（允许 0 的调用方传 min: 0）。 */
function parseCount(value, { fallback, min, max }) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  const floored = Math.floor(number);
  if (floored < min || floored > max) return fallback;
  return floored;
}

/**
 * 解析 `.env` 文本：支持 `KEY=VALUE`、`export KEY=VALUE`、`#` 注释、成对引号。
 * 只做字面量读取，不做变量展开（不引入依赖，也不执行任何内容）。
 *
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseDotEnv(text) {
  /** @type {Record<string, string>} */
  const values = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match === null) continue;
    let value = match[2].trim();
    const quoted = (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"));
    if (quoted && value.length >= 2) value = value.slice(1, -1);
    values[match[1]] = value;
  }
  return values;
}

/** 默认 `.env` 路径：当前工作目录（dsh 从项目根启动）。 */
export function defaultDotEnvPath(cwd = process.cwd()) {
  return resolve(cwd, '.env');
}

/** 读 `.env`；不存在或读不动时返回空表——缺 KEY 的报错由 error 层统一给。 */
export function loadDotEnv(path = defaultDotEnvPath()) {
  try {
    return parseDotEnv(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * 归一化配置。
 *
 * @param {Object} [options]
 * @param {Record<string, string | undefined>} [options.env]     进程环境变量（默认 `process.env`）。
 * @param {Record<string, string>} [options.dotenv]              `.env` 解析结果。
 * @param {Partial<TypeSafeConfig>} [options.overrides]          调用方显式覆盖（优先级最高）。
 * @param {string} [options.dotenvPath]                          记录用的 `.env` 路径。
 * @returns {TypeSafeConfig}
 */
export function readTypeSafeConfig({ env = process.env, dotenv = {}, overrides = {}, dotenvPath = defaultDotEnvPath() } = {}) {
  /** overrides 同时接受 `TYPESAFE_*` 与驼峰两种写法。 */
  const pick = (envName, camelName) => {
    const explicit = nonEmpty(overrides[envName]) ?? nonEmpty(overrides[camelName]);
    if (explicit !== undefined) return explicit;
    const fromEnv = nonEmpty(env?.[envName]);
    if (fromEnv !== undefined) return fromEnv;
    return nonEmpty(dotenv?.[envName]);
  };
  const pickCount = (envName, camelName, fallback, min, max) => {
    const explicit = overrides[camelName] ?? overrides[envName];
    if (explicit !== undefined && explicit !== null && explicit !== '') return parseCount(explicit, { fallback, min, max });
    const fromEnv = env?.[envName] ?? dotenv?.[envName];
    return parseCount(fromEnv, { fallback, min, max });
  };

  const baseUrl = (pick(ENV_NAMES.baseUrl, 'baseUrl') ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  return Object.freeze({
    apiKey: pick(ENV_NAMES.apiKey, 'apiKey') ?? '',
    model: pick(ENV_NAMES.model, 'model') ?? pick(ENV_NAMES.officialModel, 'officialModel') ?? DEFAULT_MODEL,
    baseUrl,
    endpoint: `${baseUrl}${SYSTEM_ONE_PATH}`,
    timeoutMs: pickCount(ENV_NAMES.timeoutMs, 'timeoutMs', DEFAULT_TIMEOUT_MS, 0, 600_000),
    maxRetries: pickCount(ENV_NAMES.maxRetries, 'maxRetries', DEFAULT_MAX_RETRIES, 0, 10),
    retryBackoffMs: parseCount(overrides.retryBackoffMs, { fallback: DEFAULT_RETRY_BACKOFF_MS, min: 0, max: 60_000 }),
    retryBackoffMaxMs: parseCount(overrides.retryBackoffMaxMs, { fallback: RETRY_BACKOFF_MAX_MS, min: 0, max: 300_000 }),
    dotenvPath,
  });
}

/** 从真实进程环境 + 项目根 `.env` 读配置（宿主与工具的运行期入口）。 */
export function configFromEnvironment({ cwd = process.cwd(), env = process.env, overrides = {} } = {}) {
  const dotenvPath = defaultDotEnvPath(cwd);
  return readTypeSafeConfig({ env, dotenv: loadDotEnv(dotenvPath), overrides, dotenvPath });
}

/** `'存在' | '不存在'`——检查 KEY 的唯一合法说法，绝不返回值本身。 */
export function apiKeyPresence(apiKey) {
  return nonEmpty(apiKey) === undefined ? '不存在' : '存在';
}

/** 同上，输入整个配置对象。 */
export function describeApiKeyPresence(config) {
  return apiKeyPresence(config?.apiKey);
}

/**
 * 可安全打印/返回的配置摘要：只含「KEY 是否存在」，不含 KEY 原文。
 *
 * @param {TypeSafeConfig} config
 */
export function configSummary(config) {
  return Object.freeze({
    apiKey: describeApiKeyPresence(config),
    apiKeyEnv: ENV_NAMES.apiKey,
    model: config.model,
    endpoint: config.endpoint,
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
    dotenvPath: config.dotenvPath,
  });
}
