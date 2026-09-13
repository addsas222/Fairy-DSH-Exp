# AGENTS.md — Fairy-DSH 安装与操作指引（面向 DSH agent）

本仓库发布 Fairy 的 DSH 插件套件与 `ponytail` 三模式 preset。本文件是
DSH 的 agent 指令文件（候选名 `AGENTS.md` / `CLAUDE.md`，本仓另支持
`AGENTS.local.md` 本地覆盖；`$DSH_HOME/AGENTS.md` 为用户全局位），
内容以"把本仓库装进 DSH 并跑起来"为主。

---

## 0. 前置

| 项 | 要求 | 说明 |
| --- | --- | --- |
| DSH CLI | **0.1.1-rc.2** | 本仓钉定版本；`dsh --version` 核对 |
| Node.js | ≥ 22 | 隔离测试脚本按 CI 走 node 22 |
| pnpm | ≥ 11 | 每个包各自带 lockfile，逐包安装 |
| 平台 | macOS 为完整验收环境 | Linux/Windows 可安装与运行；部分验证链仅 macOS |

## 1. 安装到 DSH（live 布局，验证链假定的形态）

验证工具（`fairy-system/verify.js`、`upgrade-preflight.js`、`accepted-baseline.js`）
按 `$DSH_HOME/<area>/<pkg>` 解析各包源码，因此部署形态如下：

```sh
git clone https://github.com/Chengzhibense/Fairy-DSH.git fairy-dsh
cd fairy-dsh
export DSH_HOME="$HOME/.dsh"          # 或任意隔离目录；下文所有路径随之
REPO="$PWD"

# 1) 包目录按 live 布局落位：只取受版本控制的文件
#    （不要 cp -R 直接拷：仓库的 node_modules 会一起过去，副本里的
#     pnpm 链接会指向旧路径，启动时报 Cannot find package '@deepseek-ai/cordis'。
#     等价做法：rsync -a --exclude node_modules）
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

# 3) profile 安装（link: 目标此时指向 $DSH_HOME 下各目录；
#    新增 link 依赖后需 --no-frozen-lockfile 重生成锁文件）
(cd "$DSH_HOME/profiles/web" && pnpm install --no-frozen-lockfile --ignore-scripts)

# 4) 启动
export DSH_FAIRY_REPO_ROOT="$DSH_HOME"   # ponytail preset 的插件 shim 与 persona 包扫描根
dsh --profile web --no-open
```

本节流程已在隔离目录逐条实跑验证（0.1.1-rc.2）：服务就绪 → 以 `ponytail`
创建会话 → `/fairy-modes/set ptc` 成功 → 人格包 `fairy` 选中并级联到语音
provider → `/fairy-search/state` 正常。

要点：

- `DSH_FAIRY_REPO_ROOT` **必须**导出：`ponytail` preset 经
  `.agent-presets/ponytail/plugins/fairy-modes.mjs` 解析真身
  （preset 行名只能是字面字符串或 preset 相对路径，包名只从 harness 安装解析）。
  在 live 布局里它等于 `$DSH_HOME`；原地使用仓库时等于仓库根。
- preset 用**复制**而不是链接：`readdir` 的 `Dirent.isDirectory()` 对
  symlink/junction 为假，链接形态不会被发现，表现为"preset 凭空消失"。
- `profiles/web` 首次安装需 `--no-frozen-lockfile`（新增 link 依赖后锁文件需重生成）。
- MCP 行（playwright/context7）会拉起子进程；隔离 home 里缺少
  `@playwright/mcp` 的 `.bin` 时对应行报 ENOENT，属环境耦合，不影响其余插件。

## 2. 本地快速回路（原地使用仓库，不落 live 布局）

```sh
DSH_HOME="$PWD/.dsh-test-home" ./scripts/test-isolated.sh
```

该脚本：暂存 preset 到隔离 home → 逐包测试 → profile 依赖安装 → 启动冒烟
（要求 `dsh` 在 PATH）。它不在系统里写任何东西，`.dsh-test-home/` 已在
`.gitignore` 内。

手动等价（只起服务）：

```sh
export DSH_HOME="$PWD/.dsh-test-home" DSH_FAIRY_REPO_ROOT="$PWD"
mkdir -p "$DSH_HOME/profiles" "$DSH_HOME/.agent-presets"
cp -R .agent-presets/ponytail "$DSH_HOME/.agent-presets/"
ln -s "$PWD/profiles/web" "$DSH_HOME/profiles/web"      # Windows 用 junction
(cd profiles/web && pnpm install --no-frozen-lockfile --ignore-scripts)
dsh --profile web --no-open --port 0
```

## 3. 安装后验证

```sh
# 以下命令从仓库根执行；DSH_HOME 已按第 1 节导出（live 布局）
node fairy-system/verify-build.js                       # 构建契约：9 包，exit 0
node fairy-system/skill-audit.js                        # 技能/插件冗余审计（--self-test 自检）
```

preset 健康检查（发现器的真实判定，避免"能启动但选不中"；服务运行中执行，
端口取启动日志里的 `dsh web: http://127.0.0.1:<port>`）：

```sh
curl -s -X POST -H 'content-type: application/json' \
  -d '{"type":"client-request","rpcId":"t1","method":"agentPreset.list","payload":{}}' \
  http://127.0.0.1:<port>/api/agentPreset.list \
| node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{for(const p of JSON.parse(s).result.value.presets)console.log(p.id,p.trust,p.broken?'BROKEN: '+p.broken:'')})"
```

期望（实测输出）：

```
standard system
code     system
minimal  system
cordis   system
ponytail user
fairy    user BROKEN: …      ← 见下
```

