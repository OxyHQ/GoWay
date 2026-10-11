/**
 * The city-tiles switch refines the city-3D flag and never stands alone, and
 * a production build ignores the query string — the same rules as
 * `city3dFlag.ts`, pinned the same way.
 */
import { describe, expect, test } from 'bun:test';

import { isCityTilesRequested } from '@/lib/map/cityTilesFlag';

const base = { city3d: true, enabled: false, development: true, search: '' };

describe('isCityTilesRequested', () => {
  test('off unless asked for', () => {
    expect(isCityTilesRequested(base)).toBe(false);
  });

  test('the build switch turns it on, in any build', () => {
    expect(isCityTilesRequested({ ...base, enabled: true, development: false })).toBe(true);
  });

  test('the query string works only in a development build', () => {
    expect(isCityTilesRequested({ ...base, search: '?cityTiles=1' })).toBe(true);
    expect(isCityTilesRequested({ ...base, search: '?city3d=1&cityTiles=true' })).toBe(true);
    expect(isCityTilesRequested({ ...base, search: '?cityTiles=1', development: false })).toBe(
      false,
    );
    expect(isCityTilesRequested({ ...base, search: '?cityTiles=0' })).toBe(false);
  });

  test('never without the city-3D layer', () => {
    expect(isCityTilesRequested({ ...base, city3d: false, enabled: true })).toBe(false);
    expect(isCityTilesRequested({ ...base, city3d: false, search: '?cityTiles=1' })).toBe(false);
  });
});
