/**
 * A real `.osm.pbf`, built in memory, for tests that must not download one.
 *
 * The reader in `pbf.ts` is hand-written, so testing it against a fixture
 * produced by the same code would prove nothing. This is an independent
 * ENCODER — written from the wire format rather than from the decoder — so the
 * two meet only at the bytes. It emits the constructs a real extract uses:
 * `DenseNodes` with delta-encoded ids and coordinates, ways with delta-encoded
 * references, relations with typed members, a shared string table, and both
 * blob compressions (`raw` and `zlib`).
 */

import { deflateSync } from 'node:zlib';

/** A base-128 varint. */
function varint(value: number): number[] {
  const bytes: number[] = [];
  let remaining = value;
  while (remaining >= 0x80) {
    bytes.push((remaining % 128) + 0x80);
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(remaining);
  return bytes;
}

/** Zigzag, as `sint32`/`sint64` use it. */
function zigzag(value: number): number {
  return value < 0 ? -value * 2 - 1 : value * 2;
}

/** A field header. */
function tag(field: number, wire: number): number[] {
  return varint(field * 8 + wire);
}

/** A length-delimited field. */
function bytesField(field: number, payload: readonly number[]): number[] {
  return [...tag(field, 2), ...varint(payload.length), ...payload];
}

/** A varint field. */
function varintField(field: number, value: number): number[] {
  return [...tag(field, 0), ...varint(value)];
}

/** A packed repeated varint field. */
function packedField(field: number, values: readonly number[]): number[] {
  return bytesField(field, values.flatMap((value) => varint(value)));
}

/** Successive differences, as every delta-encoded field in the format stores them. */
function deltas(values: readonly number[]): number[] {
  let previous = 0;
  return values.map((value) => {
    const delta = value - previous;
    previous = value;
    return zigzag(delta);
  });
}

/** A node in the fixture. */
export interface FixtureNode {
  id: number;
  latitude: number;
  longitude: number;
  tags?: Record<string, string>;
}

/** A way in the fixture. */
export interface FixtureWay {
  id: number;
  refs: number[];
  tags?: Record<string, string>;
}

/** A relation in the fixture. Members are ways; that is all this importer reads. */
export interface FixtureRelation {
  id: number;
  wayMembers: number[];
  tags?: Record<string, string>;
}

/** One `PrimitiveBlock`'s worth of elements. */
export interface FixtureBlock {
  nodes?: FixtureNode[];
  ways?: FixtureWay[];
  relations?: FixtureRelation[];
  /** `zlib` by default, `raw` to exercise the uncompressed branch. */
  compression?: 'zlib' | 'raw';
}

/** OpenStreetMap stores coordinates as integers of 100 nanodegrees. */
const COORDINATE_SCALE = 1e7;

/** Assembles one block's string table as elements are added. */
class StringTable {
  private readonly indices = new Map<string, number>();
  readonly entries: string[] = [''];

  index(text: string): number {
    const existing = this.indices.get(text);
    if (existing !== undefined) return existing;
    const next = this.entries.length;
    this.entries.push(text);
    this.indices.set(text, next);
    return next;
  }

  encode(): number[] {
    return this.entries.flatMap((text) => bytesField(1, [...Buffer.from(text, 'utf8')]));
  }
}

/** `DenseNodes` for a block's nodes. */
function denseNodes(nodes: readonly FixtureNode[], strings: StringTable): number[] {
  const keysVals: number[] = [];
  for (const node of nodes) {
    for (const [key, value] of Object.entries(node.tags ?? {})) {
      keysVals.push(strings.index(key), strings.index(value));
    }
    keysVals.push(0);
  }
  return [
    ...packedField(1, deltas(nodes.map((node) => node.id))),
    ...packedField(8, deltas(nodes.map((node) => Math.round(node.latitude * COORDINATE_SCALE)))),
    ...packedField(9, deltas(nodes.map((node) => Math.round(node.longitude * COORDINATE_SCALE)))),
    ...packedField(10, keysVals),
  ];
}

/** One `Way`. */
function way(element: FixtureWay, strings: StringTable): number[] {
  const keys = Object.keys(element.tags ?? {});
  return [
    ...varintField(1, element.id),
    ...packedField(2, keys.map((key) => strings.index(key))),
    ...packedField(3, keys.map((key) => strings.index((element.tags ?? {})[key] as string))),
    ...packedField(8, deltas(element.refs)),
  ];
}

/** One `Relation`, with every member a way. */
function relation(element: FixtureRelation, strings: StringTable): number[] {
  const keys = Object.keys(element.tags ?? {});
  return [
    ...varintField(1, element.id),
    ...packedField(2, keys.map((key) => strings.index(key))),
    ...packedField(3, keys.map((key) => strings.index((element.tags ?? {})[key] as string))),
    // roles_sid: one empty role per member.
    ...packedField(8, element.wayMembers.map(() => 0)),
    ...packedField(9, deltas(element.wayMembers)),
    ...packedField(10, element.wayMembers.map(() => 1)),
  ];
}

/** A `PrimitiveBlock` holding one block's elements. */
function primitiveBlock(block: FixtureBlock): number[] {
  const strings = new StringTable();
  const groups: number[] = [];

  if (block.nodes?.length) {
    groups.push(...bytesField(2, bytesField(2, denseNodes(block.nodes, strings))));
  }
  for (const element of block.ways ?? []) {
    groups.push(...bytesField(2, bytesField(3, way(element, strings))));
  }
  for (const element of block.relations ?? []) {
    groups.push(...bytesField(2, bytesField(4, relation(element, strings))));
  }

  return [
    ...bytesField(1, strings.encode()),
    ...groups,
    ...varintField(17, 100),
    ...varintField(19, 0),
    ...varintField(20, 0),
  ];
}

/** A blob, framed: 4-byte length, `BlobHeader`, then the `Blob`. */
function blob(type: string, payload: Buffer, compression: 'zlib' | 'raw'): Buffer {
  const body =
    compression === 'raw'
      ? Buffer.from(bytesField(1, [...payload]))
      : Buffer.from([
          ...varintField(2, payload.length),
          ...bytesField(3, [...deflateSync(payload)]),
        ]);
  const header = Buffer.from([
    ...bytesField(1, [...Buffer.from(type, 'utf8')]),
    ...varintField(3, body.length),
  ]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(header.length, 0);
  return Buffer.concat([length, header, body]);
}

/**
 * A complete archive: an `OSMHeader` blob followed by one `OSMData` blob per
 * block, in the node → way → relation order every real extract is sorted in.
 */
export function buildPbf(blocks: readonly FixtureBlock[]): Buffer {
  const parts = [blob('OSMHeader', Buffer.from(bytesField(4, [...Buffer.from('OsmSchema-V0.6')])), 'raw')];
  for (const block of blocks) {
    parts.push(
      blob('OSMData', Buffer.from(primitiveBlock(block)), block.compression ?? 'zlib'),
    );
  }
  return Buffer.concat(parts);
}
