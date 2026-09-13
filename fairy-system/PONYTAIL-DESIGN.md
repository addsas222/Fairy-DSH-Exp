# Ponytail 优化设计（2026-09-13)

标准：Ponytail 规则集（skills/ponytail,github.com/DietrichGebert/ponytail),
强度 full:7 级懒解阶梯——能复用不新造，能 stdlib/平台不依赖，能一行不五十行。
`ponytail:` 注释标记有意为之的上限与升级路径。

## 现状审计（精简对象)

| 对象 | 问题 | 处置 |
| --- | --- | --- |
| `.agent-presets/fairy/agent.cordis.yml` | 依赖私有 runtime 行(`runtime/*`,在 .gitignore 内,发布树缺失);且行名是 `!!js` 表达式 → discovery 判 broken、picker 不可选。persona 行本身用的是本 cohort 的 `config.text`(0.1.1 合法;0.1.5 改为 prefix/suffix) | 公开入口为 `ponytail` preset;fairy preset 属私有部署资产,迁移到新 cohort 需改写 runtime 行与 persona 键 |
| `fairy-startup` | host apply 为空操作,但 lib/client.js 承担真实启动动作(sessions.clear / workspaces.startSession,verify.js:349 钉死)且验证链全量引用 | 保持完整挂载;不是简化对象 |
| `fairy-voice` | TTS 硬编码单一本地 GPT-SoVITS(127.0.0.1:9880)；音色与人格无绑定 | 抽象 provider 注册表；人格包绑定音色 |
| 人格资产 | 单一人格,语料 JSON 与 prompt 静态耦合 | 人格包(pack)目录化,可切换;tone 属性渲染进人格文本 |
| 模式 | 无模式概念；官方 plan/ptc 分散 | 统一三模式引擎 + 主会话显示 |
| 搜索 | `tool-web` 已在 preset 但 `fetch:false`;provider 固定 deepseek-official，无控制界面 | `fetch:true`;search-hub 元 provider + 设置卡 |

## 复用清单（阶梯第 2 级，不重造）

- 探索/计划：`@deepseek-ai/dsh-plan-mode`(`plan/mode` 事件、`plan` 投影、`/plan` 命令、`exit_plan_mode` 工具）原样复用 = 极简模式（Explore&Check)。
- PTC:`ctx.tools.presentAs('ptc')` 可在 agent 作用域运行时调用、返回 disposer、未声明 mode 的作用域才可切换 ⇒ 新 preset 不挂 `tool-presentation` 行，由模式引擎按会话切换。
- 回忆：`dsh-tool-session-query` 的 `session_search`/`session_event_search` 覆盖"回忆所作所为"；preset 增加该行。
- 搜索：`ctx.web.registerSearchProvider` + base bundle 已挂 `web-search-deepseek`(DEEPSEEK_API_KEY 同源）+ `web-fetch-http`;`web` 行 `searchProvider` 可 pin。
- 人格行：`dsh-persona` 是 scope-only;`ctx.systemPrompt.section()` 同名作用域覆盖、dispose 还原、`system-prompt/change` 事件 ⇒ 会话内热切换人格文档合法。
- 技能：skill = SKILL.md 目录包；写入被扫描根（`.dsh/skills/` 或 preset `skills/`)即上线；`ctx.skills` 分层合并。
- 客户端：双面孔插件（node 半 + browser 半）,`window.__ModuleLoader__.load({id, factory})`,React 经 `ctx.slots.register` 入 SlotMap,RPC 走 Typert Remote。Fairy-DSH 现有用法与该契约字节兼容。
- 模式注册表：官方已刻意删除通用 mode 注册表（2026-07-22 Agent Note)。新模式 = 自有 bespoke 包：session 事件 + 投影键 + prompt section + 命令 + 工具。

## 新架构

```
.agent-presets/ponytail/            精简 preset(本优化的入口)
  agent.cordis.yml                  无悬空引用;persona 文本独立成文件引用
  preset.yml                        name: Ponytail
  skills/                           随 preset 分发的 ponytail 规则技能(soft-copy 自外部规则集,标注来源与 MIT)
persona-packs/fairy/                内置人格包(从 .agent-presets/fairy 提炼)
  persona.yml                       id/name/promptFile/tone/voice 绑定
  prompt.md                         人格文档(原 persona text)
  tone.json                         调色属性(语域/幽默密度/称呼策略);由引擎渲染成
                                    追加在人格文档后的运行时约束段
fairy-persona/dsh-fairy-persona/    新人格引擎插件(双面孔)
fairy-modes/dsh-fairy-modes/        新模式引擎插件(双面孔)
fairy-search/dsh-fairy-search/      新搜索枢纽插件(双面孔)
fairy-voice/dsh-fairy-voice/        重构:provider 注册表
fairy-system/skill-audit.js         技能/插件冗余审计(create 模式消费)
profiles/web/cordis.patch.yml       组合新插件;tool-web fetch:true
```

### 人格切换（文档 + 语音原子绑定）

