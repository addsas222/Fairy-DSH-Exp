# 外部记忆候选：调研、审核与安装

本文件是 `dsh-fairy-memory` 候选清单（`src/candidates.js`）的审核记录：清单里每一条都在这里有出处和理由，**不在这里的条目不进设置页**。

## 调研方法与范围（2026-09-15）

- anysearch 三轮并行检索（15 条查询）：MCP 记忆服务器、记忆框架横评（Mem0/Zep/Letta/Cognee/LangMem）、自托管服务、本地知识图谱 MCP、中文生态。
- **dshget.com「Memory Plugins for DeepSeek Harness」类目：198 个 DSH 记忆插件**——本 harness 的原生生态，抽审其中星标高/定位互补的条目。
- 服务侧候选（可作 fairy-memory 后端）：OpenMemory MCP、Redis Agent Memory、memobase、MemOS、Graphiti、basic-memory、官方 server-memory、causal-memory、SGME。

## 审核标准（六条同时满足才进清单）

1. **本机可跑**：无强制云账号/云 API；
2. **许可明确**：MIT / Apache-2.0 / AGPL（AGPL 需标注传染性风险）；
3. **活跃**：近 90 天有推送；
4. **安装路径 ≤2 步**：`dsh plugin add` 一条，或一条 + 一条服务命令；
5. **不替换会话运行时**：只是记忆层，不是"Is-a-whole-agent"框架；
6. **可验证**：装完有明确的验证命令或端口。

## 通过清单（9 条，按设置页顺序）

| id | 名称 | 定位 | 星标 | 许可 | 语言 | 最近推送 | 安装（可直接执行） |
|---|---|---|---|---|---|---|---|
| `hindsight` | Hindsight | 会学习的项目记忆：自动回忆/留存、知识页、按仓库记忆库 | 20.8K | MIT | Python | 2026-08-21 | `dsh plugin --profile web add @vectorize-io/hindsight-coding-agents` |
| `openviking` | OpenViking | 火山引擎上下文数据库：pre-step 自动回忆与画像注入、会话捕获 | 31.2K | AGPL-3.0 | Python | 2026-08-21 | `dsh plugin --profile web add @openviking/dsh-memory-plugin` |
| `reme` | ReMe | 本地优先自演进知识库：会话落 Markdown、BM25+wikilink 检索、每日整合 | 3.4K | Apache-2.0 | Python | 2026-09-11 | `dsh plugin --profile web add @agentscope-ai/reme-dsh-plugin` |
| `memsearch` | MemSearch | 跨编码 agent 共享 Markdown 记忆 + 记忆→技能演进 | 2.5K | MIT | Python | 2026-08-23 | `dsh plugin --profile web add @zilliz/memsearch-dsh` |
| `deja-vu` | deja-vu | 读本机 22 种 agent 的会话文件做历史回忆（含安装前），BM25、无 LLM/无网络 | 687 | MIT | Go | 2026-08-24 | `dsh plugin --profile web add dsh-deja` |
| `engramory` | Engramory | 纯 Markdown、一事实一文件；200 行/25KB 索引硬上限 | 167 | MIT | Python | 2026-08-20 | `dsh plugin --profile web add dsh-engramory` |
| `mneme` | dsh-mneme | 会"做梦"的记忆：睡眠整合、冲突冻结、审计回放；SQLite+Markdown+实体图+API/CLI | 30 | MIT | JavaScript | 2026-08-20 | `dsh plugin --profile web add @modusensus/dsh-mneme` |
| `causal-memory` | causal-memory | 因果记忆：决策→结果类型边（caused/enabled/prevented），本地 SQLite | 77 | Apache-2.0 | Rust | 2026-09-10 | `dsh plugin --profile web add github:JingxuanC/causal-memory#path:/dsh-plugin`（另需 `pip install causal-memory` 提供服务二进制） |
| `sgme` | SGME | 多智能体共享记忆（HTTP）、四级蒸馏、中文优先、零 LLM 注入 | 6 | MIT | Python | 2026-08-20 | `dsh plugin --profile web add github:freehul/sgme` |

