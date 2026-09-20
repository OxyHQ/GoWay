/**
 * An 8-bit RGBA PNG encoder and decoder, ~250 lines, no dependencies.
 *
 * ## Why GoWay writes its own PNG
 *
 * The sprite atlas is the only raster this repo produces, and every library
 * that could produce it is either native (`sharp`, `canvas` — a compiler
 * toolchain in CI to lay out 35 icons) or a large pure-JS decoder built for
 * reading arbitrary PNGs off the internet. What is actually needed is one
 * narrow writer: 8-bit, truecolour-with-alpha, non-interlaced, one `IDAT`. The
 * PNG spec's own minimum. `node:zlib` supplies the only hard part.
 *
 * The decoder exists for the same reason `glyph-pbf.ts` has one: so the build
 * can re-read what it just wrote and prove the atlas coordinates in the JSON
 * actually locate the icons in the image.
 *
 * ## What breaks silently if this is wrong
 *
 * A malformed sprite PNG does not log. MapLibre hands the bytes to the browser
 * image decoder; a browser that rejects it leaves `ImageManager` with no
 * sprite, and every `icon-image` in the style resolves to nothing — the map
 * draws, the labels draw, and the icons are simply absent, with a single
 * "Image not found" console warning per icon id that most people never see. A
 * WRONG-but-valid PNG is worse: shift a scanline filter byte and every icon is
 * offset by a pixel, which reads as "the icons look a bit soft".
 *
 * ## Filtering
 *
 * Adaptive per-scanline, chosen by the minimum-sum-of-absolute-differences
 * heuristic from the PNG spec's own recommendation. On an SDF atlas this is
 * worth a lot — the field is smooth, so `Sub`/`Up` predict it well — and it is
 * fully deterministic, which matters because the output is committed and
 * `--check` compares bytes. Encoding always emits exactly one `IDAT`, so the
 * chunk layout cannot drift with zlib's internal buffering either.
 */
import { deflateSync, inflateSync } from 'node:zlib';

const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Truecolour with alpha. The only colour type this module reads or writes. */
const COLOR_TYPE_RGBA = 6;
const BIT_DEPTH_8 = 8;
const CHANNELS = 4;

/** An image as tightly-packed RGBA rows, top row first. */
export interface RgbaImage {
  width: number;
  height: number;
  /** `width * height * 4` bytes. */
  data: Uint8Array;
}

// ---------------------------------------------------------------------------
// CRC-32 (PNG's, i.e. the standard reflected polynomial 0xEDB88320)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Filter one scanline five ways and keep the cheapest.
 *
 * `previous` is the already-UNfiltered row above, as the spec requires —
 * filtering against the encoded bytes instead is the classic PNG encoder bug
 * that produces a file which decodes to noise in the second row onward.
 */
function filterScanline(row: Uint8Array, previous: Uint8Array | null, out: Uint8Array, outOffset: number): void {
  const bpp = CHANNELS;
  const length = row.length;
  const candidates = new Uint8Array(5 * length);
  const sums = [0, 0, 0, 0, 0];

  for (let i = 0; i < length; i += 1) {
    const raw = row[i];
    const left = i >= bpp ? row[i - bpp] : 0;
    const up = previous ? previous[i] : 0;
    const upLeft = previous && i >= bpp ? previous[i - bpp] : 0;

    const values = [
      raw,
      (raw - left) & 0xff,
      (raw - up) & 0xff,
      (raw - ((left + up) >> 1)) & 0xff,
      (raw - paeth(left, up, upLeft)) & 0xff,
    ];
    for (let f = 0; f < 5; f += 1) {
      candidates[f * length + i] = values[f];
      // The spec's heuristic treats bytes as signed for the purpose of the sum.
      sums[f] += values[f] < 128 ? values[f] : 256 - values[f];
    }
  }

  let best = 0;
  for (let f = 1; f < 5; f += 1) if (sums[f] < sums[best]) best = f;
  out[outOffset] = best;
  out.set(candidates.subarray(best * length, best * length + length), outOffset + 1);
}

