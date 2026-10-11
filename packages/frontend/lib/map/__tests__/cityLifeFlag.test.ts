/**
 * The city-life switch refines the city-3D flag and never stands alone, and a
 * production build ignores the query string — the rules of `city3dFlag.ts`,
 * pinned the same way.
 */
import { describe, expect, test } from 'bun:test';

import { isCityLifeRequested } from '@/lib/map/cityLifeFlag';

const base = { city3d: true, enabled: false, development: true, search: '' };

describe('isCityLifeRequested', () => {
  test('off unless asked for', () => {
    expect(isCityLifeRequested(base)).toBe(false);
  });

  test('the build switch turns it on, in any build', () => {
    expect(isCityLifeRequested({ ...base, enabled: true, development: false })).toBe(true);
  });

  test('the query string works only in a development build', () => {
    expect(isCityLifeRequested({ ...base, search: '?cityLife=1' })).toBe(true);
    expect(isCityLifeRequested({ ...base, search: '?city3d=1&cityLife=true' })).toBe(true);
    expect(isCityLifeRequested({ ...base, search: '?cityLife=1', development: false })).toBe(false);
    expect(isCityLifeRequested({ ...base, search: '?cityLife=0' })).toBe(false);
  });

  test('never without the city-3D layer; the city tiles are not required (worldwide)', () => {
    expect(isCityLifeRequested({ ...base, city3d: false, enabled: true })).toBe(false);
    expect(isCityLifeRequested({ ...base, city3d: false, search: '?cityLife=1' })).toBe(false);
    expect(isCityLifeRequested({ ...base, search: '?city3d=1&cityLife=1' })).toBe(true);
  });
});
