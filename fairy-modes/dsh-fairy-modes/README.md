# dsh-fairy-modes

Fairy-DSH 的**会话模式引擎**（双面孔插件）：把五个协作模式（空闲 / 探查 / 建造 / 创造 / 角色扮演）记进会话模式镜像（`$DSH_HOME/fairy-modes/modes.json`），并驱动对应的提示词段落与工具呈现；四站**模式流水线**（扮演→探查→建造→创造→回到扮演）由 `mode_pipeline` 工具推进，进探查站会尝试打开官方 plan 审批闸门。主会话头部的模式 chip 由本包的浏览器一半提供。

> 为什么不是会话日志：`fairy/mode` 对所有 harness 线都是**词表外事件**，而持久化读路径拒绝"未知类型且未带 `ignorable` 标记"的日志——该标记在 0.1.1 / 0.1.6-alpha.1 的 `session.append` 里**无法设置**（信封只透传 `surfaceOp`/`sourceEventSeqs`）。写进去等于让整段日志在每条线上都不可读（2026-09-17 实测：`SessionFormatUnsupportedError … not marked ignorable`）。镜像换掉了这条写入路径；旧日志的折叠读取保留为只读兼容。

## 五种模式

| 模式 | 语义 | 谁实现 |
| --- | --- | --- |
| 极简（Explore&Check） | 探查并定案，不改文件 | 官方 `@deepseek-ai/dsh-plan-mode` 原样复用：`plan/mode` 事件、`plan` 投影、`/plan` 命令、`exit_plan_mode` 工具。本包**不重实现**，chip 只读它的投影并代发 `/plan` |
| `ptc`（Build&Work） | 用 `run_code` 编排脚本系列，一次调用完成多步执行 | 本包：`ctx.tools.presentAs('ptc')` + `fairy:mode-ptc` 段落 + 模式镜像行 |
| `create`（Memory&Dream） | 先 `session_recall` 回忆全部历史；制作/审查 skill 与插件；冗余合并删除 | 本包：`fairy:mode-create` 段落 + `session_recall` 工具 + 模式镜像行 |
| `explore`（探查·只读） | 只读代码/配置/检索，产出可审阅的方案，不改任何文件 | 本包：`fairy:mode-explore` 段落 + 模式镜像行；流水线进站时另外尝试打开官方 plan 闸门 |
| `roleplay`（角色扮演） | 以绑定人格为第一人称对话；去AI味自检（`roleplay_check`）与风格库（`roleplay_style`） | 本包：`fairy:mode-roleplay` 段落 + `dsh-fairy-roleplay` 的工具 |
| `off` | 默认（空闲，不在流水线内） | 本包：撤销以上全部 |

官方极简（plan-mode）与五个 fairy 模式值**正交**：chip 在 plan 生效时优先显示「极简」，两条轴的勾选各自独立。流水线的探查站同时写 `fairyMode=explore` 并（能解析到控制器时）请求 plan 开启，所以批准前后阶段都停在「探查」——离开探查一律走官方 `exit_plan_mode` 审批，本包不替用户关闸门。

## 契约

**模式镜像**：`$DSH_HOME/fairy-modes/modes.json`，形如 `{ "<sessionId>": "ptc" }`（原子写：临时文件 + rename）。读取顺序 = 镜像 → 旧日志折叠 → `off`；fork 是新 session id，因此**不携带**模式（从 `off` 起）。

**旧会话事件（只读兼容）**：`fairy/mode`，载荷 `{ mode }`。新代码不再写入它（见文首说明），仅保留投影折叠与 `loggedMode()` 的回退读取。

**投影**：键 `fairyMode`，`stateVersion: 1`，折叠为 `{ mode }`；带 `wire` 视图，浏览器侧可 `useProjection('fairyMode')`。

**提示词段落**（切换即注册/撤销，`order = getSectionOrder('PLAN_POLICY') + 1`）：

