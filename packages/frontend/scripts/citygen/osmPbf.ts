/**
 * Reading an `.osm.pbf` extract for the city-tile compiler.
 *
 * The backend's importer has its own reader (`packages/backend/src/import/osm/pbf.ts`)
 * and this one is deliberately separate: that one serves POIs and does not
 * decode relation member ROLES, which a building multipolygon cannot be
 * assembled without (`outer` vs `inner`), and the two packages share no build.
 * This one is built on `pbf`, the decoder the frontend already depends on.
 *
 * ## The file
 *
 * A sequence of blobs: a 4-byte big-endian length, a `BlobHeader` (type and
 * payload size), then a `Blob` holding a zlib-compressed `PrimitiveBlock` —
 * a string table plus up to 8000 nodes, ways or relations. Extracts are
 * sorted nodes → ways → relations, which is why the compiler reads the file
 * in passes (relations first need their member ways, ways need their nodes).
 * {@link scanBlobs} records what each blob holds on the first pass so later
 * passes inflate only the blobs they need.
 *
 * Every array a visitor receives is valid only during the call.
 */
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

import { PbfReader } from 'pbf';

export interface BlobRef {
  /** Byte offset of the payload. */
  offset: number;
  length: number;
  type: string;
}

/** Every blob's header, in file order. Reads headers only — cheap. */
export function scanBlobs(path: string): BlobRef[] {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const blobs: BlobRef[] = [];
    const lengthBuffer = Buffer.alloc(4);
    let position = 0;
    while (position + 4 <= size) {
      readSync(fd, lengthBuffer, 0, 4, position);
      const headerLength = lengthBuffer.readUInt32BE(0);
      if (headerLength === 0 || headerLength > 64 * 1024) {
        throw new Error(`implausible blob header length ${headerLength} at ${position}`);
      }
      const header = Buffer.alloc(headerLength);
      readSync(fd, header, 0, headerLength, position + 4);
      const decoded = new PbfReader(header).readFields(
        (tag, out: { type: string; size: number }, pbf) => {
          if (tag === 1) out.type = pbf.readString();
          else if (tag === 3) out.size = pbf.readVarint();
        },
        { type: '', size: 0 },
      );
      const offset = position + 4 + headerLength;
      blobs.push({ offset, length: decoded.size, type: decoded.type });
      position = offset + decoded.size;
    }
    return blobs;
  } finally {
    closeSync(fd);
  }
}

/** A blob's decompressed payload. */
export function readBlob(fd: number, blob: BlobRef): Uint8Array {
  const payload = Buffer.alloc(blob.length);
  readSync(fd, payload, 0, blob.length, blob.offset);
  const fields = new PbfReader(payload).readFields(
    (tag, out: { raw?: Uint8Array; zlib?: Uint8Array }, pbf) => {
      if (tag === 1) out.raw = pbf.readBytes();
      else if (tag === 3) out.zlib = pbf.readBytes();
      else if (tag !== 2) throw new Error(`blob compression ${tag} is not supported (raw, zlib)`);
    },
    {},
  );
  if (fields.raw) return fields.raw;
  if (!fields.zlib) throw new Error('blob has no data');
  return new Uint8Array(inflateSync(fields.zlib));
}

/** The replication stamp an extract carries, for the build receipt. */
export interface OsmHeader {
  replicationTimestamp?: string;
  replicationSequence?: number;
  replicationUrl?: string;
  requiredFeatures: string[];
  optionalFeatures: string[];
}

export function readHeader(bytes: Uint8Array): OsmHeader {
  return new PbfReader(bytes).readFields(
    (tag, out: OsmHeader, pbf) => {
      if (tag === 4) out.requiredFeatures.push(pbf.readString());
      else if (tag === 5) out.optionalFeatures.push(pbf.readString());
      else if (tag === 32)
        out.replicationTimestamp = new Date(pbf.readVarint() * 1000).toISOString();
      else if (tag === 33) out.replicationSequence = pbf.readVarint();
      else if (tag === 34) out.replicationUrl = pbf.readString();
    },
    { requiredFeatures: [], optionalFeatures: [] },
  );
}

