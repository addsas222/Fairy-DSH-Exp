# Fairy System：当前操作与验证

本目录只负责当前 live workspace 的验证、升级预检和浏览器证据边界。公开仓的工程规则见根 `AGENTS.md`、设计记录见 `PONYTAIL-DESIGN.md`；本文引用的 `AI_PROJECT_RULES.md` / `ARCHITECTURE.md` / `DSH-HANDOFF.md` 与语音服务脚本属私有树，不随本仓分发。

## 当前批准边界

| 项 | 值 |
| --- | --- |
| Canonical custom source | 当前仓库 checkout |
| DSH | `0.1.1-rc.2` |
| 官方 browser runtime SHA-256 | `13a5fe0ee8cddda2306d302eb0dbfdd601e96d14baeb512867b4b6d1d72f6679` |
| Visual settings package | `@deepseek-ai/dsh-settings@0.1.1-rc.2` |
| Capability matrix | `capability-matrix.json` |
| Browser acceptance matrix | `BROWSER-EVIDENCE-MATRIX.md` |

官方 runtime 是只读边界。任何 hash、版本、selector、slot、ARIA、Session 或 Workspace contract 变动都必须按升级流程审查，不得直接改官方生成文件。

## 日常验证

从 canonical custom source root 执行：

```sh
./fairy-system/check.sh
```

它是非破坏性全量入口，覆盖：

- source 与 browser bundle syntax；
- custom package build/profile link/export contracts；
- Fairy language、Visual、Voice、Startup、Balance 与 System 测试；
- official runtime SHA-256；
- canonical Web launcher 与外部兼容入口/桌面 App 的映射；
- canonical Voice plist 与已安装 LaunchAgent 的逐字节一致性；
- 工程外 accepted baseline 的逐文件 SHA-256，以及 added/modified/deleted 清单；
- 最新 Web `run_id` 日志段的终态与 actionable/expected-cancellation 分类；
- live voice health；
- profile dependency、bundle 和 capability contract。

Playwright 默认经 `dsh-browser-dock` 代理以 headless Chrome 运行。代理只在首张有效页面截图、清洗后的标题和标签信息完整就绪后创建右上角 Dock；空白页、启动中间态和内部错误不会进入可见 UI，后续画面按 revision 原子替换。关闭 Dock 或切换会话会同步关闭浏览器并清理临时帧。只有页面结果命中登录或验证码语义时，Dock 才提供一次性的外部浏览器接管。

按需使用：

```sh
node fairy-system/verify.js --live
node fairy-system/verify-build.js
node fairy-system/accepted-baseline.js --diff
node fairy-system/log-triage.js
node --test fairy-visual/dsh-fairy-visual/test/*.test.js
node --test balance-meter/dsh-balance-meter/test/*.test.js
```

`accepted-baseline.js` 不使用 mtime。默认模式只读；`--diff` 会针对发生变化的文本文件输出 unified diff。验收快照位于 `DSH_ACCEPTED_BASELINE_ROOT`，与工作树分离且创建后设为只读。

Web launcher 默认会调用启动 preflight，并强制验证 accepted baseline、runtime、package、build 与 profile 边界。需要运行尚未验收的隔离候选版本时，必须显式设置 `DSH_ALLOW_UNACCEPTED_BASELINE=1`；该模式会写入启动日志，不能更新或接受基线。Baseline drift 仍由 `./fairy-system/check.sh` 严格报告。

只有在改动已完成相称验证、人工审查并明确成为新验收状态后，才运行：

```sh
node fairy-system/accepted-baseline.js --accept --reason "描述本次已验收变更"
```

该命令创建新的内容寻址快照并原子切换 `CURRENT`，不会覆盖旧基线。不得仅为让 `check.sh` 通过而接受新基线。

## 日志排障

`logs/dsh-web.log` 包含多个历史运行段。默认只诊断最新段：

