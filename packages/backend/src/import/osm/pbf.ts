/**
 * Reading an `.osm.pbf` extract: the file's blob framing and the one message
 * inside it this importer cares about.
 *
 * ## The file, in one paragraph
 *
 * An `.osm.pbf` is a concatenation of self-delimiting *blobs*. Each is a 4-byte
 * big-endian length, a `BlobHeader` giving the blob's TYPE (`OSMHeader` once,
 * then `OSMData` for the rest) and the byte length of what follows, and then a
 * `Blob` holding either raw or zlib-compressed bytes. Inflating an `OSMData`
 * blob yields a `PrimitiveBlock`: a string table plus up to 8000 elements that
 * reference it by index, with coordinates stored as integers against the
 * block's own `granularity` and offsets.
 *
 * ## Elements are ordered, and that order is why this file exposes offsets
 *
 * Every extract Geofabrik publishes is sorted: all nodes, then all ways, then
 * all relations. That order is the whole difficulty of importing POIs. A POI
 * mapped as a way — a museum, a shopping centre, a park — has no coordinates of
 * its own, only a list of node ids, and by the time the file names them the
 * nodes have already gone past. So the importer reads the file more than once,
 * and {@link readBlobs} takes a `shouldRead` predicate so the later passes
 * inflate only the blobs they need: the second pass touches the ~15% of the
 * archive holding ways, and the third re-reads nodes alone. A blob's TYPE is
 * only knowable after inflating it, which is why the caller records the offsets
 * it saw on the first pass instead of guessing them on the later ones.
 *
 * ## Scratch arrays, and the contract that comes with them
 *
 * A Spain extract carries on the order of 10^8 nodes. Allocating a tag array
 * per element would allocate a few hundred million short-lived arrays and spend
 * most of the import in the garbage collector. Every visitor below is therefore
 * handed REUSED arrays that are valid only for the duration of the call: a
 * visitor that wants to keep tags must copy them. Each callback's doc says so.
 */

import { promises as fs } from 'node:fs';
import { inflate } from 'node:zlib';
import { promisify } from 'node:util';
import {
  WIRE_LENGTH_DELIMITED,
  readBytes,
  readFieldHeader,
  readMessage,
  readPackedSignedVarints,
  readPackedVarints,
  readSignedVarint,
  readString,
  readVarint,
  reader,
  skipField,
  type Reader,
} from './protobuf';

const inflateAsync = promisify(inflate);

/**
 * The header of an OSM blob, and the bytes that follow it.
 *
 * `inflate()` is a FUNCTION rather than a decoded payload so a pass can decide
 * per blob whether to pay for the decompression. See the file docblock.
 */
export interface Blob {
  /** Byte offset of this blob's 4-byte length prefix, from the start of the file. */
  offset: number;
  /** `OSMHeader` or `OSMData`. */
  type: string;
  /** Decompress this blob's payload. */
  inflate: () => Promise<Uint8Array>;
}

/** Fields of `BlobHeader`. */
const BLOB_HEADER_TYPE = 1;
const BLOB_HEADER_DATASIZE = 3;

/** Fields of `Blob`. */
const BLOB_RAW = 1;
const BLOB_RAW_SIZE = 2;
const BLOB_ZLIB_DATA = 3;

/** An OSM blob header may not exceed 64 KiB, and its payload may not exceed 32 MiB. */
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_BLOB_BYTES = 32 * 1024 * 1024;

/** Which blobs a pass wants inflated. `undefined` means all of them. */
export interface BlobFilter {
  /** Called with a blob's offset before its payload is read. */
  shouldRead?: (offset: number) => boolean;
}

/**
 * Every blob in the archive, in file order.
 *
 * The scan reads each blob's 4-byte length and header and then SEEKS past the
 * payload unless `shouldRead` wants it, so a filtered pass costs two small
 * reads per blob rather than a decompression.
 */
export async function* readBlobs(
  path: string,
  filter: BlobFilter = {},
): AsyncGenerator<Blob, void, void> {
  const handle = await fs.open(path, 'r');
  try {
    const { size } = await handle.stat();
    const lengthBuffer = Buffer.allocUnsafe(4);
    let position = 0;

    while (position + 4 <= size) {
      const head = await handle.read(lengthBuffer, 0, 4, position);
      if (head.bytesRead < 4) break;
      const headerLength = lengthBuffer.readUInt32BE(0);
      if (headerLength === 0 || headerLength > MAX_HEADER_BYTES) {
        throw new Error(`Blob header length ${headerLength} at offset ${position} is not plausible.`);
      }

      const headerBuffer = Buffer.allocUnsafe(headerLength);
      await handle.read(headerBuffer, 0, headerLength, position + 4);
      const { type, dataLength } = decodeBlobHeader(headerBuffer);
      if (dataLength > MAX_BLOB_BYTES) {
        throw new Error(`Blob payload length ${dataLength} at offset ${position} is not plausible.`);
      }

      const dataOffset = position + 4 + headerLength;
      const offset = position;
      position = dataOffset + dataLength;

      if (filter.shouldRead && !filter.shouldRead(offset)) continue;

      yield {
        offset,
        type,
        inflate: async () => {
          const payload = Buffer.allocUnsafe(dataLength);
          await handle.read(payload, 0, dataLength, dataOffset);
          return decodeBlob(payload);
        },
      };
    }
  } finally {
    await handle.close();
  }
}

