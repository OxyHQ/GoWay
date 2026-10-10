import { describe, expect, test } from 'bun:test';

import { AVAILABILITY_MESSAGES } from '@/lib/mercaria/presentation';

import { PRODUCTS_EN, PRODUCTS_ES } from '../products';

describe('Products messages', () => {
  test('every locale carries exactly the same keys', () => {
    expect(Object.keys(PRODUCTS_ES).sort()).toEqual(Object.keys(PRODUCTS_EN).sort());
  });

  test('placeholders match across locales', () => {
    const placeholders = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort();
    for (const [key, english] of Object.entries(PRODUCTS_EN)) {
      expect({ key, placeholders: placeholders(PRODUCTS_ES[key]) }).toEqual({
        key,
        placeholders: placeholders(english),
      });
    }
  });

  test('every availability has its words', () => {
    for (const key of Object.values(AVAILABILITY_MESSAGES)) {
      expect(PRODUCTS_EN[key]).toBeDefined();
    }
  });

  test('every counted message has both forms', () => {
    for (const key of Object.keys(PRODUCTS_EN)) {
      if (key.endsWith('.one'))
        expect(PRODUCTS_EN[`${key.slice(0, -'.one'.length)}.other`]).toBeDefined();
      if (key.endsWith('.other'))
        expect(PRODUCTS_EN[`${key.slice(0, -'.other'.length)}.one`]).toBeDefined();
    }
  });
});
