/**
 * 已审核的外部记忆候选（备选清单）：不是运行期 provider，而是"可以装、装了能接"的后端/插件。
 *
 * 数据来源与逐条审核记录见本包 `CANDIDATES.md`：anysearch 全生态扫描（MCP 记忆服务器、
 * 记忆框架、自托管服务）+ dshget.com「DeepSeek Harness 记忆插件」类目（198 个）抽审。
 * 入选条件：本机可跑（无强制云）、开源许可明确、近 90 天有推送、安装路径 ≤2 步、
 * 不要求替换会话运行时。**安装命令必须能在本机直接执行**（`dsh plugin` 等价于对
 * 目标 profile 跑 pnpm，新增依赖会写进 `profiles/web/package.json`，部署时按本机适配保留）。
 *
 * 这里只放数据与纯函数：安装动作由会话里的 Agent 执行（见 `buildMemorySetupText`），
 * 宿主与客户端都只读这份清单。
 */

export const MEMORY_CANDIDATES = Object.freeze([
  Object.freeze({
    id: 'hindsight',
    name: 'Hindsight',
    kind: 'dsh-plugin',
    summary: '会"学习"的项目记忆：自动回忆与留存、知识页、深度反思、按仓库记忆库。',
    repo: 'https://github.com/vectorize-io/hindsight',
    listing: 'https://dshget.com/plugins/vectorize-io/hindsight~h~coding-agents',
    stars: '20.8K',
    license: 'MIT',
    language: 'Python',
    lastPush: '2026-08-21',
    install: 'dsh plugin --profile web add @vectorize-io/hindsight-coding-agents',
    requires: 'Node ≥20；Python 3.10+（插件自带本地服务）',
    verify: 'dsh plugin --profile web list（应出现 @vectorize-io/hindsight-coding-agents）',
    wire: '自带 agent 面（pre-step 自动回忆/留存），与 fairy-memory 并行；若要做 fairy-memory 的后端，用 custom-http 指向它的本地 HTTP 面。',
    caveats: '',
  }),
  Object.freeze({
    id: 'openviking',
    name: 'OpenViking',
    kind: 'dsh-plugin',
    summary: '火山引擎的上下文数据库：pre-step 自动回忆与画像注入、会话捕获、viking:// 资源守卫。',
    repo: 'https://github.com/volcengine/OpenViking',
    listing: 'https://dshget.com/plugins/volcengine/OpenViking~h~examples/dsh-memory-plugin',
    stars: '31.2K',
    license: 'AGPL-3.0',
    language: 'Python',
    lastPush: '2026-08-21',
    install: 'dsh plugin --profile web add @openviking/dsh-memory-plugin',
    requires: 'Node ≥20；OpenViking 服务（Python）在后端运行',
    verify: 'dsh plugin --profile web list（应出现 @openviking/dsh-memory-plugin）',
    wire: '自带 agent 面；若要作为 fairy-memory 后端，用 custom-http 指向 OpenViking 服务的 HTTP 面。',
    caveats: 'AGPL-3.0：自用无碍，二次分发或对外提供服务前需评估传染性许可。',
  }),
  Object.freeze({
    id: 'reme',
    name: 'ReMe',
    kind: 'dsh-plugin',
    summary: '本地优先、自演进的个人知识库：会话自动落成本地 Markdown 记忆，BM25（可选嵌入）+ wikilink 扩展检索，每日整合。',
    repo: 'https://github.com/agentscope-ai/ReMe',
    listing: 'https://dshget.com/plugins/agentscope-ai/ReMe~h~dsh',
    stars: '3.4K',
    license: 'Apache-2.0',
    language: 'Python',
    lastPush: '2026-09-11',
    install: 'dsh plugin --profile web add @agentscope-ai/reme-dsh-plugin',
    requires: 'Node ≥20；Python 3.10+（检索与整合在本地跑）',
    verify: 'dsh plugin --profile web list（应出现 @agentscope-ai/reme-dsh-plugin）',
    wire: '自带 agent 面；记忆是本地 Markdown，fairy-memory 的 local-markdown 也可指向同一目录做交叉检索。',
    caveats: '',
  }),
  Object.freeze({
    id: 'memsearch',
    name: 'MemSearch',
    kind: 'dsh-plugin',
    summary: '编码 agent 共享的 Markdown 记忆：自动捕获、pre-step 注入、可检索回忆、记忆→技能自演进（带审阅面板）。',
    repo: 'https://github.com/zilliztech/memsearch',
    listing: 'https://dshget.com/plugins/zilliztech/memsearch~h~MemSearch',
    stars: '2.5K',
    license: 'MIT',
    language: 'Python',
    lastPush: '2026-08-23',
    install: 'dsh plugin --profile web add @zilliz/memsearch-dsh',
    requires: 'Node ≥20；Python 3.10+',
    verify: 'dsh plugin --profile web list（应出现 @zilliz/memsearch-dsh）',
    wire: '自带 agent 面；Markdown 存储可与 local-markdown 指向同一目录。',
    caveats: '',
  }),
  Object.freeze({
    id: 'deja-vu',
    name: 'deja-vu',
    kind: 'dsh-plugin',
    summary: '读取本机 22 种编码 agent 已写的会话文件（含安装前的历史）：六个回忆工具 + /deja 命令，BM25 本地索引，无 LLM、无嵌入、无网络。',
    repo: 'https://github.com/vshulcz/deja-vu',
    listing: 'https://dshget.com/plugins/vshulcz/deja-vu~h~extensions/dsh',
    stars: '687',
    license: 'MIT',
    language: 'Go',
    lastPush: '2026-08-24',
    install: 'dsh plugin --profile web add dsh-deja',
    requires: 'Node ≥20（无 Python、无网络依赖）',
    verify: 'dsh plugin --profile web list（应出现 dsh-deja）',
    wire: '自带 agent 面（补"历史回忆"这一路），与 fairy-memory 并行；不需要接线即可用。',
    caveats: '',
  }),
  Object.freeze({
    id: 'engramory',
    name: 'Engramory',
    kind: 'dsh-plugin',
    summary: '纯 Markdown 长期记忆，一事实一文件；MEMORY.md 索引有 200 行 / 25KB 硬上限（超限写入被守卫拒绝，压缩写入放行）。',
    repo: 'https://github.com/tinqiao-oss/engramory',
    listing: 'https://dshget.com/plugins/tinqiao-oss/engramory~h~plugin',
    stars: '167',
    license: 'MIT',
    language: 'Python',
    lastPush: '2026-08-20',
    install: 'dsh plugin --profile web add dsh-engramory',
    requires: 'Node ≥20；Python 3.10+',
    verify: 'dsh plugin --profile web list（应出现 dsh-engramory）',
    wire: 'Markdown 存储；fairy-memory 的 local-markdown 可指向同一目录。',
    caveats: '',
  }),
  Object.freeze({
    id: 'mneme',
    name: 'dsh-mneme',
    kind: 'dsh-plugin',
    summary: '会"做梦"的记忆：跨会话回忆、睡眠期自动整合、冲突冻结待审、可回放审计；SQLite + Markdown 镜像 + 实体图 + 面板 + 外部 API/CLI。',
    repo: 'https://github.com/modusensus/dsh-mneme',
    listing: 'https://dshget.com/plugins/modusensus/dsh-mneme',
    stars: '30',
    license: 'MIT',
    language: 'JavaScript',
    lastPush: '2026-08-20',
    install: 'dsh plugin --profile web add @modusensus/dsh-mneme',
    requires: 'Node ≥20（纯 JS，无 Python）',
    verify: 'dsh plugin --profile web list（应出现 @modusensus/dsh-mneme）',
    wire: '自带外部 API/CLI：如需让 fairy-memory 共享同一份记忆，用 custom-http 指向其 API。',
    caveats: '',
  }),
  Object.freeze({
    id: 'causal-memory',
    name: 'causal-memory',
    kind: 'dsh-plugin',
    summary: '因果记忆：决策→结果带类型边（caused / enabled / prevented），本地 SQLite，抵御上下文压缩。',
    repo: 'https://github.com/JingxuanC/causal-memory',
    listing: 'https://dshget.com/plugins/JingxuanC/causal-memory~h~dsh-plugin',
    stars: '77',
    license: 'Apache-2.0',
    language: 'Rust',
    lastPush: '2026-09-10',
    install: 'dsh plugin --profile web add github:JingxuanC/causal-memory#path:/dsh-plugin',
    requires: 'causal-memory 服务二进制：`pip install causal-memory` 或预编译 release（服务在 PATH 上）',
    verify: 'dsh plugin --profile web list（应出现 JingxuanC/causal-memory）；再确认 `causal-memory` 命令可用',
    wire: '自带 17 个记忆工具（桥接服务）。服务本身是本地进程，不接入 fairy-memory 也可用。',
    caveats: '依赖外部二进制；Rust 预编译 release 需与本机架构匹配。',
  }),
  Object.freeze({
    id: 'sgme',
    name: 'SGME（时光记忆引擎）',
    kind: 'dsh-plugin',
    summary: '多智能体共享长期记忆：HTTP 通道、L0/L1/L1.5/L2 蒸馏、场景化注入、统一检索与主动关怀信号；中文优先、零 LLM 注入。',
    repo: 'https://github.com/freehul/sgme',
    listing: 'https://dshget.com/plugins/freehul/sgme',
    stars: '6',
    license: 'MIT',
    language: 'Python',
    lastPush: '2026-08-20',
    install: 'dsh plugin --profile web add github:freehul/sgme',
    requires: 'Node ≥20；Python 3.10+',
    verify: 'dsh plugin --profile web list（应出现 freehul/sgme）',
    wire: '自带 HTTP 记忆服务：若要多 agent 共享，可让 fairy-memory 的 custom-http 也指向它。',
    caveats: '较新项目（星数低）；建议先只装不改接线。',
  }),
]);

