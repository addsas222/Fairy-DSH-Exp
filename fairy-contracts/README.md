# Fairy Shared Contracts

This package owns only versioned, runtime-free vocabulary shared by the Fairy
subsystems. It contains immutable JavaScript constants and TypeScript
declarations; it has no browser singleton, mutable store, network access,
timers, DOM access, or persistence.

## Public contract

- Visual settings schema version: `2`.
- Themes: `dark`, `light`.
- Power modes: `normal`, `low-power`.
- Voice control DOM attribute: `data-dsh-fairy-voice-control`.
- Visual `composerDockHeight`: persisted pixel preference for the HDD Hero/Active
  bottom composer dock; default 132 and runtime-clamped by viewport geometry.

## Activity vocabulary

The exported activity union is the Visual activity state machine.

| Literal | Status | Current meaning |
| --- | --- | --- |
| `normal` | active | Emitted by `dsh-fairy-visual` when the bound official Session snapshot is not running. |
| `thinking` | active | Emitted by `dsh-fairy-visual` when the bound official Session snapshot has `running: true`. |
| `comforting` | active | Entered by the local comfort detector after an explicit distress or request-for-comfort cue. It remains latched for that session until an explicit recovery/topic-exit cue or page exit, and takes precedence over `thinking` and `normal`. |

`dsh-fairy-visual` uses the official Session `snapshot.running` flag for
`thinking`, while a local, explainable projection over committed user nodes
owns `comforting`. User text is never sent to a service for classification.

## Lifecycle vocabulary

`FairyVisualLifecycle` is shared vocabulary; it is not an instruction to treat
all literals as states emitted by the current Visual runtime.

| Literal | Status | Current meaning |
| --- | --- | --- |
| `idle` | active | Current Visual controller snapshot when no bound session is running, including an absent or blank session. |
| `running` | active | Current Visual controller snapshot while the official bound Session reports `running: true`. |
| `completed` | active | Current Visual controller snapshot for a nonblank bound Session that is no longer running. |
| `preparing`, `interrupted`, `failed`, `disposed` | reserved | Retained shared vocabulary. The current Visual controller neither emits them in its public snapshot nor has a current runtime consumer for them. |

No literal is classified as historical from the current disk evidence. Reserved
means “preserved without current Visual state-machine reachability”; it does
not imply an old or active behavior exists.

The authoritative files are `index.js` and `types.d.ts`. Settings-shape
breaking changes require a settings schema-version increase and a migration in
the module that owns persistence. Changing or removing an exported activity or
lifecycle literal instead requires a compatibility review of consumers; it does
not by itself change the persisted settings schema. This package must never
become a channel for one feature to mutate another feature's state.

Validate it through `~/.dsh/fairy-system/check.sh`. Roll back source/config
from the verified audit archive documented by the system audit; do not restore
contracts independently from their consuming plugins.

## 提问件（归一化）

设置卡里"向用户要输入"的那些行（密钥、地址、档位、开关）统一走一套：

- **唯一真源** `client-ask-kit.cjs`（本包 `./client-ask-kit`）。它给
  `AskSection` / `AskRow` / `AskText` / `AskSelect` / `AskToggle` /
  `AskActions` / `AskResult` 与一份 `useAskForm` 状态机（读取 → 草稿 → 保存 →
  复读，忙时禁用、只读会话停用、不轮询），文案只在 `ASK_TEXT` 里写一次。
- **界面件优先用官方冻结原语**：`Input`（有才用）、`Button`、`StateDot`；
  官方没有的（`select`/`checkbox`）用官方设计令牌 `var(--dsw-alias-*)` 自绘，
  外观与官方设置面同色同尺。原语清单按 shell 冻结模块表的实证导出走，
  **不要臆造组件名**。
- **接线两条路**：
  - 有 `src/` 的包直接 `require('../../../../fairy-contracts/client-ask-kit.cjs')`；
  - 手写 `lib/client.js` 的包由 `fairy-system/sync-ask-kit.js` 把真源内联进
    `// >>> fairy-ask-kit` … `// <<< fairy-ask-kit` 标记区，改完跑一次同步；
    没有提问件的包**不要**内联（同步器会报错拦下）。
- **门禁**：`check.sh` 跑 `sync-ask-kit.js --check`，内联块与真源不逐字节一致即失败；
  `fairy-system/test/ask-kit.test.js` 另跑一遍状态机行为（保存、无改动、保存失败、
  读取失败、只读、官方 `Input` 回退）。

新的设置卡不得再手搓 `input`/`select`/`checkbox` 与自己的保存文案；需要新控件时先在这里加。

`ponytail: useAskForm 不外露 setStatus，只读会话的说明句由调用方派生 status。` 目前只有 search 卡需要这一手，`ASK_TEXT.readOnly` 仍在（供 `AskActions` 的只读态用）；升级路径：出现第二处需要自己控制状态行时，再把 `setStatus` 从 hook 里放出来。

**边界：本套件只管设置卡里的输入行。** 真正"请用户做决定"的提问不走这里，
也不得自造弹窗：官方已有待答问题通道（host 插件 `@deepseek-ai/dsh-user-questions`
提供 `userQuestions`，客户端 `@deepseek-ai/dsh-client-ui-user-questions` 在
`conversation.composer` 插槽接管并渲染选项/自定义输入/跳过/分页/收起），
`exit_plan_mode` 走的就是它。插件若需要问用户，就调那条通道，让官方面板呈现；
本仓库的探查闸门已经是这个形态（按名解析 plan 控制器 + 官方 `exit_plan_mode`），
没有自建问询界面。

## ponytail 上限

`ponytail: HTTP 小工具（sendJson/readJson）在六个包各抄一份。` 每份十几行、语义稳定（正文大小上限 + JSON 解析错误），复制比跨包抽象便宜；升级路径：把这它们搬进本包（`./http` 子路径）后逐包删本地副本。
