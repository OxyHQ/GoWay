/**
 * Low-poly vehicles and people, as plain arrays: built here, uploaded once,
 * and instanced by `lifeRenderer.ts` hundreds of times per draw call.
 *
 * Every model is a handful of boxes in local metres — x FORWARD, y LEFT, z UP,
 * origin on the ground at the model's centre — with flat normals and a PART
 * per vertex that the shader colours by (paint, glass, tyres, clothes, skin,
 * legs that swing). No textures, no badges, no lettering: generic maquette
 * forms, the same art direction as the buildings. No third-party asset is
 * involved anywhere (see `docs/MAP_CITY_LIFE.md`).
 *
 * Faces wind counter-clockwise seen from OUTSIDE in this right-handed frame;
 * the engine's mirrored model matrix makes three call them back faces, which
 * is why the materials draw `BackSide` exactly as the buildings do
 * (`cityEngine.ts`).
 */

/** What the shader colours a vertex as. */
export const PART = {
  paint: 0,
  glass: 1,
  tyre: 2,
  legLeft: 3,
  legRight: 4,
  skin: 5,
  clothes: 6,
} as const;

export interface ModelGeometry {
  positions: Float32Array;
  normals: Float32Array;
  parts: Float32Array;
  indices: Uint16Array;
  /** Nominal length, metres (cars: what `length` scale 1 means). */
  length: number;
}

type V3 = [number, number, number];

interface Builder {
  positions: number[];
  normals: number[];
  parts: number[];
  indices: number[];
}

function quad(b: Builder, corners: [V3, V3, V3, V3], part: number): void {
  const [a, c1, c2] = corners;
  const ux = c1[0] - a[0];
  const uy = c1[1] - a[1];
  const uz = c1[2] - a[2];
  const vx = c2[0] - a[0];
  const vy = c2[1] - a[1];
  const vz = c2[2] - a[2];
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz) || 1;
  nx /= len;
  ny /= len;
  nz /= len;
  const base = b.positions.length / 3;
  for (const corner of corners) {
    b.positions.push(...corner);
    b.normals.push(nx, ny, nz);
    b.parts.push(part);
  }
  b.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

/**
 * A box from `x0..x1`, `y0..y1`, `z0..z1`, its top optionally inset (a
 * cabin's sloped glass). `parts`: sides, top, bottom.
 */
function box(
  b: Builder,
  [x0, x1]: [number, number],
  [y0, y1]: [number, number],
  [z0, z1]: [number, number],
  parts: { side: number; top?: number; bottom?: number },
  inset: { front?: number; back?: number; sides?: number } = {},
): void {
  const tx0 = x0 + (inset.back ?? 0);
  const tx1 = x1 - (inset.front ?? 0);
  const ty0 = y0 + (inset.sides ?? 0);
  const ty1 = y1 - (inset.sides ?? 0);
  const B: V3[] = [
    [x0, y0, z0],
    [x1, y0, z0],
    [x1, y1, z0],
    [x0, y1, z0],
  ];
  const T: V3[] = [
    [tx0, ty0, z1],
    [tx1, ty0, z1],
    [tx1, ty1, z1],
    [tx0, ty1, z1],
  ];
  const side = parts.side;
  // Counter-clockwise from outside.
  quad(b, [B[0], B[1], T[1], T[0]], side); // right (−y)
  quad(b, [B[1], B[2], T[2], T[1]], side); // front (+x)
  quad(b, [B[2], B[3], T[3], T[2]], side); // left (+y)
  quad(b, [B[3], B[0], T[0], T[3]], side); // back (−x)
  quad(b, [T[0], T[1], T[2], T[3]], parts.top ?? side);
  if (parts.bottom !== undefined) quad(b, [B[0], B[3], B[2], B[1]], parts.bottom);
}

function finish(b: Builder, length: number): ModelGeometry {
  return {
    positions: Float32Array.from(b.positions),
    normals: Float32Array.from(b.normals),
    parts: Float32Array.from(b.parts),
    indices: Uint16Array.from(b.indices),
    length,
  };
}

function wheels(b: Builder, axles: number[], halfWidth: number, radius: number): void {
  for (const x of axles) {
    for (const side of [-1, 1]) {
      const y0 = side > 0 ? halfWidth - 0.24 : -halfWidth;
      box(b, [x - radius, x + radius], [y0, y0 + 0.24], [0, radius * 2], { side: PART.tyre });
    }
  }
}

/** A hatchback/saloon: body, a glass cabin with a painted roof, four wheels. ~4.5 m. */
export function carModel(): ModelGeometry {
  const b: Builder = { positions: [], normals: [], parts: [], indices: [] };
  box(b, [-2.25, 2.25], [-0.88, 0.88], [0.3, 0.86], { side: PART.paint });
  box(
    b,
    [-1.55, 1.05],
    [-0.8, 0.8],
    [0.86, 1.4],
    { side: PART.glass, top: PART.paint },
    { front: 0.55, back: 0.3, sides: 0.1 },
  );
  wheels(b, [-1.4, 1.4], 0.92, 0.32);
  return finish(b, 4.5);
}

/** A van: a tall box with a short bonnet and a window band. ~5.4 m. */
export function vanModel(): ModelGeometry {
  const b: Builder = { positions: [], normals: [], parts: [], indices: [] };
  box(b, [-2.7, 1.7], [-0.98, 0.98], [0.32, 2.15], { side: PART.paint }, { front: 0.25 });
  box(b, [1.7, 2.7], [-0.96, 0.96], [0.32, 1.05], { side: PART.paint }, { front: 0.15 });
  box(b, [-2.5, 1.55], [-1.0, 1.0], [1.35, 1.9], { side: PART.glass, top: PART.paint });
  wheels(b, [-1.8, 1.8], 1.0, 0.34);
  return finish(b, 5.4);
}

/** A bus: one long box with a continuous window band. ~12 m. */
export function busModel(): ModelGeometry {
  const b: Builder = { positions: [], normals: [], parts: [], indices: [] };
  box(b, [-6, 6], [-1.25, 1.25], [0.35, 3.05], { side: PART.paint });
  box(b, [-5.8, 5.95], [-1.27, 1.27], [1.45, 2.55], { side: PART.glass, top: PART.paint });
  wheels(b, [-3.6, 3.9], 1.28, 0.48);
  return finish(b, 12);
}

/** A person, ~1.72 m: two legs (which swing), a torso, a head. Faces +x. */
export function personModel(): ModelGeometry {
  const b: Builder = { positions: [], normals: [], parts: [], indices: [] };
  box(b, [-0.08, 0.08], [0.02, 0.15], [0, 0.86], { side: PART.legLeft });
  box(b, [-0.08, 0.08], [-0.15, -0.02], [0, 0.86], { side: PART.legRight });
  box(b, [-0.11, 0.11], [-0.2, 0.2], [0.84, 1.46], { side: PART.clothes }, { sides: 0.03 });
  box(b, [-0.1, 0.1], [-0.09, 0.09], [1.48, 1.72], { side: PART.skin });
  return finish(b, 0.3);
}

/** The car models, by the simulation's model order (`CAR_MODELS`). */
export const VEHICLE_MODELS = { car: carModel, van: vanModel, bus: busModel } as const;
