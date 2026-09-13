/* Shared request/response boundary for the online STT adapters. `http.js`
 * turns every non-2xx into a bare `语音服务返回 <status>`, but a rejected key or
 * an unsupported container is exactly what the upstream body explains, so the
 * status check lives here where that body can still be read. */
import { PROVIDER_FAILED, PROVIDER_UNAVAILABLE, providerError } from './http.js';

/** One upstream fetch with the shared error taxonomy, non-2xx included. */
export async function requestAudioBytes(fetchImpl, url, options, signal) {
  let response;
  try {
    response = await fetchImpl(url, { ...options, signal });
  } catch (error) {
    if (signal?.aborted) throw providerError(signal.reason || 'client-aborted', '语音服务请求已取消。');
    throw providerError(PROVIDER_UNAVAILABLE, '语音服务连接失败。');
  }
  if (!response || typeof response.ok !== 'boolean') throw providerError(PROVIDER_FAILED, '语音服务未返回有效响应。');
  return response;
}

/** Upstream error text: `err_msg` (Deepgram), `error` as text or as an object
 * (Azure speech and most proxies in front of either service). */
function upstreamErrorMessage(payload) {
  const raw = payload?.err_msg ?? payload?.error;
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  if (raw && typeof raw === 'object' && typeof raw.message === 'string' && raw.message.trim()) return raw.message.trim();
  return '';
}

/**
 * Decode a transcription response, mapping a non-2xx status, an in-body error
 * (`{err_msg}` / `{error}`), or a non-JSON page into `provider-failed`. The
 * caller only ever sees a decoded object it can index into.
 */
export async function readTranscriptionPayload(response, emptyMessage) {
  let payload = null;
  try {
    payload = await response.json();
  } catch (error) {
    payload = null;
  }
  const upstream = upstreamErrorMessage(payload);
  if (!response.ok) throw providerError(PROVIDER_FAILED, upstream || `语音服务返回 ${response.status}`);
  if (upstream) throw providerError(PROVIDER_FAILED, upstream);
  if (!payload || typeof payload !== 'object') throw providerError(PROVIDER_FAILED, emptyMessage);
  return payload;
}
