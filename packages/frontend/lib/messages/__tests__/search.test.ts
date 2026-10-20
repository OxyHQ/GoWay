import { describe, expect, test } from 'bun:test';

import { SEARCH_EN, SEARCH_ES } from '../search';

describe('search messages', () => {
  test('every locale carries exactly the same keys', () => {
    expect(Object.keys(SEARCH_ES).sort()).toEqual(Object.keys(SEARCH_EN).sort());
  });

  test('placeholders match across locales', () => {
    const placeholders = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort();
    for (const [key, english] of Object.entries(SEARCH_EN)) {
      expect({ key, placeholders: placeholders(SEARCH_ES[key] ?? '') }).toEqual({
        key,
        placeholders: placeholders(english),
      });
    }
  });
});
