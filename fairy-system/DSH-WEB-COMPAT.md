# dsh-web 兼容面分析（2026-09-13,dsh-web @ 0.3.21)

对象：[zhu1090093659/dsh-web](https://github.com/zhu1090093659/dsh-web)——DSH Web
的社区插件聚合包（任务看板、移动远程、SSH、Git 图谱、皮肤、创意工坊），经官方
profile 机制挂载（`dsh plugin --profile web add @linxin666/dsh-web-all@latest`)。

## 版本边界（硬约束)

| | Fairy-DSH | dsh-web |
| --- | --- | --- |
| DSH 固定 | `0.1.1-rc.2`(capability-matrix.json + 官方 runtime SHA-256) | `>=0.1.5-rc.1`(`packages/dsh-web-all/package.json` 的 `dsh.engines.dsh`) |
| 客户端面孔 | 10 个插件 manifest 注入 `@deepseek-ai/dsh-client-runtime` | 0.1.2+ 队列已删除该面孔（实测:本机安装的 0.1.2-rc.1 `@deepseek-ai/` 下已无 `dsh-client-runtime`,仅 41 个 `dsh-client-*` 新面孔），改注入 `dsh-client-ui-renderer` / `dsh-client-store` / `dsh-api-*-controller` |

两包分居 0.1.2 客户端面孔切换线两侧，**同一 profile 目前不能同时运行**。
兼容的前置条件是把 Fairy-DSH 的官方运行时固定升级到 ≥ 0.1.5-rc.1，走仓库既有
的升级流程（`fairy-system/upgrade-candidate-preflight.sh` + accepted baseline
验收）。这不是本优化能代为决定的：官方 UI 的 slot/selector/ARIA 契约在 0.1.5
可能已漂移，`fairy-visual` 的 DOM 适配层需要按新 capability matrix 重新验收。

### 底座线（`DSH_FAIRY_BASE`）

| 线 | 运行时 | 状态 |
| --- | --- | --- |
| `011` | 0.1.1-rc.2 | 长期运行线：capability matrix、runtime SHA-256、accepted baseline 与全部门禁都以它为准 |
| `015` | 0.1.5-rc.1 | 可安装/可启动（`.dsh-test-home-015` 为对照镜像） |
| `016` | 0.1.6-alpha.1 | 最新非稳定线（2026-09-17 纳入）：可安装/可启动；门禁不覆盖，UI 契约未重新验收 |

015/016 的共同点：底座自带 `@deepseek-ai/dsh-web-fetch-http`，profile 的
`fairy-web-fetch-http` 行必须禁用（行条件见 `profiles/web/cordis.patch.yml`）——
未禁用会以 `WEB_DUPLICATE_PROVIDER` 在启动期失败（0.1.6-alpha.1 实测）。

### 0.1.6 客户端面（已落位，2026-09-17）

0.1.6 的客户端模块面去掉了 `@deepseek-ai/dsh-client-runtime`（新面为
`dsh-client-store` / `dsh-client-resources` / `dsh-client-ui-renderer` 等；
`ctx.slots` 由 `dsh-client-ui-renderer` 提供，**API 与旧面相同**）。Fairy 自己
的 10 个客户端 bundle 在该面上**无需改动**即可 apply（实证：client 侧
`DSH_FAIRY_LOG … "surface":"client","outcome":"success"`）；注入清单里残留的
旧面名字不会被解析，但也不会阻塞条目激活。

真正的阻塞者是**第三方插件** `dsh-message-edit@0.2.3`：它的客户端
`require("@deepseek-ai/dsh-client-runtime/client")`（0.1.6 无此模块）导致该
条目激活失败，而宿主会因"1 entry did not activate"**不组装整个 web UI**——
症状是白屏 + `Failed to load plugins`，Fairy 的 dock/主视觉没有可挂载的 DOM。

