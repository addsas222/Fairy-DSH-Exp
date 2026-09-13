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
| `custom-http` | `url` 合法且 `headersJson` 可解析 | `method url`，请求体由 `bodyTemplate` 插值 | 未知（按 32 kHz 播放） |
| `browser` | 总是可用 | 不合成：`/tts` 返回 409，客户端改用 `speechSynthesis` | — |

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
- 设置卡片「语音引擎」：切换提供方、编辑其字段、保存后刷新可用性并重新探测 `/status`；可用性在挂载、保存和手动刷新时更新（不轮询）。
