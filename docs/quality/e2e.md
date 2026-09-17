# 检查项 e2e（端到端：夹具仓库跑真 CLI）

- **id**：`e2e`　**阶段**：`deep`　**类型**：`e2e`　**脚本**：`scripts/checks/e2e.mjs`
- **required**：是

## 机制

每个场景都建一个**临时夹具仓库**（`scripts/checks/lib/fixture-repo.mjs`：最小 `quality.yaml` +
真实 schema 的副本 + 生成的检查项 yaml/脚本/文档），然后**真起子进程**
`node scripts/verify.mjs --repo <夹具>`，断言的是可观察结果（退出码 + 真落盘的 JSON）：

| 场景 | 断言 |
| --- | --- |
| 发现并执行新增检查项 | 退出码 0、`gate=pass`、该项 `passed` 且带阈值明细、`verify.log` 追加 |
| 检查项失败 | 退出码 1、`gate=fail`、该项 `failed` |
| 配置缺字段 | 退出码 2、报错含 `windows_command`、且**不生成报告**（不静默跳过） |
| `--list` | 退出码 0、输出含 id 与阶段 |
| `--dry-run` | 退出码 0、输出含平台命令、不生成报告 |
| `--generate-install` | 生成 `install.ps1`（UTF-8 BOM + CRLF、winget 三件套参数、choco 仅注释）与 `install.sh`（LF、无 `sudo` 调用） |
| 部分运行语义 | 默认只记警告；`--strict-partial` 退出码 1 |

这条检查项同时就是"新增检查项 → 自动发现 → 真实执行"闭环的**机器可复核证明**。

## 阈值（threshold）

- `failed` = 0（门禁）；`passed`/`scenarios` 只作观测

## 前提与产物

- 前提：`node` ≥22。夹具在系统临时目录，跑完即删（失败时也会删）。
- 复现：`node scripts/verify.mjs --only e2e`
- 产物：`reports/artifacts/e2e.json`（逐场景：状态、退出码、断言失败信息）。
