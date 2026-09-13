/* Operator-defined HTTP transcription endpoint. The URL and headers are
 * static data from settings: nothing is signed, refreshed, or derived here. */
import { PROVIDER_FAILED, PROVIDER_UNAVAILABLE, providerError, requestProvider } from './http.js';
import { parseStaticHeaders } from './custom-http.js';

export const CUSTOM_HTTP_STT_ID = 'custom-http';

export const STT_CUSTOM_HTTP_DEFAULTS = Object.freeze({
  url: '',
  headersJson: '{}',
  responsePath: 'text',
});

function resolveConfig(config = {}) {
  return { ...STT_CUSTOM_HTTP_DEFAULTS, ...config };
}

/** Dot-path lookup over a decoded JSON body (`text`, `data.text`, `0.text`).
 * ponytail: dot segments only, no brackets or escapes; operators needing
 * filters or wildcards should get a JSONPath dependency instead. */
export function readResponsePath(value, path) {
  const parts = String(path ?? '').trim().split('.').filter(Boolean);
  if (!parts.length) return undefined;
  let current = value;
  for (const part of parts) {
    if (current === null || typeof current !== 'object') return undefined;
    current = current[part];
  }
  return current;
}

/** Static headers only, with the same JSON and CRLF rules as TTS. */
function parseHeaders(headersJson) {
  try {
    return parseStaticHeaders(headersJson);
  } catch (error) {
    throw providerError(PROVIDER_UNAVAILABLE, '自定义语音识别服务请求头不是合法 JSON。');
  }
}

function hasHeader(headers, name) {
  const wanted = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === wanted);
}

export function createCustomSttProvider({ fetchImpl = fetch } = {}) {
  return {
    id: CUSTOM_HTTP_STT_ID,
    available(config) {
      const value = resolveConfig(config);
      const url = String(value.url || '').trim();
      if (!url) return { available: false, reason: '未配置自定义语音识别服务地址。' };
      try {
        new URL(url);
      } catch (error) {
        return { available: false, reason: '自定义语音识别服务地址无效。' };
      }
      try {
        parseStaticHeaders(value.headersJson);
      } catch (error) {
        return { available: false, reason: error.message };
      }
      return { available: true, reason: null };
    },
    async transcribe({ audio, contentType, language, config, signal }) {
      const value = resolveConfig(config);
      const url = String(value.url || '').trim();
      if (!url) throw providerError(PROVIDER_UNAVAILABLE, '未配置自定义语音识别服务地址。');
      try {
        new URL(url);
      } catch (error) {
        throw providerError(PROVIDER_UNAVAILABLE, '自定义语音识别服务地址无效。');
      }
      const headers = { ...parseHeaders(value.headersJson) };
      if (!hasHeader(headers, 'content-type')) headers['Content-Type'] = contentType;
      const spoken = String(language || '').trim();
      if (spoken && !hasHeader(headers, 'x-fairy-language')) headers['x-fairy-language'] = spoken;
      const response = await requestProvider(fetchImpl, url, { method: 'POST', headers, body: audio }, signal);
      let payload;
      try {
        payload = await response.json();
      } catch (error) {
        throw providerError(PROVIDER_FAILED, '语音识别服务未返回有效 JSON。');
      }
      const path = String(value.responsePath ?? '').trim();
      const found = readResponsePath(payload, path);
      if (found === undefined || found === null) {
        throw providerError(PROVIDER_FAILED, `语音识别服务返回内容缺少 ${path || 'text'}。`);
      }
      return { text: typeof found === 'string' ? found : String(found) };
    },
  };
}
