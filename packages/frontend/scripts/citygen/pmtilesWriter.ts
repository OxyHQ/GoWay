/**
 * A PMTiles v3 WRITER, for the city-tile compiler.
 *
 * The basemap never needed one — Planetiler writes its own archive — but the
 * city tiles are written by GoWay's compiler, and the production plan for
 * them is the basemap's: one archive in R2, read by byte range in the Worker
 * (`docs/MAP_3D_CITY.md` → Hosting). So this writes exactly what
 * `worker/pmtiles.js` reads, and `__tests__/cityTiles.test.ts` round-trips an
 * archive through THAT reader, not a second one.
 *
 * Layout: header (127 B) · root directory · metadata · leaf directories · tile
 * data. Tiles are written in tile-id (Hilbert) order, so the archive is
 * `clustered` and a run of neighbouring tiles is contiguous in storage.
 * Directories and metadata are gzipped; tiles are gzipped by the caller.
 *
 * Spec: https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md
 */
import { gzipSync } from 'node:zlib';

import { COMPRESSION, HEADER_BYTES, TILE_TYPE, zxyToTileId } from '../../worker/pmtiles.js';

export interface PmtilesTile {
  z: number;
  x: number;
  y: number;
  /** The stored bytes (already gzipped — see `tileCompression`). */
  bytes: Uint8Array;
}

export interface PmtilesOptions {
  minZoom: number;
  maxZoom: number;
  bounds: [number, number, number, number];
  center: [number, number, number];
  metadata: Record<string, unknown>;
  tileType?: number;
  tileCompression?: number;
  /** Largest root directory, compressed. Default: what fits the reader's first read. Tests lower it. */
  rootBudgetBytes?: number;
}

interface Entry {
  tileId: number;
  offset: number;
  length: number;
  runLength: number;
}

/** The root must fit in the reader's first fetch together with the header. */
const ROOT_BUDGET_BYTES = 16384 - HEADER_BYTES;

function pushVarint(out: number[], value: number): void {
  let remaining = value;
  while (remaining >= 0x80) {
    out.push((remaining % 0x80) | 0x80);
    remaining = Math.floor(remaining / 0x80);
  }
  out.push(remaining);
}

/** Serialise a directory exactly as `decodeDirectory` reads it. */
export function encodeDirectory(entries: readonly Entry[]): Uint8Array {
  const out: number[] = [];
  pushVarint(out, entries.length);
  let last = 0;
  for (const entry of entries) {
    pushVarint(out, entry.tileId - last);
    last = entry.tileId;
  }
  for (const entry of entries) pushVarint(out, entry.runLength);
  for (const entry of entries) pushVarint(out, entry.length);
  entries.forEach((entry, i) => {
    const previous = entries[i - 1];
    if (i > 0 && entry.offset === previous.offset + previous.length) pushVarint(out, 0);
    else pushVarint(out, entry.offset + 1);
  });
  return new Uint8Array(out);
}

const gzip = (bytes: Uint8Array) => new Uint8Array(gzipSync(bytes, { level: 9 }));

/** Root (+ leaves when the root alone would not fit). */
function buildDirectories(
  entries: readonly Entry[],
  budget: number,
): { root: Uint8Array; leaves: Uint8Array } {
  const flat = gzip(encodeDirectory(entries));
  if (flat.length <= budget) return { root: flat, leaves: new Uint8Array(0) };
  for (let leafSize = Math.min(4096, Math.ceil(entries.length / 8)); ; leafSize *= 2) {
    const leafChunks: Uint8Array[] = [];
    const rootEntries: Entry[] = [];
    let offset = 0;
    for (let i = 0; i < entries.length; i += leafSize) {
      const chunk = gzip(encodeDirectory(entries.slice(i, i + leafSize)));
      rootEntries.push({ tileId: entries[i].tileId, offset, length: chunk.length, runLength: 0 });
      leafChunks.push(chunk);
      offset += chunk.length;
    }
    const root = gzip(encodeDirectory(rootEntries));
    if (root.length <= budget || rootEntries.length === 1) {
      const leaves = new Uint8Array(offset);
      let at = 0;
      for (const chunk of leafChunks) {
        leaves.set(chunk, at);
        at += chunk.length;
      }
      return { root, leaves };
    }
  }
}

/** Build a complete archive in memory. City-sized archives are tens of MB. */
export function writePmtiles(tiles: readonly PmtilesTile[], options: PmtilesOptions): Uint8Array {
  const sorted = tiles
    .map((tile) => ({ tile, tileId: zxyToTileId(tile.z, tile.x, tile.y) }))
    .sort((a, b) => a.tileId - b.tileId);

  const entries: Entry[] = [];
  const contents = new Map<string, { offset: number; length: number }>();
  const chunks: Uint8Array[] = [];
  let dataLength = 0;
  for (const { tile, tileId } of sorted) {
    // Identical tiles are stored once (rare for buildings, but free to do).
    const key = Buffer.from(tile.bytes).toString('base64');
    let stored = contents.get(key);
    if (!stored) {
      stored = { offset: dataLength, length: tile.bytes.length };
      contents.set(key, stored);
      chunks.push(tile.bytes);
      dataLength += tile.bytes.length;
    }
    const last = entries[entries.length - 1];
    if (
      last &&
      last.tileId + last.runLength === tileId &&
      last.offset === stored.offset &&
      last.length === stored.length
    ) {
      last.runLength += 1;
    } else {
      entries.push({ tileId, offset: stored.offset, length: stored.length, runLength: 1 });
    }
  }

  const { root, leaves } = buildDirectories(entries, options.rootBudgetBytes ?? ROOT_BUDGET_BYTES);
  const metadata = gzip(new TextEncoder().encode(JSON.stringify(options.metadata)));

  const rootOffset = HEADER_BYTES;
  const metadataOffset = rootOffset + root.length;
  const leavesOffset = metadataOffset + metadata.length;
  const dataOffset = leavesOffset + leaves.length;
  const total = dataOffset + dataLength;

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  out.set(new TextEncoder().encode('PMTiles'), 0);
  out[7] = 3;
  const u64 = (at: number, value: number) => view.setBigUint64(at, BigInt(value), true);
  u64(8, rootOffset);
  u64(16, root.length);
  u64(24, metadataOffset);
  u64(32, metadata.length);
  u64(40, leavesOffset);
  u64(48, leaves.length);
  u64(56, dataOffset);
  u64(64, dataLength);
  u64(72, sorted.length);
  u64(80, entries.length);
  u64(88, contents.size);
  out[96] = 1; // clustered
  out[97] = COMPRESSION.GZIP;
  out[98] = options.tileCompression ?? COMPRESSION.GZIP;
  out[99] = options.tileType ?? TILE_TYPE.MVT;
  out[100] = options.minZoom;
  out[101] = options.maxZoom;
  const e7 = (value: number) => Math.round(value * 1e7);
  view.setInt32(102, e7(options.bounds[0]), true);
  view.setInt32(106, e7(options.bounds[1]), true);
  view.setInt32(110, e7(options.bounds[2]), true);
  view.setInt32(114, e7(options.bounds[3]), true);
  out[118] = options.center[2];
  view.setInt32(119, e7(options.center[0]), true);
  view.setInt32(123, e7(options.center[1]), true);

  out.set(root, rootOffset);
  out.set(metadata, metadataOffset);
  out.set(leaves, leavesOffset);
  let at = dataOffset;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}
