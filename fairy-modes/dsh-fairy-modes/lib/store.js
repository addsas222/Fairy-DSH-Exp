/**
 * Per-session mode mirror: `$DSH_HOME/fairy-modes/modes.json`.
 *
 * Why a mirror instead of the session log: `fairy/mode` is out-of-vocabulary
 * for every harness cohort, and the persistence read path refuses a log that
 * carries an unknown type without the envelope's `ignorable` marker — a marker
 * `session.append` cannot set on 0.1.1 or 0.1.6-alpha.1 (its envelope builder
 * only threads `surfaceOp`/`sourceEventSeqs`). Appending the event therefore
 * made the whole log unreadable on every line. The mirror keeps one mode per
 * session id: a restart restores it, a fork starts at `off` (a new id), and
 * the log stays readable.
 *
 * Reads are synchronous and per call, so sibling realm instances stay
 * consistent without a cache protocol; a mode click is the only writer and the
 * file is tiny. A missing or corrupt file degrades to an empty map — the mode
 * is advisory state, never a reason to fail a session.
 *
 * @module dsh-fairy-modes/store
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * `$DSH_HOME/fairy-modes/modes.json` (mirrors `fairy-memory/config.json`).
 *
 * Resolved per call so tests can retarget `DSH_HOME` without module state.
 *
 * @returns the absolute mirror path.
 */
export function modesFilePath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(home, 'fairy-modes', 'modes.json');
}

/**
 * Read the whole mirror, treating any unreadable shape as empty.
 *
 * @param file - the mirror path.
 * @returns a plain `{ [sessionId]: mode }` object, never null.
 */
function readAll(file) {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

/**
 * One session's mirrored mode.
 *
 * @param sessionId - the session to read.
 * @param file - the mirror path; defaults to {@link modesFilePath}.
 * @returns the recorded mode, or undefined when none was recorded.
 */
export function readMode(sessionId, file = modesFilePath()) {
  const value = readAll(file)[sessionId];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Record one session's mode. Atomic: temp file plus rename, so a crash leaves
 * either the old or the new map, never a torn one.
 *
 * @param sessionId - the session to record.
 * @param mode - the canonical mode (`off`, `explore`, `ptc`, `create`, `roleplay`).
 * @param file - the mirror path; defaults to {@link modesFilePath}.
 * @returns None.
 */
export function writeMode(sessionId, mode, file = modesFilePath()) {
  const all = readAll(file);
  if (all[sessionId] === mode) return;
  all[sessionId] = mode;
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(all, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, file);
}
