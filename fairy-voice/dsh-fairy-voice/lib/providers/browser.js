/* Browser speech synthesis marker provider. The host cannot speak, so the
 * /tts endpoint answers 409 and the client falls back to speechSynthesis. */
import { clientSideProvider } from './http.js';

export const BROWSER_ID = 'browser';

export const browserProvider = clientSideProvider(BROWSER_ID, 'stream', '浏览器端朗读');
