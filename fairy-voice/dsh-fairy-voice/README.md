# dsh-fairy-voice

Fairy 朗读插件：把 DSH 的最终回答转成语音，负责「文本 → 可播放音频」这一段，并提供设置卡片选择由谁合成。

- host（`lib/index.js`）：HTTP 路由、设置命名空间、提供方注册表、人格语音绑定。
- client（`lib/client.js`）：会话朗读控制、Web Audio PCM 播放、设置卡片。
- providers（`lib/providers/`）：GPT-SoVITS、OpenAI 兼容接口、自定义 HTTP、浏览器朗读。

## 设置命名空间 `fairy-voice`

```jsonc
{
  "version": 1,
  "provider": "local-sovits",            // local-sovits | openai | browser | custom-http
  "providers": {
    "localSovits": { "baseURL": "http://127.0.0.1:9880", "referenceAudioPath": "…/fairy_ref.wav", "referencePromptPath": "…/fairy_ref.txt" },
    "openai":      { "baseURL": "https://api.openai.com/v1", "apiKey": "", "model": "tts-1", "voice": "alloy" },
    "customHttp":  { "url": "", "method": "POST", "headersJson": "{}", "bodyTemplate": "{\"text\":\"{{text}}\"}" }
  }
}
```

- 未识别的 `provider` 回退到 `local-sovits` 并记录一条诊断。
- 参考文本按路径缓存一次（改文件后需重载插件）。

## 提供方

| id | 可用性判定 | 合成方式 | 上游采样率 |
| --- | --- | --- | --- |
| `local-sovits` | `GET {baseURL}/docs` 可达 | `POST {baseURL}/tts`，GPT-SoVITS raw PCM | 32 kHz |
| `openai` | 已填 `baseURL` 与 `apiKey` | `POST {baseURL}/audio/speech`，`response_format: pcm` | 24 kHz |
| `elevenlabs-ws` | 已填 `apiKey` 与 `voiceId`，运行时存在 `WebSocket` | `wss://…/stream-input`：init 帧 → 文本帧 → 空帧 flush，`audio` 帧 base64 解码为 PCM 转发 | 由 `outputFormat`（`pcm_32000` 等）决定 |
| `kokoro-web` | 总是「可用」 | 浏览器内：动态导入 `moduleUrl`（默认 jsDelivr 的 kokoro-js），`KokoroTTS.from_pretrained(modelId)` 后逐句合成 | 24 kHz |
| `piper-web` | 总是「可用」 | 浏览器内：动态导入 `moduleUrl`（默认 jsDelivr 的 piper-tts-web），`predict({text, voiceId})` 得 WAV，`decodeAudioData` 后播放 | 由 WAV 决定 |
| `custom-http` | `url` 合法且 `headersJson` 可解析 | `method url`，请求体由 `bodyTemplate` 插值 | 未知（按 32 kHz 播放） |
| `browser` | 总是可用 | 不合成：`/tts` 返回 409，客户端改用 `speechSynthesis` | — |

### 接入任意 OpenAI 兼容的本地 TTS（零代码）

`openai` 提供方对任何实现 `POST {baseURL}/audio/speech`（OpenAI Audio API 形态）
的服务都能直接用，无需改代码。社区里常见的本地服务：

