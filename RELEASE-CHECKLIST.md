# GitHub 发布前检查

版本锚点：本文档对应质量门禁 `.agent/checks/*.yaml`（11 项，由 `scripts/verify.mjs` 自动发现执行）。
更新日期：2026-09-18（对齐 `.agent/checks/` 现状重写）。

这份目录是 Fairy DSH 的公开候选版，不包含生产会话、密钥、缓存、完整
世界观资料或本地 TTS 运行环境。

## 发布前必须逐项确认

### 授权与许可证

- [ ] 已完成 Fairy 语料、游戏文本和第三方代码的授权审查；
- [ ] 已确认原创代码、脚本、测试、配置和文档按 Apache-2.0 发布，并保留
      `LICENSE`、`NOTICE`；第三方内容仍按其原始许可证处理；
- [ ] `THIRD_PARTY_NOTICES.md` 与 `TRADEMARKS.md` 已随当前树同步。

### 质量门禁（11 项，全部须 PASS）

发布前在仓库根跑 `node scripts/verify.mjs`（Windows 亦可用 `scripts\verify.cmd`），
以下 11 项必须全部通过；本清单与 `.agent/checks/*.yaml` 一一对应：

| 门禁 | 检查项文件 | 检查什么 |
| --- | --- | --- |
| coverage | `.agent/checks/coverage.yaml` | 测试覆盖率阈值 |
| e2e | `.agent/checks/e2e.yaml` | 端到端测试 |
| format | `.agent/checks/format.yaml` | 文本形态（行尾/BOM/空行） |
| gherkin | `.agent/checks/gherkin.yaml` | 特性文件语法 |
| integration | `.agent/checks/integration.yaml` | 集成测试 |
| lint | `.agent/checks/lint.yaml` | 语法解析与项目规则 |
| mutation | `.agent/checks/mutation.yaml` | 变异测试 |
| repo-contracts | `.agent/checks/repo-contracts.yaml` | 质量体系自洽与仓库契约 |
| secret-scan | `.agent/checks/secret-scan.yaml` | 密钥/凭据扫描 |
| typecheck | `.agent/checks/typecheck.yaml` | 类型检查 |
| unit | `.agent/checks/unit.yaml` | 单元测试 |

单项速查：`node scripts/verify.mjs --only <id>`（如 `--only secret-scan`）。

### 隔离与干净发布

- [ ] `git clone` 到全新临时目录后，`DSH_HOME` 指向独立测试目录；
- [ ] `DSH_HOME="$PWD/.dsh-test-home" ./scripts/test-isolated.sh` 全部通过；
- [ ] 不上传 `node_modules`、`.dsh-test-home`、会话、日志、凭据和世界观私有库；
- [ ] 已检查所有发布文件中不存在维护者本机绝对路径
      （`grep -rn 'D:\\\\' --include='*.json' .` 应零命中；voice_path 等语料字段不得含本机路径）；
- [ ] GitHub Actions 的 Node/pnpm 测试通过；
- [ ] 公开 README 已说明 DSH CLI、模型密钥和可选私有资料的配置方式。

## 发布前最后核验

- [ ] 工作树干净：`git status --porcelain` 仅预期的发布文件；
- [ ] `node scripts/verify.mjs` 门禁：PASS；
- [ ] `reports/quality-report.md` 的"门禁"段为 PASS（全绿）。
