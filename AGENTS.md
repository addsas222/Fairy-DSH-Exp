# AGENTS.md — Fairy-DSH 仓库说明与部署指引

面向在本仓库里工作的 DSH agent 与部署者。**先读第 2 节跑部署脚本，再按第 3 节
验证**；第 5 节的硬约束是红线。

（文件名：DSH 只加载 `AGENTS.md` 与 `CLAUDE.md`，单数 `AGENT.md` 不会被读取。）

## 1. 仓库信息

**Fairy-DSH** 是一套 DSH（DeepSeek Harness）插件集合：把人格、语音（TTS/STT）、
会话模式流水线、搜索枢纽、长期记忆、浏览器 Dock、视觉舞台等能力做成可独立安装的包，
并把"怎么装、怎么验、怎么升级"固化成脚本与门禁。

### 1.1 版本钉定

| 项 | 值 |
| --- | --- |
| DSH | **0.1.1-rc.2**（capability matrix、官方 runtime SHA-256、upgrade-preflight 批准记录都以它为准） |
| Node | CI 固定 **22**（`.github/workflows/test.yml`）；各包未声明 `engines`，测试用内置 `node --test` |
| pnpm | ≥ 11（每个包各自带 lockfile，逐包安装） |
| 社区包 dsh-web | 需 **≥ 0.1.5-rc.1**，与本仓分居客户端面孔切换线两侧（0.1.2 起移除 `@deepseek-ai/dsh-client-runtime`），同一 profile 不能共跑；详见 `fairy-system/DSH-WEB-COMPAT.md` |

### 1.2 包清单（9 个插件包 + 支撑目录）

| 路径 | 作用 |
| --- | --- |
| `fairy-persona/dsh-fairy-persona/` | 人格包引擎：文档 + 调色属性 + 语音绑定热切换。端点 `/fairy-persona/*` |
| `fairy-modes/dsh-fairy-modes/` | 五模式引擎（极简 Explore&Check=官方 plan / 探查只读 / PTC Build&Work / 创造 Memory&Dream / 角色扮演），含 `session_recall` 与 `mode_pipeline` 工具；后者把四个站点串成流水线（扮演→探查→建造→创造→回到扮演），进探查站会尝试自动打开官方 plan 审批闸门，离开走 `exit_plan_mode`。端点 `/fairy-modes/*` |
| `fairy-search/dsh-fairy-search/` | 搜索枢纽：deepseek / exa / perplexity / 自定义路由 + MCP 片段生成。端点 `/fairy-search/*` |
| `fairy-memory/dsh-fairy-memory/` | 长期记忆：**GBrain 主用**（MCP，按官方 `MEMORY_VERBS_v1`），mem0 / 自定义 HTTP / 本地 Markdown 备选；`memory_recall`/`memory_remember` 工具 + CLI。端点 `/fairy-memory/*` |
| `fairy-roleplay/dsh-fairy-roleplay/` | 角色扮演（`/mode roleplay`，流水线环的起点与回环点）：去AI味检查器（L1 词表 → L4 通读）+ 风格库（当…时，可以用…）+ 规划/时机/回复规则；`roleplay_check`/`roleplay_style` 工具 + 设置卡。端点 `/fairy-roleplay/*` |
| `fairy-voice/dsh-fairy-voice/` | TTS provider 注册表（local-sovits / openai / elevenlabs-ws / kokoro-web / kitten-web / piper-web / browser / custom-http）与 STT（网上：browser / openai / deepgram / azure / custom-http；本地：whisper-web、或 openai 指向 loopback）。端点 `/fairy-voice/*` |
| `fairy-visual/` | 视觉舞台（HDD 视觉与身份），客户端产物由 tsdown 生成 |
| `balance-meter/` | 余额指示 |
| `browser-dock/` | 浏览器 Dock（宿主插件 + 独立 `proxy.cjs` 进程 + `fs.watch` 状态桥） |
| `fairy-startup/` | 启动动作（恢复会话选择、按 workspace 就绪开新会话） |
| `fairy-contracts/` | 跨插件契约与诊断边界；各插件以 `link:` 依赖它 |
| `fairy-system/` | 验证/预检/审计工具：`verify-build.js`、`image-manifest.js`（清单 prune + 镜像 vs 源对账）、`verify.js`、`check.sh`、`accepted-baseline.js`、`upgrade-preflight.js`、`skill-audit.js`、`scaffold-plugin.js` |
| `persona-packs/{fairy,standard}/` | 内置人格包（`persona.yml` + `prompt.md` + `tone.json`） |
| `.agent-presets/ponytail/` | 模式预设（**公开入口**；modes 与 memory 的 agent 面 shim）。ponytail 规则技能按上游 MIT **本机安装**、不入库；部署时由 `deploy-live.sh` 从本机技能根同步进 preset 的 `skills/` 槽位（槽位在跳过策略里，不参与对账/prune；可用 `DSH_FAIRY_SKILLS_DIR` 指定来源） |
| `.agent-presets/fairy/` | 私有部署预设（依赖未公开的 runtime 资产，公开仓库里必然 broken） |
| `profiles/web/` | Web profile：组合各插件、pin 搜索 provider、接管部署 persona |
| `scripts/` | `deploy-live.sh`（部署）、`test-isolated.sh`（本地回路） |
| `fairy-system/PONYTAIL-DESIGN.md` | 三模式与人格/语音绑定的设计记录 + 0.1.1 运行时契约 |
| `fairy-system/DSH-WEB-COMPAT.md` | 与社区包 dsh-web 的共存分析与版本地板 |