/** `BlobHeader` — the type name and the payload length. */
function decodeBlobHeader(bytes: Uint8Array): { type: string; dataLength: number } {
  const read = reader(bytes);
  let type = '';
  let dataLength = 0;
  for (let header = readFieldHeader(read); header; header = readFieldHeader(read)) {
    if (header.field === BLOB_HEADER_TYPE && header.wire === WIRE_LENGTH_DELIMITED) {
      type = readString(read);
    } else if (header.field === BLOB_HEADER_DATASIZE) {
      dataLength = readVarint(read);
    } else {
      skipField(read, header.wire);
    }
  }
  return { type, dataLength };
}

/**
 * `Blob` — raw or zlib, and nothing else.
 *
 * `lzma_data`, `lz4_data` and `zstd_data` exist in the format and no extract
 * GoWay reads uses them; an archive that did would fail HERE, naming the
 * compression, rather than producing an empty import that looks like a region
 * with no POIs in it.
 */
async function decodeBlob(bytes: Uint8Array): Promise<Uint8Array> {
  const read = reader(bytes);
  let raw: Uint8Array | null = null;
  let compressed: Uint8Array | null = null;
  let rawSize = 0;
  for (let header = readFieldHeader(read); header; header = readFieldHeader(read)) {
    if (header.field === BLOB_RAW && header.wire === WIRE_LENGTH_DELIMITED) {
      raw = readBytes(read);
    } else if (header.field === BLOB_RAW_SIZE) {
      rawSize = readVarint(read);
    } else if (header.field === BLOB_ZLIB_DATA && header.wire === WIRE_LENGTH_DELIMITED) {
      compressed = readBytes(read);
    } else {
      skipField(read, header.wire);
    }
  }

  if (raw) return raw;
  if (!compressed) {
    throw new Error('Blob uses a compression this importer does not support (only raw and zlib).');
  }
  const inflated = await inflateAsync(compressed);
  if (rawSize > 0 && inflated.length !== rawSize) {
    throw new Error(`Blob inflated to ${inflated.length} bytes, header said ${rawSize}.`);
  }
  return new Uint8Array(inflated.buffer, inflated.byteOffset, inflated.length);
}

// ── PrimitiveBlock ──────────────────────────────────────────────────────────

/** A block's string table, decoded on demand. */
export interface BlockStrings {
  /** How many entries the table holds. */
  readonly count: number;
  /** The entry at `index`, as UTF-8. Memoized: a key is asked for many times. */
  text(index: number): string;
}

/**
 * What a pass wants out of one block.
 *
 * `onStrings` runs once per block BEFORE any element, which is what lets a
 * caller classify the string table's few thousand entries once and then match
 * tags by integer index for the block's 8000 elements — the difference between
 * decoding a few thousand strings per block and a few hundred million per file.
 *
 * Every `keys`/`vals`/`refs` array a callback receives is SCRATCH, reused
 * across elements and invalid once the callback returns.
 */
export interface BlockVisitor {
  onStrings?: (strings: BlockStrings) => void;
  onNode?: (id: number, latitude: number, longitude: number, keys: number[], vals: number[]) => void;
  onWay?: (id: number, keys: number[], vals: number[], refs: number[]) => void;
  onRelation?: (
    id: number,
    keys: number[],
    vals: number[],
    memberIds: number[],
    memberTypes: number[],
  ) => void;
}

/** Which element kinds a block turned out to hold. Recorded to steer later passes. */
export interface BlockContents {
  nodes: boolean;
  ways: boolean;
  relations: boolean;
}

/** Fields of `PrimitiveBlock`. */
const BLOCK_STRINGTABLE = 1;
const BLOCK_PRIMITIVEGROUP = 2;
const BLOCK_GRANULARITY = 17;
const BLOCK_LAT_OFFSET = 19;
const BLOCK_LON_OFFSET = 20;

/** Fields of `PrimitiveGroup`. */
const GROUP_NODES = 1;
const GROUP_DENSE = 2;
const GROUP_WAYS = 3;
const GROUP_RELATIONS = 4;

