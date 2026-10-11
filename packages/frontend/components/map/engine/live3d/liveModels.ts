/**
 * GoWay Live's vehicles in 3D, in city life's soft maquette style — built
 * with the same superellipsoid and wheel builders (`../cityLife/agentModels.ts`),
 * so a live train and a simulated car look like they belong to one model
 * railway.
 *
 * A model is ONE car (a train is several, each placed on the track by the
 * pass): stacked bands — skirt, livery stripe, body, glazing, roof — each
 * its own rounded solid so a band has a crisp edge, over bogies or wheels.
 * The livery is baked into vertex colours (`MapLiveModel.livery`, flat bands
 * only: no logo, number or text). Near ≤ ~1.5k triangles a car; far, one
 * rounded block of a few dozen.
 *
 * Built in city life's frame (x forward, y left, z up, metres, origin on the
 * ground at the centre) and turned once so the nose points +y, the frame
 * `anchorMath.ts` places shapes in.
 */
import type { MapLiveModel } from '../../types';
import { type Builder, builder, finish, superellipsoid, TYRE, wheel } from '../maquette';

const BAND = { lower: 10, stripe: 11, body: 12, window: 13, roof: 14 } as const;

export interface LiveModelGeometry {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  indices: Uint16Array | Uint32Array;
  triangles: number;
}

type Detail = 'near' | 'far';

