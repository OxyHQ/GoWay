/**
 * The road compiler end to end, on a PBF written here: tag parsing, splitting
 * at junctions, tagged nodes and tile edges, node-via turn restrictions, the
 * MVT encoding — and the simulation's own decoder reading it back.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

import { PbfWriter } from 'pbf';

import { decodeRoadTile } from '../../components/map/engine/roads/roadTiles';
import { CITY_TILE_EXTENT, CITY_TILE_ZOOM } from '../../lib/map/cityTiles';
import { encodeTileLayers } from '../citygen/mvtEncode';
import {
  compileRoads,
  parseMaxspeed,
  roadLayers,
  roadNodeKind,
  roadProperties,
  splitAtTileEdges,
} from '../citygen/roads';

describe('road tags', () => {
  test('classes, access and what a car or a person may use', () => {
    expect(roadProperties({ highway: 'residential' })).toMatchObject({ car: true, foot: false });
    expect(roadProperties({ highway: 'footway' })).toMatchObject({ car: false, foot: true });
    expect(roadProperties({ highway: 'living_street' })).toMatchObject({ car: true, foot: true });
    expect(roadProperties({ highway: 'residential', access: 'private' })).toBeNull();
    expect(roadProperties({ highway: 'service', service: 'parking_aisle' })).toBeNull();
    expect(roadProperties({ highway: 'service', service: 'alley' })).toMatchObject({ car: true });
    // Kept for the street detail (schema 3), neither a car's nor a person's.
    expect(roadProperties({ highway: 'cycleway' })).toMatchObject({
      car: false,
      foot: false,
      cycle: true,
    });
    expect(roadProperties({ highway: 'cycleway', foot: 'designated' })).toMatchObject({
      foot: true,
    });
    expect(roadProperties({ highway: 'pedestrian', area: 'yes' })).toBeNull();
    expect(roadProperties({ highway: 'rail' })).toBeNull();
    expect(roadProperties({ highway: 'construction' })).toBeNull();
  });

  test('one-way: tagged, reversed, and implied by motorways and roundabouts', () => {
    expect(roadProperties({ highway: 'primary', oneway: 'yes' })?.oneway).toBe(1);
    expect(roadProperties({ highway: 'primary', oneway: '-1' })?.oneway).toBe(-1);
    expect(roadProperties({ highway: 'primary' })?.oneway).toBeUndefined();
    expect(roadProperties({ highway: 'motorway' })?.oneway).toBe(1);
    expect(roadProperties({ highway: 'motorway', oneway: 'no' })?.oneway).toBeUndefined();
    expect(roadProperties({ highway: 'tertiary', junction: 'roundabout' })).toMatchObject({
      oneway: 1,
      roundabout: true,
    });
  });

  test('lanes, maxspeed, sidewalks and tunnels only as recorded', () => {
    const p = roadProperties({
      highway: 'secondary',
      lanes: '4',
      'lanes:forward': '3',
      maxspeed: '30 mph',
      'sidewalk:left': 'yes',
      'sidewalk:right': 'yes',
      tunnel: 'yes',
    });
    expect(p).toMatchObject({
      lanes: 4,
      lanes_forward: 3,
      maxspeed: 48,
      sidewalk: 'both',
      tunnel: true,
    });
    expect(roadProperties({ highway: 'secondary', lanes: '2.5' })?.lanes).toBeUndefined();
    expect(parseMaxspeed('50')).toBe(50);
    expect(parseMaxspeed('walk')).toBe(6);
    expect(parseMaxspeed('ES:urban')).toBeUndefined();
    expect(parseMaxspeed('none')).toBeUndefined();
    expect(roadProperties({ highway: 'residential', sidewalk: 'separate' })?.sidewalk).toBe(
      'separate',
    );
    expect(roadProperties({ highway: 'footway', footway: 'crossing' })?.footway).toBe('crossing');
  });

  test('tagged nodes', () => {
    expect(roadNodeKind({ highway: 'traffic_signals' })).toEqual({ kind: 'signals' });
    expect(roadNodeKind({ highway: 'crossing', crossing: 'zebra' })).toEqual({
      kind: 'crossing',
      crossing: 'zebra',
    });
    expect(roadNodeKind({ highway: 'bus_stop' })).toBeNull();
  });
});

describe('splitAtTileEdges', () => {
  test('a line over two tile edges becomes three pieces that meet exactly', () => {
    const pieces = splitAtTileEdges([
      [100, 100],
      [9000, 100],
    ]);
    expect(pieces.map((p) => p.tx)).toEqual([0, 1, 2]);
    expect(pieces[0].points.at(-1)).toEqual(pieces[1].points[0]);
    expect(pieces[1].points[0][0]).toBe(CITY_TILE_EXTENT);
    expect(pieces[1].points.at(-1)?.[0]).toBe(2 * CITY_TILE_EXTENT);
    for (const piece of pieces) {
      for (const [x] of piece.points) {
        expect(x).toBeGreaterThanOrEqual(piece.tx * CITY_TILE_EXTENT);
        expect(x).toBeLessThanOrEqual((piece.tx + 1) * CITY_TILE_EXTENT);
      }
    }
  });
});

// ── A tiny OSM PBF with node tags and a restriction ──────────────────────

const M_LAT = 1 / 111_000;
const M_LON = 1 / 83_500;
const ORIGIN = { lat: 41.392, lon: 2.164 };

type Node = { id: number; x: number; y: number; tags?: Record<string, string> };
type Way = { id: number; refs: number[]; tags: Record<string, string> };
type Relation = {
  id: number;
  tags: Record<string, string>;
  members: { id: number; type: 0 | 1; role: string }[];
};

const delta = (values: number[]) => values.map((v, i) => v - (i === 0 ? 0 : values[i - 1]));

function writePbf(nodes: Node[], ways: Way[], relations: Relation[]): Uint8Array {
  const strings = [''];
  const index = (s: string) => {
    let i = strings.indexOf(s);
    if (i < 0) i = strings.push(s) - 1;
    return i;
  };
  const sorted = [...nodes].sort((a, b) => a.id - b.id);
  const keysVals: number[] = [];
  for (const node of sorted) {
    for (const [k, v] of Object.entries(node.tags ?? {})) keysVals.push(index(k), index(v));
    keysVals.push(0);
  }
  const wayTags = ways.map((w) => ({
    keys: Object.keys(w.tags).map(index),
    vals: Object.values(w.tags).map(index),
  }));
  const relTags = relations.map((r) => ({
    keys: Object.keys(r.tags).map(index),
    vals: Object.values(r.tags).map(index),
    roles: r.members.map((m) => index(m.role)),
  }));

  const block = new PbfWriter();
  block.writeMessage(
    1,
    (_: null, pbf) => {
      for (const s of strings) pbf.writeBytesField(1, new TextEncoder().encode(s));
    },
    null,
  );
  block.writeMessage(
    2,
    (_: null, group) => {
      group.writeMessage(
        2,
        (_n: null, dense) => {
          dense.writePackedSVarint(1, delta(sorted.map((n) => n.id)));
          dense.writePackedSVarint(
            8,
            delta(sorted.map((n) => Math.round((ORIGIN.lat + n.y * M_LAT) * 1e7))),
          );
          dense.writePackedSVarint(
            9,
            delta(sorted.map((n) => Math.round((ORIGIN.lon + n.x * M_LON) * 1e7))),
          );
          dense.writePackedVarint(10, keysVals);
        },
        null,
      );
    },
    null,
  );
  block.writeMessage(
    2,
    (_: null, group) => {
      ways.forEach((way, i) => {
        group.writeMessage(
          3,
          (_w: null, out) => {
            out.writeVarintField(1, way.id);
            out.writePackedVarint(2, wayTags[i].keys);
            out.writePackedVarint(3, wayTags[i].vals);
            out.writePackedSVarint(8, delta(way.refs));
          },
          null,
        );
      });
      relations.forEach((relation, i) => {
        group.writeMessage(
          4,
          (_r: null, out) => {
            out.writeVarintField(1, relation.id);
            out.writePackedVarint(2, relTags[i].keys);
            out.writePackedVarint(3, relTags[i].vals);
            out.writePackedVarint(8, relTags[i].roles);
            out.writePackedSVarint(9, delta(relation.members.map((m) => m.id)));
            out.writePackedVarint(
              10,
              relation.members.map((m) => m.type),
            );
          },
          null,
        );
      });
    },
    null,
  );
  const blockBytes = block.finish();

  const blob = (type: string, raw: Uint8Array) => {
    const body = new PbfWriter();
    body.writeVarintField(2, raw.length);
    body.writeBytesField(3, deflateSync(raw));
    const bodyBytes = body.finish();
    const header = new PbfWriter();
    header.writeStringField(1, type);
    header.writeVarintField(3, bodyBytes.length);
    const headerBytes = header.finish();
    const size = new Uint8Array(4);
    new DataView(size.buffer).setUint32(0, headerBytes.length);
    return [size, headerBytes, bodyBytes];
  };
  const osmHeader = new PbfWriter();
  osmHeader.writeStringField(4, 'OsmSchema-V0.6');
  osmHeader.writeStringField(4, 'DenseNodes');
  const parts = [...blob('OSMHeader', osmHeader.finish()), ...blob('OSMData', blockBytes)];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

let dir = '';
let pbf = '';
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'city-roads-'));
  pbf = join(dir, 'roads.osm.pbf');
  // An east–west street through a junction with a north–south one, a signal
  // on the east arm, a footway crossing, and a no-left-turn.
  const nodes: Node[] = [
    { id: 1, x: -150, y: 0 },
    { id: 2, x: 0, y: 0 },
    { id: 3, x: 40, y: 0, tags: { highway: 'traffic_signals' } },
    { id: 4, x: 150, y: 0 },
    { id: 5, x: 0, y: -150 },
    { id: 6, x: 0, y: 150 },
    { id: 7, x: 80, y: -15 },
    {
      id: 8,
      x: 80,
      y: 0,
      tags: { highway: 'crossing', crossing: 'zebra', 'crossing:markings': 'Zebra' },
    },
    { id: 9, x: 80, y: 15 },
  ];
  const ways: Way[] = [
    {
      id: 100,
      refs: [1, 2, 3, 8, 4],
      tags: {
        highway: 'primary',
        lanes: '4',
        maxspeed: '50',
        name: 'x',
        'turn:lanes:forward': 'left|through',
        'bus:lanes:backward': '|designated',
        'turn:lanes:backward': 'left|straight', // junk: refused, counted
      },
    },
    { id: 200, refs: [5, 2], tags: { highway: 'residential', oneway: 'yes' } },
    { id: 201, refs: [2, 6], tags: { highway: 'residential' } },
    {
      id: 300,
      refs: [7, 8, 9],
      tags: {
        highway: 'footway',
        footway: 'crossing',
        crossing: 'traffic_signals',
        'crossing:markings': 'ladder',
      },
    },
    { id: 400, refs: [5, 1], tags: { highway: 'rail' } },
  ];
  const relations: Relation[] = [
    {
      id: 900,
      tags: { type: 'restriction', restriction: 'no_left_turn' },
      members: [
        { id: 100, type: 1, role: 'from' },
        { id: 2, type: 0, role: 'via' },
        { id: 201, type: 1, role: 'to' },
      ],
    },
  ];
  writeFileSync(pbf, writePbf(nodes, ways, relations));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('compileRoads', () => {
  test('splits at junctions and tagged nodes, keeps tags, writes restrictions', () => {
    const result = compileRoads({ pbf, zoom: CITY_TILE_ZOOM });
    expect(result.coverage.ways).toBe(4);
    expect(result.coverage.carWays).toBe(3);
    expect(result.coverage.nodes).toEqual({ signals: 1, crossing: 1 });
    expect(result.coverage.restrictions).toBe(1);

    const decoded = [...result.tiles.entries()].map(([key, tile]) => {
      const [, x, y] = key.split('/').map(Number);
      return decodeRoadTile(encodeTileLayers(roadLayers(tile)), { x, y });
    });
    const pieces = decoded.flatMap((t) => t.pieces);
    const primary = pieces.filter((p) => p.highway === 'primary');
    // 1-2, 2-3 (signal), 3-8 (crossing), 8-4: four pieces, more if a tile edge cuts one.
    expect(primary.length).toBeGreaterThanOrEqual(4);
    expect(primary.every((p) => p.lanes === 4 && p.maxspeed === 50)).toBe(true);
    // The restriction names ways 100 and 201, so only they carry ids.
    expect(new Set(pieces.map((p) => p.way))).toEqual(new Set([100, 201, 0]));
    const oneway = pieces.filter((p) => p.highway === 'residential' && p.oneway === 1);
    expect(oneway.length).toBeGreaterThanOrEqual(1);
    const crossing = pieces.filter((p) => p.footway === 'crossing');
    expect(crossing.length).toBeGreaterThanOrEqual(2);
    expect(crossing.every((p) => p.foot && !p.car)).toBe(true);
    const restrictions = decoded.flatMap((t) => t.restrictions);
    expect(restrictions).toEqual([expect.objectContaining({ from: 100, to: 201, type: 'no' })]);
    // Every tagged node is a piece end, exactly.
    const ends = new Set(
      pieces.flatMap((p) => [p.points[0], p.points.at(-1)]).map((q) => `${q?.[0]},${q?.[1]}`),
    );
    for (const node of decoded.flatMap((t) => t.nodes))
      expect(ends.has(`${node.x},${node.y}`)).toBe(true);
    // The restriction's via node is the junction: a piece end too.
    expect(ends.has(`${restrictions[0].x},${restrictions[0].y}`)).toBe(true);
    // Street detail (schema 2) survives the encoding and the shared decoder.
    expect(primary.every((p) => p.name === 'x')).toBe(true);
    expect(primary[0].turnLanesForward).toEqual([['left'], ['through']]);
    expect(primary[0].busLanesBackward).toEqual([false, true]);
    expect(primary[0].turnLanesBackward).toBeUndefined();
    expect(result.coverage.street.refused['turn:lanes:backward']).toBe(1);
    expect(
      crossing.every((p) => p.crossingMarkings === 'ladder' && p.crossing === 'traffic_signals'),
    ).toBe(true);
    const zebra = decoded.flatMap((t) => t.nodes).find((n) => n.kind === 'crossing');
    expect(zebra?.crossingMarkings).toBe('zebra');
  });
});
