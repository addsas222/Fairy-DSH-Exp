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

## 宿主提供的 DSH 包

`@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app` 等由 DSH CLI/profile
宿主提供，不随本仓库 vendoring，也不由本项目重新授权。使用者应按照 DSH
发行包中的许可证和版权文件处理。

## 再分发的第三方内容

| 内容 | 位置 | 许可证 | 版权 / 来源 |
| --- | --- | --- | --- |
| ponytail 技能组 | `.agent-presets/ponytail/skills/ponytail*/SKILL.md` | MIT | DietrichGebert · [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail)；许可证全文见 `.agent-presets/ponytail/skills/ponytail.LICENSE` |

## 本仓库内的本地包

`fairy-contracts`、`dsh-browser-dock`、`dsh-balance-meter`、
`dsh-fairy-startup`、`dsh-fairy-visual`、`dsh-fairy-voice`、
`dsh-fairy-persona`、`dsh-fairy-modes`、`dsh-fairy-search` 是本仓库的原创
代码（除其自身依赖外），按根目录 `LICENSE` 和 `NOTICE` 处理。

发布新版本时，应从最终 lockfile 重新核对版本、来源和许可证，并把新增的
第三方依赖补入本表；不能因为依赖被锁定就把它们当作本项目原创内容。
