# Fairy DSH

《绝区零》Fairy 的 DSH（DeepSeek Harness）插件套件：把**人格、语音（TTS/STT）、会话模式流水线、搜索枢纽、长期记忆、浏览器 Dock、视觉舞台**做成可独立安装的包，并把「怎么装、怎么验、怎么升级」固化成脚本与门禁。

本目录是**开源发布候选目录**：不含个人会话、日志、密钥、缓存、`node_modules`，也不含完整游戏语料。

---

## 1. 目录

| 路径 | 作用 |
| --- | --- |
| `fairy-contracts/` | 跨插件契约与诊断边界（各包以 `link:` 依赖它） |
| `browser-dock/` | 浏览器 Dock：宿主插件 + 独立 `proxy.cjs` 进程 + 状态桥（驱动 Playwright MCP） |
| `balance-meter/` | 余额指示 |
| `fairy-startup/` | 启动动作（恢复会话选择、按 workspace 就绪开新会话） |
| `fairy-persona/` | 人格包引擎：人格文档 + 调色属性 + TTS 绑定热切换 |
| `fairy-modes/` | 五模式引擎（极简 Explore&Check / 探查只读 / PTC Build&Work / 创造 Memory&Dream / 角色扮演）+ `mode_pipeline` 四站流水线 |
| `fairy-search/` | 搜索枢纽：deepseek / exa / perplexity / 自定义路由 + MCP 片段生成 |
| `fairy-memory/` | 长期记忆：**GBrain 主用**（MCP，按官方 `MEMORY_VERBS_v1`）；mem0 / 自定义 HTTP / 本地 Markdown 备选 |
| `fairy-roleplay/` | 角色扮演：去AI味检查器（L1 词表 → L4 通读）+ 风格库 + 规划/时机/回复规则 |
| `fairy-voice/` | TTS provider 注册表（local-sovits / openai / elevenlabs-ws / kokoro-web / kitten-web / piper-web / browser / custom-http）与 STT 路线 |
| `fairy-visual/` | 视觉舞台（HDD 视觉与身份），客户端产物由 tsdown 生成 |
| `fairy-system/` | 验证/预检/审计工具（`verify-build.js`、`image-manifest.js`、`verify.js`、`check.sh`、`accepted-baseline.js`、`upgrade-preflight.js`、`skill-audit.js`、`scaffold-plugin.js`） |
| `persona-packs/` | 内置人格包（`fairy`、`standard`） |
| `profiles/web/` | Web profile：组合各插件、pin 搜索 provider、接管部署 persona |
| `.agent-presets/ponytail/` | 精简模式 preset（modes 与 memory 的 agent 面 shim；规则技能见下） |
| `.agent-presets/fairy/` | Fairy preset：人格文本 + 语料（`behavior`/`personality`/`canon`/`style`）+ 三个插件行 |
| `scripts/` | `deploy-live.sh`（落位）、`test-isolated.sh`（本地回路） |

设计记录见 `fairy-system/PONYTAIL-DESIGN.md`；与社区包 dsh-web 的共存分析见 `fairy-system/DSH-WEB-COMPAT.md`。

---

## 2. 两种部署形态

| 形态 | 面向 | 关键差异 |
| --- | --- | --- |
| **隔离实例**（推荐，fairy 只能在它上面跑全） | 自用、实验 | 独立 `DSH_HOME`（如 `~/.dsh-fairy`）+ 独立 runtime 安装（本机用 0.1.1-rc.2），不碰日常 GUI |
| **主 profile**（`~/.dsh`） | 日常使用 | 走宿主自己的 runtime（本机已是 0.1.5-rc.2）；fairy 的**客户端面孔**在 0.1.2+ 已不存在（见 §3） |

一键部署（POSIX sh，Windows 上用 `sh` 调用）：

```sh
git clone https://github.com/addsas222/Fairy-DSH-Exp.git fairy-dsh && cd fairy-dsh
sh scripts/deploy-live.sh --home "$HOME/.dsh"          # 或 --home /path/to/DSH_HOME
```