### 1.3 形态约定（改代码前必读）

- 插件包三件套：**宿主桥面**（默认导出，`lib/index.js` 或 `lib/bridge.js`）、
  **agent 面**（`./engine`，注册工具）、**客户端 bundle**（`./client`）。
- 客户端是手写/构建产物，形态为 `window.__ModuleLoader__.load({ id, factory })`；
  插槽只用 `settings.section`、`conversation.session.header.utilities`、
  `conversation.input.left`。
- 有 `src/` 的包（browser-dock、fairy-visual、fairy-memory）**必须重建**：
  `pnpm bundle`（fairy-memory 为 `node scripts/bundle.mjs`），`lib/**` 是产物。
- 预设行名只能是字面字符串或预设内相对路径；`$DSH_HOME` 下被 link 的包只能经
  **预设内 shim**（`DSH_FAIRY_REPO_ROOT` 解析真身）或文件路径加载。
- 预设必须**复制**进 `$DSH_HOME/.agent-presets/`：`readdir` 的
  `Dirent.isDirectory()` 对 symlink/junction 为假，链接形态不会被发现。

## 2. 安装与部署

### 2.1 一键部署（推荐）

```sh
git clone https://github.com/addsas222/Fairy-DSH-Exp.git fairy-dsh && cd fairy-dsh
./scripts/deploy-live.sh --home "$HOME/.dsh"          # 或 --home /path/to/DSH_HOME
```

**来源（改这里之前先读）**：本机实际部署与隔离实例都取
`addsas222/Fairy-DSH-Exp` 的 `main` 分支（2026-09 起仓库只保留这一条）；另有两个同源分支在别处被用到，别混：

| 位置 | 来源 | 与本仓的关系 |
| --- | --- | --- |
| `C:\Users\Administrator\fairy-dsh`（本部署源） | `addsas222/Fairy-DSH-Exp` @ `main` | **canonical**：镜像与隔离实例都从它落位 |
| `F:\世界观\Fairy-DSH` | `Chengzhibense/Fairy-DSH` | 停在更早提交（`d639887`）且带未提交改动；被 `~/.dsh` 主 profile 以 `link:` 引用 |
| `Guzhou2002/Fairy-DSH-Optimized` | 安装包下载说明里的地址 | 第三方再分发，未在本机使用 |

除 `browser-dock/proxy.cjs` 的浏览器接管外，`F:` 的其余未提交改动（per-package
`cordis.patch.yml` 桩、`dsh.bundle.patch` 键）属于已被 profile 级 patch 取代的旧结构，
**不要**照搬回本仓。

