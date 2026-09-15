/* Client-side Whisper marker provider: transformers.js runs the model in the
 * browser, so the host only stores the client's config and answers 409 on
 * /fairy-voice/stt, exactly like browser recognition. */
import { clientSideProvider } from './http.js';

export const WHISPER_WEB_STT_ID = 'whisper-web';

export const STT_WHISPER_WEB_DEFAULTS = Object.freeze({
  moduleUrl: 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/+esm',
  modelId: 'onnx-community/whisper-base',
  device: 'wasm',
  dtype: 'q8',
  language: 'chinese',
  // Optional Hugging Face mirror, same meaning as the TTS engine field.
  resourceBase: '',
});

export const whisperWebSttProvider = clientSideProvider(WHISPER_WEB_STT_ID, 'transcribe', '浏览器端语音输入');
