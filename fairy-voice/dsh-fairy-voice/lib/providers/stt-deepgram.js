/* Deepgram pre-recorded transcription: `/v1/listen` takes the raw container
 * bytes with token auth, so no multipart wrapper is involved. */
import { PROVIDER_FAILED, PROVIDER_UNAVAILABLE, providerError, trimBaseUrl } from './http.js';
import { readTranscriptionPayload, requestAudioBytes } from './stt-online.js';

export const DEEPGRAM_STT_ID = 'deepgram';

export const STT_DEEPGRAM_DEFAULTS = Object.freeze({
  baseUrl: 'https://api.deepgram.com',
  apiKey: '',
  model: 'nova-3',
  language: 'zh-CN',
});

function resolveConfig(config = {}) {
  return { ...STT_DEEPGRAM_DEFAULTS, ...config };
}

function listenUrl(value, language) {
  const base = trimBaseUrl(value.baseUrl);
  if (!base) throw providerError(PROVIDER_UNAVAILABLE, '未配置 Deepgram 服务地址。');
  const query = new URLSearchParams();
  query.set('model', String(value.model ?? '').trim());
  // The request header wins over the stored default so one session can
  // dictate its spoken language without editing settings.
  const spoken = String(language || value.language || '').trim();
  if (spoken) query.set('language', spoken);
  query.set('smart_format', 'true');
  query.set('punctuate', 'true');
  return `${base}/v1/listen?${query.toString()}`;
}

export function createDeepgramSttProvider({ fetchImpl = fetch } = {}) {
  return {
    id: DEEPGRAM_STT_ID,
    /** No availability probe: a key is all this host can judge offline. */
    available(config) {
      const value = resolveConfig(config);
      if (!String(value.apiKey || '').trim()) return { available: false, reason: '未配置 Deepgram API Key。' };
      if (!trimBaseUrl(value.baseUrl)) return { available: false, reason: '未配置 Deepgram 服务地址。' };
      return { available: true, reason: null };
    },
    async transcribe({ audio, contentType, language, config, signal }) {
      const value = resolveConfig(config);
      const apiKey = String(value.apiKey || '').trim();
      if (!apiKey) throw providerError(PROVIDER_UNAVAILABLE, '未配置 Deepgram API Key。');
      const url = listenUrl(value, language);
      const response = await requestAudioBytes(fetchImpl, url, {
        method: 'POST',
        // Deepgram declares the container itself: a multipart body would be
        // transcribed as noise.
        headers: { Authorization: `Token ${apiKey}`, 'Content-Type': contentType },
        body: audio,
      }, signal);
      const payload = await readTranscriptionPayload(response, '语音识别服务未返回有效响应。');
      const transcript = payload?.results?.channels?.[0]?.alternatives?.[0]?.transcript;
      if (typeof transcript !== 'string') throw providerError(PROVIDER_FAILED, '语音识别服务未返回识别结果。');
      return { text: transcript.trim() };
    },
  };
}
