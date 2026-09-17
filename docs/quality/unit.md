# 检查项 unit（全量单元测试）

- **id**：`unit`　**阶段**：`test`　**类型**：`unit`　**脚本**：`scripts/checks/unit.mjs`
- **required**：是

## 机制

1. 按 `scope.package_globs`（默认 `*/dsh-*/package.json`）发现包；
2. 包内 `test/**/*.test.js`（递归）**显式列出文件**跑 TAP——不依赖 shell 展开 glob，
   因为 cmd.exe 不展开通配符（这也是 Windows 友好的关键）；
3. 解析 TAP 汇总（`tests/pass/fail/skipped/todo`）与失败用例名；
4. 失败包**重试一次**：重试后通过记 `flaky`（进 `flaky_rate`），仍失败才算失败。

环境耦合的 `fairy-system/test/*` **不在本项**（需要官方制品与已部署 home），见
`docs/quality/integration.md`——把它塞进来会让"换台机器就红"。

## 阈值（threshold）

- `failed` = 0、`packages_failed` = 0（门禁）
- `pass_rate` ≥ 100（**跳过不计入分母**：`pass/(tests-skipped)`）
- `flaky_rate` ≤ 1（B.md 默认：flaky 率上限）
- `tests` 只作观测

## 前提与安装

- `node` ≥22、`pnpm` ≥11、`package-deps`（`node scripts/checks/lib/deps-probe.mjs`）。
  依赖没装时状态是 `blocked`（required），报告给出真实手动命令：
  `node scripts/checks/lib/deps-install.mjs --repo .`（逐包 `pnpm install --frozen-lockfile --ignore-scripts`）。

## 复现与产物

```sh
node scripts/verify.mjs --only unit
(cd fairy-persona/dsh-fairy-persona && node --test test/*.test.js)   # 单包复现
```

产物：`reports/artifacts/unit.json`（逐包 tests/pass/fail/skipped、失败用例名、重试次数、flaky 标记）。
