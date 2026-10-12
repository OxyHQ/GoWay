/**
 * Drawing model-library geometry (`library.ts`) in a TSL material — the frame
 * change and the colours — so every consumer reads the asset profile the same
 * way (`docs/MODEL_LIBRARY.md`). The nodes the city engine's TSL pass draws
 * with (`docs/MAP_NATIVE_3D.md` → Phase 2).
 *
 * A consumer declares the attributes `position`, `normal`, `color` and
 * `paint` on its geometry and reads them through these.
 */
import type { Node } from 'three/webgpu';
import { select, sRGBTransferOETF, vec3 } from 'three/tsl';

type Vec3 = Node<'vec3'>;
type Float = Node<'float'>;

/** glTF (+Y up, front +Z, +X left) to a map's local frame (x forward, y left, z up). */
export const libraryFrame = (g: Vec3): Vec3 => vec3(g.z, g.x, g.y);

/** Linear to sRGB, the piecewise curve (three's own transfer function). */
export const librarySrgb = (linear: Vec3): Vec3 => sRGBTransferOETF(linear) as unknown as Vec3;

/**
 * A vertex's sRGB colour: on the tintable body the paint, shaded by the kit's
 * ramp (the vertex colour is that shade, grey); elsewhere its own.
 */
export function libraryColour(color: Vec3, paint: Float, paintSrgb: Vec3): Vec3 {
  const own = librarySrgb(color);
  return select(paint.greaterThan(0.5), paintSrgb.mul(own), own);
}
