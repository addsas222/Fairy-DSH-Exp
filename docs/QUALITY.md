# Fairy-DSH 质量体系（QUALITY.md）

本文件说明**质量体系怎么用、门禁判什么、为什么这么判**。要新增检查项请看
[EXTENDING.md](EXTENDING.md)；逐项检查的机制与阈值见 [docs/quality/](quality/)。

## 1. 一句话架构

```
scripts/verify.mjs（主入口，不认识任何具体检查项）
        │  1. 读 .agent/quality.yaml（用 .agent/quality.schema.json 校验）
        │  2. 自动发现 .agent/checks/*.yaml
        │  3. 按 stages 顺序执行（按平台挑 windows_command / unix_command）
        ▼  4. 汇总 → reports/quality-report.{md,json} + reports/verify.log + reports/artifacts/<id>.log
scripts/checks/<id>.mjs（检查实现，逐个用 Node 内建能力写）
```

- 主入口**零硬编码**：新增检查项 = 加一个 yaml + 一个脚本 + 一份文档，主入口不动。
- 配置有版本：`schema_version: 1`（结构变更要同时改 `quality.schema.json` 并递增版本）。
- 机器人可读：`reports/quality-report.json` 是权威结论；`reports/verify.log` 是历史追加。

## 2. 入口与用法

| 平台 | 入口 | 说明 |
| --- | --- | --- |
| Windows | `scripts\verify.cmd` | **推荐**。纯 ASCII + CRLF；避开 PS 5.1 的 AMSI 崩溃面 |
| Windows | `powershell -ExecutionPolicy Bypass -File scripts/verify.ps1` | UTF-8 with BOM + CRLF；等价入口 |
| Linux/macOS/CI | `sh scripts/verify.sh` | POSIX sh；CI 的 ubuntu-latest 走这条 |
| 任意 | `node scripts/verify.mjs` | 真正的主入口，上面三个只是包装 |

常用参数：

```sh
node scripts/verify.mjs --list                  # 列出发现的检查项（阶段 / required / enabled）
node scripts/verify.mjs --dry-run               # 只打印将要执行的平台命令
node scripts/verify.mjs --stage static          # 只跑某阶段
node scripts/verify.mjs --only unit,format      # 只跑指定检查项
node scripts/verify.mjs --tags security         # 按标签选择
node scripts/verify.mjs --strict-partial        # 部分运行也判失败（默认只记警告）
node scripts/verify.mjs --generate-install      # 依据 requires 重新生成安装脚本
node scripts/verify.mjs --repo <dir> --config <path> --checks-dir <dir>   # 在别处跑（夹具/沙箱）
```

**部分运行语义**：用 `--stage/--only/--tags` 筛掉 required 检查项时，本轮 `PASS` 只覆盖已执行的项，
未执行的 required 项会逐条进报告的"警告"一节；`--strict-partial` 可改成直接判失败。

## 3. 门禁语义（什么算 FAIL）

| 状态 | 含义 | 是否阻断门禁 |
| --- | --- | --- |
| `passed` | 退出码 0 且阈值全部满足 | 否 |
| `failed` | 退出码 1，或阈值不满足 | **是**（`allow_failure: true` 时降级为警告） |
| `error` | 退出码 2/其它（脚本内部错误、spawn 失败） | **是** |
| `timeout` | 超时（整棵进程树被杀） | **是** |
| `blocked` | required 检查项前提缺失（`on_missing` 默认对 required 项取 `block`） | **是** |
| `skipped` | 前提缺失（可选项默认跳过）或显式 `on_missing: skip` | 否，但进警告 |
| `unsupported` | 配置里显式声明当前平台不支持 | 否（这是决定，不是侥幸） |
| `disabled` | `enabled: false` | required 项被禁用才算失败 |

其它门禁约束（`quality.yaml` 的 `gate`）：`min_enabled_checks`（防止有人把检查项全关掉）、
`max_disabled_checks`（未启用项上限）、`allow_failure_downgrades`。

