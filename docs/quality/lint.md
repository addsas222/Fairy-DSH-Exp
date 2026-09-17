# 检查项 lint（语法解析与项目规则）

- **id**：`lint`　**阶段**：`static`　**类型**：`lint`　**脚本**：`scripts/checks/lint.mjs`
- **required**：是

## 机制

1. **解析校验**：每个跟踪的 `.js`/`.mjs`/`.cjs` 按它**真实的模块类型**解析——`.mjs`→ESM、
   `.cjs`→CJS、`.js` 取最近的 `package.json.type`，没有 type 字段时用 Node 自己的"模块语法探测"
   （先按 CJS 解析，报 `Cannot use import statement outside a module` 之类就改按 ESM）。
   CJS 用 `vm.Script`、ESM 用 `vm.SourceTextModule`（因此命令带 `--experimental-vm-modules`）。
2. **规则检查**（高信号，且当前代码库本来就满足）：

| 规则 | 级别 | 范围 |
| --- | --- | --- |
| `no-debugger` | 错误 | 全仓 |
| `no-eval-in-production` | 错误 | `lib/`、`src/`（测试夹具用 `new Function` 解析 bundle 是合法用法，故排除） |
| `no-console-in-production` | 错误 | `lib/`、`src/` 里的 `console.log`/`console.debug` |
| `no-focused-tests` | 错误 | `test/` 里的 `.only(`（会把整包测试收窄成一条） |
| `no-empty-catch` | 提示 | 全仓空 catch（存量 10 处是有意的幂等释放模式，故只作提示） |

为什么不引 eslint：仓库没有 eslint，也没有根级工程；引它会改变各包依赖树，与 `AGENTS.md` §1.1 的
逐包锁文件约定、CI 的 `--frozen-lockfile` 冲突。这是**口径取舍**（详见 docs/QUALITY.md），不是"不能做"。

## 阈值（threshold）

- `errors` = 0、`parse_errors` = 0（门禁）
- `files_scanned`、`advisories` 只作观测

需要豁免存量点时写进 `.agent/checks/lint.yaml` 的 `scope.exclude`（附原因），而不是放宽规则。

## 前提与产物

- 前提：`node` ≥22、`git`。
- 复现：`node scripts/verify.mjs --only lint`
- 产物：`reports/artifacts/lint.json`（`module_types` 统计 + 逐条命中：路径/行号/代码片段）。
