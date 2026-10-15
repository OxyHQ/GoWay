/**
 * The terrain credit (`terrainCoverage.ts`): a terrain source is named while
 * a cell of its set is on screen, and only a source this build knows.
 */
import { describe, expect, test } from 'bun:test';

import { encodeCoverageTree } from '@/worker/coverageTree.js';
import { cellsTree } from '../../../scripts/imagery/cells';
import { parseTerrainCoverage, terrainSourcesInView } from '../terrainCoverage';

function document(sources: string[]) {
  return {
    schema: 1,
    sets: [
      {
        id: 'icgc-met-2021',
        tiers: ['terrain'],
        minZoom: 7,
        maxZoom: 12,
        sources,
        bbox: [0.15, 40.52, 3.33, 42.87],
        cells: encodeCoverageTree(cellsTree([{ z: 7, x: 64, y: 47 }], 7), 7),
      },
    ],
  };
}

describe('the terrain credit', () => {
  const barcelona = { zoom: 16.4, west: 2.16, south: 41.39, east: 2.19, north: 41.41 };
  test('the source is named over its cell, at street and city zooms', () => {
    const coverage = parseTerrainCoverage(document(['icgc-met']));
    expect(terrainSourcesInView(coverage, barcelona)).toEqual(['icgc-met']);
    expect(terrainSourcesInView(coverage, { ...barcelona, zoom: 9 })).toEqual(['icgc-met']);
  });

  test('not elsewhere, and not below the set’s zooms (the fallback is drawn there)', () => {
    const coverage = parseTerrainCoverage(document(['icgc-met']));
    expect(
      terrainSourcesInView(coverage, {
        zoom: 15,
        west: -74.0,
        south: 40.7,
        east: -73.9,
        north: 40.8,
      }),
    ).toEqual([]);
    expect(terrainSourcesInView(coverage, { ...barcelona, zoom: 5 })).toEqual([]);
  });

  test('a source this build does not know is never credited by the server’s string', () => {
    expect(parseTerrainCoverage(document(['someone-else'])).sets).toEqual([]);
  });

  test('a view whose bounds a tilted camera made nonsense counts as the whole world', () => {
    const coverage = parseTerrainCoverage(document(['icgc-met']));
    expect(
      terrainSourcesInView(coverage, { zoom: 15, west: Number.NaN, south: 41, east: 2, north: 42 }),
    ).toEqual(['icgc-met']);
  });
});