/** Fields of `DenseNodes`. */
const DENSE_ID = 1;
const DENSE_LAT = 8;
const DENSE_LON = 9;
const DENSE_KEYS_VALS = 10;

/** Fields of `Node`, `Way` and `Relation` — the same three numbers mean the same three things. */
const ELEMENT_ID = 1;
const ELEMENT_KEYS = 2;
const ELEMENT_VALS = 3;
const NODE_LAT = 8;
const NODE_LON = 9;
const WAY_REFS = 8;
const RELATION_MEMBER_IDS = 9;
const RELATION_MEMBER_TYPES = 10;

/** `Relation.MemberType.WAY`. */
export const MEMBER_TYPE_WAY = 1;

/**
 * Coordinates are stored as integers in units of a nanodegree times the block's
 * `granularity`, biased by the block's offsets.
 */
const NANODEGREE = 1e-9;

/**
 * Decode one `PrimitiveBlock`, calling `visitor` for each element it holds.
 *
 * Returns which kinds it held, so a first pass can build the offset index the
 * later passes filter on.
 */
export function readPrimitiveBlock(data: Uint8Array, visitor: BlockVisitor): BlockContents {
  const read = reader(data);
  const groups: Reader[] = [];
  let strings: BlockStrings | null = null;
  let granularity = 100;
  let latOffset = 0;
  let lonOffset = 0;

  for (let header = readFieldHeader(read); header; header = readFieldHeader(read)) {
    switch (header.field) {
      case BLOCK_STRINGTABLE:
        strings = decodeStringTable(readMessage(read));
        break;
      case BLOCK_PRIMITIVEGROUP:
        groups.push(readMessage(read));
        break;
      case BLOCK_GRANULARITY:
        granularity = readVarint(read);
        break;
      case BLOCK_LAT_OFFSET:
        latOffset = readSignedVarint(read);
        break;
      case BLOCK_LON_OFFSET:
        lonOffset = readSignedVarint(read);
        break;
      default:
        skipField(read, header.wire);
    }
  }

  if (!strings) throw new Error('PrimitiveBlock carries no string table.');
  visitor.onStrings?.(strings);

  const contents: BlockContents = { nodes: false, ways: false, relations: false };
  const scale = NANODEGREE * granularity;
  const latBase = NANODEGREE * latOffset;
  const lonBase = NANODEGREE * lonOffset;

  for (const group of groups) {
    for (let header = readFieldHeader(group); header; header = readFieldHeader(group)) {
      switch (header.field) {
        case GROUP_DENSE:
          contents.nodes = true;
          readDenseNodes(readMessage(group), visitor, scale, latBase, lonBase);
          break;
        case GROUP_NODES:
          contents.nodes = true;
          readNode(readMessage(group), visitor, scale, latBase, lonBase);
          break;
        case GROUP_WAYS:
          contents.ways = true;
          readWay(readMessage(group), visitor);
          break;
        case GROUP_RELATIONS:
          contents.relations = true;
          readRelation(readMessage(group), visitor);
          break;
        default:
          skipField(group, header.wire);
      }
    }
  }

  return contents;
}

/** `StringTable`, with decoding deferred to first use and then cached. */
function decodeStringTable(read: Reader): BlockStrings {
  const raw: Uint8Array[] = [];
  for (let header = readFieldHeader(read); header; header = readFieldHeader(read)) {
    if (header.field === 1 && header.wire === WIRE_LENGTH_DELIMITED) raw.push(readBytes(read));
    else skipField(read, header.wire);
  }
  const decoded: (string | undefined)[] = new Array(raw.length);
  const decoder = new TextDecoder('utf-8');
  return {
    count: raw.length,
    text(index: number): string {
      const cached = decoded[index];
      if (cached !== undefined) return cached;
      const bytes = raw[index];
      const value = bytes === undefined ? '' : decoder.decode(bytes);
      decoded[index] = value;
      return value;
    },
  };
}

/** Scratch, reused across every element of every block. See the file docblock. */
const scratchKeys: number[] = [];
const scratchVals: number[] = [];
const scratchRefs: number[] = [];
const scratchMemberIds: number[] = [];
const scratchMemberTypes: number[] = [];
const scratchPacked: number[] = [];

/**
 * `DenseNodes` — ids and coordinates delta-encoded, tags in one flat
 * `keys_vals` array terminated by a zero per node.
 *
 * The deltas are cumulative across the whole block, so the loop may not skip an
 * uninteresting node: every id and both ordinates have to be accumulated even
 * for nodes the visitor never sees.
 */
