# 检查项 repo-contracts（质量体系自洽与仓库契约）

- **id**：`repo-contracts`　**阶段**：`static`　**类型**：`meta`　**脚本**：`scripts/checks/repo-contracts.mjs`
- **required**：是

## 机制

配置驱动体系最容易"悄悄失效"的地方，都在这里变成硬契约：

1. **schema 校验**：`.agent/quality.yaml` 与每个 `.agent/checks/*.yaml` 通过
   `.agent/quality.schema.json`（schema 不是装饰文档）。
2. **检查项自洽**：
   - `id` 与文件名一致、`stage` 已在 `quality.yaml` 定义、`id` 不重复；
   - `windows_command` 与 `unix_command` 都在（或显式 `platform_support` 声明不支持 + 原因）；
   - 实现脚本 `scripts/checks/<id>.mjs` 存在；
   - **阈值里的每个指标名都能在脚本源码里找到**——防"阈值写了、脚本从不输出"的假门禁；
   - 文档 `docs/quality/<id>.md` 存在、不小于 `scope.docs_min_bytes`、含 id 与阈值说明；
   - `enabled: false` 必须写 `enabled_reason`。
3. **仓库级**：`.gitattributes` 含必需规则（`text=auto`、`*.sh eol=lf`、`*.ps1 eol=crlf`、
   `*.cmd eol=crlf`）；每个包有 lockfile；`.github/workflows/quality.yml` 含 `windows-latest` +
   `ubuntu-latest` 矩阵并分别调用 `scripts/verify.ps1` 与 `scripts/verify.sh`；`docs/QUALITY.md`
   写明 `core.longpaths` 约定。

## 阈值（threshold）

- `errors` = 0（门禁）——修配置/文档/CI，不要删规则
- `checks_scanned`、`docs_scanned`、`packages_checked` 只作观测

## 复现与产物

```sh
node scripts/verify.mjs --only repo-contracts
```

产物：`reports/artifacts/repo-contracts.json`（逐条违规 + 提示 `notes`）。
