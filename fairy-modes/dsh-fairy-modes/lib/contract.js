/**
 * The one cross-face contract of dsh-fairy-modes: the mode vocabulary, the
 * session event that records it, and the projection key that folds it. Both
 * faces (agent service, host bridge) and the browser chip answer to these
 * names, so they live apart from either implementation.
 */

/** Log-only session event carrying the selected mode; the last one wins. */
export const FAIRY_MODE_EVENT = 'fairy/mode';

/** Session projection key folding {@link FAIRY_MODE_EVENT} into `{ mode }`. */
export const FAIRY_MODE_PROJECTION = 'fairyMode';

/** Every selectable mode, in UI order. Plan mode (探索/极简) is official and orthogonal. */
export const FAIRY_MODES = Object.freeze(['off', 'explore', 'ptc', 'create', 'roleplay']);

/**
 * Normalize a requested mode, tolerating case and surrounding blanks.
 *
 * @param value - untrusted mode request from a command line, HTTP body, or chip.
 * @returns The canonical mode, or undefined when the request names none.
 */
export function normalizeFairyMode(value) {
  const mode = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return FAIRY_MODES.includes(mode) ? mode : undefined;
}

/**
 * The presentation-mode value this harness cohort uses for the code surface.
 *
 * The tools registry renamed the value across cohorts: 0.1.1 accepts
 * `native | code | both` (its code-only instruction requires exactly `code`),
 * while 0.1.2+ uses `native | ptc | both`. The split is detectable through
 * `systemPrompt.getSectionOrder`, which 0.1.1 lacks and 0.1.2+ exposes.
 *
 * @param systemPrompt - the prompt registry of the calling scope.
 * @returns `ptc` on 0.1.2+ cohorts, `code` on 0.1.1.
 */
export function codePresentationMode(systemPrompt) {
  return typeof systemPrompt?.getSectionOrder === 'function' ? 'ptc' : 'code';
}

/**
 * Prompt order for one mode guidance section: immediately after the official
 * plan policy, which sits at order 500 (0.1.2+) or the literal 50 (0.1.1).
 *
 * @param systemPrompt - the prompt registry of the calling scope.
 * @returns the numeric order this cohort places after the plan policy.
 */
export function modeSectionOrder(systemPrompt) {
  return typeof systemPrompt?.getSectionOrder === 'function'
    ? systemPrompt.getSectionOrder('PLAN_POLICY') + 1
    : 51;
}

/**
 * 模式流水线（会话调度）：扮演 → 探查 → 建造 → 创造，然后回到扮演。
 *
 * 阶段不是新的日志状态：`explore` 读的是官方 `plan` 投影（plan 模式打开即处于
 * 探查阶段），`ptc` / `create` / `roleplay` 读的是 `fairyMode` 投影。两个投影都
 * 折在会话日志里，所以 resume / fork 之后流水线位置自动还原。
 */
export const FAIRY_PIPELINE_STAGES = Object.freeze(['roleplay', 'explore', 'ptc', 'create']);

/** 阶段的中文名，供工具回报与 chip 使用。 */
export const PIPELINE_STAGE_LABELS = Object.freeze({
  off: '空闲（不在流水线内）',
  explore: '探查（只读）',
  roleplay: '扮演',
  ptc: '建造（PTC）',
  create: '创造（回忆）',
});

/**
 * 每个阶段要落地的状态：fairy 模式 + 是否期望官方 plan-mode 打开。
 *
 * `explore` 用 `off`（默认 agent 行为）并把 plan 打开：官方 plan 策略段自带
 * 「只探查、不改动、方案经审批」的约束，不需要我们再写一份。plan-mode 由官方
 * 服务拥有（另一个 isolate 领域），本包只读 `plan` 投影、不写它——需要打开时
 * 由用户在输入框 `/plan` 或会话头 chip 切换。
 */
export const PIPELINE_STAGE_STATE = Object.freeze({
  roleplay: Object.freeze({ mode: 'roleplay', plan: false }),
  explore: Object.freeze({ mode: 'explore', plan: true }),
  ptc: Object.freeze({ mode: 'ptc', plan: false }),
  create: Object.freeze({ mode: 'create', plan: false }),
});

/**
 * 当前阶段：plan 打开即在探查阶段，否则就是 fairy 模式本身。
 *
 * @param input.planActive - 官方 `plan` 投影的 `active`。
 * @param input.mode - `fairyMode` 投影的模式。
 * @returns 流水线阶段；未知模式回落 `roleplay`。
 */
export function pipelineStageOf({ planActive, mode }) {
  if (planActive === true) return 'explore';
  // 默认模式（off）是流水线之外的空闲态：用户显式关掉了模式，或还没进入流水线。
  if (mode === undefined || mode === 'off') return 'off';
  return FAIRY_PIPELINE_STAGES.includes(mode) ? mode : 'off';
}

/**
 * 下一个阶段；末尾回到扮演，所以流水线是个环。
 *
 * @param stage - 当前阶段。
 * @returns 下一个阶段。
 */
export function nextPipelineStage(stage) {
  // 空闲态推进一格 = 回到流水线起点（扮演），而不是跳到探查：进入工作流应当是
  // 一次显式选择，从空闲直接落到探查会跳过扮演阶段的判断。
  if (stage === 'off') return 'roleplay';
  const index = FAIRY_PIPELINE_STAGES.indexOf(stage);
  return FAIRY_PIPELINE_STAGES[index < 0 ? 0 : (index + 1) % FAIRY_PIPELINE_STAGES.length];
}