`fairy` 在公开仓库里必然 broken：它依赖私有 runtime 资产（`runtime/` 在
`.gitignore` 内）且行名用了 `!!js` 表达式（discovery 要求行名是字面字符串），
属私有部署资产；公开入口是 `ponytail`。

完整链（需 live macOS 部署：launchers/、LaunchAgents、语音服务）：
`./fairy-system/check.sh`。基线对比只读：`node fairy-system/accepted-baseline.js --diff`。

## 4. 版本边界与升级

- 本仓钉定 DSH **0.1.1-rc.2**；官方 runtime 的 SHA-256、capability matrix 与
  upgrade-preflight 的批准记录都以它为准（`fairy-system/README.md`）。
- 社区包 [dsh-web](https://github.com/zhu1090093659/dsh-web) 要求
  **≥ 0.1.5-rc.1**：两者分居客户端面孔切换线两侧（0.1.2 起删除
  `@deepseek-ai/dsh-client-runtime`），同一 profile 不能共跑。升级须走
  `fairy-system/upgrade-candidate-preflight.sh`，并同步 client face 清单、
  selector 契约与 accepted baseline。
- 工具呈现取值随 cohort 改名：0.1.1 为 `native|code|both`，0.1.2+ 为
  `native|ptc|both`；`fairy-modes` 已按 `systemPrompt.getSectionOrder` 是否存在
  自动判别。

## 5. 硬约束（不要做）

- **不要**改 DSH 官方安装与 runtime（只读边界）；升级走候选择预检流程。
- **不要**为让检查变绿而运行 `node fairy-system/accepted-baseline.js --accept`；
  接受基线是人工审查后的发布级动作。
- **不要**手改 `profiles/web/pnpm-lock.yaml` 或跳过逐包安装：CI 与
  `test-isolated.sh` 用 `--frozen-lockfile`；锁文件与 package.json 不同步即失败。
- **不要**把插件包名写进 preset 行：preset 行只接受字面字符串 / preset 相对
  路径 / 文件路径，`$DSH_HOME` 下被 link 的包只能经 preset 内 shim 或文件路径加载。
- **不要**把 preset 目录以链接形式放进 `$DSH_HOME/.agent-presets/`（见上）。
- 行尾：仓库根 `.gitattributes` 已固定 `eol=lf`，`profiles/web/patches/*.patch`
  另标 `-text`（其哈希是被 pin 的字节）。CRLF 检出不再制造"源码文本断言"型
  失败；若本地仍见此类失败，按索引字节把命中文件落盘再重跑（`git checkout`
  与 `checkout-index` 都会跳过 stat 未变的文件、且前者会静默丢弃未提交改动）：

      git cat-file -p :profiles/web/patches/dsh-message-edit@0.2.3.patch > \
        profiles/web/patches/dsh-message-edit@0.2.3.patch
- `fairy-system/test/*` 里比较"当前 live 布局"的用例需要真实安装前提：
  `DSH_HOME`（隔离 home）+ `DSH_OFFICIAL_PACKAGE` / `DSH_OFFICIAL_RUNTIME`
  指向已安装的 0.1.1-rc.2。缺这两个旋钮时它们无法比较对象（不是断言放宽）：
  先装好并在同一 shell 导出，或按 `scripts/test-isolated.sh` 的打印提示补上。
  需要本机全绿时用 LF 检出（`git config core.autocrlf false` 后重新 checkout）。

## 6. 目录速查

| 路径 | 作用 |
| --- | --- |
| `fairy-persona/dsh-fairy-persona/` | 人格包引擎（文档 + 调色属性 + 语音绑定热切换），端点 `/fairy-persona/*` |
| `fairy-modes/dsh-fairy-modes/` | 三模式引擎（极简/PTC/创造），端点 `/fairy-modes/*`，含 `session_recall` 工具 |
| `fairy-search/dsh-fairy-search/` | 搜索枢纽（deepseek/exa/perplexity/自定义路由），端点 `/fairy-search/*` |
| `fairy-memory/dsh-fairy-memory/` | 长期记忆（GBrain 主用；Mem0/自定义 HTTP/本地 Markdown 备选），端点 `/fairy-memory/*` |
| `fairy-voice/dsh-fairy-voice/` | TTS provider 注册表（local-sovits/openai/elevenlabs-ws/kokoro-web/piper-web/browser/custom-http）+ STT（网上：browser/openai/deepgram/azure/custom-http；本地：whisper-web 浏览器内识别、openai 指向 loopback 服务），端点 `/fairy-voice/*` |
| `fairy-visual/`、`balance-meter/`、`browser-dock/`、`fairy-startup/` | 视觉舞台、余额、浏览器 Dock、启动动作 |
| `fairy-contracts/` | 跨插件契约与诊断边界（各插件 `link:` 依赖它） |
| `fairy-system/` | 验证/预检/审计工具（`check.sh`、`verify*.js`、`skill-audit.js`、`scaffold-plugin.js`） |
| `persona-packs/{fairy,standard}/` | 内置人格包（`persona.yml` + `prompt.md` + `tone.json`） |
| `.agent-presets/ponytail/` | 三模式 preset（公开入口；自带 ponytail 规则技能与 modes shim） |
| `profiles/web/` | Web profile：组合各插件、pin 搜索 provider、接管部署 persona |
| `fairy-system/PONYTAIL-DESIGN.md` | 三模式与人格/语音绑定的设计记录与 0.1.1 运行时契约 |
| `fairy-system/DSH-WEB-COMPAT.md` | 与社区包 dsh-web 的共存分析与版本地板 |
