/**
 * Undo/redo is one step per GESTURE: a stroke or a slider drag is undone as a
 * whole, not one pointer move at a time.
 */
import { describe, expect, test } from 'bun:test';

import {
  begin,
  canRedo,
  canUndo,
  commit,
  createHistory,
  MAX_HISTORY,
  preview,
  push,
  redo,
  undo,
} from '@/lib/map/camera/history';

describe('history', () => {
  test('discrete edits are one step each', () => {
    let h = createHistory(0);
    h = push(h, 1);
    h = push(h, 2);
    expect(h.present).toBe(2);
    h = undo(h);
    expect(h.present).toBe(1);
    h = undo(h);
    expect(h.present).toBe(0);
    expect(canUndo(h)).toBe(false);
    h = redo(h);
    h = redo(h);
    expect(h.present).toBe(2);
    expect(canRedo(h)).toBe(false);
  });

  test('a gesture of many previews is ONE step', () => {
    let h = createHistory('a');
    h = begin(h);
    for (const value of ['b', 'c', 'd', 'e']) h = preview(h, value);
    h = commit(h);
    expect(h.present).toBe('e');
    expect(h.past).toEqual(['a']);
    h = undo(h);
    expect(h.present).toBe('a');
    h = redo(h);
    expect(h.present).toBe('e');
  });

  test('a gesture that ends where it began records nothing', () => {
    const start = { n: 1 };
    let h = createHistory(start);
    h = begin(h);
    h = preview(h, { n: 2 });
    h = preview(h, start);
    h = commit(h);
    expect(h.past).toEqual([]);
  });

  test('an unclosed gesture is settled by the next edit, undo or redo', () => {
    let h = createHistory(0);
    h = preview(h, 5); // opens a gesture implicitly (a keyboard step with no release)
    h = push(h, 6);
    expect(h.past).toEqual([0, 5]);
    h = preview(h, 7);
    h = undo(h); // settles 6→7 first, then undoes it
    expect(h.present).toBe(6);
  });

  test('a new edit clears the redo stack', () => {
    let h = push(push(createHistory(0), 1), 2);
    h = undo(h);
    h = push(h, 9);
    expect(canRedo(h)).toBe(false);
    expect(h.past).toEqual([0, 1]);
  });

  test('the stack is bounded', () => {
    let h = createHistory(0);
    for (let i = 1; i <= MAX_HISTORY + 20; i++) h = push(h, i);
    expect(h.past).toHaveLength(MAX_HISTORY);
    expect(h.past[0]).toBe(20);
  });
});
