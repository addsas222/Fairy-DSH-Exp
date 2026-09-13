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

## ponytail 上限

`ponytail: HTTP 小工具（sendJson/readJson）在六个包各抄一份。` 每份十几行、语义稳定（正文大小上限 + JSON 解析错误），复制比跨包抽象便宜；升级路径：把这它们搬进本包（`./http` 子路径）后逐包删本地副本。
