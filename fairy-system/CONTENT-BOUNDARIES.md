# DSH 内容边界与清理清单

更新时间：2026-08-28

本清单用于防止后续 Agent 把历史材料、生成物或运行状态误认为当前源码。不授权自动删除、恢复或覆盖任何内容。

## 当前有效运行输入

- `profiles/web/`、`launchers/`、`.agent-presets/fairy-lite/agent.cordis.yml`
- 五个自定义包的 source 与已验证对应的 `lib/` 输出
- `fairy-contracts/`
- 已固定版本与 SHA-256 的官方 DSH 安装（只读）

## 离线输入、可重建产物与审计证据（保留）

- `.agent-presets/fairy-lite/corpus/`、`training/`、`evaluation/`：被离线构建链引用。
- `.agent-presets/fairy-lite/behavior/`、`style/`、`canon/`、`corpus_manifest.json`：运行时 compiler 读取的派生产物。
- `patches/`：保存当前 profile patch 的来源和可审查差异；不能作为恢复源。
- `fairy-system/browser-evidence/`、`fairy-system/benchmarks/`：append-only 历史证据；旧 hash 必须保留并在新证据中标注。

## 运行状态与用户数据（禁止常规清理）

- `logs/`、`sessions/`、`attachments/`、`storages/`、`playwright-profile/`
- `fairy-voice/runtime/` 下的模型、venv 和推理状态
- `.credentials.yaml`、settings、余额日文件及其他本地密钥/配置

这些目录可能由正在运行的 DSH、TTS 或 Playwright 进程持有；清理必须有明确路径、停机窗口、备份和用户授权。

## 验收基线

`$DSH_ACCEPTED_BASELINE_ROOT` 是工程外的只读快照，只能比较，不能覆盖 live workspace。当前 drift 必须先审阅，再由用户明确接受；不得为通过检查而删除差异或自动更新 `CURRENT`。

## 本次清理决定

本次没有发现可在不改变运行行为、用户数据或审计可追溯性的前提下安全删除的目标。后续若要压缩日志、清理浏览器缓存或删除旧 session，必须另行给出精确路径和保留期限。
