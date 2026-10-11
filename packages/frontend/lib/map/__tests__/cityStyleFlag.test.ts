import { describe, expect, test } from 'bun:test';

import { cityStyleRequested } from '@/lib/map/cityStyleFlag';

const ask = (over: Partial<Parameters<typeof cityStyleRequested>[0]>) =>
  cityStyleRequested({ city3d: true, build: 'classic', development: true, search: '', ...over });

describe('cityStyleRequested', () => {
  test('classic unless asked', () => {
    expect(ask({})).toBe('classic');
  });

  test('the query string picks the look in development', () => {
    expect(ask({ search: '?cityStyle=detailed' })).toBe('detailed');
    expect(ask({ search: '?cityStyle=classic', build: 'detailed' })).toBe('classic');
    expect(ask({ search: '?cityStyle=shiny' })).toBe('classic');
  });

  test('production ignores the query string and follows the build', () => {
    expect(ask({ development: false, search: '?cityStyle=detailed' })).toBe('classic');
    expect(ask({ development: false, build: 'detailed' })).toBe('detailed');
  });

  test('never without the city-3D layer', () => {
    expect(ask({ city3d: false, build: 'detailed', search: '?cityStyle=detailed' })).toBe(
      'classic',
    );
  });
});
