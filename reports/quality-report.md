# Fairy-DSH 质量报告

- 生成时间：2026-09-17T04:57:06.751Z
- 仓库：`C:\tmp\fairy-dsh`
- 平台：windows（Node v26.7.0）
- 提交：`c1f2062`（分支 main，工作树有未提交改动）
- 筛选：阶段=全部；检查项=全部；标签=全部
- 门禁：**PASS（全绿）**

汇总：共 11 项 —— 通过 9 / 未启用 1 / 跳过 1

## 阶段 static — 静态检查

| 检查项 | 状态 | 耗时 | 关键指标 | 阈值判定 |
| --- | --- | --- | --- | --- |
| `format` 文本形态（行尾/BOM/空行） | 通过 | 1.5s | files_scanned=420, errors=0, error_rate=0, advisories=0, baseline_exemptions=12 | 全部满足 |
| `lint` 语法解析与项目规则 | 通过 | 1.8s | files_scanned=273, errors=0, parse_errors=0, rule_findings=11, advisories=11, error_rate=0 | 全部满足 |
| `repo-contracts` 质量体系自洽与仓库契约 | 通过 | 1.4s | errors=0, checks_scanned=11, docs_scanned=11, packages_checked=11, error_rate=0 | 全部满足 |
| `secret-scan` 密钥/凭据扫描 | 通过 | 1.7s | files_scanned=426, findings=0, advisories=1, allowed=17, finding_rate=0 | 全部满足 |
| `typecheck` TypeScript 类型检查 | 未启用 | 0.0s | — | — |

## 阶段 test — 测试

| 检查项 | 状态 | 耗时 | 关键指标 | 阈值判定 |
| --- | --- | --- | --- | --- |
| `gherkin` Gherkin 行为用例 | 通过 | 6.0s | features=3, scenarios=32, passed=32, failed=0, pending=0, undefined_steps=0 | 全部满足 |
| `unit` 单元测试（全量 node --test） | 通过 | 15.2s | packages=11, packages_failed=0, tests=533, passed=533, failed=0, skipped=0 | 全部满足 |

## 阶段 verify — 验证

| 检查项 | 状态 | 耗时 | 关键指标 | 阈值判定 |
| --- | --- | --- | --- | --- |
| `coverage` 覆盖率（全量 + 变更行/变更块） | 通过 | 31.4s | scope_changed_lines=0, lines_pct=90.25, blocks_pct=73.49, files_measured=76, unexecuted_production_files=78, workload_failures=0 | 全部满足 |
| `integration` 跨包/镜像集成与 fairy-system 套件 | 通过 | 4.1s | subchecks=5, passed=3, failed=0, skipped=2, pass_rate=100 | 全部满足 |

## 阶段 deep — 深度验证

| 检查项 | 状态 | 耗时 | 关键指标 | 阈值判定 |
| --- | --- | --- | --- | --- |
| `e2e` 端到端（夹具仓库跑真 CLI + 报告闭环） | 通过 | 3.2s | scenarios=7, passed=7, failed=0, pass_rate=100 | 全部满足 |
| `mutation` 变异测试（变更文件，加载器替换，不落盘） | 跳过 | 1.1s | skipped=true, targets=0 | 未满足：变更文件变异分数（%） 缺失（要求 >=80）；存活变异体 缺失（要求 ）；被杀变异体 缺失（要求 ）；采样的变异体数 缺失（要求 ） |

## 警告（不阻断门禁）

- `typecheck`（未启用）：仓库没有可用的 TypeScript 编译器（根级无 TS 依赖；唯一的 TS 输入是两个包的 tsdown.config.ts 与 fairy-contracts/types.d.ts），无法做真实类型检查。启用步骤见 docs/quality/typecheck.md
- `mutation`（跳过）：本次变更里没有落在包生产目录（lib/ src/ scripts/）且带测试的 JS 文件

## 跳过 / 阻塞项与前提

- `mutation`：本次变更里没有落在包生产目录（lib/ src/ scripts/）且带测试的 JS 文件

## 未启用的检查项

- `typecheck` TypeScript 类型检查：仓库没有可用的 TypeScript 编译器（根级无 TS 依赖；唯一的 TS 输入是两个包的 tsdown.config.ts 与 fairy-contracts/types.d.ts），无法做真实类型检查。启用步骤见 docs/quality/typecheck.md（启用步骤见 docs/quality/typecheck.md）

## 明细与复现

- 每项检查的完整 stdout/stderr 与真实退出码：`reports/artifacts/<id>.log`
- 本轮机器可读结果：`reports/quality-report.json`；历史追加：`reports/verify.log`
- 安装依赖的生成脚本：`scripts/install.ps1` / `scripts/install.sh`（由 `--generate-install` 从检查项的 requires 生成）
- 新增检查项见 `docs/EXTENDING.md`（模板 + 自动发现，无需改主入口）