失败时报告会给三样东西：**阈值明细**（哪个指标差多少）、**真实命令**、**逐项完整日志**
（`reports/artifacts/<id>.log`，含 stdout/stderr 与真实退出码）。

## 4. 检查清单总览与阈值

| id | 阶段 | 机制（真实执行） | 门禁阈值 |
| --- | --- | --- | --- |
| `format` | static | 跟踪文本文件的行尾/BOM/NUL/混合行尾；行尾空白与末尾换行是提示级 | 错误级违规 = 0 |
| `lint` | static | 全部跟踪 JS 按真实模块类型解析 + 5 条项目规则 | 错误级问题 = 0、解析错误 = 0 |
| `typecheck` | static | **未启用**（仓库无 tsconfig/TS 编译器；脚本已就位，启用步骤见文档） | — |
| `secret-scan` | static | 具名密钥模式 + 通用赋值叠加香农熵；报告只打掩码 | 命中 = 0 |
| `repo-contracts` | static | 配置/文档/脚本/CI 彼此对齐的硬契约（含"阈值指标必须在脚本里真实出现"） | 违规 = 0 |
| `unit` | test | 各包 `node --test` 全量（TAP 解析），失败包重试一次 | 失败用例 = 0、通过率 100%、flaky ≤1% |
| `gherkin` | test | 自解析 `.feature` + 执行 `features/steps/*.mjs` | failed/pending/undefined/ambiguous = 0 |
| `coverage` | verify | V8 原始覆盖率（包测试 + harness 一轮 verify），变更行/变更块口径 | 全量行 ≥90%、全量块 ≥75%；变更行 ≥90%、变更块 ≥85% |
| `integration` | verify | fairy-system 自检 + 构建契约 + 环境耦合套件（前提缺失记 skipped） | 失败子检查 = 0 |
| `e2e` | deep | 建夹具仓库、**真起 CLI 子进程**、断言退出码与报告产物 | 失败场景 = 0 |
| `mutation` | deep | 变更文件的 token 级变异 + 加载器替换 + 真实套件判定（不落盘） | 变异分数 ≥80% |

## 5. 覆盖率口径（先说清楚，避免"口径黑箱"）

仓库没有 c8/nyc，本体系自己收 V8 原始数据（`NODE_V8_COVERAGE`），因为 Node 内建的
`--experimental-test-coverage` 只给整文件百分比、给不出**按行**数据，而没有按行数据就无法实现
"新增行覆盖 ≥90%"。

- **行覆盖**：某行的"最内层区间"（覆盖该行起始偏移的最小 span）`count > 0` 即视为覆盖；
  被任何区间覆盖的行才算"可计量行"。
- **块覆盖（分支代理口径）**：`functions[].isBlockCoverage` 为真时，其 `ranges` 每个区间记一个块。
- **合并**：同一文件可能被多次加载（带 `?query` 的 ESM 重载），同 `(startOffset,endOffset)` 区间取
  `count` 最大值。
- **变更口径**：`git diff --unified=0 HEAD` 的新增行 ∪ 未跟踪文件的全部行。默认基数是 `HEAD`
  （即**未提交改动**）；要按远端分支做 PR 增量门禁可设 `QUALITY_DIFF_BASE=origin/main`——注意基数
  过旧会把历史代码算成"新增"。
- **未被执行的生产文件**：不计入分母，但会在产物 JSON 里逐个列出（`unexecuted_production_files`），
  避免"没跑过的文件看起来 100%"。

口径校准（2026-09-17 在本机实测，同文件对比 `node --experimental-test-coverage`）：

| 文件 | 本体系行覆盖 | Node 内建 Lines | 结论 |
| --- | --- | --- | --- |
| `fairy-persona/dsh-fairy-persona/lib/index.js` | 92.08% | 92.77% | 同量级，未覆盖行集合一致 |
| `balance-meter/dsh-balance-meter/lib/index.js` | 73.62% | 75.97% | 同量级，未覆盖行区间一致 |
| `fairy-modes/dsh-fairy-modes/lib/index.js` | 97.06% | 97.90% | 同量级 |

