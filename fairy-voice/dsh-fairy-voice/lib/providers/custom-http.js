/* Operator-defined HTTP synthesis endpoint. The template and headers are
 * static data from settings: nothing is signed, refreshed, or derived here. */
import { PROVIDER_CONFIG_INVALID, providerError, requestProvider } from './http.js';

export const CUSTOM_HTTP_ID = 'custom-http';
export const CUSTOM_HTTP_TEXT_PLACEHOLDER = '{{text}}';
export const CUSTOM_HTTP_METHODS = ['POST', 'PUT', 'PATCH'];
export const CUSTOM_HTTP_DEFAULTS = {
  url: '',
  method: 'POST',
  headersJson: '{}',
  bodyTemplate: `{"text":"${CUSTOM_HTTP_TEXT_PLACEHOLDER}"}`,
};

function resolveConfig(config = {}) {
  return { ...CUSTOM_HTTP_DEFAULTS, ...config };
}

/** JSON-safe inner-text interpolation: a quoted template stays valid JSON. */
export function renderCustomBody(template, text) {
  const escaped = JSON.stringify(String(text ?? '')).slice(1, -1);
  return String(template ?? '').split(CUSTOM_HTTP_TEXT_PLACEHOLDER).join(escaped);
}

/** Static headers only. Values must be strings and cannot smuggle CRLF. */
export function parseStaticHeaders(headersJson) {
  const source = String(headersJson ?? '').trim();
  if (!source) return {};
  let value;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw providerError(PROVIDER_CONFIG_INVALID, '自定义服务请求头不是合法 JSON。');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw providerError(PROVIDER_CONFIG_INVALID, '自定义服务请求头必须是 JSON 对象。');
  }
  return Object.fromEntries(Object.entries(value)
    .filter(([, entry]) => typeof entry === 'string' && !/[\r\n]/.test(entry))
    .map(([name, entry]) => [name, entry]));
}

function resolveMethod(value) {
  const method = String(value || CUSTOM_HTTP_DEFAULTS.method).toUpperCase();
  return CUSTOM_HTTP_METHODS.includes(method) ? method : CUSTOM_HTTP_DEFAULTS.method;
}

export function createCustomHttpProvider({ fetchImpl = fetch } = {}) {
  return {
    id: CUSTOM_HTTP_ID,
    available(config) {
      const value = resolveConfig(config);
      if (!String(value.url || '').trim()) return { available: false, reason: '未配置自定义语音服务地址。' };
      try {
        new URL(value.url);
      } catch (error) {
        return { available: false, reason: '自定义语音服务地址无效。' };
      }
      try {
        parseStaticHeaders(value.headersJson);
      } catch (error) {
        return { available: false, reason: error.message };
      }
      return { available: true, reason: null };
    },
    async stream(text, config, { signal } = {}) {
      const value = resolveConfig(config);
      const url = String(value.url || '').trim();
      if (!url) throw providerError(PROVIDER_CONFIG_INVALID, '未配置自定义语音服务地址。');
      try {
        new URL(url);
      } catch (error) {
        throw providerError(PROVIDER_CONFIG_INVALID, '自定义语音服务地址无效。');
      }
      const headers = { 'Content-Type': 'application/json', ...parseStaticHeaders(value.headersJson) };
      const response = await requestProvider(fetchImpl, url, {
        method: resolveMethod(value.method),
        headers,
        body: renderCustomBody(value.bodyTemplate, text),
      }, signal);
      // A custom endpoint's audio format is unknown; the client keeps its
      // default rate and reports the mismatch as a broken stream.
      return { response, release: null, sampleRate: null };
    },
  };
}