常用开关：`--from-worktree`（用当前工作树，含未提交改动）·`--dry-run`（只打印将执行的命令）·`--skip-install`（只落文件）·`--no-verify`（跳过契约检查）·`--skip-evomap`（CI/无人值守**必须**带上）·`--preserve <路径,…>`（保留镜像里的本机适配）。

脚本做六件事：**① 同步本机资产**（ponytail 规则技能、fairy world-core）→ **② 与源对账**（删掉镜像里「提交已没有」的文件；这是收敛语义的关键，旧版只增不删会留死产物）→ **③ 落位受控文件** → **④ 逐包安装依赖** → **⑤ EvoMap 接入**（可跳过）→ **⑥ 构建契约 + 镜像对账**。

---

## 3. 版本兼容

本仓库的代码按**特征探测**而非版本号分支（`fairy-modes/lib/contract.js`：0.1.1 无 `systemPrompt.getSectionOrder`，0.1.2+ 有）。实测两代 cohort 的差异：

| 面 | 0.1.1-rc.2（本机隔离实例） | 0.1.5-rc.2（本机主环境） |
| --- | --- | --- |
| 宿主插件 / preset / 工具注册 | 可用 | 可用（预设引用的 22 个官方包**全部在位**） |
| 工具呈现模式取值 | `native \| code \| both` | `native \| ptc \| both`（已按特征自动判别） |
| 段落 order 契约 | 字面数字（plan 策略=50） | `systemPrompt.getSectionOrder('PLAN_POLICY')`（=500） |
| **客户端面孔** | `dsh-client-runtime`、`dsh-client-ui-slots`、`dsh-client-ui-primitives` | 三者**已移除**；新面孔为 `dsh-client-modules`、`dsh-client-ui-renderer` 等（47 个 `dsh-client-*`） |

结论：

- **宿主侧（工具、段落、预设发现、world-core 检索）跨代可用**——本仓库新增的部分都属于这一层。
- **客户端侧（设置卡、会话头 chip、侧栏）在 0.1.5 上尚未移植**：10 个插件的 `dsh.client.inject` 仍列旧面孔。**好消息**是 slot API 同名（`slots.inject` / `slots.register` 在新 `dsh-client-ui-renderer` 里同样存在），所以这是**改包名级别**的迁移，不是重写；但仍需真机 DOM 验收。
- 跨代升级到 ≥0.1.5 **必须**走 `fairy-system/upgrade-candidate-preflight.sh` + accepted baseline 验收，不要靠改断言让检查变绿。

---

## 4. Plugins 与 preset

启动前设置 `DSH_FAIRY_REPO_ROOT` 指向本仓库（preset 内的 shim 与 persona 扫描根都用它）：

```sh
export DSH_FAIRY_REPO_ROOT="$DSH_HOME"
dsh --profile web --no-open
```

| 模式 | 行为 | 切换 |
| --- | --- | --- |
| 极简 Explore&Check | 只探查与定案，`exit_plan_mode` 审批后才实施 | 会话头 chip → 探查·极简，或 `/plan` |
| PTC Build&Work | 工具面切换为 `run_code` 编排 | chip → 建造·PTC，或 `/mode ptc` |
| 创造 Memory&Dream | 先用 `session_recall` 回忆历史，再制作/审查技能与插件 | chip → 创造·回忆，或 `/mode create` |

设置入口：**人格**（与语音引擎按人格包原子绑定）、**语音引擎**（TTS provider 注册表）、**搜索引擎**（DeepSeek / Exa / Perplexity / 自定义）、**长期记忆**（GBrain / mem0 / 自定义 HTTP / 本地 Markdown，显示各提供方可用性原因与条数）、**语音输入**（本地浏览器内 Whisper，或把 OpenAI 兼容地址指向 loopback 服务；也可用云端）。

### 4.1 ponytail 规则技能（不入库，部署时同步）

规则技能是上游 MIT 文本（DietrichGebert/ponytail），**不随仓库分发**。`deploy-live.sh` 从本机技能根同步进 preset 的 `skills/` 槽位：

