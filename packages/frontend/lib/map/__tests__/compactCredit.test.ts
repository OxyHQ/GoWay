/**
 * The compact data credit (OSMF Attribution Guidelines): visible when the map
 * loads, folded only by its own timer or the reader's first interaction, and
 * opened again from its ⓘ — and wired so on both `MapCanvas` forks, with no
 * prop anywhere that turns it off.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  CREDIT_AUTO_COLLAPSE_MS,
  type CreditEvent,
  type CreditState,
  creditReducer,
  INITIAL_CREDIT_STATE,
} from '@/lib/map/compactCredit';

const run = (events: readonly CreditEvent['type'][], from: CreditState = INITIAL_CREDIT_STATE) =>
  events.reduce((state, type) => creditReducer(state, { type }), from);

describe('the compact credit', () => {
  test('is spelled out when the map loads', () => {
    expect(INITIAL_CREDIT_STATE.expanded).toBe(true);
  });

  test('folds after five seconds', () => {
    expect(CREDIT_AUTO_COLLAPSE_MS).toBe(5000);
    expect(run(['elapsed']).expanded).toBe(false);
  });

  test('folds at the first interaction with the map', () => {
    expect(run(['mapInteraction']).expanded).toBe(false);
  });

  test('those are the only ways it folds by itself', () => {
    // Exhaustive over the event union: anything else would be a new trigger.
    const triggers: CreditEvent['type'][] = ['elapsed', 'mapInteraction', 'toggle'];
    for (const type of triggers) {
      const next = creditReducer(INITIAL_CREDIT_STATE, { type });
      expect(next.expanded).toBe(false);
    }
  });

  test('the ⓘ opens it again, and the timer never folds what the reader opened', () => {
    const reopened = run(['elapsed', 'toggle']);
    expect(reopened.expanded).toBe(true);
    expect(run(['elapsed'], reopened).expanded).toBe(true);
    // ...but going back to the map does.
    expect(run(['mapInteraction'], reopened).expanded).toBe(false);
    // And the ⓘ folds it on demand.
    expect(run(['toggle'], reopened).expanded).toBe(false);
  });

  test('an interaction once folded changes nothing (React bails out per frame)', () => {
    const folded = run(['mapInteraction']);
    expect(creditReducer(folded, { type: 'mapInteraction' })).toBe(folded);
    expect(creditReducer(folded, { type: 'elapsed' })).toBe(folded);
  });
});

describe('wired on every map', () => {
  const read = (path: string) => readFileSync(join(import.meta.dir, '..', '..', '..', path), 'utf8');

  for (const fork of ['components/map/MapCanvas.web.tsx', 'components/map/MapCanvas.native.tsx']) {
    test(`${fork} renders it from the credit state, unconditionally`, () => {
      const text = read(fork);
      expect(text).toContain('useCompactCredit(');
      expect(text).toMatch(/<MapAttribution[^>]*expanded=\{credit\.expanded\}/);
      expect(text).toMatch(/onToggle=\{credit\.toggle\}/);
      // The interaction is the READER's: user-sourced moves and taps only.
      const notes = text.match(/noteCreditInteraction\(\)/g) ?? [];
      expect(notes.length).toBe(2);
    });
  }

  test('the web fork folds only on a user-sourced move', () => {
    expect(read('components/map/MapCanvas.web.tsx')).toContain(
      "if (moveSourceOf(event) === 'user') noteCreditInteraction();",
    );
  });

  test('no MapCanvas prop can switch the credit off', () => {
    const types = read('components/map/types.ts');
    const props = types.slice(types.indexOf('export interface MapCanvasProps'));
    const body = props.slice(0, props.indexOf('\n}\n'));
    expect(body).not.toMatch(/attribution|credit/i);
  });
});
