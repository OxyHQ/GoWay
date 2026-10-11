/**
 * GoWay Live is off unless a build or a DEVELOPMENT tab asks for it: a
 * production build ignores `?live=1`, so no link can switch a third party's
 * real-time feed on for somebody using goway.to.
 */
import { describe, expect, test } from 'bun:test';

import { isLiveRequested } from '@/lib/map/liveFlag';

describe('isLiveRequested', () => {
  test('off by default, and off in this test environment', () => {
    expect(isLiveRequested({ enabled: false, development: false, search: '' })).toBe(false);
    expect(isLiveRequested({ enabled: false, development: true, search: '' })).toBe(false);
  });

  test('the build flag turns it on everywhere', () => {
    expect(isLiveRequested({ enabled: true, development: false, search: '' })).toBe(true);
  });

  test('the query parameter works in development only', () => {
    expect(isLiveRequested({ enabled: false, development: true, search: '?live=1' })).toBe(true);
    expect(isLiveRequested({ enabled: false, development: true, search: '?x=1&live=true' })).toBe(
      true,
    );
    expect(isLiveRequested({ enabled: false, development: true, search: '?live=0' })).toBe(false);
    expect(isLiveRequested({ enabled: false, development: false, search: '?live=1' })).toBe(false);
  });
});
