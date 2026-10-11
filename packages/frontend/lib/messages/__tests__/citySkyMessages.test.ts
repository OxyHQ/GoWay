import { describe, expect, test } from 'bun:test';

import { CITY_SKY_EN, CITY_SKY_ES, CITY_SKY_MESSAGES } from '../citySky';

describe('time-of-day scrubber messages', () => {
  test('every locale carries exactly the same keys', () => {
    for (const table of Object.values(CITY_SKY_MESSAGES)) {
      expect(Object.keys(table).sort()).toEqual(Object.keys(CITY_SKY_EN).sort());
    }
  });

  test('placeholders match across locales', () => {
    const placeholders = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort();
    for (const [key, english] of Object.entries(CITY_SKY_EN)) {
      expect({ key, placeholders: placeholders(CITY_SKY_ES[key]) }).toEqual({
        key,
        placeholders: placeholders(english),
      });
    }
  });

  test('every sun phase the caption can show has a string', () => {
    for (const phase of ['day', 'golden', 'civil', 'nautical', 'night']) {
      expect(CITY_SKY_EN[`citySky.phase.${phase}`]).toBeDefined();
    }
  });
});
