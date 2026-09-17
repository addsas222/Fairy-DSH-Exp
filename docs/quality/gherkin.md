# 检查项 gherkin（行为用例）

- **id**：`gherkin`　**阶段**：`test`　**类型**：`gherkin`　**脚本**：`scripts/checks/gherkin.mjs`
- **required**：是

## 机制

仓库没有 cucumber，本检查项自带一个小而完整的运行器：

1. **解析** `features/**/*.feature`：`Feature` / `Background` / `Scenario` /
   `Scenario Outline + Examples` / 步骤关键字（`Given|When|Then|And|But|*`）/ 标签 / `#` 注释；
2. **加载** `features/steps/*.mjs` 的步骤定义（默认导出 `{ steps: { 文本或 /正则/: fn } }`），
   文本键支持 `{string}`/`{int}`/`{float}`/`{word}` 占位符；
3. **执行**：每个场景用全新的 `world` 跑 Background + 场景步骤；正则捕获组按顺序作为参数；
   Scenario Outline 的每个 Examples 行各算一个场景；
4. **判定**：没匹配到定义 = `undefined`；`{pending: true}` = `pending`；匹配到多条 = `ambiguous`。

当前用例：`features/quality/quality-system.feature`（7 个场景，进程内驱动主入口的 lib API：自动发现、
失败判定、阈值生效、配置报错、`allow_failure` 降级、平台不支持、模板可解析）。

## 阈值（threshold）

- `failed` = 0、`undefined_steps` = 0、`pending` = 0、`ambiguous` = 0、`syntax_errors` = 0（门禁）
- `scenarios` 只作观测；标 `@skip` 的场景单独计数，不计入失败

## 前提与产物

- 前提：`node` ≥22、`git`。
- 复现：`node scripts/verify.mjs --only gherkin`
- 产物：`reports/artifacts/gherkin.json`（逐场景状态 + 失败原因 + 步骤定义清单）。

扩展方式见 `docs/EXTENDING.md` 第 4 节。
