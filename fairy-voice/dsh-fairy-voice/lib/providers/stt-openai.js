/* OpenAI-compatible `/audio/transcriptions` provider (multipart upload). */
import { PROVIDER_FAILED, PROVIDER_UNAVAILABLE, providerError, requestProvider, trimBaseUrl } from './http.js';

export const OPENAI_STT_ID = 'openai';

export const STT_OPENAI_DEFAULTS = Object.freeze({
  baseURL: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'whisper-1',
  language: 'zh',
});

const AUDIO_EXTENSIONS = new Map([
  ['audio/webm', 'webm'],
  ['audio/ogg', 'ogg'],
  ['audio/mp4', 'm4a'],
  ['audio/mpeg', 'mp3'],
  ['audio/wav', 'wav'],
  ['audio/x-wav', 'wav'],
  ['audio/wave', 'wav'],
  ['audio/flac', 'flac'],
  ['audio/x-flac', 'flac'],
]);

function resolveConfig(config = {}) {
  return { ...STT_OPENAI_DEFAULTS, ...config };
}

/**
 * Local whisper.cpp / faster-whisper / speaches servers ship without any auth,
 * so an empty key is valid as long as the service really is on this machine.
 * The hostname comes from the URL parser: a string prefix test would accept
 * `127.0.0.1.evil.com` as local.
 */
export function isLoopbackBaseUrl(baseURL) {
  let hostname;
  try {
    hostname = new URL(String(baseURL ?? '').trim()).hostname;
  } catch (error) {
    return false;
  }
  // WHATWG keeps the brackets on an IPv6 literal (`[::1]`).
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

/**
 * Upstream services sniff the container from the multipart filename, and a
 * mislabeled extension is rejected before the audio is ever read. The host
 * only ever passes a `type/subtype` string, never parameters.
 */
export function audioFileName(contentType) {
  const extension = AUDIO_EXTENSIONS.get(String(contentType || '').trim().toLowerCase());
  return `audio.${extension || 'bin'}`;
}

export function createOpenAiSttProvider({ fetchImpl = fetch } = {}) {
  return {
    id: OPENAI_STT_ID,
    available(config) {
      const value = resolveConfig(config);
      if (!String(value.baseURL || '').trim()) return { available: false, reason: '未配置 OpenAI 服务地址。' };
      if (!String(value.apiKey || '').trim()) {
        if (isLoopbackBaseUrl(value.baseURL)) return { available: true, reason: '本地服务无需密钥。' };
        return { available: false, reason: '未配置 OpenAI API Key。' };
      }
      return { available: true, reason: null };
    },
    async transcribe({ audio, contentType, language, config, signal }) {
      const value = resolveConfig(config);
      const apiKey = String(value.apiKey || '').trim();
      const baseURL = String(value.baseURL || '').trim();
      if (!baseURL) throw providerError(PROVIDER_UNAVAILABLE, '未配置 OpenAI 服务地址。');
      if (!apiKey && !isLoopbackBaseUrl(baseURL)) throw providerError(PROVIDER_UNAVAILABLE, '未配置 OpenAI API Key。');
      const form = new FormData();
      form.append('file', new Blob([audio], { type: contentType }), audioFileName(contentType));
      form.append('model', value.model);
      // The request header wins over the stored default so one session can
      // dictate its spoken language without editing settings.
      const spoken = String(language || value.language || '').trim();
      if (spoken) form.append('language', spoken);
      // fetch derives the multipart boundary itself: setting Content-Type here
      // would strip the boundary and make the upstream body unparsable. An
      // empty `Bearer ` header makes some local servers answer 401, so an
      // unauthenticated service gets no Authorization header at all.
      const response = await requestProvider(fetchImpl, `${trimBaseUrl(value.baseURL)}/audio/transcriptions`, {
        method: 'POST',
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        body: form,
      }, signal);
      let payload;
      try {
        payload = await response.json();
      } catch (error) {
        throw providerError(PROVIDER_FAILED, '语音识别服务未返回有效响应。');
      }
      const text = typeof payload?.text === 'string' ? payload.text : '';
      if (!text) throw providerError(PROVIDER_FAILED, '语音识别服务未返回识别结果。');
      return { text };
    },
  };
}