```
源优先级：$DSH_FAIRY_SKILLS_DIR > ~/.omp/agent/skills/_ponytail-vendor > ~/.omp/agent/skills
只取 ponytail* 目录 + NOTICE/LICENSE；找不到就跳过（preset 仍可用）
槽位在 image-manifest 的跳过策略内 → 既不删也不报，避免「同步→prune→再同步」抖动
```

### 4.2 fairy preset 的世界知识（借用官方游戏文本）

`.agent-presets/fairy/` 自带语料（`behavior` 规则 334 KB、`personality` 55 KB、`canon`、`style`）与三个插件行：

- `fairy-core-runtime` / `fairy-safety-gate`：优先加载**私有 runtime**（`runtime/index.js` 等，不在公开仓库）；缺失时走**降级模式**——用自带语料编译一段系统提示速查 + 保守风险闸门。
- `fairy-world-core`：注册 `fairy_world_lookup` 工具，按需检索本机 `world-core/` 行式索引（从《绝区零》官方 TextMap 提取，游戏 3.2.0，3 万+ 条，每条带原始文本键作证据）。

`world-core/` 由 `.gitignore` 挡住并在跳过策略内：**不进仓库、不随部署分发**（版权归 miHoYo/HoYoverse），部署时从本机 clone 同步。

---

## 5. 测试

需要已安装的 DSH CLI、Node.js 与 pnpm。**测试必须使用独立 `DSH_HOME`**，不要指向生产目录：

```sh
DSH_HOME="$PWD/.dsh-test-home" ./scripts/test-isolated.sh   # 自足：逐包装依赖 → 逐包测试 → profile → 冒烟
node --test --test-timeout=45000 fairy-system/test/*.test.js
```

包测试的前提是**依赖已逐包装好**：clone 里没有 `node_modules`，而各包的 `link:` 依赖（`dsh-fairy-contracts`）不会自动就位；直接跑会报 `ERR_MODULE_NOT_FOUND`。两条正确路径：在部署镜像里跑（依赖已装），或先 `pnpm install --frozen-lockfile --ignore-scripts`。

`fairy-system/test/` 里比较「当前 live 布局」的用例需要 `DSH_HOME` + `DSH_OFFICIAL_PACKAGE` / `DSH_OFFICIAL_RUNTIME` 指向已安装的官方 runtime；缺这两个旋钮时它们没有比较对象（不是断言放宽）。纯 Windows 机器上 `verify.js` / `check.sh` 依赖 macOS live 布局，不适合作为本地验证入口。

---

## 6. 两道门禁

```sh
DSH_HOME=/path/to/home node fairy-system/verify-build.js                  # 构建契约：10 包，exit 0
node fairy-system/image-manifest.js check --repo . --home /path/to/home    # 镜像 vs 源：三类差异
```

- `verify-build.js` 查 manifest 身份、产物新鲜度与禁用字符串（**只查「该有的在不在」**）。
- `image-manifest.js check` 报 **extra / missing / drifted** 三类差异并以 exit 1 判决，`prune` 负责收敛。这是唯一会看「多出来的文件」的门禁——上游删过的死产物只有它能发现。
- 本机适配（例如未装 Chrome 时 `cordis.patch.yml` 改用 `msedge`）走 `--preserve <路径>`，检查会把它列在 `allowed` 而不计差异。**不要**靠改断言让门禁变绿。

预设健康检查（发现器的真实判定，避免「能启动但选不中」）：服务运行时 POST `agentPreset.list` 到 `/api/agentPreset.list`，期望 `standard/code/minimal/cordis` 为 `system`、`ponytail` 与 `fairy` 为 `user`。

---

## 7. 排障

