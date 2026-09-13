# AGENTS.md — Fairy-DSH 仓库说明与部署指引

面向在本仓库里工作的 DSH agent 与部署者。**先读第 2 节跑部署脚本，再按第 3 节
验证**；第 5 节的硬约束是红线。

（文件名：DSH 只加载 `AGENTS.md` 与 `CLAUDE.md`，单数 `AGENT.md` 不会被读取。）

## 1. 仓库信息

**Fairy-DSH** 是一套 DSH（DeepSeek Harness）插件集合：把人格、语音（TTS/STT）、
三模式、搜索枢纽、长期记忆、浏览器 Dock、视觉舞台等能力做成可独立安装的包，
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
| `fairy-modes/dsh-fairy-modes/` | 三模式引擎（极简 Explore&Check / PTC Build&Work / 创造 Memory&Dream），含 `session_recall` 工具。端点 `/fairy-modes/*` |
| `fairy-search/dsh-fairy-search/` | 搜索枢纽：deepseek / exa / perplexity / 自定义路由 + MCP 片段生成。端点 `/fairy-search/*` |
| `fairy-memory/dsh-fairy-memory/` | 长期记忆：**GBrain 主用**（MCP，按官方 `MEMORY_VERBS_v1`），mem0 / 自定义 HTTP / 本地 Markdown 备选；`memory_recall`/`memory_remember` 工具 + CLI。端点 `/fairy-memory/*` |
| `fairy-voice/dsh-fairy-voice/` | TTS provider 注册表（local-sovits / openai / elevenlabs-ws / kokoro-web / kitten-web / piper-web / browser / custom-http）与 STT（网上：browser / openai / deepgram / azure / custom-http；本地：whisper-web、或 openai 指向 loopback）。端点 `/fairy-voice/*` |
| `fairy-visual/` | 视觉舞台（HDD 视觉与身份），客户端产物由 tsdown 生成 |
| `balance-meter/` | 余额指示 |
| `browser-dock/` | 浏览器 Dock（宿主插件 + 独立 `proxy.cjs` 进程 + `fs.watch` 状态桥） |
| `fairy-startup/` | 启动动作（恢复会话选择、按 workspace 就绪开新会话） |
| `fairy-contracts/` | 跨插件契约与诊断边界；各插件以 `link:` 依赖它 |
| `fairy-system/` | 验证/预检/审计工具：`verify-build.js`、`verify.js`、`check.sh`、`accepted-baseline.js`、`upgrade-preflight.js`、`skill-audit.js`、`scaffold-plugin.js` |
| `persona-packs/{fairy,standard}/` | 内置人格包（`persona.yml` + `prompt.md` + `tone.json`） |
| `.agent-presets/ponytail/` | 三模式预设（**公开入口**；自带 ponytail 规则技能、modes 与 memory 的 agent 面 shim） |
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
git clone https://github.com/Chengzhibense/Fairy-DSH.git fairy-dsh && cd fairy-dsh
./scripts/deploy-live.sh --home "$HOME/.dsh"          # 或 --home /path/to/DSH_HOME
```

脚本按 AGENTS.md 原先的手工步骤做了四件事：落位受控文件 → 逐包安装依赖 →
安装 `profiles/web` → EvoMap 接入 → 跑构建契约。常用开关：

| 开关 | 用途 |
| --- | --- |
| `--from-worktree` | 用当前工作树部署（含未提交改动）；开发回路常用 |
| `--evomap` | 强制在非默认 `--home` 上执行第 4 步（默认只对真实部署执行，见下） |
| `--skip-evomap` | 跳过 EvoMap 接入。**无人值守/CI 一律带上**（该步会向外网注册并产生本机凭据） |
| `--skip-install` | 只落文件不装依赖（离线排障） |
| `--no-verify` / `--dry-run` | 跳过契约检查 / 只打印将执行的命令 |

> Windows：本机 `bash` 可能被 WSL 抢占（`/bin/bash` 不存在）。脚本已写成
> **POSIX sh**，用 `sh scripts/deploy-live.sh …` 运行即可。

### 2.2 手工等价（脚本内容的来源）

```sh
REPO=$PWD; DSH_HOME=$HOME/.dsh

# 1) 落位受控文件（发布形态取 HEAD；开发形态从工作树 tar --exclude=node_modules,.git）
for area in browser-dock/dsh-browser-dock balance-meter/dsh-balance-meter \
            fairy-startup/dsh-fairy-startup fairy-visual/dsh-fairy-visual \
            fairy-voice/dsh-fairy-voice fairy-persona/dsh-fairy-persona \
            fairy-modes/dsh-fairy-modes fairy-search/dsh-fairy-search \
            fairy-memory/dsh-fairy-memory; do
  git -C "$REPO" archive HEAD -- "$area" | tar -x -C "$DSH_HOME"
done
git -C "$REPO" archive HEAD -- fairy-contracts fairy-system persona-packs \
    .agent-presets/ponytail .agent-presets/fairy profiles/web | tar -x -C "$DSH_HOME"

# 2) 逐包安装依赖（每个包自带 lockfile；link: 依赖要各自 node_modules）
for area in browser-dock/dsh-browser-dock balance-meter/dsh-balance-meter \
            fairy-startup/dsh-fairy-startup fairy-visual/dsh-fairy-visual \
            fairy-voice/dsh-fairy-voice fairy-persona/dsh-fairy-persona \
            fairy-modes/dsh-fairy-modes fairy-search/dsh-fairy-search \
            fairy-memory/dsh-fairy-memory; do
  (cd "$DSH_HOME/$area" && pnpm install --ignore-scripts)