脚本按 AGENTS.md 原先的手工步骤做了这样几件事：**与源对账**（删掉提交里已删、
镜像里还留着的文件）→ 落位受控文件 → 逐包安装依赖 → 安装 `profiles/web` →
EvoMap 接入 → 跑两道门禁（构建契约 + 镜像对账）。常用开关：

| 开关 | 用途 |
| --- | --- |
| `--from-worktree` | 用当前工作树部署（含未提交改动）；开发回路常用。对账也随之改成对工作树 |
| `--preserve LIST` | 逗号分隔的仓库相对路径：**保留镜像里的现有内容**，既不清理也不按提交覆盖（本机适配用，见 §3） |
| `--evomap` | 强制在非默认 `--home` 上执行第 5 步（默认只对真实部署执行，见下） |
| `--skip-evomap` | 跳过 EvoMap 接入。**无人值守/CI 一律带上**（该步会向外网注册并产生本机凭据） |
| `--skip-install` | 只落文件不装依赖（离线排障）；两道门禁仍会跑 |
| `--no-verify` / `--dry-run` | 跳过两道门禁 / 只打印将执行的命令 |

> Windows：本机 `bash` 可能被 WSL 抢占（`/bin/bash` 不存在）。脚本已写成
> **POSIX sh**，用 `sh scripts/deploy-live.sh …` 运行即可。

### 2.2 手工等价（脚本内容的来源）

```sh
REPO=$PWD; DSH_HOME=$HOME/.dsh

# 1) ponytail 规则技能（第三方 MIT，不入库）：从本机技能根同步进 preset 的 skills/ 槽位。
#    槽位在 image-manifest 的跳过策略里（既不删也不报），所以必须在**对账之前**同步。
SKILLS_SRC="${DSH_FAIRY_SKILLS_DIR:-$HOME/.omp/agent/skills/_ponytail-vendor}"
if [ -d "$SKILLS_SRC" ]; then
  mkdir -p "$DSH_HOME/.agent-presets/ponytail/skills"
  cp -R "$SKILLS_SRC/." "$DSH_HOME/.agent-presets/ponytail/skills/"
fi

# 2) 对账：删掉受控路径下「提交里已经没有」的文件（收敛语义的关键一步；
#    落位只新增/覆盖，从不删除，少了这步上游删过的文件会永远留在镜像里）
node "$REPO/fairy-system/image-manifest.js" prune --repo "$REPO" --home "$DSH_HOME"

# 3) 落位受控文件（发布形态取 HEAD；开发形态从工作树 tar --exclude=node_modules,.git）
for area in browser-dock/dsh-browser-dock balance-meter/dsh-balance-meter \
            fairy-startup/dsh-fairy-startup fairy-visual/dsh-fairy-visual \
            fairy-voice/dsh-fairy-voice fairy-persona/dsh-fairy-persona \
            fairy-modes/dsh-fairy-modes fairy-search/dsh-fairy-search \
            fairy-memory/dsh-fairy-memory \
            fairy-roleplay/dsh-fairy-roleplay; do
  git -C "$REPO" archive HEAD -- "$area" | tar -x -C "$DSH_HOME"
done
git -C "$REPO" archive HEAD -- fairy-contracts fairy-system persona-packs \
    .agent-presets/ponytail .agent-presets/fairy profiles/web | tar -x -C "$DSH_HOME"

# 4) 逐包安装依赖（每个包自带 lockfile；link: 依赖要各自 node_modules）
for area in browser-dock/dsh-browser-dock balance-meter/dsh-balance-meter \
            fairy-startup/dsh-fairy-startup fairy-visual/dsh-fairy-visual \
            fairy-voice/dsh-fairy-voice fairy-persona/dsh-fairy-persona \
            fairy-modes/dsh-fairy-modes fairy-search/dsh-fairy-search \
            fairy-memory/dsh-fairy-memory \
            fairy-roleplay/dsh-fairy-roleplay; do
  (cd "$DSH_HOME/$area" && pnpm install --ignore-scripts)
done

# 5) profile 安装（新增 link 依赖后需 --no-frozen-lockfile 重生成锁文件）
(cd "$DSH_HOME/profiles/web" && pnpm install --no-frozen-lockfile --ignore-scripts)

# 6) EvoMap 接入（Layer 1，失败不阻断部署）
node "$DSH_HOME/fairy-memory/dsh-fairy-memory/lib/memory-cli.js" evomap join --name "Fairy DSH" \
  || echo "evomap join 未完成（离线或 Hub 不可达）：部署继续，稍后重跑即可。"

# 7) 启动
export DSH_FAIRY_REPO_ROOT="$DSH_HOME"   # ponytail 预设的 shim 与 persona 扫描根
dsh --profile web --no-open
```