人格包 = 目录：`persona.yml` + `prompt.md` + `tone.json` + 可选 `voice.ref` 资产。
扫描根：`$DSH_HOME/personas/`（用户）+ 仓库 `persona-packs/`（内置）。

```yaml
# persona.yml
id: fairy
name: Fairy
prompt: prompt.md          # 相对包目录
tone: tone.json            # 调色属性:register 权重、幽默密度、称呼策略
voice:                     # TTS 绑定:切换人格即原子切换
  provider: local-sovits   # local-sovits | openai | edge | browser | custom-http
  # provider 各自的配置键,见 fairy-voice provider 契约
```

- host 服务 `fairyPersona`:`list()` / `active(agent?)` / `select(agent, id)`。
- select:agent 作用域内 dispose 旧 persona section、以同名 `PERSONA_PREFIX_SECTION` 重注册新文档（作用域覆盖全局）,emit `fairy-persona/change`;fairy-voice 监听并应用 `voice` 绑定到该会话的 TTS 配置。
- 设置命名空间 `fairy-persona`:`{ defaultPack, sessions: { [sessionId]: packId } }`。
- client:设置卡（包选择 + 预览）+ 会话头 chip 显示当前人格；切换走 Typert Remote。

### TTS provider 注册表（允许所有接入方式）

```ts
interface TtsProvider {
  id: string                                    // local-sovits | openai | edge | browser | custom-http
  available(config): Promise<boolean>
  stream(text, config, signal): Promise<AsyncIterable<Uint8Array> | { clientSide: true, utterance: string }>
}
```

内置：`local-sovits`（现状搬迁）、`openai`(POST {baseURL}/audio/speech，兼容 OpenAI/鱼/其他同形 API)、`browser`（客户端 SpeechSynthesis，零服务端）、`custom-http`(URL/方法/头/正文模板，`{{text}}` 插值）。`edge` 以 custom-http 模板预置形式给出（不新写协议客户端）。
`ponytail:` 上限——自定义 HTTP 模板仅支持 JSON 正文与静态头；流式 SSE 解析属升级路径。
`/fairy-voice/*` 既有端点路径与响应形状不变（client 兼容）；新增 `/fairy-voice/providers`（列出）与 provider 配置读写进 `fairy-voice` 设置命名空间。

### 三模式引擎（主会话显示）

| 模式 | 语义 | 实现 |
| --- | --- | --- |
| 极简 Explore&Check | 探查并制定方案，不改文件 | 复用 plan-mode;chip 读 `plan` 投影；切换 = 发 `/plan` 命令 |
| PTC Build&Work | 执行系列脚本（run_code 编排） | `fairyMode` 服务 `set(agent,'ptc')` → `ctx.tools.presentAs('ptc')`（持 disposer)+ prompt section + `fairy/mode` 事件 + `fairyMode` 投影 |
| 创造 Memory&Dream | 回忆一切作为；制作/审查 skill 与插件；冗余合并删除 | 同上服务 `set(agent,'create')` → prompt section（强制先用 session_search 回忆、技能/插件脚手架指引、运行 skill-audit)+ 事件 + 投影 |

- 服务隔离：`isolate: { fairyMode: true }`，每会话私有控制器（仿 plan-mode)。
- ptс 与 create 互斥（同一枚举）;plan 独立正交，chip 组合显示。
- 命令：`/mode ptc|create|off`(host 命令）;chip 点击走同一 Remote。
- 主会话显示：client 插件在会话头（`sessionHeaderUtilities` 槽区，按 capability-matrix 契约）渲染模式 chip + 人格 chip；模式色按 `mode-theme.js` 既有机制扩展。

### 搜索枢纽（快捷接入 + 控制界面 + 主会话展示）

- profile:`web` 行保持 `searchProvider: deepseek-official` 为默认；新增 `fairy-search` 插件注册元 provider `fairy-search-hub`，读设置命名空间 `fairy-search` `{ provider, keys: { exa?, perplexity?, tavily?, brave? }, mcpNote }` 在请求时路由到对应后端（deepseek-official / exa / perplexity / 通用 POST 模板）。
- 控制界面：设置卡（provider 下拉、key 输入、连通性测试按钮、MCP 服务器快速说明）。主会话展示：复用 tool-web 既有 `WebSearchResultView` 卡片，不新写展示层。
- `ponytail:` 上限——MCP 服务器增删属 loader 行变更，需重启；设置卡只生成可粘贴的 patch 片段，不做热挂载。

### 冗余审计（create 模式消费）

`fairy-system/skill-audit.js`:
- 输入：技能根（preset skills/、`.dsh/skills/`、`$DSH_HOME/skills/`)+ profile/preset 插件行。
- 技能相似度：name+description 的 token Jaccard ≥ 0.6 报 merge 候选；frontmatter `name` 冲突报重复。
- 插件冗余：同名 id 多行、同服务多 provider、disabled 行。
- 输出：`<tag> <what>. <replacement>. [path]`(ponytail-audit 格式）,merge/delete 候选清单。
- 一个可运行自检（`node fairy-system/skill-audit.js --self-test`)。

