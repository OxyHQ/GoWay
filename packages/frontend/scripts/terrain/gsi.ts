/**
 * GSI's elevation tiles (地理院タイル 標高タイル, `maps.gsi.go.jp/development/demtile.html`):
 * 256 px PNG in the web-mercator tile pyramid, each pixel a height in
 * centimetres as a 24-bit integer — `x = R·2¹⁶ + G·2⁸ + B`, `h = x / 100` m,
 * negative above 2²³ (`h = (x − 2²⁴) / 100`), and (128, 0, 0) "no data".
 */
import { inflateSync } from 'node:zlib';

/** The pixels of an 8-bit, non-interlaced RGB or RGBA PNG, as RGB. Anything else is an error. */
export function decodePngRgb(bytes: Uint8Array): {
  width: number;
  height: number;
  rgb: Uint8Array;
} {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!signature.every((b, i) => bytes[i] === b)) throw new Error('not a PNG');
  let at = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Uint8Array[] = [];
  while (at < bytes.length) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    const data = bytes.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      const depth = data[8];
      const colour = data[9];
      const interlace = data[12];
      if (depth !== 8 || interlace !== 0 || (colour !== 2 && colour !== 6)) {
        throw new Error(
          `PNG depth ${depth}, colour type ${colour}, interlace ${interlace}: not 8-bit RGB(A)`,
        );
      }
      channels = colour === 2 ? 3 : 4;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? out[i - channels] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= channels ? prev[i - channels] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) throw new Error(`PNG filter ${filter}`);
      out[i] = v & 0xff;
    }
  }
  if (channels === 3) return { width, height, rgb: pixels };
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    rgb[i * 3] = pixels[i * 4];
    rgb[i * 3 + 1] = pixels[i * 4 + 1];
    rgb[i * 3 + 2] = pixels[i * 4 + 2];
  }
  return { width, height, rgb };
}

/** A GSI elevation tile's heights (m); `NaN` where it has none. */
export function decodeGsiHeights(rgb: Uint8Array): Float32Array {
  const out = new Float32Array(rgb.length / 3);
  for (let i = 0; i < out.length; i++) {
    const r = rgb[i * 3];
    const g = rgb[i * 3 + 1];
    const b = rgb[i * 3 + 2];
    if (r === 128 && g === 0 && b === 0) {
      out[i] = Number.NaN;
      continue;
    }
    const x = r * 65536 + g * 256 + b;
    out[i] = (x < 8388608 ? x : x - 16777216) / 100;
  }
  return out;
}