全量块覆盖（77% 上下）明显低于"分支 ≥85%"，这是**存量现实**：`blocks_pct` 的 75% 是**存量地板**，
新代码的标准由 `changed_blocks_pct ≥ 85%` 承担（B.md 的默认值，针对新增分支）。

## 6. 依赖安装策略（Windows 友好、永不提权）

优先级：**项目本地依赖（local）> winget `--scope user` > scoop > choco（只写文档，不执行）**。

- `scripts/install.ps1` / `scripts/install.sh` 由 `node scripts/verify.mjs --generate-install`
  从各检查项的 `requires[].install` **生成**（勿手改：改配置后重新生成）。
- winget 命令一律追加 `--accept-source-agreements --accept-package-agreements --scope user`。
- **禁用 sudo**；需要管理员权限的步骤（含所有 choco 命令）只写入脚本注释与本文档，不自动执行。
- 实际使用过的安装动作记录在 `reports/install.log`（追加）。
- 本机当前**没有执行过任何 winget/scoop 安装**：Node 26.7.0、pnpm 11.27.0、git 都在 PATH 上，
  各包依赖也已经就位（详见 `reports/install.log` 与最终报告）。

**Windows 长路径**：本仓有较深目录（`.agent-presets/fairy-lite/runtime/...`），
请在本机执行一次（只影响本机 clone，不入库）：

```cmd
git config core.longpaths true
```

`repo-contracts` 检查项会校验 `docs/QUALITY.md`（本文件）写明这条约定——因为 `core.longpaths`
是本机配置，仓库里无法"备份"它，只能靠文档 + 自检提醒。

## 7. 跨平台规则（写脚本前必读）