/** Encode an RGBA image as a non-interlaced 8-bit PNG. */
export function encodePng(image: RgbaImage): Uint8Array {
  const { width, height, data } = image;
  if (width <= 0 || height <= 0) throw new Error(`refusing to encode a ${width}x${height} PNG`);
  const stride = width * CHANNELS;
  if (data.length !== stride * height) {
    throw new Error(`pixel buffer is ${data.length} bytes, expected ${stride * height}`);
  }

  const raw = new Uint8Array((stride + 1) * height);
  let previous: Uint8Array | null = null;
  for (let y = 0; y < height; y += 1) {
    const row = data.subarray(y * stride, (y + 1) * stride);
    filterScanline(row, previous, raw, y * (stride + 1));
    previous = row;
  }

  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width);
  ihdrView.setUint32(4, height);
  ihdr[8] = BIT_DEPTH_8;
  ihdr[9] = COLOR_TYPE_RGBA;
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter method: adaptive
  ihdr[12] = 0; // interlace: none

  const idat = new Uint8Array(deflateSync(raw, { level: 9 }));

  const parts = [PNG_SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const png = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    png.set(part, at);
    at += part.length;
  }
  return png;
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

/** Decode an 8-bit RGBA non-interlaced PNG. Anything else throws. */
export function decodePng(bytes: Uint8Array): RgbaImage {
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
    if (bytes[i] !== PNG_SIGNATURE[i]) throw new Error('not a PNG: signature mismatch');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = PNG_SIGNATURE.length;
  let width = 0;
  let height = 0;
  const idatParts: Uint8Array[] = [];

  while (at < bytes.length) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    const body = bytes.subarray(at + 8, at + 8 + length);
    const declared = view.getUint32(at + 8 + length);
    const actual = crc32(bytes.subarray(at + 4, at + 8 + length));
    if (declared !== actual) throw new Error(`chunk ${type} has a bad CRC`);

    if (type === 'IHDR') {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      if (body[8] !== BIT_DEPTH_8) throw new Error(`bit depth ${body[8]} is not supported`);
      if (body[9] !== COLOR_TYPE_RGBA) throw new Error(`colour type ${body[9]} is not supported`);
      if (body[12] !== 0) throw new Error('interlaced PNGs are not supported');
    } else if (type === 'IDAT') {
      idatParts.push(body);
    } else if (type === 'IEND') {
      break;
    }
    at += 12 + length;
  }

  if (width === 0 || height === 0) throw new Error('PNG has no IHDR');

  const compressed = new Uint8Array(idatParts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of idatParts) {
    compressed.set(part, offset);
    offset += part.length;
  }
  const raw = new Uint8Array(inflateSync(compressed));

  const stride = width * CHANNELS;
  if (raw.length !== (stride + 1) * height) {
    throw new Error(`inflated ${raw.length} bytes, expected ${(stride + 1) * height}`);
  }

  const data = new Uint8Array(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const rowIn = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const rowOut = data.subarray(y * stride, (y + 1) * stride);
    const above = y > 0 ? data.subarray((y - 1) * stride, y * stride) : null;

    for (let i = 0; i < stride; i += 1) {
      const left = i >= CHANNELS ? rowOut[i - CHANNELS] : 0;
      const up = above ? above[i] : 0;
      const upLeft = above && i >= CHANNELS ? above[i - CHANNELS] : 0;
      let value: number;
      switch (filter) {
        case 0:
          value = rowIn[i];
          break;
        case 1:
          value = rowIn[i] + left;
          break;
        case 2:
          value = rowIn[i] + up;
          break;
        case 3:
          value = rowIn[i] + ((left + up) >> 1);
          break;
        case 4:
          value = rowIn[i] + paeth(left, up, upLeft);
          break;
        default:
          throw new Error(`unknown scanline filter ${filter} on row ${y}`);
      }
      rowOut[i] = value & 0xff;
    }
  }

  return { width, height, data };
}