| 服务 | 启动方式 | 语音引擎设置 |
| --- | --- | --- |
| [fastkokoro](https://pypi.org/project/fastkokoro/)（Kokoro-82M，CPU 可跑） | `pip install fastkokoro` | 服务地址 `http://127.0.0.1:8880/v1`，模型 `kokoro`，音色 `af_heart` |
| Local-TTS-Service（多引擎聚合） | 见其仓库说明 | 服务地址 = 其 `/v1` 前缀 |
| Zonos2 inference server（Mini-SGLang） | 见 Zyphra 仓库 | 服务地址 = 其 `/v1` 前缀 |
| Edge-TTS 自建包装 | 任一 HTTP 包装（edge-tts → REST） | 走 `custom-http` 模板更直接 |

字段：服务地址 / API Key / 模型 / 音色；本机无鉴权服务把 API Key 填任意非空值
（host 只要求非空，不会对外发送到别处）。

### 语音输入（转文字，STT）

把说话写进输入框（写入后由你确认再发送；不会自动发送）。**网上 / 本地**两条路都在设置 → 语音输入里按提供方切换：

| 路线 | id | 判定 | 识别方式 |
| --- | --- | --- | --- |
| 本地 | `whisper-web` | 总是可用（需浏览器能解码音频） | **浏览器内 Whisper**（transformers.js + ONNX）：录音在本标签页识别，音频不出机器，离线可用；首次使用时下载并缓存模型 |
| 本地 | `openai`（指向本机） | `baseURL` 主机为 loopback（`127.0.0.1`/`localhost`/`::1`）时空 key 即算可用 | 录音（`MediaRecorder`）→ `POST {baseURL}/audio/transcriptions`；适配 whisper.cpp `whisper-server`、faster-whisper-server、speaches 等 |
| 网上 | `browser` | 总是可用（需浏览器支持 `SpeechRecognition`） | 浏览器内置识别（由浏览器厂商的在线服务完成），`lang` 默认 `zh-CN` |
| 网上 | `openai`（云端） | 已填 `baseURL` 与 `apiKey` | OpenAI / Groq / SiliconFlow / DeepInfra 等 OpenAI 兼容云端 |
| 网上 | `deepgram` | 已填 `apiKey` | `POST {baseUrl}/v1/listen`（Nova 模型，`smart_format` + `punctuate`） |
| 网上 | `azure` | 已填 `endpoint` 与 `apiKey` | Azure 快速转写 API（multipart：`audio` + `definition.locales`），中文短语按字拼接 |
| 任意 | `custom-http` | `url` 合法且 `headersJson` 可解析 | 录音 → `POST {url}` 原始音频 + 静态头，按 `responsePath`（默认 `text`）取文本 |

本地服务一行起（三者都走 `openai` 提供方，地址填各自 `/v1`）：

```sh
whisper-server -m ggml-base.bin --port 8080   # whisper.cpp → http://127.0.0.1:8080/v1
uvx speaches --port 8000                       # → http://127.0.0.1:8000/v1
faster-whisper-server --port 9000              # → http://127.0.0.1:9000/v1
```

`whisper-web` 字段：模块地址（默认 `@huggingface/transformers@3.8.1`，仅填可信来源，会在页面内执行）、
模型 ID（默认 `onnx-community/whisper-base`）、设备（`wasm` 或 `webgpu`）、精度（WASM 用 `q8`、
WebGPU 用 `fp32`）、识别语言（`chinese`/`english`/`auto`）、资源镜像（HF 不可达时填，复用 TTS 的
`resourceBase` 域名重写机制）。与浏览器内 TTS 相同：单线程 ONNX 守卫 + 引擎模块缓存。

主机端点：`GET /fairy-voice/stt-providers`、`GET|POST /fairy-voice/stt-config`、
`POST /fairy-voice/stt`（请求体=原始音频字节，`content-type: audio/*`，可选
`x-fairy-language`；成功返回 `{ text }`；体上限 8 MiB，超时 60s）。
写入路径按官方优先级：① 槽位 props 的 `inputActions.setDraft(next)`
（composer 的公开动作面，拥有 draft 状态机，实测端到端可用）；② 退路
`ctx.bail('slash/input-insert-text', { text, span })`（一方 input-trigger 用的
同一通道，span 取实时 `useInput` 快照的 `draftRev`）；③ 两者都不可用时**明确报错**
而不是直写 DOM——草稿归 shell 的 draftRev 状态机所有，直写会被下一次渲染覆盖。

### 朗读与语音控件

- 控件（自动朗读开关 / 麦克风 / 音量 / 语速）默认只在 **H.D.D 视觉模式**下挂载；
  在 设置 → 语音引擎 勾选「始终显示朗读与语音控件」可放行（持久化于
  `localStorage['dsh.fairyVoice.alwaysShowControls.v1']`）。
- 设置 → 语音引擎 有「试听一句」：按当前提供方直接合成一小段并播放
  （host 走 `/tts`、浏览器引擎走本地合成、系统朗读走 `speechSynthesis`）。
- 设置 → 语音简报 可调「简报触发字数」（0 = 每次都先简报），值存
  `localStorage['dsh.fairyVoice.briefThreshold.v1']`。

### 浏览器内引擎（`kokoro-web` / `piper-web`）

模型完全在浏览器里加载与合成，host 只保存配置（`/tts` 对它们返回 409
`client-side`，客户端按自己选中的引擎 id 走本地合成）：

- `moduleUrl` 默认指向 jsDelivr 的 ESM 构建，且**钉精确版本**（`kokoro-js@1.2.1`、
  `@realtimex/piper-tts-web@1.1.1`）；离线或自托管时改成自己的地址即可。
  该地址会在页面内执行代码，**只填可信来源**。
- piper 选用 `@realtimex/piper-tts-web` 而非另外两个 fork（`@diffusionstudio/vits-web`、
  `@mintplex-labs/piper-tts-web`）：后两者把 onnxruntime-web 基址钉在 cdnjs 的 1.18.0
  目录，而该目录没有 1.19+ 才有的 `ort-wasm-simd-threaded` 加载器（实测 404），
  引擎每次初始化都会失败。客户端会在初始化前探测该 URL，基址不可用时直接给出
  可读错误而不是静默降级。
- `resourceBase`（可选）是模型/音色下载的镜像基址：填了之后，加载与合成期间
  发往 `huggingface.co`（含 `cdn-lfs*.huggingface.co`、`cas-bridge.xethub.hf.co`）
  的请求会被改写到该基址，其余请求不受影响。家在 HuggingFace 不可达的网络
  （如大陆直连）时，填 `https://hf-mirror.com` 之类的镜像即可；留空用引擎默认。
- **同源/线程约束**：DSH 页面没有 CSP，所以 CDN 动态 import 可用；但页面
  `crossOriginIsolated === false`、没有 `SharedArrayBuffer`，跨源 Worker 也被拦，
  因此 onnxruntime-web 必须单线程。`piper-web` 在自己的 `init()` 里把线程数设成
  `navigator.hardwareConcurrency`，客户端在初始化窗口内把它固定为 1
  （`withSingleThreadHint`）再恢复。若将来要跑 worker/多线程，只能由宿主
  webServer 以同源方式转发引擎资源。
- `kokoro-web`：`device` 选 `webgpu` 时自动把精度收敛到 `fp32`，否则用 `q8`（WASM）。
  首次加载需下载模型（约 80MB，之后走浏览器缓存）。
- `piper-web`：`voiceId` 首次使用会预下载音色（30–60MB，存入 OPFS）。
- **piper 会话复用**：整段朗读共用一个 `TtsSession`（`init()` 只下载/初始化一次），
  逐句 `predict()`。
- **降级语义**：任一环节失败（无 WebGPU、模块被拦截、显存不足、下载失败）
  都会把**剩余句子**交给系统语音继续朗读，而不是静默或报错停机；
  host 路径中途失败同样如此（见下）。

- `custom-http`：`{{text}}` 占位符会被 JSON 转义后的文本替换；只发送静态请求头，值必须是字符串且不能含 CR/LF。`method` 仅接受 POST/PUT/PATCH，其他值按 POST 处理。
- 未知的 `provider`（写错或来自更新版本的人格包）不会让设置注册失败，而是在解析时回退到 `local-sovits` 并记录诊断；通过 HTTP 写入未知 id 会被拒绝（400）。
- API Key 只在 host 侧保存；`GET /fairy-voice/provider-config` 一律返回 `***`，写入时字段值为 `***` 表示「保持不变」，空字符串表示「清空」。

## HTTP 路由

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/fairy-voice/status` | `{ available, reason, provider }` |
| GET | `/fairy-voice/providers` | `[{ id, available, reason? }]`，每个提供方最多 3 秒探测 |
| GET | `/fairy-voice/provider-config` | 已脱敏的 `{ provider, providers }` |
| POST | `/fairy-voice/provider-config` | 写入 `{ provider?, providers?{…} }`，返回脱敏结果 |
| POST | `/fairy-voice/prepare` | `{ markdown }` → `{ sentences: [] }` |
| POST | `/fairy-voice/tts` | `{ text }` → PCM 音频流；`X-Fairy-Sample-Rate` 声明上游采样率 |
| GET | `/fairy-voice/brain/status` | Voice Brain（DeepSeek）配置状态 |
| POST | `/fairy-voice/brain/config` | 写入/清除 DeepSeek API Key |
| POST | `/fairy-voice/brain/brief` | `{ markdown }` → `{ brief }` |

`/tts` 失败响应统一为 `{ error: { code, message } }`；`browser` 提供方返回 `409 { error: { code: "client-side", message: "浏览器端朗读" } }`。

## 人格语音绑定

人格包通过 host 事件广播语音选择，本插件是 `fairy-voice` 命名空间的唯一写入方：

```
ctx.emit('fairy-persona/change', { packId, voice: { provider, config } })
```

- `voice === null`（人格包没有 voice 段）：保持当前绑定。
- 其余情况写入 `provider` 与对应的 `providers.<section>`，只接受该提供方的已知字段。
- 配置键固定为 `localSovits` / `openai` / `customHttp` 的 camelCase 字段名。

## 客户端行为

- 槽位：`conversation.input.left`（朗读控制）、`conversation.chat.assistant-actions`（单条朗读）、`settings.section` id `fairy-voice-brain` order 30、id `fairy-voice-engine` order 31。
- 播放：`/tts` 的 PCM 经 Web Audio 调度；`schedulePcm` 按 `X-Fairy-Sample-Rate` 建缓冲，未声明时用 32 kHz。
- 浏览器回退：提供方为 `browser`，或 `/tts` 返回 409 `client-side` 时，改用 `window.speechSynthesis` 逐句朗读，`rate = 1.0`，音色优先 `zh`。
- 中途降级：host 引擎在读到第 k 组时失败，客户端把第 k…n 句交给系统语音读完（`playSystem`），而不是留下半句或静默；本地引擎同理。
- 语速：输入框左侧控制器的第二个滑杆（0.5×–2×，步进 0.05，持久化于 `localStorage['dsh.fairyVoice.rate.v1']`），对全部提供方统一生效——Web Audio 走 `source.playbackRate`（时间轴按 `buffer.duration / rate` 推进），系统语音走 `utterance.rate`。
- Blink 长句保活：`speechSynthesis` 在 Chrome/Edge 上约 15 秒会停住，播放期间每 6 秒做一次 `pause()/resume()`（`BROWSER_SPEECH_BUMP_MS`），停止/结束时清掉定时器。
- 设置卡片「语音引擎」：切换提供方、编辑其字段、保存后刷新可用性并重新探测 `/status`；可用性在挂载、保存和手动刷新时更新（不轮询）。
