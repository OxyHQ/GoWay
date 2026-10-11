/**
 * The city-3D trees come with the prototype unless a build or a DEVELOPMENT
 * tab turns them off; a production build ignores the query string, as it does
 * `?city3d=1`.
 */
import { describe, expect, test } from 'bun:test';

import { isCity3dTreesRequested } from '@/lib/map/city3dTreesFlag';

describe('isCity3dTreesRequested', () => {
  test('on by default, in development and production alike', () => {
    expect(isCity3dTreesRequested({ enabled: true, development: false, search: '' })).toBe(true);
    expect(isCity3dTreesRequested({ enabled: true, development: true, search: '' })).toBe(true);
  });

  test('the build flag turns them off everywhere', () => {
    expect(isCity3dTreesRequested({ enabled: false, development: true, search: '' })).toBe(false);
    expect(
      isCity3dTreesRequested({ enabled: false, development: true, search: '?city3dTrees=1' }),
    ).toBe(false);
  });

  test('?city3dTrees=0 works in development only', () => {
    expect(
      isCity3dTreesRequested({ enabled: true, development: true, search: '?city3dTrees=0' }),
    ).toBe(false);
    expect(
      isCity3dTreesRequested({
        enabled: true,
        development: true,
        search: '?city3d=1&city3dTrees=false',
      }),
    ).toBe(false);
    expect(
      isCity3dTreesRequested({ enabled: true, development: false, search: '?city3dTrees=0' }),
    ).toBe(true);
  });
});
