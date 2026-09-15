/* TTS/STT registry 的公共脚手架：id→provider 表、带硬上限的可用性探测、
 * 未知 id 的兜底解析与逐项列表。差异（id 表、配置合并、设置路径、兜底 id、
 * 文案）由调用方传入；探测语义只有这一份。 */
import { createFairyDiagnostics } from 'dsh-fairy-contracts/diagnostics';

const diagnostics = createFairyDiagnostics('dsh-fairy-voice');

export function createAvailabilityRegistry({
  ids,
  providers,
  configFor,
  requestedOf,
  fallbackId,
  unknownReason,
  warnOperation,
  availabilityTimeoutMs = 3_000,
}) {
  const PROVIDERS = providers;

  const check = (id, settingsValue, signal) => {
    const provider = PROVIDERS.get(id);
    if (!provider) return Promise.resolve({ id, available: false, reason: unknownReason });
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason || 'client-aborted');
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    // The probe budget is a hard bound: a provider that ignores its signal
    // must not be able to hold the settings card open.
    let timer;
    const expired = new Promise((resolve) => {
      timer = setTimeout(() => {
        controller.abort('timeout');
        resolve({ id, available: false, reason: '检查超时。' });
      }, availabilityTimeoutMs);
    });
    const probe = (async () => {
      try {
        const result = await provider.available(configFor(id, settingsValue), { signal: controller.signal });
        if (result?.available === true) return { id, available: true };
        return { id, available: false, reason: String(result?.reason || '不可用。') };
      } catch (error) {
        if (controller.signal.aborted) return { id, available: false, reason: '检查超时。' };
        return { id, available: false, reason: String(error?.message || '不可用。') };
      }
    })();
    return Promise.race([probe, expired]).finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    });
  };

  return {
    PROVIDERS,
    /** Unknown or absent ids fall back to `fallbackId` with a diagnostic. */
    resolve(settingsValue) {
      const requested = requestedOf(settingsValue);
      const provider = PROVIDERS.get(requested);
      if (!provider) {
        diagnostics.warn(warnOperation, { provider: requested, fallback: fallbackId });
        return { id: fallbackId, provider: PROVIDERS.get(fallbackId), config: configFor(fallbackId, settingsValue) };
      }
      return { id: requested, provider, config: configFor(requested, settingsValue) };
    },
    check,
    list(settingsValue, { signal } = {}) {
      return Promise.all(ids.map((id) => check(id, settingsValue, signal)));
    },
  };
}
