/**
 * A PMTiles v3 reader — the format GoWay's own basemap is stored in.
 *
 * ## Why a whole tile archive is one file
 *
 * GoWay serves the planet from Cloudflare R2, and R2 is object storage: it can
 * hand back a byte range of an object and nothing else. It cannot run a tile
 * server, and 350 million individual tile objects would cost more in Class A
 * operations to upload than the bytes cost to keep. PMTiles is the format that
 * makes those two facts compatible — one object, a header, a tree of
 * directories, and a tile body, all addressed by `Range:`. The Worker was
 * already standing between the browser and the tiles, so the Worker becomes
 * the thing that reads the ranges. There is no tile server anywhere in GoWay.
 *
 * ## The shape of a lookup
 *
 * ```
 *   z/x/y ──hilbert──▶ tileId ──▶ root directory ──▶ (leaf directory) ──▶ range
 * ```
 *
 * Three facts about that chain decide the whole design:
 *
 *  1. **The tile id is a Hilbert index, not `z*4^n + y*2^z + x`.** PMTiles
 *     orders tiles along a space-filling curve so that tiles near each other
 *     on the map are near each other in the file, which is what makes a leaf
 *     directory describe a contiguous region and a viewport's worth of tiles
 *     land in a handful of ranges. Get {@link zxyToTileId} wrong by one and
 *     every tile in the world resolves to a neighbour's bytes — the map
 *     renders, and it renders the wrong place. There is no error to catch.
 *  2. **The directories are the only part worth caching.** A tile body is read
 *     once and handed straight to one browser. The root directory is read by
 *     EVERY request. That asymmetry is why {@link PMTiles} takes a `source`
 *     rather than an R2 bucket: the Worker hands it a source that memoises
 *     ranges in `caches.default`, and the build-time verifier hands it one
 *     backed by a local file, and neither knows about the other.
 *  3. **The bytes stay compressed.** Planetiler writes gzipped MVT and the
 *     header says so. Decompressing a tile in the Worker to re-compress it on
 *     the wire would be pure waste, so {@link PMTiles.getTile} returns the
 *     stored bytes and the stored compression, and the caller sets
 *     `content-encoding`. Directories are a different matter — they must be
 *     decompressed to be read at all.
 *
 * ## What is deliberately not here
 *
 * No writer, no clustering, no deduplication, no `pmtiles` npm package. This
 * file reads; `scripts/build-map-tiles.ts` delegates writing to Planetiler,
 * which already does all three better than anything that could be written
 * here. The format is versioned in its own magic bytes and
 * {@link readHeader} refuses anything but v3.
 *
 * @see https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md
 */

/** Fixed size of a PMTiles v3 header, in bytes. */
export const HEADER_BYTES = 127;

/**
 * How much of the archive the first read fetches.
 *
 * The header is 127 bytes and the root directory follows it immediately, and
 * the format's own guidance is that a root directory should fit in ~16 KiB so
 * that a client can reach any tile in two requests. Asking for 16 KiB up front
 * therefore usually costs one round trip instead of two, and never costs more
 * than one extra when the root turns out to be larger — {@link PMTiles.header}
 * falls back to an explicit read rather than assuming.
 */
export const INITIAL_READ_BYTES = 16384;

/** `compression` enum values, as the spec numbers them. */
export const COMPRESSION = { UNKNOWN: 0, NONE: 1, GZIP: 2, BROTLI: 3, ZSTD: 4 };

/** `tile type` enum values. GoWay only ever writes MVT. */
export const TILE_TYPE = { UNKNOWN: 0, MVT: 1, PNG: 2, JPEG: 3, WEBP: 4, AVIF: 5 };

/** The `content-encoding` a stored body needs, or `null` when it needs none. */
export function contentEncodingFor(compression) {
  if (compression === COMPRESSION.GZIP) return 'gzip';
  if (compression === COMPRESSION.BROTLI) return 'br';
  if (compression === COMPRESSION.ZSTD) return 'zstd';
  return null;
}

/**
 * `z/x/y` to the archive's tile id.
 *
 * The leading `acc` is the number of tiles in every zoom below `z`
 * (`(4^z - 1) / 3`), summed rather than divided so that the arithmetic stays
 * exact in a double at every zoom this can be asked about. The loop is the
 * standard Hilbert d2xy inverse.
 *
 * Bitwise `&` is safe here because `s` never exceeds 2^25: `z` is capped at 26,
 * far above the z14 GoWay builds, and well below the point at which JavaScript's
 * 32-bit bitwise coercion would silently wrap.
 */
