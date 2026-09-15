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

## 软兼容面（同 cohort 前提下实测为干净）

- 设置命名空间零冲突：dsh-web 用 `pet`/`doctor`/`task-board`/`dsh-ssh`/`dsh-usage`
  /`dsh-market-*`;Fairy 全部使用 `fairy-*`。
- 槽位仅共享两个 list 槽，且 id/order 不相交：`settings.section`(dsh-web 的
  `web-ui-plugins` order 110、`pet` order 130;Fairy 的 `fairy-persona` 25、
  `fairy-search` 28、`fairy-voice-brain` 30、`fairy-voice-engine` 31、`fairy-voice-stt` 32、
  `fairy-memory` 33、`fairy-roleplay` 34）与
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
