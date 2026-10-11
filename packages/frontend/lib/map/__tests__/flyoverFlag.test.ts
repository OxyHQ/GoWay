/**
 * The flyover and Camera Studio are off unless a build or a DEVELOPMENT tab
 * asks: a production build ignores `?flyover=1`.
 */
import { describe, expect, test } from 'bun:test';

import { isFlyoverRequested } from '@/lib/map/flyoverFlag';

describe('isFlyoverRequested', () => {
  test('off by default, in development and production alike', () => {
    expect(isFlyoverRequested({ enabled: false, development: false, search: '' })).toBe(false);
    expect(isFlyoverRequested({ enabled: false, development: true, search: '' })).toBe(false);
  });

  test('the build flag turns it on everywhere', () => {
    expect(isFlyoverRequested({ enabled: true, development: false, search: '' })).toBe(true);
  });

  test('the query parameter works in development only', () => {
    expect(isFlyoverRequested({ enabled: false, development: true, search: '?flyover=1' })).toBe(
      true,
    );
    expect(
      isFlyoverRequested({ enabled: false, development: true, search: '?a=b&flyover=true' }),
    ).toBe(true);
    expect(isFlyoverRequested({ enabled: false, development: false, search: '?flyover=1' })).toBe(
      false,
    );
    expect(isFlyoverRequested({ enabled: false, development: true, search: '?flyover=0' })).toBe(
      false,
    );
  });
});
