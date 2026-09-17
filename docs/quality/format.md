# 检查项 format（文本形态）

- **id**：`format`　**阶段**：`static`　**类型**：`format`　**脚本**：`scripts/checks/format.mjs`
- **required**：是（错误级违规直接让门禁 FAIL）

## 机制

读 `git ls-files` 的**跟踪文本文件**，逐文件判定：

| 规则 | 级别 | 判定 |
| --- | --- | --- |
| `eol-lf` | 错误 | 默认文本文件必须 LF（`.cmd`/`.bat`/`.ps1` 例外） |
| `eol-crlf` | 错误 | `.cmd`/`.bat`/`.ps1` 必须 CRLF |
| `ps1-bom` | 错误 | `.ps1` 必须 UTF-8 with BOM（PS 5.1 无 BOM 时按 ANSI 解码，中文注释会吞掉后续代码） |
| `bom-forbidden` | 错误 | 其它文本文件不得带 BOM |
| `nul-byte` | 错误 | 文本文件里出现 NUL（误把二进制当文本提交） |
| `mixed-eol` | 错误 | 同一文件混用 CRLF/LF 或只有 CR |
| `trailing-whitespace` | 提示 | 行尾空白（存量债见基线） |
| `final-newline` | 提示 | 缺少文件末尾换行（存量债见基线） |

为什么是这些规则而不是"格式化风格"：它们都会让同一份提交在不同平台产生不同结果，是本仓真实踩过的
坑（根 `AGENTS.md` 第 6 节：`.ps1` 无 BOM → 变量赋值被吞；`.cmd` 用 LF → cmd.exe 每行吃掉开头字符）。
仓库没有 prettier，也不为此引根级依赖。

## 阈值（threshold）

- `errors` = 0（错误级违规）——**这是门禁**
- `files_scanned`、`advisories` 只作观测（提示级不进错误计数）

## 存量基线（scope.legacy_violations）

配置里逐条登记已知存量（根级法律文本的 CRLF、被哈希 pin 的 patch 文件、其它所有者的客户端 bundle
与源码）。命中基线的只记 advisory；**新增**违规一律算错误。修好某项后删掉对应条目即可。

## 前提与产物

- 前提：`node` ≥22、`git`（`git ls-files`）；安装步骤见 `scripts/install.ps1` / `install.sh`。
- 复现：`node scripts/verify.mjs --only format`
- 产物：`reports/artifacts/format.json`（逐条违规：路径/规则/证据）+ `reports/artifacts/format.log`。
