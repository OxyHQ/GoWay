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

export function readZipEntries(
  bytes: Uint8Array,
  wanted: readonly string[],
): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u32 = (at: number) => {
    if (at + 4 > bytes.byteLength) throw new ZipError('truncated archive');
    return view.getUint32(at, true);
  };
  const u16 = (at: number) => {
    if (at + 2 > bytes.byteLength) throw new ZipError('truncated archive');
    return view.getUint16(at, true);
  };

  // The end-of-central-directory record is in the last 64 KB + 22 bytes.
  let end = -1;
  for (let at = bytes.byteLength - 22; at >= Math.max(0, bytes.byteLength - 65_557); at--) {
    if (u32(at) === END_OF_CENTRAL_DIRECTORY) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new ZipError('not a zip archive');
  const count = u16(end + 10);
  let at = u32(end + 16);

  const want = new Set(wanted);
  const out = new Map<string, Uint8Array>();
  const decoder = new TextDecoder();
  for (let index = 0; index < count; index++) {
    if (u32(at) !== CENTRAL_FILE_HEADER) throw new ZipError('bad central directory');
    const method = u16(at + 10);
    const compressedSize = u32(at + 20);
    const size = u32(at + 24);
    const nameLength = u16(at + 28);
    const extraLength = u16(at + 30);
    const commentLength = u16(at + 32);
    const localOffset = u32(at + 42);
    if (at + 46 + nameLength > bytes.byteLength) throw new ZipError('truncated archive');
    const fullName = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    // GTFS zips sometimes nest the files in a folder.
    const name = fullName.split('/').pop() ?? fullName;
    at += 46 + nameLength + extraLength + commentLength;
    if (!want.has(name)) continue;
    if (size > MAX_INFLATED_BYTES) throw new ZipError(`${name} is too large`);
    if (u32(localOffset) !== LOCAL_FILE_HEADER) throw new ZipError('bad local header');
    const dataStart = localOffset + 30 + u16(localOffset + 26) + u16(localOffset + 28);
    if (dataStart + compressedSize > bytes.byteLength) throw new ZipError('truncated entry');
    const data = bytes.subarray(dataStart, dataStart + compressedSize);
    if (method === 0) out.set(name, data);
    else if (method === 8)
      out.set(name, new Uint8Array(inflateRawSync(data, { maxOutputLength: MAX_INFLATED_BYTES })));
    else throw new ZipError(`unsupported compression ${method} for ${name}`);
  }
  return out;
}
