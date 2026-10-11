/**
 * Undo/redo for Camera Studio, one step per GESTURE.
 *
 * The rule from Atlas Camera Studio, and the one users expect from any
 * drawing tool: undo takes back what you DID, not what the app recorded
 * along the way. A stroke is hundreds of pointer moves and a slider drag is
 * dozens of values; each is one step. So the history has two ways in:
 *
 *  - {@link History.push} — a discrete edit (add a keyframe, delete one,
 *    change an aim). One step.
 *  - {@link History.begin} … {@link History.preview} … {@link History.commit} —
 *    a gesture. `begin` remembers where it started, `preview` shows each
 *    intermediate value WITHOUT recording it, and `commit` records the whole
 *    gesture as one step (or nothing, if it ended where it began). A gesture
 *    left open is committed by the next `push`, `undo` or `redo`, so a slider
 *    whose release event never arrived (a keyboard step) cannot swallow the
 *    edits after it.
 *
 * Immutable and pure: each call returns a new history, so it drops straight
 * into React state and tests without a renderer.
 */

export interface History<T> {
  readonly past: readonly T[];
  readonly present: T;
  readonly future: readonly T[];
  /** The state a gesture started from, while one is open. */
  readonly gestureStart: T | null;
}

/** Most steps kept. Older ones fall off the bottom. */
export const MAX_HISTORY = 100;

export function createHistory<T>(initial: T): History<T> {
  return { past: [], present: initial, future: [], gestureStart: null };
}

function record<T>(history: History<T>, previous: T, next: T): History<T> {
  if (Object.is(previous, next)) return { ...history, present: next, gestureStart: null };
  const past = [...history.past, previous];
  if (past.length > MAX_HISTORY) past.splice(0, past.length - MAX_HISTORY);
  return { past, present: next, future: [], gestureStart: null };
}

/** Close an open gesture, recording it as one step. */
function settle<T>(history: History<T>): History<T> {
  if (history.gestureStart === null) return history;
  return record(history, history.gestureStart, history.present);
}

/** A discrete edit: one step. A no-op edit (same object) records nothing. */
export function push<T>(history: History<T>, next: T): History<T> {
  const settled = settle(history);
  return record(settled, settled.present, next);
}

/** Start a gesture from the current state. */
export function begin<T>(history: History<T>): History<T> {
  const settled = settle(history);
  return { ...settled, gestureStart: settled.present };
}

/** Show an intermediate value of the open gesture (opening one if needed). */
export function preview<T>(history: History<T>, next: T): History<T> {
  const open = history.gestureStart === null ? begin(history) : history;
  return { ...open, present: next };
}

/** End the gesture: one step for all of it. */
export function commit<T>(history: History<T>): History<T> {
  return settle(history);
}

export function canUndo<T>(history: History<T>): boolean {
  return history.past.length > 0 || history.gestureStart !== null;
}

export function canRedo<T>(history: History<T>): boolean {
  return history.future.length > 0 && history.gestureStart === null;
}

export function undo<T>(history: History<T>): History<T> {
  const settled = settle(history);
  if (settled.past.length === 0) return settled;
  const previous = settled.past[settled.past.length - 1];
  return {
    past: settled.past.slice(0, -1),
    present: previous,
    future: [settled.present, ...settled.future],
    gestureStart: null,
  };
}

export function redo<T>(history: History<T>): History<T> {
  const settled = settle(history);
  if (settled.future.length === 0) return settled;
  const [next, ...rest] = settled.future;
  return {
    past: [...settled.past, settled.present],
    present: next,
    future: rest,
    gestureStart: null,
  };
}
