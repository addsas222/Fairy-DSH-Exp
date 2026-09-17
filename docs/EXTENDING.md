# 扩展质量体系（EXTENDING.md）

新增一个检查项**只需要三步**，主入口 `scripts/verify.mjs` 一行都不用改——它只做
"读配置 → 自动发现 → 按阶段执行 → 汇总报告"。

```sh
# 1) 加配置（模板里把 <...> 占位符全部替换掉）
cp .agent/templates/check.yaml .agent/checks/<id>.yaml

# 2) 加实现（模板是一份能直接跑的最小骨架，把它改成真实检查）
cp scripts/checks/template.mjs scripts/checks/<id>.mjs

# 3) 加文档（repo-contracts 会校验它存在、足够长、写了阈值说明）
cp .agent/templates/check-doc.md docs/quality/<id>.md

# 立刻可见 + 可跑
node scripts/verify.mjs --list
node scripts/verify.mjs --dry-run --only <id>
node scripts/verify.mjs --only <id>
```

需要安装新工具时：在 `requires[].install` 里写安装步骤，然后
`node scripts/verify.mjs --generate-install` 重新生成 `scripts/install.ps1` / `install.sh`。
CI 也要跟着跑的东西：改 `.github/workflows/quality.yml`（**不要**动既有的 `test.yml`）。

> 新增检查项 id 的命名：小写字母/数字/连字符（`^[a-z][a-z0-9-]*$`），文件名必须叫 `<id>.yaml`，
> 脚本必须叫 `scripts/checks/<id>.mjs`（`repo-contracts` 检查项会核对这三者一致）。

## 1. 检查脚本的契约（只有三条）

1. **入参**：`--check <check.yaml> --repo <仓库根> --report-dir <报告目录> --artifact <产物 JSON 路径>`。
   阈值与作用域从 `check.yaml` 自己读（`readCheckConfig(args.check)`）——这是"主入口不认识检查项"的关键。
2. **指标**：最后往 stdout 打一行

   ```
   <<<QUALITY-METRICS>>> {"errors":0,"files_scanned":334}
   ```

   主入口会用 `threshold.metrics` 逐条判 `min`/`max`；不满足即该项失败。
3. **退出码**：`0` 通过 / `1` 失败 / `2` 内部错误 / `3` 跳过（前提缺失，附 `skip_reason` 指标）。

`scripts/checks/lib/runtime.mjs` 提供了这些工具（全部零依赖）：
`parseCli` / `readCheckConfig` / `run`（带超时与环境变量）/ `runCommandString` / `trackedFiles` /
`git` / `globToRegExp` / `listFiles` / `parseTap` / `pct` / `writeJson` / `finish` / `emitMetrics`。

**别做的事**：不要在自己脚本里 `process.exit(0)` 假装通过；不要吞掉失败；不要依赖 shell 通配符展开
（Windows 的 cmd 不展开 glob）；不要在 Windows 上用 `sudo`/`chmod`/符号链接。

## 2. 检查项 yaml 字段（全部字段的语义）

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `schema_version` | ✅ | 当前为 `1`；结构变更时递增并同步 `quality.schema.json` |
| `id` | ✅ | 唯一 id，`^[a-z][a-z0-9-]*$`；与文件名、脚本名、文档名一致 |
| `title` | ✅ | 一行说明（出现在报告表格） |
| `stage` | ✅ | 必须是 `.agent/quality.yaml` 的 `stages[].id` 之一 |
| `type` | ✅ | `static｜lint｜format｜typecheck｜unit｜coverage｜gherkin｜integration｜e2e｜mutation｜scan｜meta` |
| `enabled` | ✅ | `false` 时本轮不执行（状态 `disabled`），且必须写 `enabled_reason` |
| `required` | ✅ | `true` 时失败/错误/超时/阻塞都会让门禁 FAIL |
| `tags` | ✅ | 便于 `--tags` 选择（如 `static`/`windows`/`slow`/`security`） |
| `command` | ✅ | 可移植兜底命令（同一平台变量替换规则） |
| `windows_command` | ✅ | Windows 用的命令（`\` 分隔路径）；或用 `platform_support.windows` 声明不支持 |
| `unix_command` | ✅ | Linux/macOS 用的命令（`/` 分隔路径）；或用 `platform_support.unix` 声明不支持 |
| `platform_support` | 可选 | `{windows: {supported: false, reason: "…"}, unix: {…}}` → 状态记 `unsupported` |
| `cwd` | ✅ | 工作目录，通常 `${repo}` |
| `env` | ✅ | 追加环境变量（值为字符串；可用 `${...}` 变量） |
| `timeout` | ✅ | 秒；超时整棵进程树被杀，状态 `timeout` |
| `threshold` | ✅ | `{enforce: true, metrics: [{name, min?, max?, unit?, label?, optional?}]}` |
| `artifacts` | ✅ | 仓库相对路径列表（产物 JSON），报告里会列出来 |
| `requires` | ✅ | 前提列表，见下 |
| `install` | ✅ | 检查项级安装步骤（与 `requires[].install` 合并进安装脚本） |
| `docs` | ✅ | 必须是 `docs/quality/<id>.md` 形式且文件存在 |
| `owner` | ✅ | 归属（出问题找谁） |
| `allow_failure` | ✅ | `true` 时失败降级为警告 |
| `on_missing` | 可选 | 前提缺失时的终态：`skip`（警告）/`block`（失败，required 默认）/`fail`（失败） |
| `enabled_reason` | 可选 | `enabled: false` 的必填说明 |
| `description` / `scope` | 可选 | 一句话说明 / 检查项自用的配置段（脚本自己解析，主入口不解释它） |

### requires 的 `kind`

| kind | 字段 | 判定 |
| --- | --- | --- |
| `tool` | `name`、`probe`、`min_version?` | 跑 `probe`；退出码 0 且版本达标才算就绪 |
| `env` | `env` | 环境变量存在 |
| `path` | `path` | 仓库内路径存在 |
| `check` | `id` | 依赖的另一检查项状态是 `passed`/`disabled` |
| `home` | `name?`/`env?` | `DSH_HOME`（默认 `~/.dsh`）存在 |

每个 require 建议都写 `reason`（为什么需要）与 `manual`（人工安装命令）——报告会把它打给用户。

### install 的 `strategy`

优先级：`local`（项目本地依赖）> `winget --scope user` > `scoop` > `choco`（**只写文档**）。

```yaml
install:
  - strategy: local
    command: node "scripts/checks/lib/deps-install.mjs" --repo .
    reason: 项目本地安装，免提权
  - strategy: winget
    command: winget install --id Example.Tool --source winget   # 生成器自动补三件套参数
    admin: false
  - strategy: scoop
    command: scoop install example
  - strategy: choco          # admin: true 或 strategy=choco 一律只进注释，不执行
    command: choco install example -y
    admin: true
    reason: 需要管理员权限
