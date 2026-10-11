/**
 * The city-3D prototype is off unless a build or a DEVELOPMENT tab asks for it.
 *
 * The rule worth a test: a production build ignores `?city3d=1`, so nobody can
 * send a goway.to link that switches an experimental renderer on.
 */
import { describe, expect, test } from 'bun:test';

import { isCity3dRequested } from '@/lib/map/city3dFlag';

describe('isCity3dRequested', () => {
  test('off by default, in development and production alike', () => {
    expect(isCity3dRequested({ enabled: false, development: false, search: '' })).toBe(false);
    expect(isCity3dRequested({ enabled: false, development: true, search: '' })).toBe(false);
  });

  test('the build flag turns it on everywhere', () => {
    expect(isCity3dRequested({ enabled: true, development: false, search: '' })).toBe(true);
  });

  test('the query parameter works in development only', () => {
    expect(isCity3dRequested({ enabled: false, development: true, search: '?city3d=1' })).toBe(
      true,
    );
    expect(
      isCity3dRequested({ enabled: false, development: true, search: '?a=b&city3d=true' }),
    ).toBe(true);
    expect(isCity3dRequested({ enabled: false, development: false, search: '?city3d=1' })).toBe(
      false,
    );
  });

  test('anything but 1/true is not a yes', () => {
    expect(isCity3dRequested({ enabled: false, development: true, search: '?city3d=0' })).toBe(
      false,
    );
    expect(isCity3dRequested({ enabled: false, development: true, search: '?city3d' })).toBe(false);
    expect(isCity3dRequested({ enabled: false, development: true, search: '?xcity3d=1' })).toBe(
      false,
    );
  });
});
