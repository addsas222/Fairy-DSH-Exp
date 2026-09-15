# 外部 agent provider（Codex / Claude Code 这类）启用 Runbook

> 体检工具：`node fairy-system/agent-providers.mjs [--home <DSH_HOME>] [--json]`
> 结论口径：**四环闭合**才算可用；任一环缺失的表现都是「**不激活**」——不报错，只是工具不出现。

## 1. 四环是什么

| 环 | 含义 | 断了会怎样 |
| --- | --- | --- |
| bundle | profile 里装了 `@deepseek-ai/dsh-subagent-<id>`，且版本与本机核心**同线** | 行不激活（缺包）或装上也不激活（异线） |
| 宿主行 | `profiles/web/cordis.patch.yml` 里摆了该 provider 的 provider 行 | provider 服务不存在，行不激活 |
| 原生 CLI | 产品自己的命令行在 PATH 上并已登录（provider 是**驱动**它，不是替代它） | 行激活后一调用就失败 |
| preset 行 | 某个 preset 有 `tool-subagent-<id>` 且**未被 `disabled` 挡住** | 工具不出现 |

## 2. 现状基线（核对日期 2026-09-15）

```
core: dsh-subagent @ 0.1.1-rc.2
codex        bundle ❌ / 宿主行 ❌ / CLI ✅ codex-cli 0.153.4 / preset 行 ✅ fairy-full(disabled)
claude-code  bundle ❌ / 宿主行 ❌ / CLI ❌                    / preset 行 ✅ fairy-full(disabled)
观察名单（本机 CLI 在、DSH 侧无 bundle）：opencode 1.18.23、pi 0.84.4
→ 当前零可用（exit 1）
```

**结论：整条 `@deepseek-ai` 发布线只有 codex 与 claude-code 两个 provider bundle，
且都属于 `0.0.1-rc.1` 线，与本机 `0.1.1-rc.2` **不同发布线**——不该装。**
想接 opencode / pi 那类，只能自己写 provider 包（是项目，不是配置）。

## 3. 启用步骤（某个 provider 四环都齐了之后）

```sh
# 1) 装 bundle —— 版本必须与当前核心同线（先看体检输出的 core）
node fairy-system/agent-providers.mjs --home "$DSH_HOME"     # 确认 bundle 那一环的版本

# 2) 摆宿主行（profiles/web/cordis.patch.yml，按官方 standard/code preset 的 provider 行形态）

# 3) 重启 profile（宿主行与包解析只在启动时读一次）

# 4) preset 里去 disabled：.agent-presets/fairy-full/agent.cordis.yml 的
#    tool-subagent-<id> 删除 `disabled: true`

# 5) 挂载校验：在实例侧对目标 preset 跑 mount 校验（真组一遍子树，
#    能抓「包解析不到 / config 非法 / 行没激活 / 服务落到根实域」四类失败；
#    roster 的 broken 字段不算校验）。

# 6) 真机确认：新开一个会话，工具列表里应出现 subagent_<id>
```

**前置里唯一挡死过的是「bundle 版本同线」**：上游 `peerDependencies` 写的是
`^0.0.1-rc.1`，与本机 `0.1.1-rc.2` 不同线——用 semver range 判会得出「不满足」，
但正确的结论是「根本不该装」。体检里的同线判定刻意只看**主次版本段**。

## 4. 维护

- 候选表在 `fairy-system/agent-providers.mjs` 顶部：
  - `PUBLISHED`：上游已发 bundle 的候选（新发一个就往这里加一行）。
  - `WATCH`：本机有 CLI、上游还没 bundle 的观察名单。
  - 两张表都在 `CHECKED_AT` 那天逐包实测过；改表时**同步改日期**。
- 判定实现的两条经验写在工具头部注释里（同线判定用主次版本段；preset 行扫按缩进块，
  不用正则前瞻）——改之前先读，别回退。
