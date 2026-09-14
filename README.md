# Fairy DSH

Fairy 的 DSH 插件套件（开源发布候选目录）。本目录与任何生产环境
完全独立，不包含个人会话、日志、密钥、缓存、
`node_modules` 或完整游戏语料。

## 目录

- `fairy-contracts/`：跨插件契约与诊断边界
- `browser-dock/`、`balance-meter/`、`fairy-startup/`、`fairy-voice/`、`fairy-visual/`：Fairy 插件
- `fairy-persona/`：人格包引擎（人格文档 + 调色属性 + TTS 绑定的热切换）
- `fairy-modes/`：会话模式引擎（极简 Explore&Check / 探查只读 / PTC Build&Work / 创造 Memory&Dream / 角色扮演；`mode_pipeline` 把四个站点串成流水线）
- `fairy-search/`：搜索枢纽（多后端按设置路由 + 控制界面）
- `fairy-memory/`：长期记忆（GBrain 主用，Mem0 / 自定义 HTTP / 本地 Markdown 备选 + 控制界面）
- `fairy-roleplay/`：角色扮演模式（五模式之一；去AI味检查器 L1-L4 + 风格库 + 控制界面）
- `fairy-system/`：离线检查与验收工具（含 `skill-audit.js` 冗余审计、`scaffold-plugin.js` 插件脚手架）
- `persona-packs/`：内置人格包（fairy、standard）
- `profiles/web/`：独立 Web profile 模板
- `.agent-presets/ponytail/`：精简模式 preset（无仓库外私有资产依赖；ponytail 规则技能按上游 MIT 装在**本机技能根**，不入库——部署时由 `scripts/deploy-live.sh` 同步进 preset 的 `skills/` 槽位）

设计与决策记录见 `fairy-system/PONYTAIL-DESIGN.md`。

## Ponytail 会话模式（部署要点）

启动前设置 `DSH_FAIRY_REPO_ROOT` 指向本仓库；`profiles/web/cordis.patch.yml`
的 `agent-presets` 行已把仓库 `.agent-presets/` 配为发现根，`ponytail`
preset 原地可发现（`dsh --profile web --dump-config` 可核对组合）。

| 模式 | 行为 | 切换 |
| --- | --- | --- |
| 极简 Explore&Check | 只探查与定案，`exit_plan_mode` 审批后才实施 | 会话头模式 chip → 探查·极简，或 `/plan` |
| PTC Build&Work | 工具面切换为 `run_code` 编排脚本系列 | chip → 建造·PTC，或 `/mode ptc` |
| 创造 Memory&Dream | 先用 `session_recall` 回忆历史，再制作/审查技能与插件 | chip → 创造·回忆，或 `/mode create` |

人格在 设置 → 人格 中选择，与语音引擎（设置 → 语音引擎）按人格包原子绑定；
人格包格式与扫描根见 `fairy-persona/dsh-fairy-persona/README.md`。
搜索引擎在 设置 → 搜索引擎 中切换后端（DeepSeek / Exa / Perplexity / 自定义）。
长期记忆在 设置 → 长期记忆 中选择提供方（GBrain / Mem0 / 自定义 HTTP / 本地 Markdown），
并显示每个提供方的可用性原因与当前记忆条数。
语音输入（转文字）在 设置 → 语音输入 中选路线：**本地**用浏览器内 Whisper（音频不出机器）或把
OpenAI 兼容地址指向本机服务（whisper.cpp / faster-whisper / speaches，loopback 免密钥）；**网上**用
浏览器识别、Deepgram、Azure 或任意 OpenAI 兼容云端；另有自定义 HTTP 通用模板。

版本边界：本仓库固定 DSH `0.1.1-rc.2`；跨到 `≥0.1.5-rc.1` 需要走
`fairy-system/upgrade-candidate-preflight.sh` 的升级验收（含前端面孔与
selector 契约复核）。与社区包 dsh-web 的共存分析见
`fairy-system/DSH-WEB-COMPAT.md`。

## 独立测试

需要已安装并固定版本的 DSH CLI、Node.js 和 pnpm。测试时必须使用独立
`DSH_HOME`，不要指向生产目录：