- `fairy:mode-ptc` — `PTC 模式：用 run_code 编排脚本系列，一次调用完成多步执行；先规划命令序列再执行。`
- `fairy:mode-create` — `创造模式：先调用 session_recall 回忆本项目全部历史作为再回答；技能制作：在被扫描的技能根写 SKILL.md；插件制作：运行 node fairy-system/scaffold-plugin.js；每次交付前运行 node fairy-system/skill-audit.js 检查冗余并合并/删除。`
- `fairy:mode-explore` — `探查模式（只读）：只读代码、配置与检索结果，不改任何文件、不跑有副作用的命令。产出是一份可审阅的方案：现状、要改什么、风险与回滚；方案定稿后调用 mode_pipeline advance 进入建造。`
- `fairy:mode-roleplay` — 角色扮演段落：人格身份、时机（沉默优先）、短句口语、去AI味硬约束、设定与记忆、自检与风格库指引。
- `fairy:pipeline` — **常驻**（`order = PLAN_POLICY + 2`，任何模式都在场）：说明四个站点各做什么、什么时候推进、用户指定时以用户为准。

**工具**：`session_recall` 与 `mode_pipeline`（都在每次挂载时注册，与当前模式无关——模式切换不得移动工具的请求目录）。`mode_pipeline` 的动作是 `status | advance | enter | finish`：`status` 只读；推进时按 `PIPELINE_STAGE_STATE` 落 `fairyMode`，探查站另外尝试 `ctx.get('agentPresets')?.serviceFor(agent, 'planMode')?.set(agent, true)` 打开官方闸门（解析不到就回报让用户 `/plan`）；**闸门仍开时不切站**，等 `exit_plan_mode` 批准后再 `advance`，因此 `advanced` 只认 `committed`/`queued`。发行版没有 `dsh-tool-session-query` 行，因此创造模式的"回忆"由本包承担：

| 项 | 内容 |
| --- | --- |
| 参数 | `query`（string，必填，按数据处理，不作检索语法）、`limit`（number，1-10，默认 5） |
| 输出 | `{ results: [{ sessionId, title?, seq?, snippet, updatedAt? }], truncated, note? }`；`updatedAt` 是该会话标题最后更新时刻（尚无标题则省略） |
| 文本呈现 | `• [title] (sessionId) seq N: snippet`，随后是截断/降级说明 |
| 读取路径 | ① `ctx.sessionQuery.searchSessions`（后端全文索引，跨会话排名 + 摘录）；② 同一调用被 `SESSION_QUERY_SEARCH_DISABLED`（`openAt: 'never'`）拒绝时，退化为标题扫描并在 `note` 里给出修复方法；③ 引擎没有搜索方法时同样走标题扫描 |
| 注册方式 | `ctx.inject(['sessionQuery'], c => c.tools.register(createSessionRecallTool(c.sessionQuery)))`——引擎缺席时没有工具，会话代理该做什么就做什么 |

**零 harness 依赖**：`ctx.tools.register()` 收的就是**裸 `ToolDefinition`**（普通 JSON Schema + `execute` + `render`），所以本包直接给出字面定义，不引入 `@deepseek-ai/dsh-tools`——harness 的 `defineTool` 只做两件事：把 DSL 编译成 JSON Schema、加上参数校验；而插件若自带一份 harness 包会因 peer 漂移在加载期崩溃（Node 先解析插件自身 realpath 的依赖）。这两件事在这里内联：

- `parameters` / `output.schema` 与 `defineTool` 对同一 DSL 的编译结果**逐字节相等**（对照脚本已验：同一 DSL 过 harness 的 `defineTool` 后 `deepEqual` 通过）；
- 参数校验用的是注册中心自己的 schema-walk 措辞（`missing required property "query"` / `"query" must be a string` / `"limit" must be a number` / `"limit" must be a finite JSON number` / `"arguments" must be an object`），并带 `code: 'INVALID_ARGS'`，因此被拒的调用与任何内置类型化工具读起来一致。

对照验证（一次性脚本，已删）同时确认：`assertSupportedJsonSchema` 接受两份 schema、`validateJsonSchemaValue` 对真实返回值零违规且能拒掉畸形值、`jsonSchemaToTs` 能渲染出 PTC 模式里 `run_code` 直接调用的 `{ query: string; limit?: number }`。

