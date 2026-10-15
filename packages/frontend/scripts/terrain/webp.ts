/**
 * WebP in the terrain build: the same libwebp (`@jsquash/webp`) the Worker
 * decodes elevation tiles with (`worker/webpDecode.js`), here also encoding.
 * Elevation tiles are LOSSLESS: a lossy codec would move heights by metres.
 */
import { readFileSync } from 'node:fs';

import decode, { init as initDecode } from '@jsquash/webp/decode.js';
import encode, { init as initEncode } from '@jsquash/webp/encode.js';

let decoderReady: Promise<unknown> | null = null;
let encoderReady: Promise<unknown> | null = null;

function wasm(path: string): WebAssembly.Module {
  return new WebAssembly.Module(readFileSync(require.resolve(path)));
}

/** RGBA pixels of a WebP image. */
export async function decodeWebp(
  bytes: Uint8Array,
): Promise<{ width: number; height: number; data: Uint8ClampedArray }> {
  decoderReady ??= initDecode(wasm('@jsquash/webp/codec/dec/webp_dec.wasm'));
  await decoderReady;
  const image = await decode(bytes.slice().buffer);
  return { width: image.width, height: image.height, data: image.data };
}

/**
 * Lossless WebP of RGBA pixels. `effort` is libwebp's lossless effort (the
 * `quality` option in lossless mode, 0–100) at `method` 6: measured on z12
 * Terrarium tiles (`docs/MAP_TERRAIN_GLOBE.md` → Precision).
 */
export async function encodeLosslessWebp(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  effort = 75,
): Promise<Uint8Array> {
  encoderReady ??= initEncode(wasm('@jsquash/webp/codec/enc/webp_enc.wasm'));
  await encoderReady;
  const buffer = await encode({ data: rgba, width, height, colorSpace: 'srgb' } as ImageData, {
    lossless: 1,
    quality: effort,
    method: 6,
    exact: 1,
  });
  return new Uint8Array(buffer);
}