```sh
DSH_HOME="$PWD/.dsh-test-home" ./scripts/test-isolated.sh
```

完整世界观资料、TTS 模型和用户数据应通过本地路径或私有配置注入，
不会随此仓库分发。

## 第三方依赖

第三方包只通过 manifest/lockfile 引用，**不复制其源码**（含 ponytail 技能文本：
它按上游 MIT 条款使用，但只在本机安装、不随本仓库分发，来源与许可见
`THIRD_PARTY_NOTICES.md`）。许可证与来源在 `THIRD_PARTY_NOTICES.md` 中维护。

## 致谢

本项目建立在下列开源工作之上（版本、来源与许可证由 `THIRD_PARTY_NOTICES.md` 统一维护，
此处只列项目与出处，避免两处表格各自漂移）：

**平台与宿主**：DSH / deepseek-harness（[@deepseek-ai/dsh](https://github.com/deepseek-ai/deepseek-harness)、schemastery）——本仓库 pin 的 agent 平台与设置 schema。

**MCP 服务**：[microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp)（浏览器 Dock 的驱动）、[upstash/context7](https://github.com/upstash/context7)（文档检索）。

**运行期依赖**：[honojs/hono](https://github.com/honojs/hono)、[syntax-tree/mdast-util-from-markdown](https://github.com/syntax-tree/mdast-util-from-markdown)、[syntax-tree/mdast-util-gfm](https://github.com/syntax-tree/mdast-util-gfm)、[micromark/micromark-extension-gfm](https://github.com/micromark/micromark-extension-gfm)（fairy-voice 的 Markdown 解析）。

**社区插件**：[Moeblack/dsh-message-edit](https://github.com/Moeblack/dsh-message-edit)、[HanaAyane/dsh-reasoning-effort](https://github.com/HanaAyane/dsh-reasoning-effort)——本仓库只 pin，不复制源码。

**本机安装、不随仓库分发**：[DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail)——ponytail 规则技能组（MIT），按上游条款在**本机**安装使用，不进本仓库、不随部署落位。

**运行期从 CDN 加载的语音引擎**：[hexgrad/kokoro](https://github.com/hexgrad/kokoro)（kokoro-js）、[vits-web 生态的 piper-tts-web](https://github.com/diffusionstudio/vits-web)（含 onnxruntime-web）、[KittenML/KittenTTS](https://github.com/KittenML/KittenTTS)（权重 Apache-2.0）与 [Algiras/kitten-tts-js](https://github.com/Algiras/kitten-tts-js)（社区非官方移植）。

**概念与结构参考**：[Mai-with-u/MaiBot](https://github.com/Mai-with-u/MaiBot)（GPL-3.0）——仅参考 `fairy-roleplay` 的流水线结构（规划器 → 回复器 → 去AI味 → 记忆印象），提示词与词表全部自撰，故本仓库不继承其 GPL 义务；三模式与 `mode_pipeline` 的设计动机来自社区 agent 实践，实现为本仓库原创。

**同源分发**：[addsas222/Fairy-DSH-Exp](https://github.com/addsas222/Fairy-DSH-Exp)（`main`，本机部署源）、[Chengzhibense/Fairy-DSH](https://github.com/Chengzhibense/Fairy-DSH)、[Guzhou2002/Fairy-DSH-Optimized](https://github.com/Guzhou2002/Fairy-DSH-Optimized)。三者的 fork 谱系与同步关系**尚未逐条核实**，此处仅记录其存在。

感谢以上作者与社区。若某处署名或归属有误，请开 issue 指正。

## 许可边界

除文件另有说明外，本仓库中 Fairy-DSH 的原创代码、脚本、测试、配置和
文档按 Apache License 2.0 发布，详见 `LICENSE` 与 `NOTICE`。第三方插件、
依赖及其生成物不在本许可范围内，继续适用各自许可证。

《绝区零》剧情文本、角色资料、官方素材，私有 WORLD CORE、个人语料、会话
数据和运行时密钥均不随仓库发布；本项目不授予相关版权、商标或官方关联权利。
发布前请按 `RELEASE-CHECKLIST.md` 复核分发内容。