**服务**：`ctx.fairyMode`（`{ get(agent) → { mode }, set(agent, mode) → 'committed' | 'noop' }`）。preset 必须把它挂在 `isolate: { fairyMode: true }` 组里（每会话私有实例），bridge 经 `ctx.agentPresets.serviceFor(agent, 'fairyMode')` 取到该实例。

**命令**：`/mode explore|ptc|create|roleplay|off`（`commands` 服务缺席时该子行不激活，HTTP 与 chip 仍是唯一切换入口）。

**HTTP**：

| 方法 | 路径 | 请求 | 响应 |
| --- | --- | --- | --- |
| POST | `/fairy-modes/set` | `{ sessionId, mode }` | `200 {ok:true,mode}` / `400` 模式或正文非法 / `422` 会话无法解析出活动 Agent / `503` 未组合 `agent-presets` 或该 preset 未挂本包 / `500` 切换失败 |
| GET | `/fairy-modes/state?sessionId=` | — | `200 {ok:true,mode,plan}` / `422` / `503` |

`plan` 为官方 plan 投影的线形视图 `{ active, pending }`，或为 `null`（未组合 plan-mode）。

## 客户端

- 槽位：`conversation.session.header.utilities`，`{ id: 'fairy-modes-chip', order: 20 }`，DOM 标记 `[data-dsh-fairy-modes-chip]`。
- 标签：`极简` / `探查` / `PTC` / `创造` / `角色` / `空闲`；弹层六项 `探查·极简（官方）`、`探查·只读（流水线）`、`建造·PTC`、`角色扮演`、`创造·回忆`、`关闭`，勾选表示当前生效。
- 数据源：优先 `useProjection('fairyMode')` 与 `useProjection('plan')`；两者缺席时回落到 `GET /fairy-modes/state`，并在**会话切换**与窗口事件 `fairy-modes-changed` 时刷新（不使用定时器）。
- 极简项经 composer 动作发送 `/plan`（已生效时发 `/plan off`）；`inputActions` 不可用时该行不动作，chip 的 tooltip 提示手动输入。
- 设置卡：`settings.section`，`{ id: 'fairy-modes', order: 29, label: '模式' }`，卡体是归一化提问件（`AskSection` + `AskRow` + `AskSelect` + `AskActions`，来源 `fairy-contracts/client-ask-kit.cjs`）：选择只改草稿，点「保存」才写 `localStorage`，状态只用归一化那几句（`已保存。` / `没有需要保存的改动。` / `保存失败：…`），忙时保存按钮与下拉一起锁住；浏览器存储写不进去时报失败，不假装已保存。
- 无设置命名空间：模式是会话状态，不是配置；设置卡里唯一的持久项是浏览器侧的「新会话默认模式」。

## 挂载（宿主侧集成点）

```yaml
# preset（每会话隔离）——行名必须是字面字符串或 preset 内相对路径；
# 子行 id 必须与组 id 不同（同名会让 loader 卡死），详见 PONYTAIL-DESIGN.md。
- id: fairy-modes
  name: cordis:group
  group: true
  isolate: { fairyMode: true }
  config:
    - id: fairy-modes-engine
      name: './plugins/fairy-modes.mjs'   # preset 内 shim → DSH_FAIRY_REPO_ROOT 下的真身

# profile patch（host 平面，提供 chip 的两个端点 + 客户端 bundle）
- id: fairy-modes-bridge
  name: 'dsh-fairy-modes'   # 裸包名；子路径名（如 dsh-fairy-modes/bridge）进不了 boot 图
  inject: [clientModules]
```

`session_recall` 需要部署组合 `ctx.sessionQuery`（base bundle 的 `session-query-sqlite` 行）。`profiles/web` 已把它的 `openAt` 设为 `first-search`；把它设为 `never` 时工具仍可用，只是退化为标题匹配并在结果里说明。

## ponytail 上限与升级路径