审核出处（一手页面）：`dshget.com/plugins/<owner>/<repo>`（每条 `listing` 字段），星标/许可/语言/推送时间取自该页的 GitHub 信息块。

## 未纳入（驳回或留观，附理由）

| 项目 | 判定 | 理由 |
|---|---|---|
| Letta / MemGPT | 驳回 | 是完整的 stateful agent runtime，会替换会话架构，不是记忆后端。 |
| Zep / Graphiti MCP | 留观 | 需要 Docker + 图数据库（FalkorDB/Neo4j），本机重；要用先单独评估。 |
| MemOS（MemTensor） | 留观 | 研究型记忆 OS 框架，接入成本高于"一条安装命令"。 |
| Mem0 云 / Supermemory 云 / 阿里云长期记忆 | 驳回 | 云依赖，违反"本机可跑"（mem0 自托管已由本仓 mem0 provider 覆盖）。 |
| OpenMemory MCP | 留观 | 本地 mem0 栈（Docker），已有 mem0 REST provider；需要时再列为后端候选。 |
| `@modelcontextprotocol/server-memory`、basic-memory | 留观 | stdio-only MCP；要经 `mcpo`/`mcp-proxy` 桥成 HTTP 才能接，两步以上。 |
| Redis Agent Memory Server | 留观 | 需要 Redis 常驻，依赖比收益重。 |
| memobase | 留观 | Docker 部署、面向用户画像/陪伴场景，与当前语料目标不同。 |
| EverOS（12.9K★，Markdown-native 便携记忆层） | 留观 | 星标高、理念同向；未在 dshget 记忆类目抽审范围内，下一轮复核对象。 |
| A-MEM、SimpleMem 等 | 驳回 | 研究代码或云托管，不可直接安装。 |

## 「指挥 Agent 自动安装」的运行方式

1. 设置页「长期记忆 → 候选记忆」选中候选，点**让 Agent 安装** → 宿主把 `installRequest`（候选 id）写进设置并镜像到 `$DSH_HOME/fairy-memory/config.json`。
2. agent 面的动态段落 `fairy:memory-setup` 读取请求，把**执行计划**（前置检查 → 安装 → 验证 → 接线 → 生效说明 → 收尾）作为指令交给会话里的模型；模型据此在终端执行 `dsh plugin …`，不需要再次确认（用户在设置页的点击就是授权）。
3. 安装完成后模型清除请求（`POST /fairy-memory/install {"id":""}` 或设置页点**取消安装请求**），再跑 `doctor` 复验。
4. **重启由用户做**：插件在启动时装载，重新开始实例会掐断当前会话；计划里明确禁止模型自行重启。

命令行等价物（供 Agent 或人工使用）：

```sh
node fairy-memory/dsh-fairy-memory/lib/memory-cli.js candidates          # 全部候选（JSON）
node fairy-memory/dsh-fairy-memory/lib/memory-cli.js candidates mneme    # 单个候选的安装计划
```

## 备注与复核节奏

- `dsh plugin --profile web add` 等价于对目标 profile 跑 `pnpm add`，新增依赖写进 `profiles/web/package.json`（部署链按本机适配保留，见 AGENTS §2.2）。
- 本机运行时钉在 **0.1.1-rc.2**：插件的兼容性以安装后实测为准（`dsh plugin --profile web list` + 会话里验证），失败用 `dsh plugin --profile web remove <pkg>` 回滚。
- 多个记忆插件与 fairy-memory 并行时可能双写同一份事实：列表里已逐条标注"并行"注意项；不确定就先只装一个。
- 复核节奏：每季度，或 dshget 记忆类目新增 ≥20 条时重跑一次抽审（保留本文件的通过/驳回格式）。
