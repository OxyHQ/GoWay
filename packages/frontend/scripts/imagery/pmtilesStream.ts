/**
 * Pack a directory of image tiles (`<z>/<x>/<y>.<ext>`, as `gdal raster tile`
 * writes them) into ONE PMTiles archive, streaming: an imagery cell is
 * hundreds of megabytes, so the tile bytes go from disk to disk and only the
 * directory is held in memory.
 *
 * The archive is CLUSTERED — tiles in tile-id (Hilbert) order — like every
 * archive GoWay writes, and read by the same reader (`worker/pmtiles.js`).
 * Identical tiles (open sea, a blank field) are stored once. Image tiles are
 * stored as they are (`tileCompression: NONE`): the codec is the compression.
 */
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { open, readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { COMPRESSION, PMTiles, TILE_TYPE, zxyToTileId } from '../../worker/pmtiles.js';
import { type PmtilesEntry, pmtilesPrelude, pushEntry } from '../citygen/pmtilesWriter';

export interface PackedArchive {
  tiles: number;
  /** Distinct tile bodies stored. */
  contents: number;
  bytes: number;
  sha256: string;
  /** Tiles per zoom. */
  perZoom: Record<number, number>;
  minZoom: number;
  maxZoom: number;
}

const TILE_TYPES: Record<string, number> = {
  webp: TILE_TYPE.WEBP,
  avif: TILE_TYPE.AVIF,
  png: TILE_TYPE.PNG,
  jpg: TILE_TYPE.JPEG,
};

interface FoundTile {
  z: number;
  x: number;
  y: number;
  path: string;
  tileId: number;
}

/** Every `<z>/<x>/<y>.<ext>` under `dir` (nothing else: viewers, `.aux.xml`). */
export async function listTiles(dir: string, ext: string): Promise<FoundTile[]> {
  const out: FoundTile[] = [];
  const numeric = (name: string) => /^\d+$/.test(name);
  for (const zName of (await readdir(dir)).filter(numeric)) {
    const z = Number(zName);
    for (const xName of (await readdir(join(dir, zName))).filter(numeric)) {
      const x = Number(xName);
      for (const file of await readdir(join(dir, zName, xName))) {
        const match = new RegExp(`^(\\d+)\\.${ext}$`).exec(file);
        if (!match) continue;
        const y = Number(match[1]);
        out.push({ z, x, y, path: join(dir, zName, xName, file), tileId: zxyToTileId(z, x, y) });
      }
    }
  }
  return out.sort((a, b) => a.tileId - b.tileId);
}

/**
 * Write the archive. `metadata` is stored as the archive's JSON metadata
 * (it should say what the archive is and where it came from: a found
 * archive must still name its set, cell, sources and licence).
 */
export async function packTileDirectory(options: {
  dir: string;
  ext: 'webp' | 'avif' | 'png' | 'jpg';
  out: string;
  bounds: [number, number, number, number];
  metadata: Record<string, unknown>;
}): Promise<PackedArchive | null> {
  const tiles = await listTiles(options.dir, options.ext);
  if (tiles.length === 0) return null;

  // Pass 1: hash every tile (identical bodies stored once) and lay out the data.
  const entries: PmtilesEntry[] = [];
  const contents = new Map<string, { offset: number; length: number; path: string }>();
  const order: { path: string }[] = [];
  const perZoom: Record<number, number> = {};
  let dataLength = 0;
  for (const tile of tiles) {
    const bytes = await readFile(tile.path);
    const digest = createHash('sha256').update(bytes).digest('hex');
    let stored = contents.get(digest);
    if (!stored) {
      stored = { offset: dataLength, length: bytes.length, path: tile.path };
      contents.set(digest, stored);
      order.push({ path: tile.path });
      dataLength += bytes.length;
    }
    pushEntry(entries, tile.tileId, stored);
    perZoom[tile.z] = (perZoom[tile.z] ?? 0) + 1;
  }
  const zooms = Object.keys(perZoom).map(Number);
  const minZoom = Math.min(...zooms);
  const maxZoom = Math.max(...zooms);
  const [w, s, e, n] = options.bounds;

  const prelude = pmtilesPrelude(
    entries,
    { addressed: tiles.length, contents: contents.size, dataLength },
    {
      minZoom,
      maxZoom,
      bounds: options.bounds,
      center: [(w + e) / 2, (s + n) / 2, minZoom],
      metadata: options.metadata,
      tileType: TILE_TYPES[options.ext],
      tileCompression: COMPRESSION.NONE,
    },
  );

  // Pass 2: stream the prelude and the distinct bodies, hashing what is written.
  const hash = createHash('sha256');
  const stream = createWriteStream(options.out);
  const write = (chunk: Uint8Array) =>
    new Promise<void>((resolve, reject) => {
      hash.update(chunk);
      stream.write(chunk, (error) => (error ? reject(error) : resolve()));
    });
  await write(prelude);
  for (const { path } of order) await write(await readFile(path));
  await new Promise<void>((resolve, reject) =>
    stream.end((error?: Error | null) => (error ? reject(error) : resolve())),
  );

  const bytes = (await stat(options.out)).size;
  if (bytes !== prelude.length + dataLength) {
    throw new Error(
      `${options.out}: wrote ${bytes} bytes, expected ${prelude.length + dataLength}`,
    );
  }
  return {
    tiles: tiles.length,
    contents: contents.size,
    bytes,
    sha256: hash.digest('hex'),
    perZoom,
    minZoom,
    maxZoom,
  };
}

/**
 * Read an archive back as the Worker will (`worker/pmtiles.js`) and compare
 * every tile to the one packed from `tileDir`: a WebP archive within the
 * set's zooms, every tile addressed and byte-identical, its metadata naming
 * the set.
 */
export async function verifyPackedArchive(
  path: string,
  tileDir: string,
  expect: { set: string; minZoom: number; maxZoom: number },
): Promise<void> {
  const handle = await open(path, 'r');
  try {
    const archive = new PMTiles({
      async read(offset: number, length: number) {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, offset);
        return new Uint8Array(buffer.subarray(0, bytesRead));
      },
    });
    const header = await archive.header();
    if (header.tileType !== TILE_TYPE.WEBP)
      throw new Error(`${path}: tile type ${header.tileType}, not WebP`);
    if (header.minZoom < expect.minZoom || header.maxZoom > expect.maxZoom) {
      throw new Error(`${path}: zooms ${header.minZoom}–${header.maxZoom} outside the set's`);
    }
    const tiles = await listTiles(tileDir, 'webp');
    if (header.addressedTiles !== tiles.length) {
      throw new Error(`${path}: ${header.addressedTiles} tiles addressed, ${tiles.length} tiled`);
    }
    for (const tile of tiles) {
      const got = await archive.getTile(tile.z, tile.x, tile.y);
      const want = await readFile(tile.path);
      if (!got || Buffer.compare(Buffer.from(got.bytes), want) !== 0) {
        throw new Error(`${path}: tile ${tile.z}/${tile.x}/${tile.y} does not read back`);
      }
    }
    const metadata = await archive.metadata();
    if (metadata['goway:set'] !== expect.set)
      throw new Error(`${path}: metadata names ${metadata['goway:set']}`);
  } finally {
    await handle.close();
  }
}