**手工等价与脚本的一处差异（开发形态）**：上面第 2 步的 `tar --exclude=node_modules,.git`
只排除两个固定名字，而 `deploy-live.sh --from-worktree` 还会排除 **git 忽略的文件**（`.env`、
`logs/` 之类）——清单用的是 `git ls-files --exclude-standard`，落位必须同口径，否则被忽略的
文件会被门禁报成 extra、prune 删掉、下次落位又加回来（永不收敛）。两个例外照旧落位：
被忽略但登记在 `fairy-system/image-manifest.js` 的 `SKIP_POLICY` 里的路径（例如
`.agent-presets/fairy/runtime`），以及 `--preserve` 声明的本机适配。

**EvoMap 第 6 步的语义**：按该服务自身的分层设计只做 Layer 1——恢复或注册节点，
打印 `claim_url` 由操作者打开完成绑定；`node_secret` 以 0600 落在 `~/.evomap`
（沙箱用 `EVOMAP_HOME` 换目录），永不打印、不入日志/仓库；**幂等**（已有凭据只
做探测，不重复注册）；**失败不阻断**（离线只提示）。心跳（stay online）与任务
操作需各自的明确授权，不在部署内。

**默认规则（防止在沙箱里顺手注册真节点）**：`--home` 指向**默认** `$DSH_HOME` 时
执行第 6 步，失败不阻断；`--home` 指向**别处**（探针/沙箱）时**自动跳过**并提示——确实要
在那里注册就加 `--evomap`，只想看命令形态用 `--dry-run`。

### 2.3 本地快速回路（原地用仓库，不落 live 布局）

```sh
DSH_HOME="$PWD/.dsh-test-home" ./scripts/test-isolated.sh
```

该脚本：暂存预设到隔离 home → 逐包安装依赖（已装则跳过）→ 逐包测试 → profile 依赖
安装 → 启动冒烟（要求 `dsh` 在 PATH）。它不向系统写东西，`.dsh-test-home/` 已在
`.gitignore` 内。只想起服务时，手动等价见 §2.2（那条循环就是脚本逐步做的事）。

## 3. 部署后验证

```sh
# 从仓库根执行；DSH_HOME 已按第 2 节导出
node fairy-system/verify-build.js     # 构建契约：10 包，exit 0
node fairy-system/skill-audit.js      # 技能/插件冗余审计（--self-test 自检）

# 镜像 vs 源的对账（只读；部署第 6 步自动跑的就是它）
node fairy-system/image-manifest.js check --repo . --home "$DSH_HOME"
node fairy-system/image-manifest.js --self-test        # 清单/prune 自检
```

`image-manifest.js check` 报**三类**差异并以 exit 1 判决：`extra`（镜像里有、
清单里没有 —— 上游删过的文件残留在这里）、`missing`（清单里有、镜像里没有）、
`drifted`（两边都有、内容不同）。它是唯一会看「多出来的文件」的门禁：`verify-build.js`
只查 manifest、产物新鲜度与禁用字符串，多出来的死产物不在它的射程内——这也正是
20260828 半成品镜像全绿通过的原因。判定用 git blob 口径（两侧同式），
`node_modules`、运行期产物与私有资产按跳过策略忽略（`image-manifest.js policy` 可看全表）。

本机适配（例如未装 Chrome 时 `profiles/web/cordis.patch.yml` 改用 `msedge`）走
`--preserve <仓库相对路径>`：该路径保留镜像现有内容，检查会把它列在 `allowed`
而不计差异。**不要**靠改断言让门禁变绿；差异要么修，要么按 `--preserve` 显式声明。

