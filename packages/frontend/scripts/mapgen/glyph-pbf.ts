/**
 * `glyphs.proto` — the Mapbox/MapLibre glyph range format — encoded and decoded.
 *
 * ```proto
 * message glyph {
 *   required uint32 id     = 1;
 *   optional bytes  bitmap = 2;   // SDF alpha, (width+6)*(height+6), row-major
 *   required uint32 width  = 3;   // ink width, WITHOUT the 3px buffer
 *   required uint32 height = 4;   // ink height, WITHOUT the 3px buffer
 *   required sint32 left   = 5;
 *   required sint32 top    = 6;
 *   required uint32 advance = 7;
 * }
 * message fontstack { required string name = 1; required string range = 2; repeated glyph glyphs = 3; }
 * message glyphs    { repeated fontstack stacks = 1; }
 * ```
 *
 * ## The two invariants that are not in the schema
 *
 * The schema cannot express either of the rules that actually matter, so they
 * are asserted here instead:
 *
 *  1. **`bitmap.length === (width + 6) * (height + 6)`.** MapLibre does not
 *     validate this. `GlyphManager` copies the bytes into the atlas using
 *     `width + 2 * GLYPH_PBF_BORDER` as the stride, so a bitmap one byte short
 *     does not throw — it shears every subsequent row by one pixel and the
 *     label renders as diagonal mush. The `6` is `2 * 3`: three pixels of
 *     buffer on each side, and MapLibre's `GLYPH_PBF_BORDER` is hard-coded to
 *     3, so this number is not ours to choose.
 *  2. **A blank glyph carries no bitmap at all.** `width = height = 0` with an
 *     omitted `bitmap` is how a space is spelled. Emitting a zero-length
 *     bitmap instead is legal protobuf and makes MapLibre allocate a 6x6
 *     atlas entry for every space in every label.
 *
 * ## Why a decoder ships alongside the encoder
 *
 * Not for the runtime — nothing in the app reads these. It exists so the build
 * script can (a) round-trip its own output and (b) decode a file produced by
 * Mapbox's `sdf-glyph-foundry` off OpenFreeMap. A decoder that reads a
 * third-party file written by the reference implementation is the only
 * available proof that our field numbers and wire types are right, short of
 * deploying and looking at a map.
 */
import { PbfReader, PbfWriter, WIRE_LENGTH_DELIMITED, WIRE_VARINT } from './protobuf';

/** MapLibre's `GLYPH_PBF_BORDER`. Not a tunable: the shaders assume it. */
export const GLYPH_PBF_BORDER = 3;

/** One glyph's SDF and metrics, in the 24px em space the format is defined in. */
export interface MapGlyph {
  /** The Unicode code point. Mapbox calls it `id`; it is not a glyph index. */
  id: number;
  /** `(width + 6) * (height + 6)` alpha bytes, or `undefined` for whitespace. */
  bitmap?: Uint8Array;
  width: number;
  height: number;
  left: number;
  top: number;
  advance: number;
}

/** One `fontstack` entry: a named stack's glyphs for one 256-codepoint range. */
export interface MapFontstack {
  /** e.g. `Inter Medium` — matched verbatim against a style's `text-font`. */
  name: string;
  /** e.g. `0-255`. Must agree with the filename or MapLibre caches it wrong. */
  range: string;
  glyphs: MapGlyph[];
}

/** Throw unless the glyph obeys the two invariants above. */
export function assertGlyphConsistent(glyph: MapGlyph, where: string): void {
  const blank = glyph.width === 0 && glyph.height === 0;
  if (blank) {
    if (glyph.bitmap !== undefined) {
      throw new Error(`${where}: blank glyph ${glyph.id} carries a bitmap; whitespace must omit it entirely`);
    }
    return;
  }
  if (glyph.bitmap === undefined) {
    throw new Error(`${where}: glyph ${glyph.id} is ${glyph.width}x${glyph.height} but carries no bitmap`);
  }
  const expected = (glyph.width + 2 * GLYPH_PBF_BORDER) * (glyph.height + 2 * GLYPH_PBF_BORDER);
  if (glyph.bitmap.length !== expected) {
    throw new Error(
      `${where}: glyph ${glyph.id} bitmap is ${glyph.bitmap.length} bytes, expected ${expected} ` +
        `((${glyph.width}+6)*(${glyph.height}+6))`,
    );
  }
}