export interface BlockVisitor {
  /** The block's string table, before any element: tags are indices into it. */
  onStrings?: (strings: string[]) => void;
  /** `true` to receive this block's nodes; they cost the most to decode. */
  wantNodes?: boolean;
  onNode?: (id: number, lon: number, lat: number) => void;
  /**
   * Nodes WITH tags (a tree, a bench…), keys and values as string-table
   * indices. Independent of {@link BlockVisitor.wantNodes}: asking for tagged
   * nodes decodes the tag stream, never the untagged majority's callbacks.
   */
  onTaggedNode?: (id: number, lon: number, lat: number, keys: number[], vals: number[]) => void;
  onWay?: (id: number, keys: number[], vals: number[], refs: number[]) => void;
  onRelation?: (
    id: number,
    keys: number[],
    vals: number[],
    memberIds: number[],
    memberTypes: number[],
    roles: number[],
  ) => void;
}

export interface BlockContents {
  strings: string[];
  nodes: boolean;
  ways: boolean;
  relations: boolean;
}

/** Relation member types, as the format numbers them. */
export const MEMBER_NODE = 0;
export const MEMBER_WAY = 1;
export const MEMBER_RELATION = 2;

const keysScratch: number[] = [];
const valsScratch: number[] = [];
const refsScratch: number[] = [];
const memIdsScratch: number[] = [];
const memTypesScratch: number[] = [];
const rolesScratch: number[] = [];
const idsScratch: number[] = [];
const latsScratch: number[] = [];
const lonsScratch: number[] = [];
const keyValsScratch: number[] = [];

function readPacked(pbf: PbfReader, header: number, out: number[], signed: boolean): void {
  out.length = 0;
  // `pbf` decides packed vs. single from the wire type of the field just read.
  pbf.type = header & 7;
  if (signed) pbf.readPackedSVarint(out);
  else pbf.readPackedVarint(out);
}

