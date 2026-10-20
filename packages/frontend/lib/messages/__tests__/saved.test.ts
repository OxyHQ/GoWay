import { describe, expect, test } from 'bun:test';

import { SAVED_EN, SAVED_ES } from '../saved';

describe('Saved places messages', () => {
  test('every locale carries exactly the same keys', () => {
    expect(Object.keys(SAVED_ES).sort()).toEqual(Object.keys(SAVED_EN).sort());
  });

  test('placeholders match across locales', () => {
    const placeholders = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort();
    for (const [key, english] of Object.entries(SAVED_EN)) {
      expect({ key, placeholders: placeholders(SAVED_ES[key] ?? '') }).toEqual({
        key,
        placeholders: placeholders(english),
      });
    }
  });

  test('every counted message has both forms', () => {
    for (const key of Object.keys(SAVED_EN)) {
      if (key.endsWith('.one'))
        expect(SAVED_EN[`${key.slice(0, -'.one'.length)}.other`]).toBeDefined();
      if (key.endsWith('.other'))
        expect(SAVED_EN[`${key.slice(0, -'.other'.length)}.one`]).toBeDefined();
    }
  });
});