```sh
# 全矩阵（10 个测试面）
node --test --test-timeout=45000 fairy-system/test/*.test.js   # 47 例
(cd fairy-memory/dsh-fairy-memory && node --test test/*.test.js)  # 其余包同理
(cd fairy-roleplay/dsh-fairy-roleplay && node --test test/*.test.js)
```

**包测试的前提：依赖必须先逐包装好**。clone 里没有 `node_modules`，而各包的
`link:` 依赖（`dsh-fairy-contracts`）不会自动就位；直接从仓库根跑包测试会得到
`ERR_MODULE_NOT_FOUND: Cannot find package 'dsh-fairy-contracts'`。两条正确路径：

```sh
# a) 在部署镜像里跑（依赖已由 deploy-live.sh 第 3 步装好，推荐）
(cd "$DSH_HOME/fairy-roleplay/dsh-fairy-roleplay" && node --test test/*.test.js)

# b) 在 clone 里跑：先逐包安装（与 CI 的 install 步骤等价）
for area in fairy-visual/dsh-fairy-visual fairy-voice/dsh-fairy-voice \
            fairy-persona/dsh-fairy-persona fairy-modes/dsh-fairy-modes \
            fairy-search/dsh-fairy-search fairy-memory/dsh-fairy-memory \
            fairy-roleplay/dsh-fairy-roleplay; do
  (cd "$area" && pnpm install --frozen-lockfile --ignore-scripts)
done
```

`scripts/test-isolated.sh` 的第 1 步就做这件事（已装过的包自动跳过），所以那条
回路是自足的。

`fairy-system/test/*` 里比较"当前 live 布局"的用例需要真实安装前提：
`DSH_HOME`（隔离 home）+ `DSH_OFFICIAL_PACKAGE` / `DSH_OFFICIAL_RUNTIME` 指向已
安装的 0.1.1-rc.2；缺这两个旋钮时它们没有比较对象（不是断言放宽）。（纯 Windows
机器上 `verify.js`/`check.sh` 依赖 macOS live 布局，不适合作为本地验证入口；
`verify-build.js` 与 `image-manifest.js` 才是跨平台的那两道。）

具体一点：**没有官方安装时 `preflight.test.js` 与 `upgrade.test.js` 会整组失败**
（13 例，症状是 `DSH_PREFLIGHT_ERROR scope="dsh_version" … actual="ENOENT"`——
预检按 `~/.local/lib/node_modules/@deepseek-ai/dsh/package.json` 找官方包，
Windows 默认根本没有这个路径）。这是环境前提，不是代码回归：这两组用例只在
存在官方 0.1.1-rc.2 安装的机器上才有意义。其余 34 例（含新增的 12 例
`image-manifest.test.js`）不依赖官方安装，任何平台都该全绿。

**预设健康检查**（发现器的真实判定，避免"能启动但选不中"；服务运行中执行，
端口取启动日志 `dsh web: http://127.0.0.1:<port>`）：

```sh
curl -s -X POST -H 'content-type: application/json' \
  -d '{"type":"client-request","rpcId":"t1","method":"agentPreset.list","payload":{}}' \
  http://127.0.0.1:<port>/api/agentPreset.list \
| node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{for(const p of JSON.parse(s).result.value.presets)console.log(p.id,p.trust,p.broken?'BROKEN: '+p.broken:'')})"
```

期望：`standard/code/minimal/cordis` 为 `system`，`ponytail` 为 `user`，
`fairy` 为 `user ok`（私有 runtime 缺失时走降级模式，见下）。

`fairy` preset 的两处历史缺陷**已修复**（2026-09）：

1. **行名不合规**（已修）：`agent.cordis.yml` 第 2/3 行原用
   `name: !!js process.env.DSH_FAIRY_REPO_ROOT + '/.agent-presets/fairy/runtime/index.js'`，
   而发现器的 `entryListProblem` 要求 `name` 必须是**字符串**——这会让整个 preset 判 BROKEN。
   现改为 preset 内相对路径 shim（`./plugins/fairy-core-runtime.mjs`、
   `./plugins/fairy-safety-gate.mjs`），与 ponytail preset 的行名约定一致。
