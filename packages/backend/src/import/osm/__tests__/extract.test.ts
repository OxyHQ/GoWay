/**
 * The three-pass extract, end to end, over an archive built in this repository.
 *
 * What this proves that the unit tests do not: that a way's position is
 * resolved from nodes that went past before the way was read, that a relation's
 * is resolved through its member ways, and that the element TYPE survives all
 * of it — which is the #58 defect, reproduced at the only place it can be
 * introduced.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractPois } from '../extract';
import type { ImportedPlace } from '../placeRecord';
import { buildPbf, type FixtureBlock } from './pbfFixture';

const directory = mkdtempSync(join(tmpdir(), 'goway-extract-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

function writePbf(name: string, blocks: FixtureBlock[]): string {
  const path = join(directory, name);
  writeFileSync(path, buildPbf(blocks));
  return path;
}

/** A square of four nodes centred on (41.4, 2.2), 0.001° on a side. */
const SQUARE = [
  { id: 101, latitude: 41.3995, longitude: 2.1995 },
  { id: 102, latitude: 41.4005, longitude: 2.1995 },
  { id: 103, latitude: 41.4005, longitude: 2.2005 },
  { id: 104, latitude: 41.3995, longitude: 2.2005 },
];

const ARCHIVE: FixtureBlock[] = [
  {
    nodes: [
      ...SQUARE,
      {
        id: 1,
        latitude: 41.385_1,
        longitude: 2.173_4,
        tags: { amenity: 'cafe', name: 'Cafè de la Plaça', 'name:es': 'Café de la Plaza' },
      },
      // No name: in the tile, never drawn, never a place.
      { id: 2, latitude: 41.3, longitude: 2.1, tags: { amenity: 'restaurant' } },
      // Named, and a class the basemap draws nowhere.
      { id: 3, latitude: 41.3, longitude: 2.1, tags: { barrier: 'gate', name: 'Porta Nord' } },
      // A second square, for the relation.
      { id: 201, latitude: 40.999, longitude: 1.999 },
      { id: 202, latitude: 41.001, longitude: 2.001 },
    ],
  },
  {
    ways: [
      { id: 500, refs: [101, 102, 103, 104, 101], tags: { tourism: 'museum', name: 'Museu del Quadrat' } },
      { id: 501, refs: [201, 202] },
      // A way POI whose nodes are not in this archive at all.
      { id: 502, refs: [999_001, 999_002], tags: { shop: 'mall', name: 'Centre Perdut' } },
    ],
  },
  {
    relations: [
      { id: 900, wayMembers: [501], tags: { leisure: 'park', name: 'Parc de la Relació' } },
    ],
  },
];

async function run(path: string, options: { limit?: number; batchSize?: number } = {}) {
  const places: ImportedPlace[] = [];
  const batches: number[] = [];
  const stats = await extractPois({
    path,
    batchSize: options.batchSize ?? 1000,
    limit: options.limit,
    onPlaces: async (batch) => {
      batches.push(batch.length);
      places.push(...batch);
    },
  });
  return { places, batches, stats };
}

describe('extractPois', () => {
  test('imports nodes, ways and relations, and nothing the basemap never draws', async () => {
    const { places, stats } = await run(writePbf('archive.osm.pbf', ARCHIVE));
    const bySourceId = new Map(places.map((place) => [place.sourceId, place]));

    expect([...bySourceId.keys()].sort()).toEqual(['node/1', 'relation/900', 'way/500']);
    expect(stats.nodePlaces).toBe(1);
    expect(stats.wayPlaces).toBe(1);
    expect(stats.relationPlaces).toBe(1);
    // `way/502` references nodes this archive does not contain.
    expect(stats.unpositioned).toBe(1);
  });

  test('positions a way at the mean of vertices read in an earlier pass', async () => {
    const { places } = await run(writePbf('way.osm.pbf', ARCHIVE));
    const museum = places.find((place) => place.sourceId === 'way/500');
    expect(museum?.name).toBe('Museu del Quadrat');
    // The closing node repeats the first, so the mean leans towards it — which
    // is a property of the vertex mean and is documented as such.
    expect(museum?.latitude).toBeCloseTo(41.4, 3);
    expect(museum?.longitude).toBeCloseTo(2.2, 3);
    expect(museum?.categories).toEqual(['museum', 'culture']);
  });

  test('positions a relation through its member ways', async () => {
    const { places } = await run(writePbf('relation.osm.pbf', ARCHIVE));
    const park = places.find((place) => place.sourceId === 'relation/900');
    expect(park?.latitude).toBeCloseTo(41.0, 6);
    expect(park?.longitude).toBeCloseTo(2.0, 6);
    expect(park?.categories).toEqual(['park', 'outdoors']);
  });

  test('carries every language through', async () => {
    const { places, stats } = await run(writePbf('names.osm.pbf', ARCHIVE));
    const cafe = places.find((place) => place.sourceId === 'node/1');
    expect(cafe?.names).toEqual([{ language: 'es', name: 'Café de la Plaza' }]);
    expect(stats.names).toBe(1);
  });

  test('counts what it emitted, by category and by language', async () => {
    const { stats } = await run(writePbf('stats.osm.pbf', ARCHIVE));
    expect(Object.fromEntries(stats.byCategory)).toEqual({ cafe: 1, museum: 1, park: 1 });
    expect(Object.fromEntries(stats.byLanguage)).toEqual({ es: 1 });
    expect(stats.placesWithTranslations).toBe(1);
  });

  test('a bounding box keeps only what is inside it', async () => {
    const places: ImportedPlace[] = [];
    await extractPois({
      path: writePbf('bbox.osm.pbf', ARCHIVE),
      // Central Barcelona: the cafe is in it, the museum square and the
      // relation park are not.
      bounds: { west: 2.15, south: 41.37, east: 2.19, north: 41.4 },
      onPlaces: async (batch) => {
        places.push(...batch);
      },
    });
    expect(places.map((place) => place.sourceId)).toEqual(['node/1']);
  });

  test('batches at the size it was asked for', async () => {
    const nodes = Array.from({ length: 7 }, (_, index) => ({
      id: index + 1,
      latitude: 41 + index / 1000,
      longitude: 2,
      tags: { amenity: 'cafe', name: `Bar ${index}` },
    }));
    const { batches, places } = await run(writePbf('batches.osm.pbf', [{ nodes }]), { batchSize: 3 });
    expect(batches).toEqual([3, 3, 1]);
    expect(places).toHaveLength(7);
  });

  test('stops at the limit without reading the rest of the archive', async () => {
    const nodes = Array.from({ length: 50 }, (_, index) => ({
      id: index + 1,
      latitude: 41 + index / 1000,
      longitude: 2,
      tags: { amenity: 'cafe', name: `Bar ${index}` },
    }));
    const { places } = await run(writePbf('limit.osm.pbf', [{ nodes }]), { limit: 5, batchSize: 2 });
    expect(places.length).toBeLessThanOrEqual(6);
    expect(places.length).toBeGreaterThanOrEqual(5);
  });

  test('skips the way pass entirely when nothing needs it', async () => {
    const { stats } = await run(
      writePbf('nodes-only.osm.pbf', [
        { nodes: [{ id: 1, latitude: 41, longitude: 2, tags: { amenity: 'cafe', name: 'Solo' } }] },
      ]),
    );
    // One OSMData blob, inflated once in pass one and once more in pass three
    // for the node coordinates that nothing asked for — which is zero blobs,
    // because no way referenced anything.
    expect(stats.blobsInflated).toBe(1);
  });
});
