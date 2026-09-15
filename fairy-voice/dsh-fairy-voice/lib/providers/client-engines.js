/* Browser-side neural engines (Kokoro via WebGPU/WASM, Piper via WASM).
 *
 * They own no host transport: the host answers 409 `client-side` and the
 * browser loads the configured module and synthesizes locally. Capability
 * (WebGPU, memory, network) is only knowable in the browser, so `available()`
 * reports the configuration as ready and the client — not the host — decides
 * whether it can actually run. Any load or synthesis failure falls back to
 * system speech on the client, which is why a false "ready" is affordable.
 */
import { clientSideProvider } from './http.js';

export const KOKORO_WEB_ID = 'kokoro-web';
export const PIPER_WEB_ID = 'piper-web';
export const KITTEN_WEB_ID = 'kitten-web';

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
/* @realtimex/piper-tts-web 而非上游两个 fork：它们把 onnxruntime-web 基址钉在
 * cdnjs 的 1.18.0 目录上，而该目录没有 1.19+ 才有的 ort-wasm-simd-threaded
 * 加载器（实测 404），会让引擎每次初始化都失败。 */
/* KittenTTS-Nano：StyleTTS2 系 ONNX（~25MB，8 个音色），kitten-tts-js 是浏览器
 * WASM 实现。它没有 dtype/device 旋钮（自己管 onnxruntime-web），所以字段比
 * kokoro 少；模型与音色从 HuggingFace 拉，`resourceBase` 同 kokoro 用于镜像。
 * 包自带 `esm.sh` 文档地址，这里按仓库惯例钉 jsDelivr 的 ESM 构建与版本。 */
export const KITTEN_WEB_DEFAULTS = {
  // 上游 README 的浏览器导入形式（esm.sh）。jsDelivr 的 `+esm` 实测不可用：
  // 该包把 onnxruntime 的 wasmPaths 指向 `.../src/`，而那里没有 ORT 的加载器
  // （报错原文：Failed to fetch dynamically imported module
  // .../kitten-tts-js@0.1.2/src/ort-wasm-simd-threaded.jsep.mjs）。自托管时
  // 本字段可换成任意可信 URL。
  moduleUrl: 'https://esm.sh/kitten-tts-js@0.1.2',
  modelId: 'KittenML/kitten-tts-nano-0.8',
  voice: 'Bella',
  resourceBase: '',
};
export const PIPER_WEB_DEFAULTS = {
  moduleUrl: 'https://cdn.jsdelivr.net/npm/@realtimex/piper-tts-web@1.1.1/+esm',
  voiceId: 'en_US-hfc_female-medium',
  resourceBase: '',
};

function clientEngineProvider(id) {
  return clientSideProvider(id, 'stream', '浏览器端引擎');
}

export const kokoroWebProvider = clientEngineProvider(KOKORO_WEB_ID);
export const kittenWebProvider = clientEngineProvider(KITTEN_WEB_ID);
export const piperWebProvider = clientEngineProvider(PIPER_WEB_ID);
