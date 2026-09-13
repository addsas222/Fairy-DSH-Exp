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
export const FAIRY_MODES = Object.freeze(['off', 'ptc', 'create']);

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
