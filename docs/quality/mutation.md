# 检查项 mutation（变异测试）

- **id**：`mutation`　**阶段**：`deep`　**类型**：`mutation`　**脚本**：`scripts/checks/mutation.mjs`
- **required**：是（`allow_failure: true`：耗时且依赖变更集，失败降级为警告）

## 机制（**不修改工作树**）

1. **目标**：`git diff HEAD` 的新增/修改 ∪ 未跟踪文件里，落在包生产目录（`lib/`、`src/`、`scripts/`）
   且带测试的 JS 文件；再用覆盖率预热筛出"**被测试实际执行过**"的文件（从没加载过的文件做变异只会
   得 0 分，那不是被测代码的问题）。
2. **变异体**：token 级规则——比较运算取反（`<=`→`<`、`===`→`!==`…）、逻辑运算互换（`&&`↔`||`）、
   布尔取反、数值 `N`→`N+1`；按位置均匀采样（上限 `scope.max_mutants`）。
3. **合法性**：每个变异体先 `node --check` 验语法，**语法非法的直接丢弃**——否则"编译失败"会被误判成
   "被杀"，分数就假了。
4. **执行**：变异体写到系统临时目录，用 Node 模块加载钩子（`module.registerHooks`，旧版回退
   `module.register`）在解析阶段把被测模块路由到变异体，跑该包**真实测试套件**：套件失败 = 被杀，
   通过 = 存活。
5. **基线**：先用同样的钩子但不替换模块跑一次；基线不过就跳过该文件（跑不通的套件给不出分数）。
6. 分数 = 被杀 / (被杀 + 存活)。

## 阈值（threshold）

- `mutation_score` ≥ 80（B.md 默认，针对变更文件）
- `survived`/`killed`/`mutants_sampled` 只作观测；`baseline_failures` 一并报出

无变更目标时脚本 `exit 3`（跳过）并写明原因。要复核机制本身（例如变更集为空时）：

```sh
QUALITY_MUTATION_TARGETS=balance-meter/dsh-balance-meter/lib/index.js \
  node scripts/checks/mutation.mjs --check .agent/checks/mutation.yaml --repo . --report-dir reports
```

实测（2026-09-17）：该命令 6 个变异体全部被杀，分数 100%。

## 前提与产物

- 前提：`node` ≥22、`git`、`package-deps`。
- 复现：`node scripts/verify.mjs --only mutation`
- 产物：`reports/artifacts/mutation.json`（逐文件逐变异体：规则、偏移、被杀/存活/非法、基线失败原因）。