/**
 * Encode one or more fontstacks into a `.pbf` range file.
 *
 * Glyphs are emitted in ascending `id` order regardless of the order given, so
 * the output is a pure function of the glyph set. Determinism is the whole
 * point of committing these files: `--check` compares bytes.
 */
export function encodeGlyphs(stacks: readonly MapFontstack[]): Uint8Array {
  const writer = new PbfWriter(1 << 16);
  for (const stack of stacks) {
    writer.writeMessageField(1, (stackWriter) => {
      stackWriter.writeStringField(1, stack.name);
      stackWriter.writeStringField(2, stack.range);
      const ordered = [...stack.glyphs].sort((a, b) => a.id - b.id);
      for (const glyph of ordered) {
        assertGlyphConsistent(glyph, `encodeGlyphs(${stack.name} ${stack.range})`);
        stackWriter.writeMessageField(3, (glyphWriter) => {
          glyphWriter.writeUint32Field(1, glyph.id);
          if (glyph.bitmap !== undefined) glyphWriter.writeBytesField(2, glyph.bitmap);
          glyphWriter.writeUint32Field(3, glyph.width);
          glyphWriter.writeUint32Field(4, glyph.height);
          glyphWriter.writeSint32Field(5, glyph.left);
          glyphWriter.writeSint32Field(6, glyph.top);
          glyphWriter.writeUint32Field(7, glyph.advance);
        });
      }
    });
  }
  return writer.finish();
}

function decodeGlyph(reader: PbfReader): MapGlyph {
  const glyph: MapGlyph = { id: 0, width: 0, height: 0, left: 0, top: 0, advance: 0 };
  while (!reader.atEnd) {
    const { field, wireType } = reader.readTag();
    switch (field) {
      case 1:
        glyph.id = reader.readVarint();
        break;
      case 2:
        // Copied, not aliased: the caller may outlive the source buffer.
        glyph.bitmap = new Uint8Array(reader.readBytes());
        break;
      case 3:
        glyph.width = reader.readVarint();
        break;
      case 4:
        glyph.height = reader.readVarint();
        break;
      case 5:
        glyph.left = reader.readSint32();
        break;
      case 6:
        glyph.top = reader.readSint32();
        break;
      case 7:
        glyph.advance = reader.readVarint();
        break;
      default:
        reader.skip(wireType);
    }
    void WIRE_VARINT;
    void WIRE_LENGTH_DELIMITED;
  }
  return glyph;
}

function decodeFontstack(reader: PbfReader): MapFontstack {
  const stack: MapFontstack = { name: '', range: '', glyphs: [] };
  while (!reader.atEnd) {
    const { field, wireType } = reader.readTag();
    switch (field) {
      case 1:
        stack.name = reader.readString();
        break;
      case 2:
        stack.range = reader.readString();
        break;
      case 3:
        stack.glyphs.push(reader.readMessage(decodeGlyph));
        break;
      default:
        reader.skip(wireType);
    }
  }
  return stack;
}

/** Parse a `.pbf` range file, ours or anybody's. */
export function decodeGlyphs(data: Uint8Array): MapFontstack[] {
  const reader = new PbfReader(data);
  const stacks: MapFontstack[] = [];
  while (!reader.atEnd) {
    const { field, wireType } = reader.readTag();
    if (field === 1) stacks.push(reader.readMessage(decodeFontstack));
    else reader.skip(wireType);
  }
  return stacks;
}

/** The `<start>-<end>` name of the 256-codepoint range a code point falls in. */
export function rangeNameFor(codePoint: number): string {
  const start = Math.floor(codePoint / 256) * 256;
  return `${start}-${start + 255}`;
}
