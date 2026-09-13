/* Azure AI Speech fast transcription: one multipart POST carrying both the
 * audio and a JSON `definition`, which is what keeps it a single round trip. */
import { PROVIDER_FAILED, PROVIDER_UNAVAILABLE, providerError, trimBaseUrl } from './http.js';
import { readTranscriptionPayload, requestAudioBytes } from './stt-online.js';

export const AZURE_STT_ID = 'azure';

export const STT_AZURE_DEFAULTS = Object.freeze({
  endpoint: '',
  apiKey: '',
  locale: 'zh-CN',
});

const API_VERSION = '2024-11-15';
const TRANSCRIBE_PATH = '/speechtotext/transcriptions:transcribe';

function resolveConfig(config = {}) {
  return { ...STT_AZURE_DEFAULTS, ...config };
}

/**
 * The documented endpoint is a resource root, but operators paste the full
 * request URL just as often: a path that already names the API is kept as-is
 * instead of being appended twice. A caller-supplied api-version wins.
 */
function transcribeUrl(endpoint) {
  const base = trimBaseUrl(endpoint);
  if (!base) throw providerError(PROVIDER_UNAVAILABLE, '未配置 Azure 语音终结点。');
  let url;
  try {
    url = new URL(base);
  } catch (error) {
    throw providerError(PROVIDER_UNAVAILABLE, 'Azure 语音终结点无效。');
  }
  const path = url.pathname.replace(/\/+$/, '');
  if (path.endsWith('/transcriptions:transcribe')) url.pathname = path;
  else if (path.endsWith('/speechtotext')) url.pathname = `${path}/transcriptions:transcribe`;
  else url.pathname = `${path}${TRANSCRIBE_PATH}`;
  if (!url.searchParams.has('api-version')) url.searchParams.set('api-version', API_VERSION);
  return url.toString();
}

/** Chinese is written without word spaces; every other locale gets a joining
 * space, because Azure returns one phrase per recognized segment. */
function joinPhrases(phrases, locale) {
  const parts = phrases
    .map((phrase) => (typeof phrase?.text === 'string' ? phrase.text.trim() : ''))
    .filter(Boolean);
  return parts.join(/^zh/i.test(locale) ? '' : ' ');
}

export function createAzureSttProvider({ fetchImpl = fetch } = {}) {
  return {
    id: AZURE_STT_ID,
    /** No availability probe: endpoint plus key is all this host can judge offline. */
    available(config) {
      const value = resolveConfig(config);
      if (!String(value.endpoint || '').trim()) return { available: false, reason: '未配置 Azure 语音终结点。' };
      try {
        transcribeUrl(value.endpoint);
      } catch (error) {
        return { available: false, reason: error.message };
      }
      if (!String(value.apiKey || '').trim()) return { available: false, reason: '未配置 Azure 语音 API Key。' };
      return { available: true, reason: null };
    },
    async transcribe({ audio, contentType, language, config, signal }) {
      const value = resolveConfig(config);
      const apiKey = String(value.apiKey || '').trim();
      if (!apiKey) throw providerError(PROVIDER_UNAVAILABLE, '未配置 Azure 语音 API Key。');
      const url = transcribeUrl(value.endpoint);
      const locale = String(language || value.locale || '').trim();
      const form = new FormData();
      form.append('audio', new Blob([audio], { type: contentType }));
      // Microsoft's own samples mark this part as JSON; a plain string part
      // serializes as text/plain and some deployments reject that.
      form.append('definition', new Blob([JSON.stringify({ locales: locale ? [locale] : [] })], { type: 'application/json' }));
      // The fetch-derived boundary must survive: setting Content-Type here
      // would strip it and make the multipart body unparsable.
      const response = await requestAudioBytes(fetchImpl, url, {
        method: 'POST',
        headers: { 'Ocp-Apim-Subscription-Key': apiKey },
        body: form,
      }, signal);
      const payload = await readTranscriptionPayload(response, '语音识别服务未返回有效响应。');
      if (!Array.isArray(payload?.phrases)) throw providerError(PROVIDER_FAILED, '语音识别服务未返回识别结果。');
      return { text: joinPhrases(payload.phrases, locale) };
    },
  };
}
