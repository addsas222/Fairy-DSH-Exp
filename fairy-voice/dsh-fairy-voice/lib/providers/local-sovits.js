/* GPT-SoVITS transport and provider boundary. The host owns routes and
 * settings; this module owns how the local CPU service is reached. */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { createFairyDiagnostics } from 'dsh-fairy-contracts/diagnostics';

const diagnostics = createFairyDiagnostics('dsh-fairy-voice');

export const LOCAL_SOVITS_ID = 'local-sovits';
const LOCAL_TTS_TIMEOUT_MS = 180_000;
const LOCAL_STATUS_TIMEOUT_MS = 3_000;
export const LOCAL_SOVITS_DEFAULTS = {
  baseURL: 'http://127.0.0.1:9880',
  referenceAudioPath: join(homedir(), '.dsh', 'fairy-voice', 'runtime', 'reference', 'fairy_ref.wav'),
  referencePromptPath: join(homedir(), '.dsh', 'fairy-voice', 'runtime', 'reference', 'fairy_ref.txt'),
};
export const REFERENCE_PROMPT_FALLBACK = '根据用户协议，我无权回复该问题。主人将在合适的时间与合适的场合获知答案。';

/* The reference transcript is operator-managed and read once per path. A
 * mid-run edit therefore needs a plugin reload; a per-request read would put
 * file I/O on the synthesis latency path for no behavioural gain.
 * ponytail: one cached read per path, reload to pick up edits. */
const promptCache = new Map();

function readReferencePrompt(file) {
  const cached = promptCache.get(file);
  if (cached !== undefined) return cached;
  let prompt;
  try {
    prompt = readFileSync(file, 'utf8').trim();
  } catch (error) {
    diagnostics.warn('reference.prompt.load', { file: basename(String(file)), fallback: true }, error);
    prompt = REFERENCE_PROMPT_FALLBACK;
  }
  promptCache.set(file, prompt);
  return prompt;
}

async function localFetch(url, options, timeoutMs, parentSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), timeoutMs);
  const onAbort = () => controller.abort(parentSignal?.reason || 'client-aborted');
  if (parentSignal?.aborted) onAbort();
  else parentSignal?.addEventListener('abort', onAbort, { once: true });
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw Object.assign(new Error(String(controller.signal.reason)), { code: controller.signal.reason });
    throw Object.assign(new Error('local service unavailable'), { code: 'local-service-unavailable' });
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', onAbort);
  }
}

/* A streaming response is active after fetch() resolves, so release() owns
 * the parent abort bridge until its consumer has finished with the PCM body. */
function openLocalStream(url, options, timeoutMs, parentSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), timeoutMs);
  const onAbort = () => controller.abort(parentSignal?.reason || 'client-aborted');
  if (parentSignal?.aborted) onAbort();
  else parentSignal?.addEventListener('abort', onAbort, { once: true });
  const release = () => {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', onAbort);
  };
  return fetch(url, { ...options, signal: controller.signal }).catch((error) => {
    release();
    if (controller.signal.aborted) throw Object.assign(new Error(String(controller.signal.reason)), { code: controller.signal.reason });
    throw Object.assign(new Error('local service unavailable'), { code: 'local-service-unavailable' });
  }).then((response) => ({ response, release }));
}

export function createLocalTtsTransport({
  fetchImpl = fetch,
  ttsUrl,
  docsUrl,
  referenceAudioPath,
  referencePrompt,
  ttsTimeoutMs,
  statusTimeoutMs,
} = {}) {
  const fetchStatus = (url, options, timeoutMs, signal) => fetchImpl === fetch
    ? localFetch(url, options, timeoutMs, signal)
    : fetchImpl(url, { ...options, signal });
  const stream = (url, options, timeoutMs, signal) => fetchImpl === fetch
    ? openLocalStream(url, options, timeoutMs, signal)
    : fetchImpl(url, { ...options, signal }).then((response) => ({ response, release: null }));
  const localTtsRequest = (text) => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, text_lang: 'zh', ref_audio_path: referenceAudioPath, prompt_text: referencePrompt, prompt_lang: 'zh', text_split_method: 'cut5', batch_size: 1, media_type: 'raw', streaming_mode: 1, fragment_interval: 0.14, parallel_infer: false }),
  });
  return {
    status(signal) {
      return fetchStatus(docsUrl, { method: 'GET' }, statusTimeoutMs, signal).then((response) => {
        if (!response.ok) throw new Error(`Fairy status returned ${response.status}`);
        return { available: true, reason: null };
      });
    },
    stream(text, signal) {
      return stream(ttsUrl, localTtsRequest(text), ttsTimeoutMs, signal);
    },
  };
}

function transportFor({ fetchImpl, ttsTimeoutMs, statusTimeoutMs }, config = {}) {
  const baseURL = String(config.baseURL || LOCAL_SOVITS_DEFAULTS.baseURL).trim().replace(/\/+$/, '');
  const referencePromptPath = config.referencePromptPath || LOCAL_SOVITS_DEFAULTS.referencePromptPath;
  return createLocalTtsTransport({
    fetchImpl,
    ttsUrl: `${baseURL}/tts`,
    docsUrl: `${baseURL}/docs`,
    referenceAudioPath: config.referenceAudioPath || LOCAL_SOVITS_DEFAULTS.referenceAudioPath,
    referencePrompt: readReferencePrompt(referencePromptPath),
    ttsTimeoutMs,
    statusTimeoutMs,
  });
}

export function createLocalSovitsProvider({
  fetchImpl = fetch,
  ttsTimeoutMs = LOCAL_TTS_TIMEOUT_MS,
  statusTimeoutMs = LOCAL_STATUS_TIMEOUT_MS,
} = {}) {
  const options = { fetchImpl, ttsTimeoutMs, statusTimeoutMs };
  return {
    id: LOCAL_SOVITS_ID,
    async available(config, { signal } = {}) {
      try {
        await transportFor(options, config).status(signal);
        return { available: true, reason: null };
      } catch (error) {
        if (signal?.aborted) return { available: false, reason: '检查已取消。' };
        return { available: false, reason: '本地 Fairy 服务未启动。' };
      }
    },
    stream(text, config, { signal } = {}) {
      return transportFor(options, config).stream(text, signal);
    },
  };
}