2. **私有 runtime 缺失**（已降级处理）：`runtime/index.js`、`runtime/safety-gate.js`、
   `runtime/fairy_core.py`、`runtime/compiler.js` 等**从未进过任何公开仓库**
   （本仓与 `Chengzhibense/Fairy-DSH` 全历史、工作树、两个 home 皆无）。两个 shim 因此
   先尝试 `import` 私有真身，**缺失时走降级路径**：把随 preset 分发的语料
   （`behavior/fairy_behavior_rules.json` 334 KB 规则、`personality/*` 55 KB traits、
   `canon/*` 12 KB、`style/*` 9 KB）编译成一段注入系统提示的速查表，
   并提供保守的风险闸门（高风险动作先"警告。"并要求确认）。
   降级路径**不含**原 runtime 的统计式语音选择，其余人格与规则照常生效。

实测（隔离实例，`agentPreset.list`）：修复前 `fairy user BROKEN: …`；修复后
`fairy user ok`，且 10 个插件全部 `apply: outcome=success`。

因此公开 clone 上 `fairy` 现在**可用**（降级模式）；把私有 `runtime/` 放到
`$DSH_FAIRY_REPO_ROOT/.agent-presets/fairy/runtime/` 即自动切换为完整模式，无需改配置。

完整链（需 live macOS 部署：`launchers/`、LaunchAgents、语音服务）：
`./fairy-system/check.sh`。基线只读对比：`node fairy-system/accepted-baseline.js --diff`。

## 4. 版本边界与升级

- 升级 DSH 必须走 `fairy-system/upgrade-candidate-preflight.sh`，并同步 client
  face 清单、selector 契约与 accepted baseline；不要靠改断言让检查变绿。
- 工具呈现取值随 cohort 改名：0.1.1 为 `native|code|both`，0.1.2+ 为
  `native|ptc|both`；`fairy-modes` 按 `systemPrompt.getSectionOrder` 是否存在自动判别。
- dsh-web 共存分析与版本地板见 `fairy-system/DSH-WEB-COMPAT.md`（含
  `settings.section` order 登记表，新增设置卡必须登记，否则与 dsh-web 冲突）。

## 5. 硬约束（不要做）

1. **不要**改 DSH 官方安装与 runtime（只读边界）；升级走候选择预检流程。
2. **不要**为让检查变绿运行 `accepted-baseline.js --accept`：接受基线是人工审查
   后的发布级动作。
3. **不要**在 CI / `scripts/test-isolated.sh` / `package.json` postinstall / 任何
   自动化里调用 `evomap join`：它会向外网注册节点并产生本机凭据，还会让测试
   依赖外网。测试一律用假 hub + `EVOMAP_HOME` 覆盖目录。
4. **不要**手改 `profiles/web/pnpm-lock.yaml`，也不要跳过逐包安装：CI 与
   `test-isolated.sh` 用 `--frozen-lockfile`，锁文件与 `package.json` 不同步即失败。
5. **不要**把插件包名写进预设行，也不要把预设目录以链接形式放进
   `$DSH_HOME/.agent-presets/`（原因见 1.3）。
6. **不要**在隔离 home 之外做验证性写入：测试必须用独立 `DSH_HOME`，不得指向
   生产目录，也不得往真实 `~/.dsh` 补资产。

## 6. 排障

- **浏览器 Dock 的"在外部浏览器接管一次"没反应**：接管在 Windows 上走
  `cmd /d /s /c start "" "…"`，浏览器由 `DSH_FAIRY_HANDOFF_BROWSER` 选（空=系统默认）。
  本机没装 Chrome，隔离实例取 `msedge`；没设这个变量又盯着 Chrome 找，会以为功能坏了。
  两个已实测的坑（改这一段前先复测，别再凭直觉）：
  1. **URL 必须显式加引号**：含 `&` 的查询串会被 cmd 当命令分隔符拆开
     （`cmd /c start "" http://x/p?a=1&b=2` → 浏览器只拿到 `?a=1`，并报
     `'b' is not recognized …`）。Node 的 win32 转义不会替 `&` 加引号，所以走手拼
     命令行 + `windowsVerbatimArguments`。
  2. **浏览器路径含空格必须加引号**：本机默认浏览器是 `MSEdgeHTM`，其 exe 位于
     `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`；不加引号时它会被
     `start` 的窗口标题槽当成标题，**什么都不启动**。
  `--user-data-dir` 两个平台都带：接管的意义就是延续会话，而 `closeBrowser()` 之后
  profile 已释放（实测可见窗口起得来、会话数据仍在）；只有浏览器**还占着** profile
  时第二个实例才会 exit 21。spawn 失败是诊断事件（`proxy.takeover.spawn`），
  不再掀掉整个 proxy 进程。