### dsh-web 兼容

- 维持 capability-matrix.json 的 selector/ARIA/slot 契约为唯一 DOM 事实源；新 UI 只占用契约内槽区。
- dsh-web(zhu1090093659）克隆落地后：比对其 dist 的 slot/ARIA 与本矩阵，差异进 `fairy-system/verify-build.js` 的兼容检查；若它只是官方 web 的再打包，则零改动，仅文档记录。

## 验证

- 既有：`scripts/test-isolated.sh` / `fairy-system/check.sh` 全量。
- 新增各包：`node --test <pkg>/test/*.test.js`，只测可观察契约（persona 切换事件与 section 替换、presentAs 互斥与 disposer 还原、provider 路由、audit 候选判定）。
- 冒烟：pnpm 安装 profile 后 `dsh --profile web` 组合成功（loader 无 broken 行）。

## 0.1.1 运行时契约（实测钉死,2026-09-13)

本轮在 dsh `0.1.1-rc.2` 实机(本地 0.1.2-rc.1 交叉验证)逐项取得以下契约;
违反任一项会在会话创建时静默卡死或 UI 缺失:

1. **preset 行名必须是字面字符串**。`discovery.entryListProblem` 不接受 `!!js`
   表达式名(判为 "names no plugin"),且包名只从 harness 安装解析。本仓库
   插件因此经 **preset 内 shim**(`.agent-presets/ponytail/plugins/*.mjs`)加载:
   shim 在 preset 内(相对路径恒可解析),用 `DSH_FAIRY_REPO_ROOT` 动态导入真身
   (顶层 await 在 `.mjs` 中合法,`.js` 会被判 CJS 而失败)。
2. **组 id 必须与子行 id 不同**。同名会让 cordis loader 的 entry 自我为父,
   `_disabled()` 的父链 while 循环把事件循环同步卡死(CPU 100%,所有 API 挂起)。
   本节由 `--inspect` + CDP 采样定位:`disabledOf → _disabled → update` 热栈。
3. **profile 行名必须是裸包名**。`clientModules` 扫描按行名解析包的 `dsh.client`
   清单;`dsh-fairy-modes/bridge` 这类子路径名会让客户端 bundle 进不了 boot 图
   (槽位 UI 不渲染且无报错)。因此 fairy-modes 包默认导出 = host 桥面,
   agent 面在 `./engine` 子路径(preset shim 走文件路径,不受影响)。
4. **0.1.1 的 section 契约是字面 order**。无 `systemPrompt.getSectionOrder`:
   官方 plan:policy = 50 → 模式段用 51;人格段是单一 `deployment:persona`
   (order 0),同名跨层注册会抛错(system-prompt 拒绝),故人格引擎保留
   `fairy:persona-prefix` 回退名 —— 这也是运行时可用的实际路径。profile 的
   system-prompt 行是**整段 config 替换**,部署人格键被替换后为空,因此模型
   只看到人格包文本,不存在旧人格与包文本叠加。
4b. **工具呈现取值随 cohort 改名**。0.1.1 的 tools 模式联合是
   `native|code|both`(code-only 指令要求恰为 `code`),0.1.2+ 改为
   `native|ptc|both`。fairy-modes 以 `getSectionOrder` 是否存在做代际探测
   (存在→`ptc`+501;缺失→`code`+51),两代各有单测。
5. **不依赖 harness 子包做独立安装**。`@deepseek-ai/dsh-tools` 在插件自有
   node_modules 中会解析出漂移的 peer 集合(如 dsh-llm 缺 `CallId`、dsh-session
   缺 `isJsonValue`),加载即崩;`session_recall` 因此改为手写原生
   `ToolDefinition`(纯 JSON Schema),零 harness 依赖(与 defineTool 编译产物
   deep-equal 已证)。
6. **preset 发现**:本 cohort 的用户根 `$DSH_HOME/.agent-presets` 生效;
   配置根(config.roots)实测不参与 roster。故 ponytail preset 由
   `scripts/test-isolated.sh`/启动器**复制**进用户根。readdir 的
   `Dirent.isDirectory()` 对链接/junction 为假,链接形态会被跳过,必须复制。
7. **人格→语音绑定**为事件级联(异步):`select` 返回后语音设置在同一秒内落盘;
   测试时需容忍该时序(persona chip 与语音引擎设置卡均可在 UI 复核)。

已实测通过的端到端链路(0.1.1-rc.2,dsh web profile):
`session.create(ponytail)` 356ms;`/fairy-modes/set|state`(ptc/create/off 双向);
`fairyMode` 投影;`/fairy-persona/list|select` → `fairy-persona/change` →
`/fairy-voice/provider-config` 双向切换(standard→browser,fairy→local-sovits);
`/fairy-voice/providers`(四提供者可用性);`/fairy-search/state`;
`/fairy-persona/list`;主会话 header utilities 三 chip 渲染(模式显示 PTC、
人格显示 Fairy)。

