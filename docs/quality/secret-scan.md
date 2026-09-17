# 检查项 secret-scan（密钥/凭据扫描）

- **id**：`secret-scan`　**阶段**：`static`　**类型**：`scan`　**脚本**：`scripts/checks/secret-scan.mjs`
- **required**：是

## 机制

只扫 `git ls-files` 的**跟踪文本文件**（未跟踪的临时文件不是泄露面），跳过二进制（扩展名 + NUL 判定），
两类判定：

1. **具名模式**（错误级）：私钥块、AWS Access Key ID、GitHub token（`ghp_`/`github_pat_`）、
   Slack token、OpenAI `sk-`、Anthropic `sk-ant-`、Google API Key、JWT。
2. **通用赋值**（错误级）：`password|secret|token|api_key|... = "…"`，叠加**香农熵阈值 3.5**，
   把 `"changeme"` 之类的占位符噪声压掉。

报告与日志里**只打印掩码**（前 4 字符 + 长度），不把疑似密钥原文写进任何产物。

**测试/夹具路径的降级策略**：`generic-credential-assignment`（模糊规则）在 `test/`、`tests/`、
`fixtures/`、`*.test.js` 路径下降级为**提示级**——夹具里本来就该有 `TYPESAFE_API_KEY="ts_live_…"`
这类占位值，把它们当门禁失败只会逼人放宽规则。**具名令牌模式**（私钥块、`sk-`、`ghp_`、`AKIA`、
JWT 等）在测试目录里仍然是**错误级**，需要逐条登记 allow。

## 阈值（threshold）

- `findings` = 0（门禁）
- `files_scanned`、`allowed` 只作观测

## 误报处理（scope.allow）

测试夹具里的假密钥逐条登记（路径 + 正则 + 原因），例如 `fairy-voice` 单测里的
`sk-live-1234567890`。**不通过放宽规则来消音**：新命中一律算错误。

## 前提与产物

- 前提：`node` ≥22、`git`。
- 复现：`node scripts/verify.mjs --only secret-scan`
- 产物：`reports/artifacts/secret-scan.json`（掩码 + 行号 + 熵值）。

## 修复指引

真实密钥：先**轮换**，再从历史里清除（`git filter-repo` 之类需要单独评审，不在本检查项射程内）；
确为夹具的，才加进 allow 列表并写明原因。
