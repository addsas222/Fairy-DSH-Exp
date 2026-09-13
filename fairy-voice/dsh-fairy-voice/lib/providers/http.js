/* Shared remote-provider request boundary. Providers own their wire shape; this
 * module owns only cancellation, transport failure, and error codes. */

export const PROVIDER_UNAVAILABLE = 'provider-unavailable';
export const PROVIDER_FAILED = 'provider-failed';
export const PROVIDER_CONFIG_INVALID = 'provider-config-invalid';

export function providerError(code, message) {
  return Object.assign(new Error(message), { code });
}

/** Strip a trailing slash so `${baseURL}/path` never doubles the separator. */
export function trimBaseUrl(value) {
  return String(value ?? '').trim().replace(/\/+$/, '');
}

/**
 * One upstream fetch with the provider error taxonomy applied.
 * Cancellation keeps the server's own reason (`timeout`, `client-aborted`,
 * `disposed`, `superseded`) so existing HTTP status mapping still applies.
 */
export async function requestProvider(fetchImpl, url, options, signal) {
  let response;
  try {
    response = await fetchImpl(url, { ...options, signal });
  } catch (error) {
    if (signal?.aborted) throw providerError(signal.reason || 'client-aborted', '语音服务请求已取消。');
    throw providerError(PROVIDER_UNAVAILABLE, '语音服务连接失败。');
  }
  if (!response || typeof response.ok !== 'boolean') throw providerError(PROVIDER_FAILED, '语音服务未返回有效响应。');
  if (!response.ok) throw providerError(PROVIDER_FAILED, `语音服务返回 ${response.status}`);
  return response;
}
