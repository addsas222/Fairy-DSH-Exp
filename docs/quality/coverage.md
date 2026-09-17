# 检查项 coverage（覆盖率：全量 + 变更行/变更块）

- **id**：`coverage`　**阶段**：`verify`　**类型**：`coverage`　**脚本**：`scripts/checks/coverage.mjs`
- **required**：是

## 机制

仓库没有 c8/nyc，而 `node --experimental-test-coverage` 只给整文件百分比、给不出按行数据（没有按行
数据就无法实现"新增行覆盖 ≥90%"），所以本项自己收 V8 原始数据：

1. 用 `NODE_V8_COVERAGE=<临时目录>` 跑真实负载：
   - `packages` 目标：各包 `node --test`（失败重试一次以区分 flaky）；
   - `harness` 目标：跑一轮 `scripts/verify.mjs`——子进程继承环境变量，于是被它拉起的检查脚本
     也一并被计量，这就是"质量体系自身代码也有覆盖率数据"的关键。
2. 按 V8 语义合并区间：同 `(startOffset,endOffset)` 取 `count` 最大值（同一文件可能被带 `?query`
   的 ESM 重新加载）。
3. 行覆盖 = 该行**最内层区间**（覆盖行首偏移的最小 span）`count > 0`；被任何区间覆盖的行才算可计量行。
4. 块覆盖（分支代理口径）= `functions[].isBlockCoverage` 为真时其 `ranges` 的每区间记一个块。
5. 变更口径 = `git diff --unified=0 HEAD` 的新增行 ∪ 未跟踪文件全部行；
   `QUALITY_DIFF_BASE` 可换成远端分支以做 PR 增量门禁（基数过旧会把历史算成新增）。

## 口径校准（实测）

| 文件 | 本项行覆盖 | `node --experimental-test-coverage` Lines |
| --- | --- | --- |
| `fairy-persona/dsh-fairy-persona/lib/index.js` | 92.08% | 92.77% |
| `balance-meter/dsh-balance-meter/lib/index.js` | 73.62% | 75.97% |
| `fairy-modes/dsh-fairy-modes/lib/index.js` | 97.06% | 97.90% |

同文件差值 ≤2.4 个百分点、未覆盖行集合一致 → 口径可信。

## 阈值（threshold）

| 指标 | 阈值 | 说明 |
| --- | --- | --- |
| `lines_pct` | ≥90 | 全量计量行覆盖 |
| `blocks_pct` | ≥75 | 全量块覆盖的**存量地板**（本仓历史分支覆盖就在 77% 上下） |
| `changed_lines_pct` | ≥90 | **变更行**覆盖（B.md 默认；仅在存在变更行时出现） |
| `changed_blocks_pct` | ≥85 | **变更块**覆盖（B.md 默认；新代码的分支标准在这里） |
| `workload_failures` | = 0 | 负载本身失败时覆盖率没有意义，先修负载 |

未被执行的生产文件不计入分母，但会在产物 JSON 的 `unexecuted_production_files` 里逐个列出——
不制造"没跑过的文件看起来 100%"的假象。

## 前提与产物

- 前提：`node` ≥22、`pnpm` ≥11、`package-deps`。
- 复现：`node scripts/verify.mjs --only coverage`
- 产物：`reports/artifacts/coverage.json`（逐文件行/块/变更行明细、负载退出码、diff 基准与说明）。
