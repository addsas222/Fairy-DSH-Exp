# dsh-fairy-eval

TypeSafe（System One / `jev-latest`）评估层级：给 dsh 一个 `typesafe_eval` 工具——传一段文本和一批问题，
**一次调用**拿回多个结构化答案（是/否概率、多选分类、连续评分），每类都带官方给的置信度。

典型用途：把「这条工单紧急吗 / 该给哪个团队 / 客户有多沮丧」这类判断从「再问一遍大模型」变成一次确定性调用，
让代码按概率与置信度做路由。

官方依据（2026-09-17 实读）：

| 事实 | 出处 |
| --- | --- |
| 端点 `POST https://api.typesafe.ai/v1/systemone`、`Authorization: Bearer <API_KEY>` | [Quickstart](https://docs.typesafe.ai/introduction/quickstart) |
| 请求体 `{ state, model, questions }`；`model` 用 `"jev-latest"` | [API reference](https://docs.typesafe.ai/api) |
| 响应体 `{ model, answers, usage }`；answer 带 `type` | 同上 |
| Noul `{ type:'noul', noul }`；Choice `{ type:'choice', choice, probabilities, confidence }`；Score `{ type:'score', score, legend, probabilities, confidence }` | 同上 |
| 错误码 `401` 未授权 / `422` 请求体校验失败 / `429` 限流 / `529` 过载；429、529 建议指数退避 | 同上（Errors、Handling rate limits） |
| 环境变量名 `TYPESAFE_API_KEY` / `TYPESAFE_BASE_URL` / `TYPESAFE_DEFAULT_MODEL` | [JS SDK ENV](https://docs.typesafe.ai/sdk/javascript/api/variables/ENV) |
| 重试默认：`max_retries=2`、`backoff_initial=0.5s`、`backoff_max=5s`、可重试 `408/429/5xx`、尊重 `Retry-After` | [Python SDK RetryPolicy](https://docs.typesafe.ai/sdk/python/api/retries) |

> **未经真实 API 验证**：本包全部测试与示例都走 mock（本机没有 `TYPESAFE_API_KEY`，`.env` 为空），
> 因此「HTTP 状态码分类、重试节奏、响应解析」是按上述文档实现的**对接逻辑**，尚未对真实服务端跑过。
> 首次拿到 KEY 后，先用 `node examples/triage.mjs`（真实调用）核对一遍响应字段。

---

## 契约

- 宿主入口 `lib/index.js`：导出 `NAME` / `ROUTES` / `apply(ctx)`，`apply` 由 `createFairyDiagnostics` 包裹；
  另再导出全部公共 API（`evaluate`、`triageQuestions`、`maskKey`…）。
- agent 入口 `./engine`（`lib/engine.js`）：`inject = ['tools']`，`apply(ctx)` 注册 `typesafe_eval`；启动时检查
  `TYPESAFE_API_KEY` 是否存在，缺 KEY 只报「不存在」并给出可操作告警。
- **没有客户端 bundle**：本包没有设置卡，配置只走环境变量（`.env` / 系统变量）。
- 依赖 `dsh-fairy-contracts`（`link:../../fairy-contracts`）提供结构化诊断。
- 分层：`config`（环境变量/`.env`/默认值）→ `client`（fetch + 超时 + 退避）→ `schema`（三类问题校验）→
  `evaluator`（一次调用多问题）→ `output`（answers/confidence/raw）→ `error`（状态码与文案）→ `tool`（agent 工具）。

## 端点

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `GET` | `/fairy-eval/status` | 配置体检：模型、端点、`TYPESAFE_API_KEY` **存在/不存在**（不含原文）、内置问题 id；缺 KEY 时附可操作帮助 |
| `POST` | `/fairy-eval/evaluate` | 不经模型跑一次评估，body `{ state, questions? , model? }`；`questions` 省略时用内置三问 |

`code` → HTTP 状态：`MISSING_API_KEY`/`INVALID_ARGS` → 400，`UNAUTHORIZED` → 401，`FORBIDDEN` → 403，
`INVALID_REQUEST` → 422，`RATE_LIMITED` → 429，`OVERLOADED` → 529，`TIMEOUT` → 504，其余上游/解析失败 → 502。

## 插槽

无。本包没有 UI；如需设置卡，按仓库 `fairy-system/scaffold-plugin.js --client` 的形状加 `lib/client.js`。

## 设置

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | 无（必填） | API Key。缺失时首次调用返回 A.md #9 的可操作错误 |
| `TYPESAFE_MODEL` | `jev-latest` | 模型名；也接受官方 JS SDK 名 `TYPESAFE_DEFAULT_MODEL` 作回退 |
| `TYPESAFE_BASE_URL` | `https://api.typesafe.ai` | 自建代理/网关时覆盖 |
| `TYPESAFE_TIMEOUT_MS` | `30000` | 单次请求超时；`0` = 不设超时 |
| `TYPESAFE_MAX_RETRIES` | `2` | 失败重试次数（`0` = 不重试）；可重试 408/429/5xx，并尊重 `Retry-After` |

优先级：显式覆盖 > 进程环境变量 > 项目根 `.env` > 默认值。

---

## 配置 API Key

1. 到 **<https://console.typesafe.ai/>** 登录并创建 API Key（Settings → Keys）。
2. 环境变量名：**`TYPESAFE_API_KEY`**。
3. 在项目根目录建 `.env`（可照抄本包 `.env.example`）：

```dotenv
TYPESAFE_API_KEY=你的_api_key
TYPESAFE_MODEL=jev-latest
```

三平台设置方式（任选其一；`.env` 只需放在 **dsh 启动时的工作目录**）：

```bash
# macOS / Linux（当前 shell 生效）
export TYPESAFE_API_KEY=你的_api_key
export TYPESAFE_MODEL=jev-latest
```

```powershell
# Windows PowerShell（当前会话生效）
$env:TYPESAFE_API_KEY = "你的_api_key"
$env:TYPESAFE_MODEL = "jev-latest"
```

```powershell
# Windows 永久设置（用户级；设置后需**重启 dsh**）
[Environment]::SetEnvironmentVariable("TYPESAFE_API_KEY", "你的_api_key", "User")
[Environment]::SetEnvironmentVariable("TYPESAFE_MODEL", "jev-latest", "User")
```

> **不要把 `.env` 提交进 git。** 根 `.gitignore` 已拦 `.env` / `.env.*`，本包 `.gitignore` 再拦一层并显式放行
> `.env.example`（模板要入库）。日志、错误与测试输出里只出现掩码（`ts_...cdef`），绝不会打印完整 KEY。

修改环境变量后需**重启 dsh**（配置在 `apply` 时读一次）。

## 调用示例

### 1. 模型直接调工具（agent 面）

工具名 `typesafe_eval`，参数：`state`（必填）、`questions`（JSON 对象文本，省略则用内置三问）、`model`（可选覆盖）。

```jsonc
{
  "state": "客户：Stripe 接了三天还是失败，我在丢单，请尽快处理。",
  "questions": {
    "is_urgent": { "type": "noul", "instructions": "这条消息是否表达出紧急或时间敏感？" },
    "department": {
      "type": "choice",
      "instructions": "应该分派给哪个团队？",
      "criteria": { "billing": "支付、发票、退款", "technical": "缺陷、故障、集成问题", "sales": "报价、升级、新账号" }
    },
    "frustration": {
      "type": "score",
      "instructions": "沮丧程度有多高？",
      "criteria": ["平静，只是陈述事实", "有些沮丧但保持礼貌", "非常愤怒，措辞激烈"]
    }
  }
}
```

工具返回 `{ ok, model, count, answers, confidence, report }`，`report` 就是给模型看的中文摘要；上游失败时
`ok: false` + `code` + 同一句可操作中文（缺 KEY、401/403、429、超时都能读懂「下一步做什么」）。

### 2. 编程调用（同一份实现，库形式）

```js
import { evaluate, triageQuestions, TRIAGE_STATE } from 'dsh-fairy-eval';

const output = await evaluate(TRIAGE_STATE, triageQuestions());
output.answers.is_urgent.yes;         // true（noul 0.999 ≥ 0.5）
output.answers.department.choice;      // 'technical'
output.answers.frustration.score;      // 1.035（0=平静 / 1=有些沮丧 / 2=非常愤怒）
output.confidence.frustration;         // 0.842
```

### 3. 真实跑一遍（示例脚本）

```bash
cd fairy-eval/dsh-fairy-eval
node examples/triage.mjs           # 真实调用（需要 TYPESAFE_API_KEY）
node examples/triage.mjs --mock    # 桩客户端：不需要 KEY，看完整输出结构
node examples/triage.mjs --json    # 追加打印 answers / confidence / usage / raw
```

`--mock` 的实测输出（本机真实运行结果，未发出网络请求）：

```text
配置：模型 jev-latest / 端点 https://api.typesafe.ai/v1/systemone / TYPESAFE_API_KEY 不存在（--mock：桩客户端，未发出网络请求）
实际发出请求 1 次：3 个问题在一次调用里问完。
已评估 3 个问题（模型 jev-latest）
- is_urgent（noul）：是（0.999；≥0.5 判为「是」，官方不给 confidence）
- department（choice）：technical（confidence 0.596；technical 0.84 / billing 0.159 / sales 0.001）
- frustration（score）：1.035（confidence 0.842；0=平静，只是陈述事实 / 1=有些沮丧但保持礼貌 / 2=非常愤怒，措辞激烈）
置信度：2 项有值，最低 0.596
```

不带 `--mock` 且没有 KEY 时（实测）：

```text
缺少 TYPESAFE_API_KEY。请到 https://console.typesafe.ai/ 获取 API Key，然后在项目根目录 .env 中添加 TYPESAFE_API_KEY=你的_api_key，或设置系统环境变量后重启插件。
```

## 自定义问题

`questions` 是「问题 id → 问题对象」的映射，**id 由你取，响应按同名回传**（官方：id 不参与推理）。三类：

| type | 返回 | `criteria` |
| --- | --- | --- |
| `noul` | `noul`：是/否的概率（0～1） | 可选，`{ true, false }` 两句描述 |
| `choice` | `choice` 选中项 + `probabilities` 全量分布 + `confidence` | 必填，`{ 选项: 说明 \| null }`，≥2 项 |
| `score` | `score` 分数 + `legend` 图例 + `probabilities` + `confidence` | 必填，**有序**字符串数组，≥2 级 |

用包里的构造器可以少写样板，并拿到同一套校验：

```js
import { noul, choice, score, evaluate } from 'dsh-fairy-eval';

const questions = {
  needs_human: noul('是否需要人工介入？', { true: '需要', false: '可自动处理' }),
  severity: score('严重程度？', ['可忽略', '影响部分用户', '全站不可用']),
  product: choice('涉及哪个产品线？', { core: '核心产品', addon: '增值插件', unknown: null }),
};
const output = await evaluate('待评估文本', questions);
```

校验规则（`validateQuestion` / `normalizeQuestions`，违反时抛 `code: 'INVALID_ARGS'` 并逐个问题点出原因）：
type 必须是三类之一；`instructions` 不能为空；Choice 至少两个选项、说明只能是字符串或 `null`；
Score 至少两级且每级都是字符串；Noul 的 `criteria` 只接受 `true`/`false` 两个键。
一次最多 64 个问题、`state` 最多 20000 字符。

## 查看置信度

- `output.confidence` 是 `{ 问题 id: number | null }` 的平表，`null` 表示该类答案没有置信度。
- **Noul 在官方响应里没有 `confidence` 字段**：`noul` 值本身（0～1）就是「是」的概率，
  本包因此给 `confidence: null`、并附 `yes: noul >= 0.5` 的判定，绝不编造一个置信度。
- `choice` / `score` 的 `confidence` 原样透传，同时保留 `probabilities` 全量分布——想做「概率差不够大就转人工」
  这类路由，用分布比用单点答案更稳（官方 Cookbook 的分类/一致性模式）。
- 工具报告末尾会给一行「置信度：N 项有值，最低 x」。

## mock fetch 做测试

client 层的 `fetchImpl` 与 `sleep` 都可注入，测试全程零网络、零等待：

```js
import { evaluate, readTypeSafeConfig } from 'dsh-fairy-eval';

const fetchImpl = async (url, init) => ({
  ok: true, status: 200, headers: { get: () => null },
  text: async () => JSON.stringify({ model: 'jev-latest', answers: { is_urgent: { type: 'noul', noul: 0.9 } }, usage: {} }),
});
const config = readTypeSafeConfig({ env: {}, dotenv: {}, overrides: { apiKey: 'test-key' } });
const output = await evaluate('文本', { is_urgent: { type: 'noul', instructions: '是否紧急？' } }, { config, fetchImpl });
```

失败路径同样好造：返回 `{ ok:false, status:401, ... }` 验证 401 文案；`throw Object.assign(new Error('x'), { name:'AbortError' })`
验证超时；返回 `<html>` 验证 `INVALID_JSON`；`retryAfterMs` 用 `headers.get('retry-after')` 桩验证退避。
示例脚本侧还有个不碰网络、不碰 KEY 的桩客户端：`examples/mock-response.mjs` 的 `createStubClient()`。

跑测试（本包 48 例）：

```bash
cd fairy-eval/dsh-fairy-eval
pnpm install --ignore-scripts   # 只为 link:../../fairy-contracts 就位
node --test test/*.test.js      # 或 pnpm test
```

覆盖：三类问题解析、一次调用多问题（断言只发一个请求）、统一输出结构、401/403/422/429/529/5xx/超时/网络/非 JSON/缺 `answers`、
退避与 `Retry-After`、掩码与「报告里不出现完整 KEY」、缺 KEY 文案、两个宿主路由与状态码映射。

## 后续扩展点

- **Agent Skill 预留**：`typesafe_eval` 已挂在 agent 面（`./engine`），任何 preset 挂上本包后该工具即可被技能引用；
  官方也有现成技能（`npx skills add typesafe-ai/skills --skill typesafe-ai`）。接入方式：在 preset 里加一条本包的
  engine 行（或 shim），技能正文里把「多维度判断」写成一次 `typesafe_eval` 调用即可，无需改本包代码。
- **设置卡**：加 `lib/client.js` + `settings.section` 插槽，把 `TYPESAFE_API_KEY` / 模型做成可视化配置（当前只走环境变量）。
- **置信度路由**：按 `confidence` 与概率分布做「高置信直接执行、低置信转人工」的分流，落在调用方代码里。
- **批量 fan-out**：`state` 支持对象/数组，可把多条记录塞进一次调用；官方 Cookbook 的「并行问题 / 重排 / 逐行检索」是同一路数。
- **模型与端点**：`TYPESAFE_MODEL` / `TYPESAFE_BASE_URL` 已可覆盖；将来 TypeSafe 加新模型或多端点时无需改代码。
- **重试抖动**：当前退避不加抖动（换取可断言的重试节奏）；要抖动就在注入的 `sleep` 里加。
- **流式/批量客户端**：本包只用 REST（A.md 要求不照搬 Python SDK）；官方 JS SDK 的 `TypeSafeClient` 若已够用，可另加一个适配器层。

## 开发

```bash
cd fairy-eval/dsh-fairy-eval
pnpm install --ignore-scripts
pnpm test
node examples/triage.mjs --mock
```

无构建步骤（纯 ESM，无 `src/`）；改 `lib/**` 后重启 dsh 即生效。
