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