function hex(value: string): [number, number, number] {
  const n = Number.parseInt(value.slice(1, 7), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** A band of the body: a rounded slab from `z0` to `z1`. */
function band(
  b: Builder,
  part: number,
  halfLength: number,
  halfWidth: number,
  z0: number,
  z1: number,
  round: [number, number],
  segments: [number, number],
): void {
  superellipsoid(b, {
    at: [0, 0, (z0 + z1) / 2],
    radii: [halfLength, halfWidth, (z1 - z0) / 2 + 0.04],
    round,
    segments,
    part: () => part,
  });
}

function emuCar(model: MapLiveModel, detail: Detail): Builder {
  const b = builder();
  const L = model.carLength / 2;
  const W = model.width / 2;
  const H = model.height;
  if (detail === 'far') {
    band(b, BAND.body, L, W, 0.6, H, [0.35, 0.18], [8, 2]);
    return b;
  }
  // Rounded cab ends: the plan's corners are soft, the profile a little
  // softer at the roof. Every car gets them; the gap hides the inner ones.
  const plan: [number, number] = [0.3, 0.24];
  const seg: [number, number] = [22, 3];
  band(b, BAND.lower, L, W - 0.04, 0.55, 1.1, plan, seg);
  band(b, BAND.stripe, L, W, 1.1, 1.42, plan, seg);
  band(b, BAND.body, L, W, 1.42, 2.05, plan, seg);
  band(b, BAND.window, L - 0.02, W - 0.01, 2.05, H - 0.95, plan, seg);
  band(b, BAND.roof, L - 0.08, W - 0.1, H - 0.95, H, [0.5, 0.3], [22, 4]);
  // Two bogies, dark, under the ends.
  for (const x of [-L * 0.68, L * 0.68]) {
    superellipsoid(b, {
      at: [x, 0, 0.42],
      radii: [1.3, W * 0.78, 0.3],
      round: [0.4, 0.3],
      segments: [10, 3],
      part: () => TYRE,
    });
  }
  return b;
}

function busBody(model: MapLiveModel, detail: Detail): Builder {
  const b = builder();
  const L = model.carLength / 2;
  const W = model.width / 2;
  const H = model.height;
  if (detail === 'far') {
    band(b, BAND.body, L, W, 0.35, H, [0.3, 0.2], [8, 2]);
    return b;
  }
  const plan: [number, number] = [0.28, 0.2];
  const seg: [number, number] = [20, 3];
  band(b, BAND.lower, L, W, 0.32, 0.8, plan, seg);
  band(b, BAND.stripe, L, W, 0.8, 1.05, plan, seg);
  band(b, BAND.body, L, W, 1.05, 1.35, plan, seg);
  if (model.form === 'double-deck') {
    band(b, BAND.window, L - 0.02, W - 0.01, 1.35, 2.15, plan, seg);
    band(b, BAND.body, L, W, 2.15, 2.55, plan, seg);
    band(b, BAND.window, L - 0.02, W - 0.01, 2.55, H - 0.35, plan, seg);
  } else {
    band(b, BAND.window, L - 0.02, W - 0.01, 1.35, H - 0.5, plan, seg);
  }
  band(b, BAND.roof, L - 0.05, W - 0.04, H - 0.5, H, [0.45, 0.2], [20, 3]);
  const axles = model.carLength > 11 ? [-L * 0.62, L * 0.66] : [-L * 0.55];
  for (const x of axles) {
    for (const side of [-1, 1]) wheel(b, [x, side * (W - 0.18), 0.48], 0.48, 0.3, 10);
  }
  return b;
}

function aircraft(model: MapLiveModel, detail: Detail): Builder {
  const b = builder();
  const L = model.carLength / 2;
  const near = detail === 'near';
  // Fuselage: a long, nearly round capsule; belly in the lower colour.
  superellipsoid(b, {
    at: [0, 0, 0],
    radii: [L, 2.0, 2.05],
    round: [0.95, 0.75],
    segments: near ? [28, 10] : [10, 4],
    part: (p) => (p[2] < -0.7 ? BAND.lower : BAND.body),
  });
  // Wings: a flat, swept-looking slab just below the middle.
  superellipsoid(b, {
    at: [1, 0, -0.9],
    radii: [3.2, model.width / 2, 0.32],
    round: [0.5, 0.35],
    segments: near ? [14, 3] : [6, 2],
    part: () => BAND.lower,
  });
  // Tailplane and fin: the fin carries the layer's aircraft colour.
  superellipsoid(b, {
    at: [-L + 2.4, 0, 0.6],
    radii: [1.7, 6, 0.22],
    round: [0.5, 0.35],
    segments: near ? [10, 3] : [6, 2],
    part: () => BAND.lower,
  });
  superellipsoid(b, {
    at: [-L + 2.8, 0, 3.6],
    radii: [2.3, 0.28, 3.2],
    round: [0.5, 0.4],
    segments: near ? [10, 4] : [6, 2],
    part: () => BAND.stripe,
  });
  return b;
}

function vessel(model: MapLiveModel, detail: Detail): Builder {
  const b = builder();
  const L = model.carLength / 2;
  const W = model.width / 2;
  const near = detail === 'near';
  superellipsoid(b, {
    at: [0, 0, 2.5],
    radii: [L, W, 3],
    round: [0.25, 0.55],
    segments: near ? [24, 4] : [8, 2],
    taper: -0.08,
    part: (p) => (p[2] < 0.9 ? BAND.stripe : p[2] < 4.6 ? BAND.lower : BAND.body),
  });
  superellipsoid(b, {
    at: [-L * 0.55, 0, 8.5],
    radii: [L * 0.22, W * 0.8, 3.2],
    round: [0.35, 0.3],
    segments: near ? [12, 3] : [6, 2],
    part: (p) => (p[2] > 9.5 && p[2] < 10.6 ? BAND.window : BAND.body),
  });
  return b;
}

/** The geometry of one car of `model` at a level of detail, coloured by its livery. */
export function buildLiveModel(model: MapLiveModel, detail: Detail): LiveModelGeometry {
  const b =
    model.form === 'emu'
      ? emuCar(model, detail)
      : model.form === 'aircraft'
        ? aircraft(model, detail)
        : model.form === 'vessel'
          ? vessel(model, detail)
          : busBody(model, detail);
  const geometry = finish(b, model.carLength, model.carLength / 2, model.width / 2);
  const palette: Record<number, [number, number, number]> = {
    [BAND.lower]: hex(model.livery.lower),
    [BAND.stripe]: hex(model.livery.stripe),
    [BAND.body]: hex(model.livery.body),
    [BAND.window]: hex(model.livery.window),
    [BAND.roof]: hex(model.livery.roof),
    [TYRE]: [0.16, 0.17, 0.18],
  };
  const n = geometry.positions.length / 3;
  const positions = new Float32Array(n * 3);
  const normals = new Float32Array(n * 3);
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    // Turn x-forward into y-forward: (x, y) → (−y, x).
    const x = geometry.positions[i * 3] as number;
    const y = geometry.positions[i * 3 + 1] as number;
    positions[i * 3] = -y;
    positions[i * 3 + 1] = x;
    positions[i * 3 + 2] = geometry.positions[i * 3 + 2] as number;
    const nx = geometry.normals[i * 3] as number;
    const ny = geometry.normals[i * 3 + 1] as number;
    normals[i * 3] = -ny;
    normals[i * 3 + 1] = nx;
    normals[i * 3 + 2] = geometry.normals[i * 3 + 2] as number;
    const color = palette[geometry.parts[i] as number] ?? palette[BAND.body] ?? [1, 1, 1];
    colors.set(color, i * 3);
  }
  return {
    positions,
    normals,
    colors,
    indices: geometry.indices,
    triangles: geometry.indices.length / 3,
  };
}