- **实机看到旧行为**：`$DSH_HOME` 下是各包的**一份副本**，改完包必须重新落位
  （`scripts/deploy-live.sh`，或至少同步该包目录）再起服务，否则验证到的是旧代码。
  客户端 bundle 按请求 + rev 现场读取，文件一换 rev 就变，无需重启服务。
- **行尾**：`.gitattributes` 固定 `eol=lf`，`profiles/web/patches/*.patch` 另标
  `-text`（其哈希是被 pin 的字节）。若见"源码文本断言"型失败，把命中文件按索引
  字节落盘再重跑（`git checkout` 会跳过 stat 未变的文件，且会丢弃未提交改动）：

      git cat-file -p :profiles/web/patches/dsh-message-edit@0.2.3.patch > \
        profiles/web/patches/dsh-message-edit@0.2.3.patch

- **构建契约报"manifest 比产物新"**：该检查只对**有构建脚本**的包生效。命中时跑
  该包的 `pnpm bundle`（fairy-memory：`node scripts/bundle.mjs`）重建产物。
- **镜像与提交不一致（半成品镜像）**：症状是某个包整个缺失、某个 `lib/*.js`
  不存在、或镜像里留着提交已删的死文件（例如曾经的 `lib/index.iife.js`）。
  只读定位：`node fairy-system/image-manifest.js check --repo . --home "$DSH_HOME"`
  —— `extra` 是镜像多出来的（上游删过），`missing` 是没落位的，`drifted` 是内容
  对不上的。修复：重跑 `scripts/deploy-live.sh`（第 1 步对账会先删多余文件）。
  本机适配（`msedge` 之类）用 `--preserve profiles/web/cordis.patch.yml` 声明，
  它会列在 `allowed` 而不计差异。
- **预设选不中/凭空消失**：检查是否为链接形态（必须复制）、行名是否字面字符串、
  以及 `DSH_FAIRY_REPO_ROOT` 是否导出。
- **隔离实例的启动器报 `Test-Path … 参数是空值` / `$Runtime` 为 null**：`.ps1` 必须是
  **UTF-8 with BOM**。Windows PowerShell 5.1（本机 `powershell.exe` 就是它，没有
  `pwsh`）对**没有 BOM** 的 `.ps1` 按 ANSI/GBK 解码；启动器里全是中文注释，误码后会
  连 `$Runtime = 'C:\tmp\dsh-011\…\bin.js'` 这行赋值一起吃掉 —— 于是运行期
  `$Runtime` 是 null，`Test-Path` 立刻失败，实例起不来。实测同一份内容：
  带 BOM → `$Runtime` 正常、实例启动；不带 BOM → 必现上述报错。
  改动/重写启动器后确认头三个字节是 `ef bb bf`：
  `node -e "const b=require('fs').readFileSync('start-fairy.ps1');console.log(b.slice(0,3).toString('hex'))"`。
  （`start-fairy.ps1` 不在仓库里——它是主机侧生成的启动器，别指望重新落位会带上 BOM。）
- **Windows**：`bash` 可能被 WSL 抢占 → 用 `sh`；目录链接用 junction；测试里的
  权限位断言（`chmod 0o600`）在 Windows 不可表达，各包已按平台跳过。
- **MCP 行**（playwright/context7）会拉起子进程；隔离 home 缺 `@playwright/mcp`
  的 `.bin` 时对应行报 ENOENT，属环境耦合，不影响其余插件。
