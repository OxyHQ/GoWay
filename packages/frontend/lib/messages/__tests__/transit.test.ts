import { describe, expect, test } from 'bun:test';

import { TRANSIT_EN, TRANSIT_ES } from '../transit';

describe('Nearby transit messages', () => {
  test('every locale carries exactly the same keys', () => {
    expect(Object.keys(TRANSIT_ES).sort()).toEqual(Object.keys(TRANSIT_EN).sort());
  });

  test('placeholders match across locales', () => {
    const placeholders = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort();
    for (const [key, english] of Object.entries(TRANSIT_EN)) {
      expect({ key, placeholders: placeholders(TRANSIT_ES[key] ?? '') }).toEqual({
        key,
        placeholders: placeholders(english),
      });
    }
  });
});