export function zxyToTileId(z, x, y) {
  if (!Number.isInteger(z) || z < 0 || z > 26) {
    throw new RangeError(`zoom ${z} is outside the addressable range`);
  }
  const span = 2 ** z;
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= span || y >= span) {
    throw new RangeError(`tile ${z}/${x}/${y} is outside the world at that zoom`);
  }

  let acc = 0;
  for (let t = 0; t < z; t += 1) acc += 4 ** t;

  let tx = x;
  let ty = y;
  let d = 0;
  for (let s = span / 2; s > 0; s /= 2) {
    const rx = (tx & s) > 0 ? 1 : 0;
    const ry = (ty & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    if (ry === 0) {
      if (rx === 1) {
        tx = s - 1 - tx;
        ty = s - 1 - ty;
      }
      const swap = tx;
      tx = ty;
      ty = swap;
    }
  }
  return acc + d;
}

/**
 * A varint cursor.
 *
 * Accumulates by multiplication rather than by `<<`, because a PMTiles offset
 * into a 100 GB planet archive is well past 2^32 and a shifted accumulator
 * would wrap into a small positive number — producing a read of real bytes
 * from the wrong place, which is again a wrong map rather than an error.
 */
function readVarint(state) {
  let result = 0;
  let shift = 1;
  for (let i = 0; i < 10; i += 1) {
    if (state.offset >= state.bytes.length) throw new RangeError('truncated varint');
    const byte = state.bytes[state.offset];
    state.offset += 1;
    result += (byte & 0x7f) * shift;
    if ((byte & 0x80) === 0) return result;
    shift *= 128;
  }
  throw new RangeError('varint longer than 10 bytes');
}

/** A u64 that must fit a double exactly, or the archive is unreadable anyway. */
function readUint64(view, offset) {
  const value = view.getBigUint64(offset, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`PMTiles offset ${value} exceeds the exact integer range`);
  }
  return Number(value);
}

/**
 * Parse the 127-byte header.
 *
 * The magic and the version are checked before anything else is read. An
 * archive that is not PMTiles v3 — an HTML error page from a misconfigured
 * bucket, say, which is the realistic failure — must fail here with a sentence
 * that names the problem, not 40 bytes further on with a `RangeError` about a
 * varint.
 */
export function readHeader(bytes) {
  if (bytes.length < HEADER_BYTES) {
    throw new RangeError(`a PMTiles header is ${HEADER_BYTES} bytes; got ${bytes.length}`);
  }
  const magic = String.fromCharCode(...bytes.subarray(0, 7));
  if (magic !== 'PMTiles') {
    throw new Error(`not a PMTiles archive (magic bytes were ${JSON.stringify(magic)})`);
  }
  if (bytes[7] !== 3) {
    throw new Error(`PMTiles v${bytes[7]} is not supported; GoWay reads v3`);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    rootDirOffset: readUint64(view, 8),
    rootDirLength: readUint64(view, 16),
    metadataOffset: readUint64(view, 24),
    metadataLength: readUint64(view, 32),
    leafDirsOffset: readUint64(view, 40),
    leafDirsLength: readUint64(view, 48),
    tileDataOffset: readUint64(view, 56),
    tileDataLength: readUint64(view, 64),
    addressedTiles: readUint64(view, 72),
    tileEntries: readUint64(view, 80),
    tileContents: readUint64(view, 88),
    clustered: bytes[96] === 1,
    internalCompression: bytes[97],
    tileCompression: bytes[98],
    tileType: bytes[99],
    minZoom: bytes[100],
    maxZoom: bytes[101],
    bounds: [
      view.getInt32(102, true) / 1e7,
      view.getInt32(106, true) / 1e7,
      view.getInt32(110, true) / 1e7,
      view.getInt32(114, true) / 1e7,
    ],
    centerZoom: bytes[118],
    center: [view.getInt32(119, true) / 1e7, view.getInt32(123, true) / 1e7],
  };
}

/**
 * Decode a directory.
 *
 * The encoding is four parallel varint arrays rather than an array of structs,
 * which is what lets the tile ids delta-encode down to a byte or two each. The
 * last array is the one with a trick in it: an `offset` varint of `0` means
 * "immediately after the previous entry", which is how a clustered archive
 * stores a run of adjacent tiles for nothing.
 *
 * An entry with `runLength === 0` is not a tile. It is a pointer to a leaf
 * directory, and confusing the two would serve directory bytes to MapLibre.
 */
export function decodeDirectory(bytes) {
  const state = { bytes, offset: 0 };
  const count = readVarint(state);
  const entries = new Array(count);

  let tileId = 0;
  for (let i = 0; i < count; i += 1) {
    tileId += readVarint(state);
    entries[i] = { tileId, runLength: 0, length: 0, offset: 0 };
  }
  for (let i = 0; i < count; i += 1) entries[i].runLength = readVarint(state);
  for (let i = 0; i < count; i += 1) entries[i].length = readVarint(state);
  for (let i = 0; i < count; i += 1) {
    const value = readVarint(state);
    entries[i].offset =
      value === 0 && i > 0 ? entries[i - 1].offset + entries[i - 1].length : value - 1;
  }
  return entries;
}

