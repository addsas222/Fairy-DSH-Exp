/* ElevenLabs bidirectional WebSocket streaming (`stream-input`).
 *
 * The host owns this transport on purpose: `/tts` answers the browser with one
 * ordinary PCM response, so a WebSocket vendor costs zero client-plugin change.
 * This provider hands the handler a Response-like whose `body` is an async
 * iterable of PCM chunks — all `pcm-forward` and the /tts header logic touch.
 *
 * Protocol shape (ElevenLabs docs, 2026): connect, send one init frame
 * (`text: ' '` + `xi_api_key` + voice settings), send the text frame, send an
 * empty text frame to flush; the server answers `{ audio: <base64> }` frames
 * and one `{ isFinal: true }`.
 */
import { PROVIDER_FAILED, PROVIDER_UNAVAILABLE, providerError, trimBaseUrl } from './http.js';

export const ELEVENLABS_WS_ID = 'elevenlabs-ws';
export const ELEVENLABS_WS_SAMPLE_RATES = Object.freeze({
  pcm_16000: 16_000,
  pcm_22050: 22_050,
  pcm_24000: 24_000,
  pcm_32000: 32_000,
  pcm_44100: 44_100,
});
export const ELEVENLABS_WS_DEFAULTS = {
  baseUrl: 'wss://api.elevenlabs.io',
  apiKey: '',
  voiceId: '21m00Tcm4TlvDq8ikWAM',
  modelId: 'eleven_multilingual_v2',
  outputFormat: 'pcm_32000',
};
/* A socket that never opens must not hold the request until the 180s TTS bound. */
const OPEN_TIMEOUT_MS = 8_000;
const VOICE_SETTINGS = Object.freeze({ stability: 0.5, similarity_boost: 0.75 });
const CHUNK_SCHEDULE = Object.freeze([120, 160, 250, 290]);

/** PCM chunk queue that also carries end-of-stream and failure. */
class WsPcmStream {
  #queue = [];
  #waiter = null;
  #done = false;
  #error = null;

  push(chunk) {
    if (this.#done) return;
    this.#queue.push(chunk);
    this.#wake();
  }

  finish() {
    if (this.#done) return;
    this.#done = true;
    this.#wake();
  }

  fail(error) {
    if (this.#done) return;
    this.#error = error;
    this.#done = true;
    this.#wake();
  }

  get settled() {
    return this.#done;
  }

  #wake() {
    const waiter = this.#waiter;
    this.#waiter = null;
    waiter?.();
  }

  async next() {
    for (;;) {
      if (this.#queue.length) return { value: this.#queue.shift(), done: false };
      if (this.#error) throw this.#error;
      if (this.#done) return { value: undefined, done: true };
      await new Promise((resolve) => { this.#waiter = resolve; });
    }
  }

  [Symbol.asyncIterator]() {
    return this;
  }

  async cancel() {
    this.finish();
  }
}

function resolveConfig(config = {}) {
  return { ...ELEVENLABS_WS_DEFAULTS, ...config };
}

function streamUrl(value) {
  const base = trimBaseUrl(value.baseUrl);
  const query = new URLSearchParams({
    model_id: value.modelId,
    output_format: value.outputFormat,
    auto_mode: 'true',
  });
  return `${base}/v1/text-to-speech/${encodeURIComponent(value.voiceId)}/stream-input?${query}`;
}

function parseFrame(data) {
  if (typeof data === 'string') return JSON.parse(data);
  if (data instanceof Uint8Array) return JSON.parse(Buffer.from(data).toString('utf8'));
  if (Buffer.isBuffer(data)) return JSON.parse(data.toString('utf8'));
  return JSON.parse(String(data));
}

export function createElevenLabsWsProvider({ WebSocketImpl = globalThis.WebSocket } = {}) {
  return {
    id: ELEVENLABS_WS_ID,
    available(config) {
      const value = resolveConfig(config);
      if (!String(value.apiKey || '').trim()) return { available: false, reason: '未配置 ElevenLabs API Key。' };
      if (!String(value.voiceId || '').trim()) return { available: false, reason: '未配置 ElevenLabs 音色 ID。' };
      if (typeof WebSocketImpl !== 'function') return { available: false, reason: '当前运行时没有 WebSocket。' };
      return { available: true, reason: null };
    },
    async stream(text, config, { signal } = {}) {
      const value = resolveConfig(config);
      if (!String(value.apiKey || '').trim()) throw providerError(PROVIDER_UNAVAILABLE, '未配置 ElevenLabs API Key。');
      if (typeof WebSocketImpl !== 'function') throw providerError(PROVIDER_UNAVAILABLE, '当前运行时没有 WebSocket。');

      const stream = new WsPcmStream();
      let socket;
      try {
        socket = new WebSocketImpl(streamUrl(value));
      } catch {
        throw providerError(PROVIDER_UNAVAILABLE, '语音服务连接失败。');
      }

      const close = (reason) => {
        try { socket.close(1000, reason); } catch { /* already closed */ }
      };
      const detach = () => {
        signal?.removeEventListener('abort', onAbort);
        clearTimeout(openTimer);
      };

      const opened = new Promise((resolve, reject) => {
        socket.onopen = () => resolve();
        socket.onclose = () => reject(providerError(PROVIDER_FAILED, '语音服务连接提前关闭。'));
        socket.onerror = () => reject(providerError(PROVIDER_UNAVAILABLE, '语音服务连接失败。'));
      });
      const openTimer = setTimeout(() => {
        stream.fail(providerError(PROVIDER_FAILED, '语音服务连接超时。'));
        close('timeout');
      }, OPEN_TIMEOUT_MS);
      const onAbort = () => {
        stream.finish();
        close('aborted');
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });

      socket.onmessage = (event) => {
        let frame;
        try {
          frame = parseFrame(event?.data);
        } catch {
          return; // The stream is audio-first; an unparsable frame is not fatal.
        }
        if (typeof frame.audio === 'string' && frame.audio) stream.push(Buffer.from(frame.audio, 'base64'));
        if (frame.isFinal === true) {
          stream.finish();
          close('final');
          return;
        }
        if (typeof frame.error === 'string' && frame.error) {
          stream.fail(providerError(PROVIDER_FAILED, frame.error));
          close('failed');
        }
      };
      socket.onclose = () => {
        detach();
        // A close before isFinal means the vendor dropped the stream early;
        // after it, closing is the documented end of the exchange.
        if (!stream.settled) stream.fail(providerError(PROVIDER_FAILED, '语音服务连接提前关闭。'));
      };
      socket.onerror = () => {
        detach();
        stream.fail(providerError(PROVIDER_UNAVAILABLE, '语音服务连接失败。'));
      };

      try {
        await opened;
      } catch (error) {
        detach();
        close('failed');
        throw error;
      }

      socket.send(JSON.stringify({
        text: ' ',
        voice_settings: { ...VOICE_SETTINGS },
        xi_api_key: value.apiKey,
        generation_config: { chunk_length_schedule: [...CHUNK_SCHEDULE] },
      }));
      socket.send(JSON.stringify({ text: `${text} `, try_trigger_generation: true }));
      socket.send(JSON.stringify({ text: '' }));

      return {
        response: {
          ok: true,
          headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? 'audio/raw' : null) },
          body: stream,
        },
        release: () => {
          detach();
          stream.finish();
          close('released');
        },
        sampleRate: ELEVENLABS_WS_SAMPLE_RATES[value.outputFormat] ?? null,
      };
    },
  };
}