done

# 3) profile 安装（新增 link 依赖后需 --no-frozen-lockfile 重生成锁文件）
(cd "$DSH_HOME/profiles/web" && pnpm install --no-frozen-lockfile --ignore-scripts)

# 4) EvoMap 接入（Layer 1，失败不阻断部署）
node "$DSH_HOME/fairy-memory/dsh-fairy-memory/lib/memory-cli.js" evomap join --name "Fairy DSH" \
  || echo "evomap join 未完成（离线或 Hub 不可达）：部署继续，稍后重跑即可。"

# 5) 启动
export DSH_FAIRY_REPO_ROOT="$DSH_HOME"   # ponytail 预设的 shim 与 persona 扫描根
dsh --profile web --no-open
```

**EvoMap 第 4 步的语义**：按该服务自身的分层设计只做 Layer 1——恢复或注册节点，
打印 `claim_url` 由操作者打开完成绑定；`node_secret` 以 0600 落在 `~/.evomap`
（沙箱用 `EVOMAP_HOME` 换目录），永不打印、不入日志/仓库；**幂等**（已有凭据只
做探测，不重复注册）；**失败不阻断**（离线只提示）。心跳（stay online）与任务
操作需各自的明确授权，不在部署内。

**默认规则（防止在沙箱里顺手注册真节点）**：`--home` 指向**默认** `$DSH_HOME` 时
执行第 4 步，失败不阻断；`--home` 指向**别处**（探针/沙箱）时**自动跳过**并提示——确实要
在那里注册就加 `--evomap`，只想看命令形态用 `--dry-run`。

### 2.3 本地快速回路（原地用仓库，不落 live 布局）

```sh
DSH_HOME="$PWD/.dsh-test-home" ./scripts/test-isolated.sh
```

该脚本：暂存预设到隔离 home → 逐包测试 → profile 依赖安装 → 启动冒烟（要求
`dsh` 在 PATH）。它不向系统写东西，`.dsh-test-home/` 已在 `.gitignore` 内。
只想起服务时，手动等价见 §2.2（那条循环就是脚本逐步做的事）。

## 3. 部署后验证

```sh
# 从仓库根执行；DSH_HOME 已按第 2 节导出
node fairy-system/verify-build.js     # 构建契约：9 包，exit 0
node fairy-system/skill-audit.js      # 技能/插件冗余审计（--self-test 自检）

# 全矩阵（10 个测试面）
node --test --test-timeout=45000 fairy-system/test/*.test.js   # 35 例
(cd fairy-memory/dsh-fairy-memory && node --test test/*.test.js)  # 其余包同理
```

`fairy-system/test/*` 里比较"当前 live 布局"的用例需要真实安装前提：
`DSH_HOME`（隔离 home）+ `DSH_OFFICIAL_PACKAGE` / `DSH_OFFICIAL_RUNTIME` 指向已
安装的 0.1.1-rc.2；缺这两个旋钮时它们没有比较对象（不是断言放宽）。

**预设健康检查**（发现器的真实判定，避免"能启动但选不中"；服务运行中执行，
端口取启动日志 `dsh web: http://127.0.0.1:<port>`）：

```sh
curl -s -X POST -H 'content-type: application/json' \
  -d '{"type":"client-request","rpcId":"t1","method":"agentPreset.list","payload":{}}' \
  http://127.0.0.1:<port>/api/agentPreset.list \
| node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{for(const p of JSON.parse(s).result.value.presets)console.log(p.id,p.trust,p.broken?'BROKEN: '+p.broken:'')})"
```

期望：`standard/code/minimal/cordis` 为 `system`，`ponytail` 为 `user`，
`fairy` 为 `user BROKEN: …`（它依赖私有 runtime，详见 1.2）。

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

- **行尾**：`.gitattributes` 固定 `eol=lf`，`profiles/web/patches/*.patch` 另标
  `-text`（其哈希是被 pin 的字节）。若见"源码文本断言"型失败，把命中文件按索引
  字节落盘再重跑（`git checkout` 会跳过 stat 未变的文件，且会丢弃未提交改动）：

      git cat-file -p :profiles/web/patches/dsh-message-edit@0.2.3.patch > \
        profiles/web/patches/dsh-message-edit@0.2.3.patch

- **构建契约报"manifest 比产物新"**：该检查只对**有构建脚本**的包生效。命中时跑
  该包的 `pnpm bundle`（fairy-memory：`node scripts/bundle.mjs`）重建产物。
- **预设选不中/凭空消失**：检查是否为链接形态（必须复制）、行名是否字面字符串、
  以及 `DSH_FAIRY_REPO_ROOT` 是否导出。
- **Windows**：`bash` 可能被 WSL 抢占 → 用 `sh`；目录链接用 junction；测试里的
  权限位断言（`chmod 0o600`）在 Windows 不可表达，各包已按平台跳过。
- **MCP 行**（playwright/context7）会拉起子进程；隔离 home 缺 `@playwright/mcp`
  的 `.bin` 时对应行报 ENOENT，属环境耦合，不影响其余插件。
