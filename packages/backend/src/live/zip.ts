/**
 * Read named files out of a ZIP archive — the static GTFS a transit operator
 * publishes. Only what GoWay needs: the central directory, stored and deflated
 * entries (ZIP64 sizes included), and nothing streamed. A GTFS zip's `stop_times.txt` is often the
 * bulk of it (Renfe's is 247 MB inflated); it is never inflated here unless
 * asked for by name.
 *
 * Bounds-checked: a truncated or malformed archive throws `ZipError` rather
 * than returning half a file.
 *
 * A big network's archive need not be downloaded to read its `routes.txt`:
 * {@link readZipEntriesRanged} asks for the directory and the named files'
 * bytes with HTTP ranges (the Netherlands' 259 MB file costs ~1 MB), and
 * falls back to the whole archive from a server that ignores ranges.
 */

import { inflateRawSync } from 'node:zlib';

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipError';
  }
}

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
const ZIP64 = 0xffff_ffff;

/** The largest single file inflated, a guard against a zip bomb. */
export const MAX_INFLATED_BYTES = 256 * 1024 * 1024;

/** A central-directory entry: where a file's bytes are, and how they are stored. */
interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

function reader(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    u32: (at: number) => {
      if (at < 0 || at + 4 > bytes.byteLength) throw new ZipError('truncated archive');
      return view.getUint32(at, true);
    },
    u16: (at: number) => {
      if (at < 0 || at + 2 > bytes.byteLength) throw new ZipError('truncated archive');
      return view.getUint16(at, true);
    },
  };
}

/** The end-of-central-directory record: in the last 64 KB + 22 bytes. */
function endOfDirectory(tail: Uint8Array): { count: number; size: number; offset: number } {
  const { u16, u32 } = reader(tail);
  for (let at = tail.byteLength - 22; at >= Math.max(0, tail.byteLength - 65_557); at--) {
    if (u32(at) === END_OF_CENTRAL_DIRECTORY)
      return { count: u16(at + 10), size: u32(at + 12), offset: u32(at + 16) };
  }
  throw new ZipError('not a zip archive');
}

/** The entries of a central directory (`bytes` starts at its first header). */
function directoryEntries(bytes: Uint8Array, count: number): ZipEntry[] {
  const { u16, u32 } = reader(bytes);
  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];
  let at = 0;
  for (let index = 0; index < count; index++) {
    if (u32(at) !== CENTRAL_FILE_HEADER) throw new ZipError('bad central directory');
    const method = u16(at + 10);
    let compressedSize = u32(at + 20);
    let size = u32(at + 24);
    const nameLength = u16(at + 28);
    const extraLength = u16(at + 30);
    const commentLength = u16(at + 32);
    let localOffset = u32(at + 42);
    if (at + 46 + nameLength > bytes.byteLength) throw new ZipError('truncated archive');
    const fullName = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    // A ZIP64 writer (Nice's GTFS) puts 0xFFFFFFFF in the header and the real
    // sizes in the extra field's 0x0001 record, each 8 bytes, in this order
    // and only for the values it overflowed.
    if (size === ZIP64 || compressedSize === ZIP64 || localOffset === ZIP64) {
      let extra = at + 46 + nameLength;
      const extraEnd = extra + extraLength;
      while (extra + 4 <= extraEnd) {
        const id = u16(extra);
        const length = u16(extra + 2);
        if (id === 0x0001) {
          let field = extra + 4;
          const u64 = () => {
            const value = u32(field) + u32(field + 4) * 0x1_0000_0000;
            field += 8;
            return value;
          };
          if (size === ZIP64) size = u64();
          if (compressedSize === ZIP64) compressedSize = u64();
          if (localOffset === ZIP64) localOffset = u64();
          break;
        }
        extra += 4 + length;
      }
    }
    // GTFS zips sometimes nest the files in a folder.
    entries.push({
      name: fullName.split('/').pop() ?? fullName,
      method,
      compressedSize,
      size,
      localOffset,
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** One entry's bytes, from a buffer holding its local header at `base`. */
function entryData(entry: ZipEntry, bytes: Uint8Array, base: number): Uint8Array {
  if (entry.size > MAX_INFLATED_BYTES) throw new ZipError(`${entry.name} is too large`);
  const { u16, u32 } = reader(bytes);
  if (u32(base) !== LOCAL_FILE_HEADER) throw new ZipError('bad local header');
  const dataStart = base + 30 + u16(base + 26) + u16(base + 28);
  if (dataStart + entry.compressedSize > bytes.byteLength) throw new ZipError('truncated entry');
  const data = bytes.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.method === 0) return data;
  if (entry.method === 8)
    return new Uint8Array(inflateRawSync(data, { maxOutputLength: MAX_INFLATED_BYTES }));
  throw new ZipError(`unsupported compression ${entry.method} for ${entry.name}`);
}

export function readZipEntries(
  bytes: Uint8Array,
  wanted: readonly string[],
): Map<string, Uint8Array> {
  const end = endOfDirectory(bytes);
  if (end.offset > bytes.byteLength) throw new ZipError('truncated archive');
  const want = new Set(wanted);
  const out = new Map<string, Uint8Array>();
  for (const entry of directoryEntries(bytes.subarray(end.offset), end.count)) {
    if (want.has(entry.name)) out.set(entry.name, entryData(entry, bytes, entry.localOffset));
  }
  return out;
}

/**
 * The answer to one ranged GET: the bytes, and whether the server honoured
 * the range (`206`) — a server that did not sent the whole archive.
 */
export interface ZipRange {
  bytes: Uint8Array;
  partial: boolean;
}

/** `range` is an HTTP `Range` value: `bytes=-N` (the last N) or `bytes=A-B`. */
export type ZipRangeReader = (range: string) => Promise<ZipRange>;

/**
 * The named files of a remote archive, read by range: the tail (for the
 * directory's address), the directory, then each wanted file. A server that
 * ignores ranges answers the first request with the whole archive, which is
 * then read as such.
 */
export async function readZipEntriesRanged(
  read: ZipRangeReader,
  wanted: readonly string[],
): Promise<Map<string, Uint8Array>> {
  const tail = await read('bytes=-65557');
  if (!tail.partial) return readZipEntries(tail.bytes, wanted);
  const end = endOfDirectory(tail.bytes);
  if (end.offset === ZIP64 || end.count === 0xffff)
    throw new ZipError('a ZIP64 directory is not read by range');
  const directory = (await read(`bytes=${end.offset}-${end.offset + end.size - 1}`)).bytes;
  const want = new Set(wanted);
  const out = new Map<string, Uint8Array>();
  for (const entry of directoryEntries(directory, end.count)) {
    if (!want.has(entry.name)) continue;
    if (entry.size > MAX_INFLATED_BYTES) throw new ZipError(`${entry.name} is too large`);
    // The local header's name and extra field may differ from the
    // directory's: ask for the most they can be.
    const last = entry.localOffset + 30 + 2 * 65_535 + entry.compressedSize - 1;
    const local = await read(`bytes=${entry.localOffset}-${last}`);
    out.set(entry.name, entryData(entry, local.bytes, 0));
  }
  return out;
}