```sh
node fairy-system/log-triage.js
```

输出必须先记录 `run_id`、`window`、行号范围和 `RUN_READY`/`RUN_FAILED`，再看当前段的 actionable。查看特定运行段、增加时间下界或读取原文：

```sh
node fairy-system/log-triage.js --run-id <run_id> --since 2026-08-27T16:26:11Z
node fairy-system/log-triage.js --run-id <run_id> --show
node fairy-system/log-triage.js --json
```

旧段中的 Visual build 缺失、source 新于 bundle、Cordis module 缺失不会污染当前结论。结构化日志中的 `client-aborted`、`superseded` 和配套的 `aborted: true` metric 单列为 expected cancellation，不计入 actionable。`check.sh` 使用 `--require-healthy`，因此最新段不是 ready 或存在当前 actionable 时会失败。

不要为例行验证重启语音服务；服务生命周期本身是改动范围时，才使用（脚本属私有/ macOS live 树，不在公开仓内）：

```sh
fairy-voice/start_fairy_voice.sh
fairy-voice/stop_fairy_voice.sh
```

## 浏览器证据

静态测试不证明 UI、动画或 TTS 的用户可见等价性。相关改动必须按 `BROWSER-EVIDENCE-MATRIX.md` 在真实浏览器验证 normal/HDD、Light/Dark、hero/历史会话、composer、sidebar、settings 与 console。

Safari 必测项为：

```text
safari-hdd-transition-svg-integrity
```

它要求验证：HDD 冷启动、normal → HDD、HDD → normal → HDD、历史会话切换，以及多轮 timed fault animation 中 **threads 与 blocks 都实际呈现**。证据写入 `browser-evidence/`，不得记录会话内容、凭据或私有响应。

## 官方升级预检

升级候选必须使用隔离 profile 与隔离 runtime，禁止把 active workspace 当 candidate：

```sh
./fairy-system/upgrade-candidate-preflight.sh \
  --profile /absolute/isolated/profile \
  --runtime /absolute/isolated/runtime/lib/client.js \
  --expected-version 0.1.1-rc.2 \
  --expected-sha256 13a5fe0ee8cddda2306d302eb0dbfdd601e96d14baeb512867b4b6d1d72f6679
```

该预检只读：检查官方 runtime、ClientModuleRegistry、Browser ModuleLoader、package exports、profile inject order、DOM/slot/ARIA、settings、session/workspace 与依赖 pin；失败时输出兼容性报告，不会修改 active profile 或官方 runtime。

`check.sh` 可在提供完整 `DSH_UPGRADE_PROFILE`、`DSH_UPGRADE_RUNTIME`、`DSH_UPGRADE_VERSION`、`DSH_UPGRADE_SHA256` 环境变量时纳入同一候选预检。

## 发布边界

自定义实现的 canonical source 是当前 checkout；完整运行时还包括经校验的部署入口和官方只读依赖。发布快照位于：

```text
当前发布候选 checkout
```

它是 non-voice distribution snapshot，不等于完整工程，也不会自动跟随 live 修改。更新 release 必须在 live 验证通过后重新生成 `LIVE-SOURCE-MANIFEST.json`、`SHA256SUMS` 与 ZIP，并运行 release root 的（发布链文件属私有树，不在公开仓内；本仓的发布门禁是上文「日常验证」与 `RELEASE-CHECKLIST.md`）：

```sh
./verify-release.sh
```

浏览器证据与 benchmark 保留在本目录的 append-only 子目录中，仅供人工追溯和升级审计；其他历史材料若需隔离，必须在工程外建立带清单的 quarantine。详见 `CONTENT-BOUNDARIES.md`。长跑基准的生成器是 `tts-long-run-benchmark.mjs`（手工运行；旋钮 `DSH_TTS_BENCH_*`；需要运行中的 fairy-voice 与 macOS 的 `pgrep`/`footprint`）。
