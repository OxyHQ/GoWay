/**
 * The slice of protocol buffers the OpenStreetMap PBF format actually uses.
 *
 * ## Why this is hand-written rather than a dependency
 *
 * The container that runs the import is built by `bun install --production`,
 * so anything the importer needs is a RUNTIME dependency of the backend — the
 * same dependency tree the API server ships. `osmformat.proto` uses six wire
 * constructs (varint, zigzag varint, length-delimited bytes, packed repeated
 * fields, and two fixed widths it never reaches for), and a general protobuf
 * runtime would add a package, a build step and a schema file to decode them.
 * What is here is about a hundred lines and is exercised by round-tripping
 * against an encoder written in the test, so it is checked against something
 * that is not itself.
 *
 * ## Numbers are `number`, on purpose, and the bound is stated
 *
 * `osmformat.proto` declares ids as `int64`. JavaScript's `BigInt` would be the
 * literal reading and it is roughly an order of magnitude slower per value, on
 * a hot path that decodes billions of them. Every id this format carries is far
 * below `Number.MAX_SAFE_INTEGER` (2^53): the largest OSM node id in existence
 * is around 1.4 × 10^10, which is 2^34, and ids are allocated densely from
 * zero. {@link readVarint} therefore accumulates into a double and
 * {@link MAX_SAFE_VARINT_BYTES} caps how far it will read — a value that would
 * exceed the safe range raises instead of silently losing its low bits, which
 * is the failure mode a `>>>`-based decoder has and does not report.
 */

/**
 * Protobuf wire types. Only the three OSM uses are named; a field of any other
 * type is skipped by {@link skipField}, which still has to know their widths.
 */
export const WIRE_VARINT = 0;
export const WIRE_FIXED64 = 1;
export const WIRE_LENGTH_DELIMITED = 2;
export const WIRE_FIXED32 = 5;

/**
 * How many varint bytes may carry value bits before the result leaves the
 * double's exact-integer range.
 *
 * Eight groups of seven bits is 56 bits, which overshoots 2^53 — so the check
 * is on the accumulated VALUE rather than on the byte count alone, and the byte
 * count is the cheap guard that stops a malformed stream from spinning.
 */
const MAX_SAFE_VARINT_BYTES = 10;

/** A cursor over one decoded protobuf message. */
export interface Reader {
  readonly data: Uint8Array;
  /** Next byte to read. Mutated in place as the message is consumed. */
  pos: number;
  /** One past the last byte of THIS message — not of the buffer. */
  readonly end: number;
}

/** A cursor over `data[start, end)`. */
export function reader(data: Uint8Array, start = 0, end = data.length): Reader {
  return { data, pos: start, end };
}

/**
 * The next base-128 varint.
 *
 * Accumulates by MULTIPLICATION rather than by `<<`: JavaScript's bitwise
 * operators coerce to int32, so a shift past 31 bits wraps and the id of every
 * node above 2^31 — which is most of the planet — comes back wrong while
 * nothing anywhere fails.
 */
export function readVarint(read: Reader): number {
  let value = 0;
  let scale = 1;
  for (let byte = 0; byte < MAX_SAFE_VARINT_BYTES; byte += 1) {
    if (read.pos >= read.end) throw new Error('Truncated varint: the message ended mid-value.');
    const current = read.data[read.pos] as number;
    read.pos += 1;
    value += (current & 0x7f) * scale;
    if ((current & 0x80) === 0) {
      if (!Number.isSafeInteger(value)) {
        throw new Error(`Varint ${value} exceeds the exact-integer range this decoder supports.`);
      }
      return value;
    }
    scale *= 128;
  }
  throw new Error('Varint longer than 10 bytes: the stream is not protobuf.');
}

/**
 * The next zigzag-encoded signed varint (`sint32`/`sint64`).
 *
 * Zigzag maps -1 to 1, 1 to 2, -2 to 3 … so small negatives stay one byte. The
 * decode is `(n >>> 1) ^ -(n & 1)` in the reference implementations, which is
 * int32 arithmetic again — hence the division and the explicit sign.
 */
export function readSignedVarint(read: Reader): number {
  const value = readVarint(read);
  const magnitude = Math.floor(value / 2);
  return (value & 1) === 1 ? -magnitude - 1 : magnitude;
}

/** A field header: its number and its wire type. */
export interface FieldHeader {
  field: number;
  wire: number;
}

/** The next field header, or `null` at the end of the message. */
export function readFieldHeader(read: Reader): FieldHeader | null {
  if (read.pos >= read.end) return null;
  const tag = readVarint(read);
  return { field: Math.floor(tag / 8), wire: tag & 7 };
}

/** The bytes of a length-delimited field, as a view — never a copy. */
export function readBytes(read: Reader): Uint8Array {
  const length = readVarint(read);
  const start = read.pos;
  const end = start + length;
  if (end > read.end) throw new Error('Length-delimited field runs past the end of its message.');
  read.pos = end;
  return read.data.subarray(start, end);
}

/** A sub-message reader over a length-delimited field. */
export function readMessage(read: Reader): Reader {
  const bytes = readBytes(read);
  return reader(bytes);
}

/** A length-delimited field decoded as UTF-8. */
export function readString(read: Reader): string {
  return DECODER.decode(readBytes(read));
}

const DECODER = new TextDecoder('utf-8');

/** Step over a field whose value this decoder does not need. */
export function skipField(read: Reader, wire: number): void {
  switch (wire) {
    case WIRE_VARINT:
      readVarint(read);
      return;
    case WIRE_FIXED64:
      read.pos += 8;
      return;
    case WIRE_LENGTH_DELIMITED:
      readBytes(read);
      return;
    case WIRE_FIXED32:
      read.pos += 4;
      return;
    default:
      throw new Error(`Unsupported protobuf wire type ${wire}.`);
  }
}

/**
 * A packed repeated varint field, appended to `into`.
 *
 * Appending rather than returning a fresh array is what keeps a packed
 * `keys_vals` of a few hundred thousand entries from allocating one array per
 * block; the caller owns a scratch array and truncates it between uses.
 */
export function readPackedVarints(read: Reader, into: number[]): number[] {
  const bytes = readBytes(read);
  const packed = reader(bytes);
  while (packed.pos < packed.end) into.push(readVarint(packed));
  return into;
}

/** A packed repeated zigzag field, appended to `into`. See {@link readPackedVarints}. */
export function readPackedSignedVarints(read: Reader, into: number[]): number[] {
  const bytes = readBytes(read);
  const packed = reader(bytes);
  while (packed.pos < packed.end) into.push(readSignedVarint(packed));
  return into;
}