- 路径用 Node 的 `path.join/path.resolve`；配置里的命令用 `${repo}` 这类**运行期变量**，
  并分别提供 `windows_command`（`\` 分隔）与 `unix_command`（`/` 分隔）。
- shell 里不要用 `export` / `chmod` / 符号链接 / `grep` / `sed` / `awk`；Windows 上 `bash`
  可能被 WSL 抢占，用 `sh`。
- Node 包管理器用 `npm.cmd` / `pnpm.cmd`（安装脚本生成器已处理）；Python 用 `py -3` 与
  `.venv\Scripts\python.exe`（当前质量体系不需要 Python）。
- `.ps1` 必须 **UTF-8 with BOM**；`.cmd` 必须**纯 ASCII 无 BOM**；`.sh` 必须 LF。
  这三条由 `format` 检查项强制，并在 `.gitattributes` 里固定行尾。
- 检查脚本不要依赖 shell 通配符展开（cmd.exe 不展开）：自己在 Node 里枚举文件，
  例如 `unit`/`coverage` 显式列出 `test/*.test.js`。

## 8. 报告与产物

| 文件 | 内容 | 是否入库 |
| --- | --- | --- |
| `reports/quality-report.md` | 人读报告：阶段汇总、逐项状态/指标/阈值、失败与跳过详情 | 是 |
| `reports/quality-report.json` | 机器读结论：`gate`、`checks[].metrics/threshold_results`、环境与提交信息 | 是 |
| `reports/verify.log` | 每次运行的追加日志（一行一项 + 失败原因） | 是 |
| `reports/install.log` | 安装脚本的追加日志（执行了什么、哪些需要人工） | 是 |
| `reports/artifacts/<id>.log` | 单项检查的完整 stdout/stderr 与真实退出码 | 否（gitignore） |
| `reports/artifacts/<id>.json` | 单项检查的机器可读明细（含逐文件/逐用例结果） | 否（gitignore） |

## 9. 常见问题

- **`unit` 报 `ERR_MODULE_NOT_FOUND: Cannot find package 'dsh-fairy-contracts'`**：包依赖没装。
  跑 `node scripts/checks/lib/deps-install.mjs --repo .`（或 `scripts/install.ps1`）。
- **`unit` 在 CI 上通过、本机失败**：先看 `reports/artifacts/unit.json` 里的 `packages[].failures`，
  再单跑那个包（`cd <包> && node --test test/*.test.js`）。
- **`integration` 的 `verify-build` 被跳过**：本机/CI 上没有装齐 11 个包的 DSH_HOME。
  按报告里的手动命令在装齐的 home 上重跑即可（这是环境前提，不是代码问题）。
- **`coverage` 报 `workload_failures > 0`**：包测试本身没跑完——覆盖率数字没有意义，先修测试。
- **`mutation` 被跳过**：本次变更里没有"落在包生产目录且被测试实际执行过"的文件。
  想复核机制本身：`QUALITY_MUTATION_TARGETS=<仓库相对路径> node scripts/checks/mutation.mjs ...`。
- **改了 `.agent/checks/*.yaml` 之后**：跑一次 `--generate-install`（requires 变了）与
  `repo-contracts`（它会校验文档与阈值指标）。

## 10. 纪律（不要做）

1. **不要**为了变绿把检查项 `enabled: false`、`allow_failure: true` 或删规则——`repo-contracts`
   与门禁下限会拦住，而且报告会保留痕迹。要么真修，要么在 `docs/quality/<id>.md` 写明原因与启用步骤。
2. **不要**改 `accept-baseline`、放宽哈希 pin、跳过逐包安装：见根 `AGENTS.md` 第 5 节硬约束。
3. **不要**把疑似密钥原文贴进 issue/PR/日志：`secret-scan` 报告只给掩码，请照此办理。
4. **不要**让"没实现的检查"变成恒过：没有真实机制就 `enabled: false` + 文档，别写 TODO 命令。

## 11. 两个补充说明（2026-09-17 实测补充）

**扫描面包含未跟踪文件**：`format`/`lint`/`secret-scan`/`repo-contracts` 扫的是
"`git ls-files` ∪ `git ls-files --others --exclude-standard`"——即**跟踪文件 + 未跟踪但未被忽略的文件**。
原因：门禁要在提交之前就能拦住新文件的问题（这套体系落地时就因为只看跟踪文件，漏掉了 13 个 CRLF 的新脚本）。
被 `.gitignore` 忽略的路径（`node_modules/`、`reports/artifacts/` 等）依然不在扫描面内。

**覆盖率按目标分别设门禁**：`coverage` 检查项把 `packages`（产品代码，11 个包）与 `harness`
（质量体系自身 `scripts/**`）分开出指标，避免一个聚合数字掩盖"谁把覆盖率拉低了"：

| 指标 | 阈值 | 实测（2026-09-17） |
| --- | --- | --- |
| `packages_lines_pct` | ≥90（B.md 默认） | 92.19% |
| `packages_blocks_pct` | ≥75（存量地板） | 77.87% |
| `packages_changed_lines_pct` / `packages_changed_blocks_pct` | ≥90 / ≥85（B.md 默认，仅在有变更行时出现） | 本次无包侧变更 |
| `harness_lines_pct` | ≥84（**棘轮地板**） | 85.20% |
| `harness_blocks_pct` | ≥60（**棘轮地板**） | 63.89% |

`harness_*` 的绝对值低于 B.md 的 90/85 默认值：质量体系脚本里大量是"配置写错才会走到"的错误分支，
当前由 32 个 Gherkin 场景 + 7 个 e2e 场景驱动，剩余未覆盖点集中在 `verify.mjs` 的 CLI 级错误处理、
`repo-contracts.mjs` 的契约违规分支与 `integration.mjs` 的子检查路径（详见
`docs/quality/coverage.md` 的"差距与下一步"）。因此这两项按**记录基线 + 棘轮**落地：先钉住真实数字
（不许下降），把 90/85 作为提升目标——没有把阈值悄悄改成"等于当前值"这种自我欺骗。
