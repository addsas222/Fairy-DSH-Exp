# Third-party notices

本仓库不复制第三方源码，唯一例外是 `.agent-presets/ponytail/skills/`：该目录
再分发 ponytail 技能文本（MIT，见下表「再分发的第三方内容」）。其余第三方依赖
由包管理器或 DSH 宿主安装；它们不在 Fairy-DSH 的 Apache-2.0 原创代码许可范围内，
发布时必须继续保留各自的许可证、版权和 NOTICE 要求。

| 包 | 固定版本 / 来源 | 许可证 | 版权 / 来源 |
| --- | --- | --- | --- |
| `@playwright/mcp` | `0.0.79` · [microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp) | Apache-2.0 | Microsoft；随包附带声明 |
| `@upstash/context7-mcp` | `4.0.2` · [upstash/context7](https://github.com/upstash/context7) | MIT | Upstash；随包附带声明 |
| `dsh-message-edit` | `0.2.3` · [Moeblack/dsh-message-edit](https://github.com/Moeblack/dsh-message-edit) | MIT | Moeblack；随包附带声明 |
| `dsh-reasoning-effort` | `0.6.2` · commit `83bc8c548749d7156a03d11d875d8117e9b5d994` · [HanaAyane/dsh-reasoning-effort](https://github.com/HanaAyane/dsh-reasoning-effort) | MIT | HanaAyane；随包附带声明 |
| `hono` | `4.13.2` · [honojs/hono](https://github.com/honojs/hono) | MIT | Hono contributors；随包附带声明 |
| `@deepseek-ai/schemastery` | `3.18.1` · [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | MIT | DeepSeek；随包附带声明 |
| `mdast-util-from-markdown` | `2.0.3` · [syntax-tree/mdast-util-from-markdown](https://github.com/syntax-tree/mdast-util-from-markdown) | MIT | syntax-tree contributors；随包附带声明（`fairy-voice` 的 Markdown 解析） |
| `mdast-util-gfm` | `3.1.0` · [syntax-tree/mdast-util-gfm](https://github.com/syntax-tree/mdast-util-gfm) | MIT | syntax-tree contributors；随包附带声明 |
| `micromark-extension-gfm` | `3.0.0` · [micromark/micromark-extension-gfm](https://github.com/micromark/micromark-extension-gfm) | MIT | micromark contributors；随包附带声明 |

## 宿主提供的 DSH 包

`@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app` 等由 DSH CLI/profile
宿主提供，不随本仓库 vendoring，也不由本项目重新授权。使用者应按照 DSH
发行包中的许可证和版权文件处理。

## 再分发的第三方内容

| 内容 | 位置 | 许可证 | 版权 / 来源 |
| --- | --- | --- | --- |
| ponytail 技能组 | `.agent-presets/ponytail/skills/ponytail*/SKILL.md` | MIT | DietrichGebert · [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail)；许可证全文见 `.agent-presets/ponytail/skills/ponytail.LICENSE` |

## 运行期从 CDN 加载的第三方引擎（未随仓库分发）

`fairy-voice` 的浏览器内引擎 provider 在**用户浏览器**里按配置的 `moduleUrl`
加载以下包（默认 jsDelivr，钉精确版本；仓库不分发其代码，仅保存默认地址与
许可证信息）：

| 包 | 版本 | 许可证 | 来源 |
| --- | --- | --- | --- |
| `kokoro-js`（内含 `@huggingface/transformers`） | 1.2.1 | Apache-2.0 | hexgrad/kokoro（Kokoro-82M 权重另见其模型卡） |
| `@realtimex/piper-tts-web`（内含 `onnxruntime-web`） | 1.1.1 | MIT | RealTimeX 对 diffusion-studio/vits-web 的 fork（另两个 fork 的 onnxruntime 基址已失效）；Piper 模型 MIT（Rhasspy） |

引擎默认从 HuggingFace 拉取模型/音色；不可达时可在设置里填 `resourceBase`
镜像，或改用其他 provider。

## 本仓库内的本地包

`fairy-contracts`、`dsh-browser-dock`、`dsh-balance-meter`、
`dsh-fairy-startup`、`dsh-fairy-visual`、`dsh-fairy-voice`、
`dsh-fairy-persona`、`dsh-fairy-modes`、`dsh-fairy-search`、`dsh-fairy-memory`、
`dsh-fairy-roleplay` 是本仓库的原创
代码（除其自身依赖外），按根目录 `LICENSE` 和 `NOTICE` 处理。

发布新版本时，应从最终 lockfile 重新核对版本、来源和许可证，并把新增的
第三方依赖补入本表；不能因为依赖被锁定就把它们当作本项目原创内容。

## MaiBot（fairy-roleplay 的规则结构参考）

- 参考对象：**MaiBot**（<https://github.com/Mai-with-u/MaiBot>），GPL-3.0。
- **只参考流水线结构**（规划器 → 回复器 → 去AI味 → 记忆印象），`fairy-roleplay` 的提示词
  文本与词表全部由本仓库自行撰写；不包含其源码或提示词原文的复制。
- 因此本仓库不继承 GPL-3.0 义务；上表列出的运行时依赖仍各自按原许可证处理。

## KittenTTS / kitten-tts-js（fairy-voice 的 `kitten-web` 引擎）

- 模型：**KittenTTS-Nano**（`KittenML/kitten-tts-nano-0.8`），版权归 **KittenML /
  Stellon Labs**，Apache-2.0；上游 <https://github.com/KittenML/KittenTTS>。
- JS 运行时：**kitten-tts-js**（<https://github.com/Algiras/kitten-tts-js>），
  社区**非官方**移植（作者自述"不隶属于、未获 KittenML/Stellon Labs 背书"），
  Apache-2.0。
- 本仓库不复制其源码：引擎在运行时由用户配置的 `moduleUrl` 动态加载，模型由
  该库经 HuggingFace 下载（可用 `resourceBase` 指向镜像）。
