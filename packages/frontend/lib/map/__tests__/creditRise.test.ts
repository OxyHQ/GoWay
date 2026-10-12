/**
 * The chrome above the data credit rises exactly as far as the credit grows
 * past one line, and not at all while it is folded (`lib/map/creditRise.ts`).
 */
import { describe, expect, test } from 'bun:test';

import {
  CREDIT_BREATHING,
  CREDIT_GAP,
  creditRise,
  MAP_CREDIT_CLEARANCE,
} from '@/lib/map/creditRise';

describe('rising over the credit', () => {
  test('folded, or one line: nothing moves', () => {
    expect(creditRise(0)).toBe(0);
    expect(creditRise(22)).toBe(0);
    expect(creditRise(MAP_CREDIT_CLEARANCE - CREDIT_GAP - CREDIT_BREATHING)).toBe(0);
  });

  test('wrapped to three lines (sources, official data, the simulation’s label)', () => {
    const plate = 62;
    const rise = creditRise(plate);
    // The chrome's bottom ends up clear of the credit's top, with its breathing room.
    expect(MAP_CREDIT_CLEARANCE + rise).toBe(CREDIT_GAP + plate + CREDIT_BREATHING);
  });

  test('a nonsense measurement moves nothing', () => {
    expect(creditRise(Number.NaN)).toBe(0);
    expect(creditRise(-10)).toBe(0);
  });
});