- **实机看到旧行为**：`$DSH_HOME` 下是各包的**一份副本**，改完包必须重新落位再起服务。客户端 bundle 按请求 + rev 现场读取，文件一换即生效，无需重启。
- **镜像与提交不一致（半成品镜像）**：`image-manifest.js check` 定位 → 重跑 `deploy-live.sh`（第 ② 步对账会先删多余文件）。
- **`fairy` 预设选不中**：检查 preset 行名是否为**字面字符串**（发现器的 `entryListProblem` 要求 name 是字符串；`!!js` 会让整个 preset 判 BROKEN），以及 `DSH_FAIRY_REPO_ROOT` 是否导出。
- **浏览器 Dock 的「在外部浏览器接管一次」没反应**：Windows 走 `cmd /d /s /c start "" "<浏览器>" "<url>"`；浏览器由 `DSH_FAIRY_HANDOFF_BROWSER` 选（空=系统默认）。两个已实测的坑：URL 必须显式加引号（含 `&` 的查询串会被 cmd 拆开）、浏览器路径含空格必须加引号（否则被 `start` 的标题槽吞掉）。
- **隔离实例启动器报 `Test-Path … 参数是空值`**：`.ps1` 必须是 **UTF-8 with BOM**。Windows PowerShell 5.1 对无 BOM 的 `.ps1` 按 ANSI 解码，中文注释误码后会吃掉 `$Runtime = …` 赋值。
- **构建契约报「manifest 比产物新」**：只对**有构建脚本**的包生效；跑该包 `pnpm bundle`（fairy-memory：`node scripts/bundle.mjs`）重建。
- **行尾**：`.gitattributes` 固定 `eol=lf`，`profiles/web/patches/*.patch` 另标 `-text`（其哈希被 pin）。
- **Windows**：`bash` 可能被 WSL 抢占 → 用 `sh`；目录链接用 junction；权限位断言各包已按平台跳过。

---

## 8. 第三方依赖与致谢

第三方包只通过 manifest/lockfile 引用，**不复制其源码**；版本、来源与许可证统一在 `THIRD_PARTY_NOTICES.md` 维护（本机安装的 ponytail 规则技能、借用的《绝区零》官方文本也在其中登记）。

**平台与宿主**：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（DSH 与 schemastery）。
**MCP 服务**：[microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp)、[upstash/context7](https://github.com/upstash/context7)。
**运行期依赖**：[honojs/hono](https://github.com/honojs/hono)、[syntax-tree/mdast-util-from-markdown](https://github.com/syntax-tree/mdast-util-from-markdown)、[syntax-tree/mdast-util-gfm](https://github.com/syntax-tree/mdast-util-gfm)、[micromark/micromark-extension-gfm](https://github.com/micromark/micromark-extension-gfm)。
**社区插件**：[Moeblack/dsh-message-edit](https://github.com/Moeblack/dsh-message-edit)、[HanaAyane/dsh-reasoning-effort](https://github.com/HanaAyane/dsh-reasoning-effort)（只 pin，不复制源码）。
**本机安装、不随仓库分发**：[DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail)（MIT 规则技能）、[dimbreath/ZenlessData](https://git.mero.moe/dimbreath/ZenlessData)（《绝区零》官方文本，版权归 miHoYo/HoYoverse）。
**CDN 语音引擎**：[hexgrad/kokoro](https://github.com/hexgrad/kokoro)、[vits-web](https://github.com/diffusionstudio/vits-web)（piper-tts-web）、[KittenML/KittenTTS](https://github.com/KittenML/KittenTTS)、[Algiras/kitten-tts-js](https://github.com/Algiras/kitten-tts-js)。
**概念与结构参考**：[Mai-with-u/MaiBot](https://github.com/Mai-with-u/MaiBot)（GPL-3.0，仅参考 `fairy-roleplay` 的流水线结构；提示词与词表全部自撰，故不继承其 GPL 义务）。

感谢以上作者与社区。若署名或归属有误，请开 issue 指正。

---

## 9. 许可边界

除文件另有说明外，本仓库中 Fairy-DSH 的原创代码、脚本、测试、配置和文档按 **Apache License 2.0** 发布（见 `LICENSE` 与 `NOTICE`）。第三方插件、依赖及其生成物不在本许可范围内，继续适用各自许可证。

《绝区零》剧情文本、角色资料、官方素材、私有 WORLD CORE、个人语料、会话数据和运行时密钥**均不随仓库发布**；本项目不授予相关版权、商标或官方关联权利。发布前请按 `RELEASE-CHECKLIST.md` 复核分发内容。
