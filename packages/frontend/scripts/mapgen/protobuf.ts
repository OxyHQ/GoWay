/**
 * A protobuf wire-format reader and writer, hand-rolled, ~200 lines.
 *
 * ## Why this is not `pbf`
 *
 * The only two schemas GoWay generates are `glyphs.proto` (three messages,
 * seven fields) and nothing else. Pulling `pbf` + `pbf-loader` + a `.proto`
 * compiler into the frontend's dependency tree — a tree that Metro bundles and
 * `expo export` ships — to serialise seven fields is a worse trade than owning
 * the 200 lines below. The wire format has been frozen since 2008; it will not
 * drift under us.
 *
 * ## What breaks silently if this is wrong
 *
 * Everything. A glyph PBF with a wrong field number does not fail to parse: the
 * reader skips the unknown field and returns a glyph with `width = 0`, which
 * MapLibre renders as an invisible label. A wrong wire type shifts the byte
 * cursor and the rest of the file decodes as garbage that still happens to
 * parse. Neither raises. That is why `build-map-glyphs.ts --check` decodes an
 * upstream file produced by Mapbox's own `sdf-glyph-foundry` with this reader:
 * if our field numbers were wrong, that file would not decode.
 *
 * ## The three wire types this needs
 *
 * `0` varint (uint32, sint32-after-zigzag), `2` length-delimited (bytes,
 * string, embedded message). Fixed32/fixed64 are not in `glyphs.proto`, but the
 * reader must still be able to *skip* them, because skipping an unknown field
 * requires knowing its length, and a reader that cannot skip is a reader that
 * corrupts on the first unknown field a future upstream version adds.
 */

/** Protobuf wire types. Only VARINT and LENGTH_DELIMITED appear in glyphs.proto. */
export const WIRE_VARINT = 0;
export const WIRE_FIXED64 = 1;
export const WIRE_LENGTH_DELIMITED = 2;
export const WIRE_FIXED32 = 5;

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

/**
 * An append-only protobuf encoder over a growable byte buffer.
 *
 * Embedded messages are encoded into their own writer and then copied in with a
 * length prefix. Encoding a sub-message into a scratch writer costs one copy
 * per message and removes the entire class of bug where a length prefix is
 * reserved, the body grows, and the prefix is never patched.
 */
export class PbfWriter {
  private buffer: Uint8Array;
  private length = 0;

  constructor(initialCapacity = 1024) {
    this.buffer = new Uint8Array(initialCapacity);
  }

  /** Bytes written so far, as a copy that the caller owns. */
  finish(): Uint8Array {
    return this.buffer.slice(0, this.length);
  }

  /** How many bytes are pending. Used by the sprite/glyph size reports. */
  get byteLength(): number {
    return this.length;
  }

  private reserve(extra: number): void {
    if (this.length + extra <= this.buffer.length) return;
    let capacity = this.buffer.length * 2;
    while (capacity < this.length + extra) capacity *= 2;
    const grown = new Uint8Array(capacity);
    grown.set(this.buffer.subarray(0, this.length));
    this.buffer = grown;
  }

  private writeByte(byte: number): void {
    this.reserve(1);
    this.buffer[this.length] = byte;
    this.length += 1;
  }

  /** Base-128 varint, little-endian groups, high bit as the continuation flag. */
  writeVarint(value: number): void {
    if (!Number.isInteger(value) || value < 0) {
      throw new RangeError(`varint must be a non-negative integer, got ${value}`);
    }
    let remaining = value;
    while (remaining > 0x7f) {
      this.writeByte((remaining & 0x7f) | 0x80);
      remaining = Math.floor(remaining / 128);
    }
    this.writeByte(remaining);
  }

  writeTag(field: number, wireType: number): void {
    this.writeVarint(field * 8 + wireType);
  }

  writeUint32Field(field: number, value: number): void {
    this.writeTag(field, WIRE_VARINT);
    this.writeVarint(value);
  }

  /**
   * `sint32`, i.e. varint over the zigzag transform `(n << 1) ^ (n >> 31)`.
   *
   * `left` and `top` are signed and routinely negative (a descender's `top` is
   * below the baseline; a `j`'s `left` is behind the pen). Encoding them as a
   * plain varint would make -1 a ten-byte number, and decoding a zigzag value
   * as a plain varint turns -3 into 5 — a glyph nudged five pixels sideways,
   * which looks like a kerning bug rather than an encoding bug.
   */
  writeSint32Field(field: number, value: number): void {
    this.writeTag(field, WIRE_VARINT);
    this.writeVarint((value << 1) ^ (value >> 31));
  }

  writeBytesField(field: number, value: Uint8Array): void {
    this.writeTag(field, WIRE_LENGTH_DELIMITED);
    this.writeVarint(value.length);
    this.reserve(value.length);
    this.buffer.set(value, this.length);
    this.length += value.length;
  }

  writeStringField(field: number, value: string): void {
    this.writeBytesField(field, new TextEncoder().encode(value));
  }

  /** Encode an embedded message and splice it in with its length prefix. */
  writeMessageField(field: number, encode: (writer: PbfWriter) => void): void {
    const nested = new PbfWriter(256);
    encode(nested);
    this.writeBytesField(field, nested.finish());
  }
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

/** One field header off the wire. */
export interface PbfTag {
  field: number;
  wireType: number;
}

/** A cursor over protobuf bytes. Bounds are checked; a short read throws. */
export class PbfReader {
  private readonly data: Uint8Array;
  private offset: number;
  private readonly end: number;

  constructor(data: Uint8Array, start = 0, end = data.length) {
    this.data = data;
    this.offset = start;
    this.end = end;
  }

  get atEnd(): boolean {
    return this.offset >= this.end;
  }

  readVarint(): number {
    let result = 0;
    let shift = 1;
    for (let i = 0; i < 10; i += 1) {
      if (this.offset >= this.end) throw new RangeError('truncated varint');
      const byte = this.data[this.offset];
      this.offset += 1;
      result += (byte & 0x7f) * shift;
      if ((byte & 0x80) === 0) return result;
      shift *= 128;
    }
    throw new RangeError('varint longer than 10 bytes');
  }

  readTag(): PbfTag {
    const key = this.readVarint();
    return { field: Math.floor(key / 8), wireType: key & 7 };
  }

  /** Undo the zigzag transform. */
  readSint32(): number {
    const raw = this.readVarint();
    return (raw >>> 1) ^ -(raw & 1);
  }

  readBytes(): Uint8Array {
    const length = this.readVarint();
    if (this.offset + length > this.end) throw new RangeError('truncated length-delimited field');
    const view = this.data.subarray(this.offset, this.offset + length);
    this.offset += length;
    return view;
  }

  readString(): string {
    return new TextDecoder().decode(this.readBytes());
  }

  /** Run `decode` over an embedded message's bytes and nothing else. */
  readMessage<T>(decode: (reader: PbfReader) => T): T {
    const length = this.readVarint();
    if (this.offset + length > this.end) throw new RangeError('truncated embedded message');
    const nested = new PbfReader(this.data, this.offset, this.offset + length);
    this.offset += length;
    return decode(nested);
  }

  /** Advance past a field this schema does not know. */
  skip(wireType: number): void {
    switch (wireType) {
      case WIRE_VARINT:
        this.readVarint();
        return;
      case WIRE_FIXED64:
        this.offset += 8;
        return;
      case WIRE_LENGTH_DELIMITED:
        this.readBytes();
        return;
      case WIRE_FIXED32:
        this.offset += 4;
        return;
      default:
        throw new RangeError(`unknown wire type ${wireType}`);
    }
  }
}