/** Decode one `PrimitiveBlock`. Strings are decoded once and returned for the caller's lookups. */
export function readBlock(bytes: Uint8Array, visitor: BlockVisitor): BlockContents {
  const pbf = new PbfReader(bytes);
  const contents: BlockContents = { strings: [], nodes: false, ways: false, relations: false };
  const groups: [number, number][] = [];
  let granularity = 100;
  let latOffset = 0;
  let lonOffset = 0;
  // A node-only pass never looks at tags; decoding thousands of strings per
  // block for it would be most of its cost.
  const wantStrings = Boolean(
    visitor.onStrings || visitor.onWay || visitor.onRelation || visitor.onTaggedNode,
  );
  const wantNodes = Boolean((visitor.wantNodes && visitor.onNode) || visitor.onTaggedNode);
  pbf.readFields((tag, _out: null, reader) => {
    if (tag === 1 && !wantStrings) {
      reader.pos = reader.readVarint() + reader.pos;
    } else if (tag === 1) {
      const end = reader.readVarint() + reader.pos;
      const decoder = new TextDecoder();
      while (reader.pos < end) {
        const header = reader.readVarint();
        if (header >> 3 === 1) {
          const length = reader.readVarint();
          contents.strings.push(
            decoder.decode(reader.buf.subarray(reader.pos, reader.pos + length)),
          );
          reader.pos += length;
        } else {
          reader.skip(header);
        }
      }
    } else if (tag === 2) {
      const length = reader.readVarint();
      groups.push([reader.pos, reader.pos + length]);
      reader.pos += length;
    } else if (tag === 17) granularity = reader.readVarint();
    else if (tag === 19) latOffset = reader.readVarint(true);
    else if (tag === 20) lonOffset = reader.readVarint(true);
  }, null);

  visitor.onStrings?.(contents.strings);
  const scale = 1e-9 * granularity;
  const latBase = 1e-9 * latOffset;
  const lonBase = 1e-9 * lonOffset;

  for (const [start, end] of groups) {
    pbf.pos = start;
    pbf.readFields(
      (tag, _out: null, reader) => {
        if (tag === 2) {
          contents.nodes = true;
          if (!wantNodes) {
            reader.pos = reader.readVarint() + reader.pos;
            return;
          }
          const groupEnd = reader.readVarint() + reader.pos;
          idsScratch.length = 0;
          latsScratch.length = 0;
          lonsScratch.length = 0;
          keyValsScratch.length = 0;
          while (reader.pos < groupEnd) {
            const header = reader.readVarint();
            const field = header >> 3;
            if (field === 1) readPacked(reader, header, idsScratch, true);
            else if (field === 8) readPacked(reader, header, latsScratch, true);
            else if (field === 9) readPacked(reader, header, lonsScratch, true);
            else if (field === 10 && visitor.onTaggedNode) {
              readPacked(reader, header, keyValsScratch, false);
            } else reader.skip(header);
          }
          let id = 0;
          let lat = 0;
          let lon = 0;
          // keys_vals: per node, (key, value) pairs then a 0; empty when no node has tags.
          let kv = 0;
          for (let i = 0; i < idsScratch.length; i++) {
            id += idsScratch[i];
            lat += latsScratch[i];
            lon += lonsScratch[i];
            if (visitor.wantNodes && visitor.onNode) {
              visitor.onNode(id, lonBase + scale * lon, latBase + scale * lat);
            }
            if (visitor.onTaggedNode && kv < keyValsScratch.length) {
              if (keyValsScratch[kv] === 0) {
                kv++;
                continue;
              }
              const keys: number[] = [];
              const vals: number[] = [];
              while (kv < keyValsScratch.length && keyValsScratch[kv] !== 0) {
                keys.push(keyValsScratch[kv]);
                vals.push(keyValsScratch[kv + 1]);
                kv += 2;
              }
              kv++;
              visitor.onTaggedNode(id, lonBase + scale * lon, latBase + scale * lat, keys, vals);
            }
          }
        } else if (tag === 1) {
          contents.nodes = true;
          const nodeEnd = reader.readVarint() + reader.pos;
          let id = 0;
          let lat = 0;
          let lon = 0;
          const keys: number[] = [];
          const vals: number[] = [];
          while (reader.pos < nodeEnd) {
            const header = reader.readVarint();
            const field = header >> 3;
            if (field === 1) id = reader.readSVarint();
            else if (field === 2 && visitor.onTaggedNode) readPacked(reader, header, keys, false);
            else if (field === 3 && visitor.onTaggedNode) readPacked(reader, header, vals, false);
            else if (field === 8) lat = reader.readSVarint();
            else if (field === 9) lon = reader.readSVarint();
            else reader.skip(header);
          }
          if (visitor.wantNodes && visitor.onNode) {
            visitor.onNode(id, lonBase + scale * lon, latBase + scale * lat);
          }
          if (visitor.onTaggedNode && keys.length > 0) {
            visitor.onTaggedNode(id, lonBase + scale * lon, latBase + scale * lat, keys, vals);
          }
        } else if (tag === 3) {
          contents.ways = true;
          const wayEnd = reader.readVarint() + reader.pos;
          if (!visitor.onWay) {
            reader.pos = wayEnd;
            return;
          }
          let id = 0;
          keysScratch.length = 0;
          valsScratch.length = 0;
          refsScratch.length = 0;
          while (reader.pos < wayEnd) {
            const header = reader.readVarint();
            const field = header >> 3;
            if (field === 1) id = reader.readVarint();
            else if (field === 2) readPacked(reader, header, keysScratch, false);
            else if (field === 3) readPacked(reader, header, valsScratch, false);
            else if (field === 8) readPacked(reader, header, refsScratch, true);
            else reader.skip(header);
          }
          // Refs are delta-encoded.
          for (let i = 1; i < refsScratch.length; i++) refsScratch[i] += refsScratch[i - 1];
          visitor.onWay(id, keysScratch, valsScratch, refsScratch);
        } else if (tag === 4) {
          contents.relations = true;
          const relationEnd = reader.readVarint() + reader.pos;
          if (!visitor.onRelation) {
            reader.pos = relationEnd;
            return;
          }
          let id = 0;
          keysScratch.length = 0;
          valsScratch.length = 0;
          memIdsScratch.length = 0;
          memTypesScratch.length = 0;
          rolesScratch.length = 0;
          while (reader.pos < relationEnd) {
            const header = reader.readVarint();
            const field = header >> 3;
            if (field === 1) id = reader.readVarint();
            else if (field === 2) readPacked(reader, header, keysScratch, false);
            else if (field === 3) readPacked(reader, header, valsScratch, false);
            else if (field === 8) readPacked(reader, header, rolesScratch, false);
            else if (field === 9) readPacked(reader, header, memIdsScratch, true);
            else if (field === 10) readPacked(reader, header, memTypesScratch, false);
            else reader.skip(header);
          }
          for (let i = 1; i < memIdsScratch.length; i++) memIdsScratch[i] += memIdsScratch[i - 1];
          visitor.onRelation(
            id,
            keysScratch,
            valsScratch,
            memIdsScratch,
            memTypesScratch,
            rolesScratch,
          );
        }
        // Anything else (changesets) is skipped by `readFields` itself.
      },
      null,
      end,
    );
  }
  return contents;
}