/**
 * The entry covering `tileId`, or `null`.
 *
 * Binary search for the largest entry id not greater than the target, then one
 * of two acceptance tests: a leaf pointer (`runLength === 0`) always covers the
 * target, because the leaf is where the answer might be; a tile entry covers it
 * only inside its run.
 */
export function findEntry(entries, tileId) {
  let low = 0;
  let high = entries.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const delta = tileId - entries[middle].tileId;
    if (delta > 0) low = middle + 1;
    else if (delta < 0) high = middle - 1;
    else return entries[middle];
  }
  if (high < 0) return null;
  const candidate = entries[high];
  if (candidate.runLength === 0) return candidate;
  if (tileId - candidate.tileId < candidate.runLength) return candidate;
  return null;
}

/**
 * A directory decoded into four typed arrays — 24 bytes an entry — rather than
 * an object per entry (~80 bytes in V8). Measured 2026-10-12: the planet
 * basemap's 2,917 leaf directories hold 17,685 entries each (~1.4 MB as
 * objects, 424 kB here), the city archives' 4,096. The Worker keeps these.
 */
export function decodeDirectoryCompact(bytes) {
  const state = { bytes, offset: 0 };
  const count = readVarint(state);
  const tileIds = new Float64Array(count);
  const runLengths = new Uint32Array(count);
  const lengths = new Uint32Array(count);
  const offsets = new Float64Array(count);
  let tileId = 0;
  for (let i = 0; i < count; i += 1) {
    tileId += readVarint(state);
    tileIds[i] = tileId;
  }
  for (let i = 0; i < count; i += 1) runLengths[i] = readVarint(state);
  for (let i = 0; i < count; i += 1) lengths[i] = readVarint(state);
  for (let i = 0; i < count; i += 1) {
    const value = readVarint(state);
    offsets[i] = value === 0 && i > 0 ? offsets[i - 1] + lengths[i - 1] : value - 1;
  }
  return { count, tileIds, runLengths, lengths, offsets, bytes: count * 24 };
}

/** {@link findEntry} over a compact directory: the entry's index, or -1. */
export function findEntryCompact(directory, tileId) {
  const { tileIds, runLengths } = directory;
  let low = 0;
  let high = directory.count - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const delta = tileId - tileIds[middle];
    if (delta > 0) low = middle + 1;
    else if (delta < 0) high = middle - 1;
    else return middle;
  }
  if (high < 0) return -1;
  if (runLengths[high] === 0) return high;
  if (tileId - tileIds[high] < runLengths[high]) return high;
  return -1;
}

