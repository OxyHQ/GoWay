/**
 * The live-coverage channel (`lib/live/coverage.ts`) and how the live layer
 * computes it (`features/live/coverageOf.ts`): only fresh sources, only the
 * kinds they actually sent, only where they cover the visible map.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { LiveSource } from '@goway.to/sdk/live';

import { coverageOf } from '@/features/live/coverageOf';
import {
  clearLiveCoverage,
  getLiveCoverage,
  type LiveCoverage,
  liveCoverageTileOf,
  publishLiveCoverage,
  subscribeLiveCoverage,
} from '@/lib/live/coverage';

afterEach(() => clearLiveCoverage());

function source(
  id: string,
  status: LiveSource['status'],
  coverage: LiveSource['coverage'],
): LiveSource {
  return {
    id,
    kind: 'transit',
    name: id,
    attribution: { label: id, href: 'https://example.org' },
    licence: { label: 'CC BY 4.0', href: 'https://example.org/l' },
    coverage,
    status,
    lastUpdatedAt: null,
    pollIntervalSeconds: 20,
    staleAfterSeconds: 120,
    dropAfterSeconds: 600,
    entityCount: 1,
  };
}

// Central Barcelona, a few z12 tiles.
const VIEW = { west: 2.12, south: 41.37, east: 2.2, north: 41.41 };

describe('the coverage channel', () => {
  test('starts empty, calls a subscriber at once and on change, and not for an equal value', () => {
    expect(getLiveCoverage().kinds.bus.tiles.size).toBe(0);
    const seen: LiveCoverage[] = [];
    const stop = subscribeLiveCoverage((coverage) => seen.push(coverage));
    expect(seen).toHaveLength(1);
    const next = coverageOf(
      [source('renfe', 'live', null)],
      new Map([['renfe', new Set(['train' as const])]]),
      VIEW,
    );
    publishLiveCoverage(next);
    publishLiveCoverage(
      coverageOf(
        [source('renfe', 'live', null)],
        new Map([['renfe', new Set(['train' as const])]]),
        VIEW,
      ),
    );
    expect(seen).toHaveLength(2);
    stop();
    clearLiveCoverage();
    expect(seen).toHaveLength(2);
  });

  test('keys tiles as x/y at z12', () => {
    expect(liveCoverageTileOf(41.3874, 2.1686)).toBe('2072/1529');
  });
});

describe('coverageOf', () => {
  test('a fresh source covers its kinds where it meets the view', () => {
    const coverage = coverageOf(
      [source('renfe', 'live', { west: -9.6, south: 35.8, east: 4.6, north: 44 })],
      new Map([['renfe', new Set(['train' as const])]]),
      VIEW,
    );
    expect(coverage.kinds.train.fresh).toBe(true);
    expect(coverage.kinds.train.tiles.has(liveCoverageTileOf(41.3874, 2.1686))).toBe(true);
    expect(coverage.kinds.bus.tiles.size).toBe(0);
  });

  test('stale, starting, foreign and unseen-mode sources cover nothing', () => {
    const modes = new Map([['s', new Set(['bus' as const])]]);
    for (const status of ['stale', 'starting', 'unavailable', 'idle'] as const) {
      expect(coverageOf([source('s', status, null)], modes, VIEW).kinds.bus.fresh).toBe(false);
    }
    // New York's buses do not cover Barcelona.
    const ny = coverageOf(
      [source('s', 'live', { west: -74.3, south: 40.45, east: -73.65, north: 40.95 })],
      modes,
      VIEW,
    );
    expect(ny.kinds.bus.tiles.size).toBe(0);
    // A source that has sent no trams covers no trams.
    expect(coverageOf([source('s', 'live', null)], modes, VIEW).kinds.tram.fresh).toBe(false);
    expect(coverageOf([source('s', 'live', null)], modes, null).kinds.bus.fresh).toBe(false);
  });
});
