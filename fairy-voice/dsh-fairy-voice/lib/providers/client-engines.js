/* Browser-side neural engines (Kokoro via WebGPU/WASM, Piper via WASM).
 *
 * They own no host transport: the host answers 409 `client-side` and the
 * browser loads the configured module and synthesizes locally. Capability
 * (WebGPU, memory, network) is only knowable in the browser, so `available()`
 * reports the configuration as ready and the client — not the host — decides
 * whether it can actually run. Any load or synthesis failure falls back to
 * system speech on the client, which is why a false "ready" is affordable.
 */
import { providerError } from './http.js';

export const KOKORO_WEB_ID = 'kokoro-web';
export const PIPER_WEB_ID = 'piper-web';

/** jsDelivr ESM builds keep the default zero-config; a self-hosted URL works
 * too. Versions are pinned: the repo pins every dependency, and a floating
 * major would drift silently behind the CDN. `resourceBase` is the mirror for
 * the model/voice downloads (HuggingFace hosts), empty = use the engine's own
 * defaults. */
export const KOKORO_WEB_DEFAULTS = {
  moduleUrl: 'https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/+esm',
  modelId: 'onnx-community/Kokoro-82M-v1.0-ONNX',
  dtype: 'q8',
  device: 'wasm',
  voice: 'af_heart',
  resourceBase: '',
};
export const PIPER_WEB_DEFAULTS = {
  moduleUrl: 'https://cdn.jsdelivr.net/npm/@mintplex-labs/piper-tts-web@1.0.5/+esm',
  voiceId: 'en_US-hfc_female-medium',
  resourceBase: '',
};

function clientEngineProvider(id) {
  return Object.freeze({
    id,
    available: () => ({ available: true, reason: null }),
    stream: () => Promise.reject(providerError('client-side', '浏览器端引擎')),
  });
}

export const kokoroWebProvider = clientEngineProvider(KOKORO_WEB_ID);
export const piperWebProvider = clientEngineProvider(PIPER_WEB_ID);
