import { describe, expect, it } from 'bun:test';
import { LIST_REFRESH_MS, nextListRefreshMs } from '../organizationLists';

describe('list refresh', () => {
  it('re-reads every minute, sooner just after the earliest active entry ends', () => {
    const entries = [
      { endsAt: '2030-01-01T00:00:30.000Z' },
      { endsAt: '2030-01-01T05:00:00.000Z' },
    ];
    const now = Date.parse('2030-01-01T00:00:00.000Z');
    expect(nextListRefreshMs(entries, 'active', now)).toBe(30_010);
    expect(nextListRefreshMs(entries, 'all', now)).toBe(LIST_REFRESH_MS);
    expect(nextListRefreshMs(entries, 'active', now + 3_600_000)).toBe(1);
    expect(nextListRefreshMs([], 'active', now)).toBe(LIST_REFRESH_MS);
  });
});
