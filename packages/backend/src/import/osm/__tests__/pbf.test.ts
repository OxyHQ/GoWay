/**
 * The PBF reader, against an archive this repository encoded itself.
 *
 * The encoder in `pbfFixture.ts` is written from the wire format rather than
 * from the decoder, so a bug shared by both would have to be a bug in the
 * format's own description. What is asserted is everything that fails SILENTLY
 * when it is wrong: ids past 2^31 (where a shift-based varint wraps), negative
 * coordinates (zigzag), delta accumulation across a block, and the string table
 * indirection.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBlobs, readPrimitiveBlock } from '../pbf';
import { buildPbf, type FixtureBlock } from './pbfFixture';

const directory = mkdtempSync(join(tmpdir(), 'goway-pbf-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

function writePbf(name: string, blocks: FixtureBlock[]): string {
  const path = join(directory, name);
  writeFileSync(path, buildPbf(blocks));
  return path;
}

interface ReadNode {
  id: number;
  latitude: number;
  longitude: number;
  tags: Record<string, string>;
}

async function readAll(path: string) {
  const nodes: ReadNode[] = [];
  const ways: { id: number; refs: number[]; tags: Record<string, string> }[] = [];
  const relations: { id: number; members: number[]; types: number[] }[] = [];
  let blocks = 0;

  for await (const blob of readBlobs(path)) {
    if (blob.type !== 'OSMData') continue;
    blocks += 1;
    let strings: { text: (index: number) => string } | null = null;
    const tagsOf = (keys: readonly number[], vals: readonly number[]): Record<string, string> => {
      const tags: Record<string, string> = {};
      for (let index = 0; index < keys.length; index += 1) {
        tags[strings?.text(keys[index] as number) ?? ''] = strings?.text(vals[index] as number) ?? '';
      }
      return tags;
    };
    readPrimitiveBlock(await blob.inflate(), {
      onStrings: (table) => {
        strings = table;
      },
      onNode: (id, latitude, longitude, keys, vals) =>
        nodes.push({ id, latitude, longitude, tags: tagsOf(keys, vals) }),
      onWay: (id, keys, vals, refs) => ways.push({ id, refs: [...refs], tags: tagsOf(keys, vals) }),
      onRelation: (id, _keys, _vals, members, types) =>
        relations.push({ id, members: [...members], types: [...types] }),
    });
  }
  return { nodes, ways, relations, blocks };
}

describe('readBlobs / readPrimitiveBlock', () => {
  test('decodes dense nodes, including ids past 2^31 and negative coordinates', async () => {
    const path = writePbf('nodes.osm.pbf', [
      {
        nodes: [
          { id: 1, latitude: 41.3851, longitude: 2.1734, tags: { amenity: 'cafe', name: 'Cafè' } },
          { id: 12_345_678_901, latitude: -33.8688, longitude: -70.6693, tags: { name: 'Sur' } },
        ],
      },
    ]);

    const { nodes } = await readAll(path);
    expect(nodes).toHaveLength(2);
    expect(nodes[0]).toEqual({
      id: 1,
      latitude: 41.3851,
      longitude: 2.1734,
      tags: { amenity: 'cafe', name: 'Cafè' },
    });
    // The id that a `<<`-based varint decoder silently wraps.
    expect(nodes[1]?.id).toBe(12_345_678_901);
    expect(nodes[1]?.latitude).toBeCloseTo(-33.8688, 7);
    expect(nodes[1]?.longitude).toBeCloseTo(-70.6693, 7);
  });

  test('accumulates deltas across a whole block rather than per element', async () => {
    const ids = [10, 20, 40, 80, 160];
    const path = writePbf('deltas.osm.pbf', [
      { nodes: ids.map((id, index) => ({ id, latitude: index, longitude: -index })) },
    ]);
    const { nodes } = await readAll(path);
    expect(nodes.map((node) => node.id)).toEqual(ids);
    expect(nodes.map((node) => Math.round(node.latitude))).toEqual([0, 1, 2, 3, 4]);
    expect(nodes.map((node) => Math.round(node.longitude))).toEqual([0, -1, -2, -3, -4]);
  });

  test('decodes ways and relations with their references', async () => {
    const path = writePbf('mixed.osm.pbf', [
      { nodes: [{ id: 5, latitude: 1, longitude: 1 }] },
      { ways: [{ id: 188_938_001, refs: [5, 9, 400, 5], tags: { tourism: 'museum' } }] },
      { relations: [{ id: 6_288_735, wayMembers: [188_938_001, 7], tags: { amenity: 'marketplace' } }] },
    ]);

    const { ways, relations, blocks } = await readAll(path);
    expect(blocks).toBe(3);
    expect(ways[0]).toEqual({ id: 188_938_001, refs: [5, 9, 400, 5], tags: { tourism: 'museum' } });
    expect(relations[0]?.members).toEqual([188_938_001, 7]);
    // Member type 1 is WAY; a relation whose members were read as nodes would
    // resolve its position from the wrong index entirely.
    expect(relations[0]?.types).toEqual([1, 1]);
  });

  test('reads both raw and zlib blobs', async () => {
    const path = writePbf('compression.osm.pbf', [
      { compression: 'raw', nodes: [{ id: 1, latitude: 0, longitude: 0, tags: { name: 'Raw' } }] },
      { compression: 'zlib', nodes: [{ id: 2, latitude: 0, longitude: 0, tags: { name: 'Zlib' } }] },
    ]);
    const { nodes } = await readAll(path);
    expect(nodes.map((node) => node.tags.name)).toEqual(['Raw', 'Zlib']);
  });

  test('a filtered pass inflates only the blobs it asked for', async () => {
    const path = writePbf('filtered.osm.pbf', [
      { nodes: [{ id: 1, latitude: 0, longitude: 0 }] },
      { nodes: [{ id: 2, latitude: 0, longitude: 0 }] },
      { nodes: [{ id: 3, latitude: 0, longitude: 0 }] },
    ]);

    const offsets: number[] = [];
    for await (const blob of readBlobs(path)) if (blob.type === 'OSMData') offsets.push(blob.offset);
    expect(offsets).toHaveLength(3);

    const wanted = new Set([offsets[1] as number]);
    const seen: number[] = [];
    for await (const blob of readBlobs(path, { shouldRead: (offset) => wanted.has(offset) })) {
      seen.push(blob.offset);
    }
    expect(seen).toEqual([offsets[1] as number]);
  });
});