function readDenseNodes(
  read: Reader,
  visitor: BlockVisitor,
  scale: number,
  latBase: number,
  lonBase: number,
): void {
  if (!visitor.onNode) return;
  const ids: number[] = [];
  const lats: number[] = [];
  const lons: number[] = [];
  const keysVals: number[] = [];

  for (let header = readFieldHeader(read); header; header = readFieldHeader(read)) {
    switch (header.field) {
      case DENSE_ID:
        readPackedSignedVarints(read, ids);
        break;
      case DENSE_LAT:
        readPackedSignedVarints(read, lats);
        break;
      case DENSE_LON:
        readPackedSignedVarints(read, lons);
        break;
      case DENSE_KEYS_VALS:
        readPackedVarints(read, keysVals);
        break;
      default:
        skipField(read, header.wire);
    }
  }

  let id = 0;
  let latitude = 0;
  let longitude = 0;
  let tag = 0;
  for (let index = 0; index < ids.length; index += 1) {
    id += ids[index] as number;
    latitude += lats[index] as number;
    longitude += lons[index] as number;

    scratchKeys.length = 0;
    scratchVals.length = 0;
    while (tag < keysVals.length) {
      const key = keysVals[tag] as number;
      tag += 1;
      if (key === 0) break;
      scratchKeys.push(key);
      scratchVals.push(keysVals[tag] as number);
      tag += 1;
    }

    visitor.onNode(id, latBase + scale * latitude, lonBase + scale * longitude, scratchKeys, scratchVals);
  }
}

/** A standalone `Node`. Rare in practice — most extracts use `DenseNodes` throughout. */
function readNode(
  read: Reader,
  visitor: BlockVisitor,
  scale: number,
  latBase: number,
  lonBase: number,
): void {
  if (!visitor.onNode) return;
  let id = 0;
  let latitude = 0;
  let longitude = 0;
  scratchKeys.length = 0;
  scratchVals.length = 0;

  for (let header = readFieldHeader(read); header; header = readFieldHeader(read)) {
    switch (header.field) {
      case ELEMENT_ID:
        id = readSignedVarint(read);
        break;
      case ELEMENT_KEYS:
        readPackedVarints(read, scratchKeys);
        break;
      case ELEMENT_VALS:
        readPackedVarints(read, scratchVals);
        break;
      case NODE_LAT:
        latitude = readSignedVarint(read);
        break;
      case NODE_LON:
        longitude = readSignedVarint(read);
        break;
      default:
        skipField(read, header.wire);
    }
  }

  visitor.onNode(id, latBase + scale * latitude, lonBase + scale * longitude, scratchKeys, scratchVals);
}

/** A `Way`: tags, and node references delta-encoded. */
function readWay(read: Reader, visitor: BlockVisitor): void {
  if (!visitor.onWay) return;
  let id = 0;
  scratchKeys.length = 0;
  scratchVals.length = 0;
  scratchRefs.length = 0;
  scratchPacked.length = 0;

  for (let header = readFieldHeader(read); header; header = readFieldHeader(read)) {
    switch (header.field) {
      case ELEMENT_ID:
        id = readVarint(read);
        break;
      case ELEMENT_KEYS:
        readPackedVarints(read, scratchKeys);
        break;
      case ELEMENT_VALS:
        readPackedVarints(read, scratchVals);
        break;
      case WAY_REFS:
        readPackedSignedVarints(read, scratchPacked);
        break;
      default:
        skipField(read, header.wire);
    }
  }

  let ref = 0;
  for (const delta of scratchPacked) {
    ref += delta;
    scratchRefs.push(ref);
  }
  visitor.onWay(id, scratchKeys, scratchVals, scratchRefs);
}

/** A `Relation`: tags, and members delta-encoded with a parallel type array. */
function readRelation(read: Reader, visitor: BlockVisitor): void {
  if (!visitor.onRelation) return;
  let id = 0;
  scratchKeys.length = 0;
  scratchVals.length = 0;
  scratchMemberIds.length = 0;
  scratchMemberTypes.length = 0;
  scratchPacked.length = 0;

  for (let header = readFieldHeader(read); header; header = readFieldHeader(read)) {
    switch (header.field) {
      case ELEMENT_ID:
        id = readVarint(read);
        break;
      case ELEMENT_KEYS:
        readPackedVarints(read, scratchKeys);
        break;
      case ELEMENT_VALS:
        readPackedVarints(read, scratchVals);
        break;
      case RELATION_MEMBER_IDS:
        readPackedSignedVarints(read, scratchPacked);
        break;
      case RELATION_MEMBER_TYPES:
        readPackedVarints(read, scratchMemberTypes);
        break;
      default:
        skipField(read, header.wire);
    }
  }

  let member = 0;
  for (const delta of scratchPacked) {
    member += delta;
    scratchMemberIds.push(member);
  }
  visitor.onRelation(id, scratchKeys, scratchVals, scratchMemberIds, scratchMemberTypes);
}
