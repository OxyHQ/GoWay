/**
 * WebP → RGBA in a Worker, which has no image decoder of its own: libwebp
 * compiled to WebAssembly (`@jsquash/webp`, Apache-2.0, Squoosh's codec). Used
 * only by the contour route (`contours.js`) to read the Terrarium elevation
 * tiles, and imported lazily by `index.js` so no other route — and no test
 * that never asks for a contour — loads the module.
 *
 * Wrangler bundles the `.wasm` import as a compiled `WebAssembly.Module`
 * (its default `CompiledWasm` rule), which is the form `init` takes in workerd,
 * where compiling from bytes at run time is not allowed.
 */
import decode, { init } from '@jsquash/webp/decode.js';
import WEBP_DECODER from '@jsquash/webp/codec/dec/webp_dec.wasm';

let ready = null;

/** RGBA pixels of a WebP image. */
export async function decodeWebp(bytes) {
  if (!ready) ready = init(WEBP_DECODER);
  await ready;
  const copy = bytes.slice().buffer;
  const image = await decode(copy);
  return { width: image.width, height: image.height, data: image.data };
}