/** Undo the archive's internal compression. Only gzip is ever written. */
export async function decompress(bytes, compression) {
  if (compression === COMPRESSION.NONE) return bytes;
  const encoding = contentEncodingFor(compression);
  if (encoding !== 'gzip' && encoding !== 'deflate') {
    throw new Error(`cannot read a directory compressed with enum value ${compression}`);
  }
  const stream = new Response(bytes).body.pipeThrough(new DecompressionStream(encoding));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * How many directory levels a lookup will walk before giving up.
 *
 * PMTiles allows arbitrary nesting; every archive anyone writes in practice is
 * root plus one leaf level. The cap exists so that a corrupt directory whose
 * leaf pointer loops back on itself fails as an error rather than as a Worker
 * that reads ranges until the request times out.
 */
const MAX_DIRECTORY_DEPTH = 4;

/**
 * A readable PMTiles archive over an arbitrary byte source.
 *
 * `source.read(offset, length, options)` is the whole interface, and it is
 * intentionally the whole interface: an R2 bucket, a cached R2 bucket, a local
 * file and an `ArrayBuffer` all satisfy it in a handful of lines, which is what
 * lets the build-time verifier assert against the archive using **exactly the
 * code the edge serves it with**. A verifier that used a different reader would
 * prove that the archive is readable, not that GoWay can read the archive.
 *
 * `options.hot` is the one hint this class gives its source, and it is the
 * difference between one storage read per map pan and four. A header, a root
 * directory and a leaf directory are read by EVERY request that lands in their
 * region and are worth memoising at the edge; a tile body is read once and
 * handed to one browser, and is cached as a RESPONSE instead. Flagging it here
 * rather than guessing from the length keeps the caching policy a decision
 * somebody made rather than a threshold somebody tuned.
 */
export class PMTiles {
  /**
   * @param source the byte source (`read(offset, length, { hot })`).
   * @param options.memo a {@link DirectoryMemo} that outlives this reader — the
   *   Worker keeps one per isolate, so a warm isolate reads an archive's header
   *   and directories once, not once per tile.
   * @param options.name the archive's identity in the memo (its object key).
   */
  constructor(source, options = {}) {
    this.source = source;
    this.memo = options.memo ?? null;
    this.name = options.name ?? '';
    this.headerPromise = null;
  }

  /**
   * The parsed header and the decoded root directory, from the memo when it
   * has them. The root's bytes are not kept: a warm isolate needs only the
   * decoded form.
   */
  async open() {
    if (!this.headerPromise && this.memo) {
      const remembered = this.memo.get(`${this.name}|header`);
      if (remembered) this.headerPromise = Promise.resolve(remembered);
    }
    if (!this.headerPromise) {
      this.headerPromise = (async () => {
        const head = await this.source.read(0, INITIAL_READ_BYTES, { hot: true });
        const header = readHeader(head);
        const end = header.rootDirOffset + header.rootDirLength;
        const rootBytes =
          end <= head.length
            ? head.subarray(header.rootDirOffset, end)
            : await this.source.read(header.rootDirOffset, header.rootDirLength, { hot: true });
        const root = decodeDirectoryCompact(
          await decompress(rootBytes, header.internalCompression),
        );
        const opened = { header, root };
        // The header object is small; the root is counted at 24 B an entry.
        this.memo?.set(`${this.name}|header`, opened, root.bytes + 512);
        return opened;
      })();
    }
    return this.headerPromise;
  }

  /** A leaf directory, decoded once per memo. */
  async leaf(offset, length) {
    const key = `${this.name}|leaf@${offset}`;
    const remembered = this.memo?.get(key);
    if (remembered) return remembered;
    const { header } = await this.open();
    const bytes = await this.source.read(offset, length, { hot: true });
    const directory = decodeDirectoryCompact(await decompress(bytes, header.internalCompression));
    this.memo?.set(key, directory, directory.bytes);
    return directory;
  }

  /** The parsed header alone. */
  async header() {
    return (await this.open()).header;
  }

  /** The archive's TileJSON-ish metadata, as the writer left it. */
  async metadata() {
    const { header } = await this.open();
    const raw = await this.source.read(header.metadataOffset, header.metadataLength, { hot: true });
    const json = await decompress(raw, header.internalCompression);
    return JSON.parse(new TextDecoder().decode(json));
  }

  /**
   * The stored bytes for one tile, or `null` when the archive has no such tile.
   *
   * `null` is the normal answer, not an error: an OpenMapTiles build omits
   * every tile that would be empty — mid-ocean, empty desert — and MapLibre
   * treats a missing tile as an empty one. A reader that threw here would turn
   * the Atlantic into an incident.
   */
  async getTile(z, x, y) {
    const { header, root } = await this.open();
    if (z < header.minZoom || z > header.maxZoom) return null;

    const tileId = zxyToTileId(z, x, y);
    let directory = root;

    for (let depth = 0; depth < MAX_DIRECTORY_DEPTH; depth += 1) {
      const index = findEntryCompact(directory, tileId);
      if (index < 0) return null;
      if (directory.runLengths[index] > 0) {
        const bytes = await this.source.read(
          header.tileDataOffset + directory.offsets[index],
          directory.lengths[index],
          { hot: false },
        );
        return { bytes, compression: header.tileCompression, type: header.tileType };
      }
      directory = await this.leaf(
        header.leafDirsOffset + directory.offsets[index],
        directory.lengths[index],
      );
    }
    throw new Error(`tile ${z}/${x}/${y} is nested deeper than ${MAX_DIRECTORY_DEPTH} directories`);
  }
}

/**
 * What a warm isolate remembers about the archives it reads — each one's
 * header with its decoded root, and decoded leaf directories — bounded by
 * BYTES, least recently used out first.
 *
 * Bytes, not entries, because entries differ by a factor of four: a planet
 * leaf is 17,685 entries (424 kB compact), a city leaf 4,096 (98 kB). A value
 * larger than the whole budget is not kept at all; the edge cache still has
 * its bytes.
 */
export class DirectoryMemo {
  constructor(maxBytes) {
    this.maxBytes = maxBytes;
    this.bytes = 0;
    this.entries = new Map();
  }

  get(key) {
    const slot = this.entries.get(key);
    if (slot === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, slot);
    return slot.value;
  }

  set(key, value, bytes) {
    this.delete(key);
    if (!(bytes <= this.maxBytes)) return;
    this.entries.set(key, { value, bytes });
    this.bytes += bytes;
    while (this.bytes > this.maxBytes) {
      const [oldest, slot] = this.entries.entries().next().value;
      this.entries.delete(oldest);
      this.bytes -= slot.bytes;
    }
  }

  delete(key) {
    const slot = this.entries.get(key);
    if (slot === undefined) return;
    this.entries.delete(key);
    this.bytes -= slot.bytes;
  }

  clear() {
    this.entries.clear();
    this.bytes = 0;
  }

  get size() {
    return this.entries.size;
  }
}
