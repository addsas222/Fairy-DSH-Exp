/* OpenAI-compatible `/audio/speech` provider. */
import { PROVIDER_UNAVAILABLE, providerError, requestProvider, trimBaseUrl } from './http.js';

export const OPENAI_ID = 'openai';
export const OPENAI_SAMPLE_RATE = 24_000;
export const OPENAI_DEFAULTS = {
  baseURL: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'tts-1',
  voice: 'alloy',
};

function resolveConfig(config = {}) {
  return { ...OPENAI_DEFAULTS, ...config };
}

export function createOpenAiProvider({ fetchImpl = fetch } = {}) {
  return {
    id: OPENAI_ID,
    available(config) {
      const value = resolveConfig(config);
      if (!String(value.baseURL || '').trim()) return { available: false, reason: '未配置 OpenAI 服务地址。' };
      if (!String(value.apiKey || '').trim()) return { available: false, reason: '未配置 OpenAI API Key。' };
      return { available: true, reason: null };
    },
    async stream(text, config, { signal, format = 'pcm' } = {}) {
      const value = resolveConfig(config);
      if (!String(value.apiKey || '').trim()) throw providerError(PROVIDER_UNAVAILABLE, '未配置 OpenAI API Key。');
      if (!String(value.baseURL || '').trim()) throw providerError(PROVIDER_UNAVAILABLE, '未配置 OpenAI 服务地址。');
      const response = await requestProvider(fetchImpl, `${trimBaseUrl(value.baseURL)}/audio/speech`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${value.apiKey}` },
        body: JSON.stringify({
          model: value.model,
          voice: value.voice,
          input: text,
          response_format: format,
        }),
      }, signal);
      // The client's PCM path resamples through Web Audio, so it needs the
      // upstream rate; mp3 responses carry no PCM rate at all.
      return { response, release: null, sampleRate: format === 'pcm' ? OPENAI_SAMPLE_RATE : null };
    },
  };
}
