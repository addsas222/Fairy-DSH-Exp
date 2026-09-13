/* Browser speech recognition marker provider. The host has no microphone, so
 * /fairy-voice/stt answers 409 and the client runs Web Speech API instead. */
import { providerError } from './http.js';

export const BROWSER_STT_ID = 'browser';

export const STT_BROWSER_DEFAULTS = Object.freeze({ lang: 'zh-CN' });

export const browserSttProvider = Object.freeze({
  id: BROWSER_STT_ID,
  available: () => ({ available: true, reason: null }),
  transcribe: () => Promise.reject(providerError('client-side', '浏览器端语音输入')),
});
