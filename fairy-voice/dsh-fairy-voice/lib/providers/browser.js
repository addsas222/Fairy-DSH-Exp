/* Browser speech synthesis marker provider. The host cannot speak, so the
 * /tts endpoint answers 409 and the client falls back to speechSynthesis. */
import { providerError } from './http.js';

export const BROWSER_ID = 'browser';

export const browserProvider = Object.freeze({
  id: BROWSER_ID,
  available: () => ({ available: true, reason: null }),
  stream: () => Promise.reject(providerError('client-side', '浏览器端朗读')),
});