```

生成器（`scripts/checks/lib/install-gen.mjs`）会写成"先探测已就绪 → 再 winget → 再 scoop →
否则打印手动命令"，并把每次尝试追加进 `reports/install.log`。生成脚本头部标注勿手改。

## 3. 变量替换（命令 / cwd / env 值里可用）

`${repo}`、`${repoNative}`、`${config}`、`${check}`、`${checkDir}`、`${reportDir}`、`${artifactDir}`、
`${artifact}`、`${checkLog}`、`${node}`、`${npm}`、`${pnpm}`、`${python}`、`${os}`、`${tmp}`、
`${stage}`、`${id}`、`${schemaVersion}`。

未知变量会**直接报错**（不会静默留空，避免"命令跑了个空路径还以为通过"）。

## 4. 加行为用例（Gherkin）

1. 在 `features/` 下加 `*.feature`（`Feature/Background/Scenario/Scenario Outline + Examples`、
   标签、`#` 注释都支持）；不想被执行的文件加 `@skip` 标签（例如模板文件）。
2. 步骤定义放 `features/steps/*.mjs`，默认导出 `{ steps: { 'Given 文本': fn, '我新增 {int} 条': fn } }`：
   - 文本键支持 `{string}`（带引号字符串）、`{int}`、`{float}`、`{word}` 占位符，也支持 `/正则/`；
   - 第一个参数是场景内共享的 `world`（每个场景全新）；返回值可以是 Promise；
   - 想表达"还没实现"用 `{ pending: true }`（计入 pending，门禁会红）。
3. 跑：`node scripts/verify.mjs --only gherkin`（或 `node scripts/checks/gherkin.mjs --check .agent/checks/gherkin.yaml --repo . --report-dir reports`）。
4. 门禁：`failed/undefined/pending/ambiguous/语法错误` 全部必须为 0。

现成例子：`features/quality/quality-system.feature` + `features/steps/quality-system-steps.mjs`
（7 个场景，进程内驱动主入口的 lib API）。

## 5. 加单元测试（`tests/` 与包内 `test/`）

- **包内的测试**（`<包>/test/*.test.js`）会被 `unit` 与 `coverage` 自动带上，什么都不用配。
- 质量体系**自身**的行为验证：优先放 Gherkin（`features/`），因为 `unit` 只跑包；
  端到端行为放 `scripts/checks/e2e.mjs` 的场景数组（那里是真起 CLI 子进程）。
- `tests/` 目录不入任何自动发现（里面放模板 `template.test.mjs` 供人复制）。

## 6. 加新阶段

`.agent/quality.yaml` 的 `stages` 里加一条（`id`/`title`/`order`/`concurrency`），
然后在新检查项里用这个 `id`。`order` 决定执行顺序，`concurrency` 决定阶段内并行度
（CPU 密集的测试阶段建议 1）。

## 7. 改阈值 / 关闭检查项的正确姿势

- 阈值：改 `threshold.metrics[].min|max`。**不要**为了让门禁变绿而放宽——先在报告里看清是哪个指标、
  差多少，再决定是修代码还是修阈值（并在 PR/文档里说明理由）。
- 关闭：`enabled: false` + `enabled_reason` + `docs/quality/<id>.md` 写清"为什么关、怎么启用"。
  `repo-contracts` 会校验三者齐全，门禁的 `max_disabled_checks` 也会限制数量。
- 已知存量债（例如老文件的行尾）：写进该检查项 `scope` 的基线列表（附原因），让**新增**违规依然红。

## 8. 提交前自检清单

```sh
node scripts/verify.mjs --list                  # 新检查项被发现了吗？
node scripts/verify.mjs --dry-run --only <id>   # 平台命令对吗？
node scripts/verify.mjs --only <id>             # 单独跑通了吗？
node scripts/verify.mjs --only repo-contracts   # 体系自洽（文档/schema/阈值指标/CI）过了吗？
node scripts/verify.mjs --generate-install      # requires 变了就重新生成安装脚本
```

`reports/quality-report.md` 与 `reports/artifacts/<id>.log` 是最终证据；把它们一起附在结论里。
