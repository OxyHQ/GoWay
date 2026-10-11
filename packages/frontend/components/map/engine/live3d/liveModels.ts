/**
 * GoWay Live's vehicles in 3D, drawn from the shared model library
 * (`../vehicles/library.ts`, `docs/MODEL_LIBRARY.md`) — the same models city
 * life simulates with, so a live train and a simulated car belong to one
 * model railway and there is no second model set.
 *
 * A live model (`MapLiveModel`) names a generic FORM, its real proportions
 * and a livery. Each form is one library model ({@link liveLibraryKey}),
 * stretched per axis to the car's real length, width and height. The livery
 * paints the library's tintable body (`livery.body`, shaded by the kit's own
 * ramp; an aircraft's fin wears `livery.stripe`); everything else keeps the
 * library's fixed colours. No logo, number or text — the library has none.
 *
 * Built nose towards +y, z up, origin on the ground at the centre: the frame
 * `anchorMath.ts` places shapes in.
 */
import { hexToRgb } from '@/lib/map/colour';
import type { MapLiveModel } from '../../types';
import type { LibraryModel } from '../vehicles/library';

export interface LiveModelGeometry {
  positions: Float32Array;
  normals: Float32Array;
  /** sRGB 0–1 per vertex. */
  colors: Float32Array;
  indices: Uint16Array | Uint32Array;
  triangles: number;
}

type Detail = 'near' | 'far';

const FORM_KEYS: Record<MapLiveModel['form'], string> = {
  emu: 'train.commuter',
  bus: 'vehicle.bus',
  coach: 'vehicle.bus',
  'double-deck': 'vehicle.bus-double',
  aircraft: 'aircraft.airliner',
  vessel: 'vessel.cargo',
};

/** Every library model the live layer may draw, for one `loadModelLibrary` call. */
export const LIVE_LIBRARY_KEYS: readonly string[] = [...new Set(Object.values(FORM_KEYS))];

/** The library model a live form is drawn as. */
export function liveLibraryKey(form: MapLiveModel['form']): string {
  return FORM_KEYS[form];
}

const srgb = (linear: number) =>
  linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055;

/** The geometry of one car of `model` at a level of detail, from its library model `source`. */
export function buildLiveModel(
  model: MapLiveModel,
  detail: Detail,
  source: LibraryModel,
): LiveModelGeometry {
  const level = source.entry.key === liveLibraryKey(model.form) ? source[detail] : null;
  if (!level) throw new Error(`${model.form} is drawn as ${liveLibraryKey(model.form)}`);
  const [width, height, length] = source.entry.size;
  const sx = model.width / width;
  const sy = model.height / height;
  const sz = model.carLength / length;
  const position = level.geometry.getAttribute('position');
  const normal = level.geometry.getAttribute('normal');
  const color = level.geometry.getAttribute('color');
  const paint = level.geometry.getAttribute('paint');
  const index = level.geometry.getIndex();
  if (!index) throw new Error(`${source.entry.key}: not indexed`);
  const body = hexToRgb(model.livery.body);
  const accent = hexToRgb(model.livery.stripe);
  const n = position.count;
  const positions = new Float32Array(n * 3);
  const normals = new Float32Array(n * 3);
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    // glTF (x left, y up, z nose) → nose +y, z up, x right.
    const gx = position.getX(i) * sx;
    const gy = position.getY(i) * sy;
    const gz = position.getZ(i) * sz;
    positions[i * 3] = -gx;
    positions[i * 3 + 1] = gz;
    positions[i * 3 + 2] = gy;
    // A stretched solid's normals scale by the inverse stretch.
    const nx = normal.getX(i) / sx;
    const ny = normal.getY(i) / sy;
    const nz = normal.getZ(i) / sz;
    const length = Math.hypot(nx, ny, nz) || 1;
    normals[i * 3] = -nx / length;
    normals[i * 3 + 1] = nz / length;
    normals[i * 3 + 2] = ny / length;
    const own = [srgb(color.getX(i)), srgb(color.getY(i)), srgb(color.getZ(i))];
    if (paint.getX(i) > 0.5) {
      const tint = model.form === 'aircraft' && gy > model.height * 0.5 ? accent : body;
      for (let k = 0; k < 3; k++) colors[i * 3 + k] = tint[k] * own[k];
    } else {
      colors.set(own, i * 3);
    }
  }
  const indices =
    n < 65536
      ? Uint16Array.from(index.array as ArrayLike<number>)
      : Uint32Array.from(index.array as ArrayLike<number>);
  return { positions, normals, colors, indices, triangles: indices.length / 3 };
}