修复：`profiles/web/patches/dsh-message-edit@0.2.3.patch` 的 **client.js hunk**
把该 require 改为「先 `@deepseek-ai/dsh-client-store`，抛错则回退旧面」——
两条底座线因此都能用（0.1.1 走回退、0.1.6 走新面）。改补丁后须重算
`pnpm-lock.yaml` 的 `patchedDependencies` 哈希（`pnpm install --lockfile-only`
或直接 `pnpm install`）。验证：两线分别起 `--profile web`，页面应出现
`[data-dsh-fairy-composer-dock="true"]` 与 `#dsh-fairy-root`。

已知残留（不阻塞 Fairy）：`dsh-reasoning-effort` 的客户端把条目注册进
`conversation.input.model` 且未声明 `remote.session` 依赖，在 0.1.6 上该 slot
条目抛 `cannot get property "remote.session" without inject`（模型行控件退化，
其余 UI 正常）。修法同型：补它的 inject/external 声明——需两线同验后再动。

## 软兼容面（同 cohort 前提下实测为干净）

- 设置命名空间零冲突：dsh-web 用 `pet`/`doctor`/`task-board`/`dsh-ssh`/`dsh-usage`
  /`dsh-market-*`;Fairy 全部使用 `fairy-*`。
- 槽位仅共享两个 list 槽，且 id/order 不相交：`settings.section`(dsh-web 的
  `web-ui-plugins` order 110、`pet` order 130;Fairy 的 `fairy-persona` 25、
  `fairy-search` 28、`fairy-modes` 29、`fairy-voice-brain` 30、`fairy-voice-engine` 31、
  `fairy-voice-stt` 32、`fairy-memory` 33、`fairy-roleplay` 34、`dsh-fairy-visual` 45、
  `dsh-fairy-mascot` 46、`dsh-fairy-identity` 47、`dsh-fairy-workshop` 48）与
  `sidebar.footer.action`(balance-meter order 0)。
- Fairy 独占槽 dsh-web 从不占用：`conversation.session.header.utilities`（模式
  chip、人格 chip)、`conversation.input.left`、`conversation.chat.assistant-actions`、
  `shell.overlay`。

## 化妆级共存风险（同 cohort 后仍需注意）

1. `dsh-pet` 的桌宠以 `z-index: 2147483000` 固定在 body 级，位于 fairy-visual
   的 shell.overlay 舞台之上；同时启用时宠物会浮在 Fairy 动画层上。
2. `dsh-web-all` 的响应式 CSS(`data-dsh-compat=responsive`,≤768px）会给
   session-header utilities 区加 `max-width: 42vw` 与 44px 按钮——我们的两个
   chip 在该区域，窄屏下会被压缩；chip 自身已定 `max-width` 容忍。
3. `dsh-web-settings` 的设置导航 CSS 假定恰好 8 个导航格；Fairy 的设置卡会
   改变格子数，触发其回退路径（其设计如此，无需动作）。
4. `dsh-preset-center` 与 dsh-fairy-persona 都管理 `$DSH_HOME/.agent-presets`
   发现根；职责不同（preset 组合 vs 人格文档包），无写冲突。

## 升级后的一条命令组合验证

```sh
dsh plugin --profile web add @linxin666/dsh-web-all@latest
```

随后按 `fairy-system/BROWSER-EVIDENCE-MATRIX.md` 复核 chip 区、设置卡、
mascot 舞台与 pet 层的视觉关系。

## 本仓库新插件的暴露面

`fairy-persona` / `fairy-modes` / `fairy-search` 的 `dsh.client.inject` 沿用
0.1.1 面孔名（与既有 fairy 插件一致）。跨到 ≥0.1.5 时它们与既有插件一起需要
面孔清单迁移——这是升级验收的一部分，不是本分支可代办的。

另：本分支实测 0.1.1 上 `agent-presets.roots`（配置发现根）不参与 roster
（用户根 `$DSH_HOME/.agent-presets` 生效），因此部署走用户根暂存；
0.1.2+ 未验证。

## 结论

Fairy-DSH 本分支无需改动代码：所有新插件只占用官方授权槽位与 `fairy-*`
命名空间，与 dsh-web 无硬冲突；唯一的真实边界是 DSH 版本（0.1.1-rc.2 vs
≥0.1.5-rc.1)，升级决策与验收属于仓库的既有升级流程。
