/**
 * Reading a RAD header — Spark's level-of-detail splat format — without Spark.
 *
 * A RAD file starts with a small header: the magic `RAD0` (u32 little-endian
 * `0x30444152`), the byte length of a JSON metadata block (u32 little-endian),
 * that JSON, then zero padding to an 8-byte boundary. Chunk data starts there
 * (`chunksStart`). The JSON's `chunks` list says where every chunk lives:
 *
 *   - without `filename`, at `chunksStart + offset` inside the header file;
 *   - with `filename`, in a separate `.radc` file BESIDE the header, read
 *     whole (`offset` 0, `bytes` its size), which starts with `RADC`
 *     (`0x43444152`).
 *
 * This is the layout Spark 2.3.1 writes (`rust/spark-lib/src/rad.rs`,
 * `encode_with_chunks`) and decodes (`decode_rad_header`); Spark's viewer reads
 * the header from the first 64 KiB–1 MiB of the file, so a header that does
 * not fit in {@link MAX_RAD_HEADER_BYTES} is refused here as Spark would.
 *
 * The backend reads a header for one reason: before an operator publishes a
 * chunked tree, every chunk the header names must exist, be the size the header
 * says, start like a chunk, and be a plain file name that resolves beside the
 * header — the same rule the viewer applies (`radChunksAllowed`). Nothing here
 * decodes splats.
 */

import { z } from 'zod';

export const RAD_MAGIC = 0x30444152;
export const RAD_CHUNK_MAGIC = 0x43444152;

/** Spark's own ceiling for a header read: it gives up after 1 MiB. */
export const MAX_RAD_HEADER_BYTES = 1024 * 1024;

/**
 * A chunk file name a viewer resolves beside its header: one path segment, no
 * dot-segments, no separators, ending `.radc` (Spark writes `<prefix><n>.radc`).
 */
export const RAD_CHUNK_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.radc$/;

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

const radChunkSchema = z.object({
  offset: count,
  bytes: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  filename: z.string().optional(),
});

/** The fields of Spark's `RadMeta` the backend reads. Unknown fields are kept out, not refused. */
const radMetaSchema = z.object({
  version: count,
  type: z.string().min(1),
  /** Gaussians in the file, every level of the tree included. */
  count,
  chunks: z.array(radChunkSchema).min(1),
});
export type RadMeta = z.infer<typeof radMetaSchema>;
export type RadChunk = RadMeta['chunks'][number];

export interface RadHeader {
  meta: RadMeta;
  /** Byte offset in the header file where inline chunk data begins. */
  chunksStart: number;
}

/** Why a RAD header was refused. The message names no path and no byte. */
export class RadHeaderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RadHeaderError';
  }
}

const roundUp8 = (size: number): number => (size + 7) & ~7;

/**
 * Parse the header at the start of `bytes` (at least the first
 * {@link MAX_RAD_HEADER_BYTES} of the file, or all of it when shorter).
 *
 * @throws {RadHeaderError} When the magic, the length or the metadata is not a
 *   RAD header, or a chunk name could not resolve beside the header.
 */
export function parseRadHeader(bytes: Uint8Array): RadHeader {
  if (bytes.byteLength < 8) throw new RadHeaderError('The file is too short to be a RAD.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== RAD_MAGIC) throw new RadHeaderError('The file is not a RAD.');
  const length = view.getUint32(4, true);
  if (8 + length > Math.min(bytes.byteLength, MAX_RAD_HEADER_BYTES)) {
    throw new RadHeaderError('The RAD metadata is truncated or larger than a viewer reads.');
  }
  let json: unknown;
  try {
    json = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(8, 8 + length)),
    );
  } catch {
    throw new RadHeaderError('The RAD metadata is not JSON.');
  }
  const parsed = radMetaSchema.safeParse(json);
  if (!parsed.success) throw new RadHeaderError('The RAD metadata is not a RAD header.');
  const names = new Set<string>();
  for (const chunk of parsed.data.chunks) {
    if (chunk.filename === undefined) continue;
    if (!RAD_CHUNK_FILENAME.test(chunk.filename) || chunk.filename.includes('..')) {
      throw new RadHeaderError('A RAD chunk name would not resolve beside its header.');
    }
    if (chunk.offset !== 0) throw new RadHeaderError('A RAD chunk file is read whole, from 0.');
    if (names.has(chunk.filename)) throw new RadHeaderError('A RAD chunk name is listed twice.');
    names.add(chunk.filename);
  }
  return { meta: parsed.data, chunksStart: 8 + roundUp8(length) };
}

/** The chunks that live in their own files, in header order. */
export function chunkFiles(header: RadHeader): (RadChunk & { filename: string })[] {
  return header.meta.chunks.filter(
    (chunk): chunk is RadChunk & { filename: string } => chunk.filename !== undefined,
  );
}

/**
 * Whether the header file itself holds every inline chunk it lists: each
 * `chunksStart + offset + bytes` within its size.
 */
export function inlineChunksFit(header: RadHeader, headerByteSize: number): boolean {
  return header.meta.chunks.every(
    (chunk) =>
      chunk.filename !== undefined ||
      header.chunksStart + chunk.offset + chunk.bytes <= headerByteSize,
  );
}

/** Whether `prefix` (the first bytes of a chunk file) starts like a RAD chunk. */
export function isRadChunk(prefix: Uint8Array): boolean {
  return (
    prefix.byteLength >= 4 &&
    new DataView(prefix.buffer, prefix.byteOffset, 4).getUint32(0, true) === RAD_CHUNK_MAGIC
  );
}
