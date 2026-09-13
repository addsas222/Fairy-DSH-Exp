/* Pocket TTS (kyutai-labs/pocket-tts) - 宿主侧本地服务 provider。
 *
 * 契约来自**已发布 wheel 里的服务端源码**（pocket_tts/main.py）：
 *   POST /tts   表单 text（必填）、voice_url（内置音色名或 http(s)://…/hf://…）、
 *               voice_wav（上传音色，与 voice_url 互斥）
 *   两个 voice 字段同时给 → 400；voice_url 协议不对 → 400
 *   返回 StreamingResponse(media_type="audio/wav")
 *
 * 关键：本仓的宿主 TTS 契约是**裸 PCM + X-Fairy-Sample-Rate**（客户端按
 * pcmBytesToSamples/schedulePcm 直接当采样播，没有容器解码路径）。Pocket TTS
 * 回的是 WAV，若原样透传，RIFF 头会被当成采样播成噪声——所以这里在宿主侧解析
 * RIFF（取采样率、剥掉头部），只把 PCM 交出去。
 */
import { PROVIDER_FAILED, PROVIDER_UNAVAILABLE, providerError, trimBaseUrl } from './http.js';

export const POCKET_TTS_ID = 'pocket-tts';

export const POCKET_TTS_DEFAULTS = {
  baseUrl: 'http://127.0.0.1:8000',
  voice: '',
};

const REQUEST_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 2_000;
const MAX_AUDIO_BYTES = 16 * 1024 * 1024;

/** RIFF/WAVE → { sampleRate, dataOffset }；非 RIFF 返回 null。 */
export function readWavHeader(bytes) {
  if (bytes.length < 44) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (offset) => String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
  if (ascii(0) !== 'RIFF' || ascii(8) !== 'WAVE') return null;
  let offset = 12;
  let sampleRate = null;
  while (offset + 8 <= bytes.length) {
    const id = ascii(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ' && size >= 16 && body + 16 <= bytes.length) sampleRate = view.getUint32(body + 4, true);
    if (id === 'data') {
      if (!Number.isFinite(sampleRate) || sampleRate <= 0) return null;
      // 数据块头之后就是 PCM；size 可能因流式写出而不准，取到末尾即可。
      return { sampleRate, dataOffset: Math.min(body, bytes.length) };
    }
    offset = body + size + (size % 2);
  }
  return null;
}

function configOf(config = {}) {
  return { ...POCKET_TTS_DEFAULTS, ...config };
}

function ttsUrl(config) {
  const base = trimBaseUrl(configOf(config).baseUrl);
  if (!base) throw providerError(PROVIDER_UNAVAILABLE, '未配置 Pocket TTS 服务地址。');
  return `${base}/tts`;
}

async function fetchWithTimeout(fetchImpl, url, options, timeoutMs, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), timeoutMs);
  const abort = () => controller.abort(signal?.reason || 'client-aborted');
  signal?.addEventListener?.('abort', abort, { once: true });
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (signal?.aborted) throw providerError(signal.reason || 'client-aborted', '语音服务请求已取消。');
    if (controller.signal.aborted) throw Object.assign(new Error('timeout'), { code: 'timeout', message: '语音服务超时。' });
    throw providerError(PROVIDER_UNAVAILABLE, '语音服务连接失败。');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', abort);
  }
}

export function createPocketTtsProvider({ fetchImpl = fetch } = {}) {
  return {
    id: POCKET_TTS_ID,
    async available(config, { signal } = {}) {
      const base = trimBaseUrl(configOf(config).baseUrl);
      if (!base) return { available: false, reason: '未配置 Pocket TTS 服务地址。' };
      try {
        const response = await fetchWithTimeout(fetchImpl, `${base}/`, { method: 'GET' }, PROBE_TIMEOUT_MS, signal);
        if (!response.ok) return { available: false, reason: `服务未就绪（HTTP ${response.status}）。` };
        return { available: true, reason: null };
      } catch (error) {
        return { available: false, reason: `未连接到 Pocket TTS（${error?.message || '连接失败'}）：先运行 uvx pocket-tts serve。` };
      }
    },
    async stream(text, config, { signal } = {}) {
      const settings = configOf(config);
      const body = new URLSearchParams({ text });
      const voice = String(settings.voice || '').trim();
      if (voice) body.set('voice_url', voice);
      const response = await fetchWithTimeout(fetchImpl, ttsUrl(config), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      }, REQUEST_TIMEOUT_MS, signal);
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw providerError(PROVIDER_FAILED, detail.slice(0, 200) || `语音服务返回 ${response.status}`);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > MAX_AUDIO_BYTES) throw providerError(PROVIDER_FAILED, '返回音频过大。');
      const wav = readWavHeader(bytes);
      if (!wav) {
        // 非 RIFF：按裸 PCM 透传，采样率交由客户端默认值（与 custom-http 一致）。
        return { response: new Response(bytes, { status: 200, headers: { 'content-type': 'audio/raw' } }), sampleRate: null };
      }
      // 剥掉 RIFF 头：客户端只会把字节当采样播，头部必须在这里去掉。
      const pcm = bytes.subarray(wav.dataOffset);
      return {
        response: new Response(pcm, { status: 200, headers: { 'content-type': 'audio/wav-pcm' } }),
        sampleRate: wav.sampleRate,
      };
    },
  };
}