export function findCandidate(id) {
  const key = typeof id === 'string' ? id.trim() : '';
  if (!key) return null;
  return MEMORY_CANDIDATES.find((entry) => entry.id === key) || null;
}

/**
 * 安装计划：给 Agent 执行的有序步骤（纯数据，不做任何执行）。
 * @param candidate - `findCandidate(id)` 的结果。
 * @returns `{ id, name, install, steps }`。
 */
export function buildInstallPlan(candidate) {
  if (!candidate) return null;
  return {
    id: candidate.id,
    name: candidate.name,
    install: candidate.install,
    steps: [
      { step: '前置检查', detail: candidate.requires },
      { step: '安装', detail: `在部署根目录执行：${candidate.install}` },
      { step: '验证', detail: candidate.verify },
      { step: '接线', detail: candidate.wire },
      { step: '生效', detail: '不要自行重启实例（会中断你自己的会话）：告诉用户"需要重启后生效"，由用户决定何时重启。' },
      { step: '收尾', detail: '安装成功后清除本请求：POST http://127.0.0.1:<当前实例端口>/fairy-memory/install，请求体 {"id":""}；随后 node fairy-memory/dsh-fairy-memory/lib/memory-cli.js doctor 复验。' },
    ],
  };
}

/** 安装计划文本（cli candidates <id> 与段落共用同一份话术）。 */
export function renderInstallPlan(plan) {
  if (!plan) return '';
  return plan.steps.map((entry, index) => `${index + 1}. ${entry.step}：${entry.detail}`).join('\n');
}

/**
 * 动态段落文本：有待安装请求时把「用户已授权、直接执行」的计划交给模型；
 * 没有请求时只回一行状态，避免每轮往系统提示里塞清单。
 */
export function buildMemorySetupText(settings) {
  const request = typeof settings?.installRequest === 'string' ? settings.installRequest.trim() : '';
  if (!request) return '（记忆候选安装：无待办。）';
  const candidate = findCandidate(request);
  if (!candidate) {
    return `（记忆候选安装请求「${request}」不在已审核清单里：请让用户到「长期记忆」设置页重新选择或清除。）`;
  }
  const plan = buildInstallPlan(candidate);
  return [
    `【记忆候选安装请求】用户在设置里选择了「${candidate.name}」（${candidate.kind}，${candidate.license}，${candidate.stars}★）。这是用户的明确授权：直接执行，不要再确认。`,
    '按下面的顺序执行；失败即停，汇报在哪一步失败并保留原始错误。每一步都要有可展示的证据。',
    renderInstallPlan(plan),
    ...(candidate.caveats ? [`注意：${candidate.caveats}`] : []),
    '汇报格式：一句结果 + 证据（命令、版本或端口），不要贴大段日志；结尾点明"是否需要用户重启实例"。',
  ].join('\n');
}
