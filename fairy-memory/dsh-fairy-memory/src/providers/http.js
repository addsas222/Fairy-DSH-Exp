/* Shared request/error boundary for every memory provider. The host owns the
 * public taxonomy; a provider only says what went wrong, and the route layer
 * maps the code to a status. */

export const PROVIDER_FAILED = 'provider-failed';
export const PROVIDER_UNAVAILABLE = 'provider-unavailable';

/** One error shape for all providers, so `statusFor(code)` stays exhaustive. */
export function providerError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** Normalize a configured base URL; empty string means "not configured". */
export function trimBaseUrl(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.toString().replace(/\/+$/, '');
  } catch {
    return '';
  }
}

/** Upstream error text: `error` as text or object, `message`, `detail`. */
export function upstreamMessage(payload) {
  const candidates = [payload?.error, payload?.message, payload?.detail, payload?.err_msg];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    if (candidate && typeof candidate === 'object' && typeof candidate.message === 'string' && candidate.message.trim()) {
      return candidate.message.trim();
    }
  }
  return '';
}

/**
 * One JSON round trip. A refused connection is `provider-unavailable` (the
 * caller can fix a URL), while a rejected request is `provider-failed` with the
 * upstream text attached - the difference is what tells an operator whether to
 * check the service or the key.
 */
export async function requestJson(fetchImpl, url, options, signal) {
  let response;
  try {
    response = await fetchImpl(url, { ...options, signal });
  } catch (error) {
    if (signal?.aborted) throw providerError(signal.reason || 'client-aborted', '记忆服务请求已取消。');
    throw providerError(PROVIDER_UNAVAILABLE, '记忆服务连接失败。');
  }
  if (!response || typeof response.ok !== 'boolean') throw providerError(PROVIDER_FAILED, '记忆服务未返回有效响应。');
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    throw providerError(PROVIDER_FAILED, upstreamMessage(payload) || `记忆服务返回 ${response.status}`);
  }
  return payload;
}
