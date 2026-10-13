/**
 * Read named files out of a ZIP archive — the static GTFS a transit operator
 * publishes. Only what GoWay needs: the central directory, stored and deflated
 * entries, and nothing streamed. A GTFS zip's `stop_times.txt` is often the
 * bulk of it (Renfe's is 247 MB inflated); it is never inflated here unless
 * asked for by name.
 *
 * Bounds-checked: a truncated or malformed archive throws `ZipError` rather
 * than returning half a file.
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

/** The largest single file inflated, a guard against a zip bomb. */
export const MAX_INFLATED_BYTES = 256 * 1024 * 1024;

/** One file listed in the central directory. */
interface CentralEntry {
  /** Its name without any folder. */
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

/** The entries of a central directory held in `bytes` from `start`, `count` of them. */
function centralEntries(bytes: Uint8Array, start: number, count: number): CentralEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u32 = (at: number) => {
    if (at + 4 > bytes.byteLength) throw new ZipError('truncated archive');
    return view.getUint32(at, true);
  };
  const u16 = (at: number) => {
    if (at + 2 > bytes.byteLength) throw new ZipError('truncated archive');
    return view.getUint16(at, true);
  };
  const decoder = new TextDecoder();
  const entries: CentralEntry[] = [];
  let at = start;
  for (let index = 0; index < count; index++) {
    if (u32(at) !== CENTRAL_FILE_HEADER) throw new ZipError('bad central directory');
    const nameLength = u16(at + 28);
    const extraLength = u16(at + 30);
    const commentLength = u16(at + 32);
    if (at + 46 + nameLength > bytes.byteLength) throw new ZipError('truncated archive');
    const fullName = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    entries.push({
      // GTFS zips sometimes nest the files in a folder.
      name: fullName.split('/').pop() ?? fullName,
      method: u16(at + 10),
      compressedSize: u32(at + 20),
      size: u32(at + 24),
      localOffset: u32(at + 42),
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** The end-of-central-directory record in `tail`: how many entries, and where their directory is. */
function endOfCentralDirectory(tail: Uint8Array): { count: number; size: number; offset: number } {
  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  for (let at = tail.byteLength - 22; at >= Math.max(0, tail.byteLength - 65_557); at--) {
    if (view.getUint32(at, true) === END_OF_CENTRAL_DIRECTORY) {
      return {
        count: view.getUint16(at + 10, true),
        size: view.getUint32(at + 12, true),
        offset: view.getUint32(at + 16, true),
      };
    }
  }
  throw new ZipError('not a zip archive');
}

/** One entry's bytes, from the compressed data (`method` 0 stored, 8 deflated). */
function unpack(entry: CentralEntry, data: Uint8Array): Uint8Array {
  if (entry.method === 0) return data;
  if (entry.method === 8) {
    return new Uint8Array(inflateRawSync(data, { maxOutputLength: MAX_INFLATED_BYTES }));
  }
  throw new ZipError(`unsupported compression ${entry.method} for ${entry.name}`);
}

export function readZipEntries(
  bytes: Uint8Array,
  wanted: readonly string[],
): Map<string, Uint8Array> {
  const { count, offset } = endOfCentralDirectory(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u32 = (at: number) => {
    if (at + 4 > bytes.byteLength) throw new ZipError('truncated archive');
    return view.getUint32(at, true);
  };
  const u16 = (at: number) => {
    if (at + 2 > bytes.byteLength) throw new ZipError('truncated archive');
    return view.getUint16(at, true);
  };
  const want = new Set(wanted);
  const out = new Map<string, Uint8Array>();
  for (const entry of centralEntries(bytes, offset, count)) {
    if (!want.has(entry.name)) continue;
    if (entry.size > MAX_INFLATED_BYTES) throw new ZipError(`${entry.name} is too large`);
    if (u32(entry.localOffset) !== LOCAL_FILE_HEADER) throw new ZipError('bad local header');
    const dataStart =
      entry.localOffset + 30 + u16(entry.localOffset + 26) + u16(entry.localOffset + 28);
    if (dataStart + entry.compressedSize > bytes.byteLength) throw new ZipError('truncated entry');
    out.set(entry.name, unpack(entry, bytes.subarray(dataStart, dataStart + entry.compressedSize)));
  }
  return out;
}

/**
 * A remote archive read by byte range: its length, and any slice of it.
 * `end` is inclusive, as in an HTTP `Range` header.
 */
export interface RangeSource {
  size: number;
  read(start: number, end: number): Promise<Uint8Array>;
}

/** What a ranged read leaves out, and why, so a caller can say so. */
export interface RangedZip {
  entries: Map<string, Uint8Array>;
  /** Wanted files that were listed but larger than their limit, by name. */
  skipped: Map<string, number>;
}

/**
 * Named files out of a remote zip, fetching only the central directory and
 * those files' bytes: a 533 MB archive whose `routes.txt` is 59 KB costs two
 * small requests and 59 KB, where reading it whole costs 533 MB in memory.
 *
 * A file inflated past `limitOf(name)` is SKIPPED and reported, not read —
 * for the files whose absence only costs detail (`shapes.txt` of 2.3 GB). A file
 * that is missing altogether is not an error here either: the caller decides
 * which ones it cannot do without.
 */
export async function readZipEntriesRanged(
  source: RangeSource,
  wanted: readonly string[],
  limitOf: (name: string) => number = () => MAX_INFLATED_BYTES,
): Promise<RangedZip> {
  const tailLength = Math.min(source.size, 65_557);
  const tail = await source.read(source.size - tailLength, source.size - 1);
  const { count, size, offset } = endOfCentralDirectory(tail);
  if (offset + size > source.size) throw new ZipError('truncated archive');
  const directory = await source.read(offset, offset + size - 1);
  const want = new Set(wanted);
  const entries = new Map<string, Uint8Array>();
  const skipped = new Map<string, number>();
  for (const entry of centralEntries(directory, 0, count)) {
    if (!want.has(entry.name)) continue;
    if (entry.size > limitOf(entry.name)) {
      skipped.set(entry.name, entry.size);
      continue;
    }
    const header = await source.read(entry.localOffset, entry.localOffset + 29);
    const headerView = new DataView(header.buffer, header.byteOffset, header.byteLength);
    if (header.byteLength < 30 || headerView.getUint32(0, true) !== LOCAL_FILE_HEADER) {
      throw new ZipError('bad local header');
    }
    const dataStart =
      entry.localOffset + 30 + headerView.getUint16(26, true) + headerView.getUint16(28, true);
    const data = await source.read(dataStart, dataStart + entry.compressedSize - 1);
    if (data.byteLength !== entry.compressedSize) throw new ZipError('truncated entry');
    entries.set(entry.name, unpack(entry, data));
  }
  return { entries, skipped };
}