- **plan 控制器按名解析**：探查站通过 `agentPresets.serviceFor(agent, 'planMode')` 取官方控制器。harness 的 `serviceForAgent` 遍历全局服务表、按名在**该 agent 的 preset 子树内**查找（`withinFiber(impl.fiber, mount.fiber)`），因此兄弟 realm 里的 plan 控制器可见；其文档也写明这正是“已持有 agent 的调用方按名寻址”的用途（官方 `exit_plan_mode` 同平面读 `ctx.get('userQuestions')`，同一先例）。拿不到（不同组合 / 该 cohort 未挂 plan-mode）时退回“提示用户 `/plan`”，流水线其余行为不变。
- **无 turn 内排队**：`set()` 立即落事件，不复制 plan-mode 的 pending-intent 等待（模式只影响下一次请求组装）。升级路径：若需在运行中的 turn 内叙述模式切换，接入 `agent/pre-step`。
- **无切换叙述消息**：段落本身就是指令，注入用户通知等于每次切换重复一遍。
- **`presentAs` 冲突不回滚**：作用域已声明呈现（preset 行或另一模式实例）时 `presentAs` 抛错，本包 `diagnostics.warn` 后仍记录模式（提示词段落照常生效）。升级路径：与声明方协商单一 owner。
- **`/plan` 走 composer 动作**：chip 不直接调 typert remote，靠 `inputActions.setDraft + submit` 提交官方 slash 命令；无 composer 时该行降级为 tooltip 提示。
- **弹层为普通绝对定位 div**：若头部容器裁剪，升级路径是 portal。
- **投影单元不引入类型依赖**：本仓库为无构建的手写 JS，因此不依赖 `@deepseek-ai/dsh-session-projection` 的运行时类型 —— 投影单元以 `{ key, stateVersion, stateSchema: { parse }, init, apply, wire }` 纯对象实现（注册中心只调用 `.parse`），契约以本 README 与 JSDoc 为准。
- **回忆的降级路径有界**：标题扫描只折叠最近 `SCAN_SESSION_LIMIT`（200）个会话的标题 —— 用索引换全文召回是后端的事，无索引时宁可有界也不做逐会话全文扫描。升级路径：索引常开或改成持久索引文件。
- **镜像索引**：`profiles/web` 用的是 `path: ':memory:'`，索引随进程重建；持久索引文件属升级路径。
- **工具定义是手写的 JSON Schema**：本包不依赖任何 harness 包（唯一依赖是 `dsh-fairy-contracts`），代价是 `parameters` / `output.schema` 与参数校验措辞由本仓库持有；它们的正确性由测试与一次性对照脚本（对 harness 的 `defineTool`/`validateJsonSchemaValue`/`jsonSchemaToTs`）保证。升级路径：若将来允许插件依赖 harness 包，换回 `defineTool`。
- **参数校验只覆盖本工具的形状**：非对象参数、缺 `query`、`query`/`limit` 类型与有限性；注册中心不做这层校验，所以每个自带 schema 的工具都必须自己做（`defineTool` 的包装之所以存在，正是为此）。

## 测试

```bash
pnpm install --ignore-scripts && pnpm test
```

`test/modes.test.js`（镜像读写与日志零写入、重启恢复、旧日志折叠回退、presentAs 互斥与还原、段落注册/撤销、命令解析、工具目录跨模式稳定）、`test/bridge.test.js`（200/400/422/503、plan 视图、冷会话经 session-controller 解析）、`test/client.test.js`（bundle 身份、槽位注册、标签与勾选、POST 载荷与事件、极简命令、无投影回落）、`test/recall.test.js`（零 harness 依赖、裸定义 schema 形状、返回值按 `output.schema` 校验、索引投影、索引禁用/后端缺席的降级、标题扫描上界、参数拒绝与 limit 边界）、`test/pipeline.test.js`（站点映射与环、`mode_pipeline` 四个动作、plan 闸门的解析/排队/降级三态、被挡住时不切站且不误报目标站、`advanced` 只认 committed/queued）、`test/client-contract.test.js`（chip 与设置卡契约：模式清单与术语、设置卡没有裸提问件、新会话默认值经归一化提问件落盘（草稿 → 保存 → 复读）与保存失败上报、会话归属、极简走官方 `/plan`）。
