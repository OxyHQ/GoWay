import type { PackedSurfaces } from './meshBuffers';
import { bridgeProfile } from './bridgeProfile';

/** Refine only where the common terrain bends away from a road triangle. */
export function groundStreetMesh(
  source: PackedSurfaces,
  ground: (x: number, y: number) => number,
  refinement?: { errorM: number; minEdgeM: number },
): PackedSurfaces {
  const positions = Array.from(source.positions);
  const baseZ = Array.from({ length: positions.length / 3 }, (_, i) => positions[i * 3 + 2]);
  const attrs = Array.from(source.attrs);
  const footprints = (source.bridges ?? []).map(() => [] as [number, number][]);
  for (let i = 0; !source.bridgeDomains && i < baseZ.length; i++) {
    const span = attrs[i * 4 + 3];
    if (span) footprints[span - 1]?.push([positions[i * 3], positions[i * 3 + 1]]);
  }
  const profiles = (source.bridges ?? []).map((points, i) =>
    bridgeProfile(points, ground, footprints[i], source.bridgeDomains?.[i], refinement),
  );
  const height = (x: number, y: number, z: number, span: number) =>
    z + (span ? (profiles[span - 1]?.(x, y) ?? ground(x, y)) : ground(x, y));
  for (let i = 0; i < baseZ.length; i++)
    positions[i * 3 + 2] = height(
      positions[i * 3],
      positions[i * 3 + 1],
      baseZ[i],
      attrs[i * 4 + 3],
    );
  const indices: number[] = [];
  const midpoints = new Map<string, number>();
  const distance2 = (a: number, b: number) =>
    (positions[a * 3] - positions[b * 3]) ** 2 + (positions[a * 3 + 1] - positions[b * 3 + 1]) ** 2;
  const split = (a: number, b: number, c: number): void => {
    if (!refinement) {
      indices.push(a, b, c);
      return;
    }
    const span = attrs[a * 4 + 3];
    const ab = distance2(a, b),
      bc = distance2(b, c),
      ca = distance2(c, a);
    if (bc > ab && bc >= ca) [a, b, c] = [b, c, a];
    else if (ca > ab && ca > bc) [a, b, c] = [c, a, b];
    const ids = [a, b, c];
    let error = 0;
    for (const weights of [
      [0.5, 0.5, 0],
      [0, 0.5, 0.5],
      [0.5, 0, 0.5],
      [1 / 3, 1 / 3, 1 / 3],
    ]) {
      let x = 0,
        y = 0,
        z = 0,
        drawn = 0;
      for (let j = 0; j < 3; j++) {
        x += positions[ids[j] * 3] * weights[j];
        y += positions[ids[j] * 3 + 1] * weights[j];
        z += baseZ[ids[j]] * weights[j];
        drawn += positions[ids[j] * 3 + 2] * weights[j];
      }
      error = Math.max(error, Math.abs(height(x, y, z, span) - drawn));
    }
    if (error <= refinement.errorM || Math.max(ab, bc, ca) <= refinement.minEdgeM ** 2) {
      indices.push(a, b, c);
      return;
    }
    const key = a < b ? `${a}/${b}` : `${b}/${a}`;
    let mid = midpoints.get(key);
    if (mid === undefined) {
      mid = baseZ.length;
      const x = (positions[a * 3] + positions[b * 3]) / 2;
      const y = (positions[a * 3 + 1] + positions[b * 3 + 1]) / 2;
      const z = (baseZ[a] + baseZ[b]) / 2;
      positions.push(x, y, height(x, y, z, span));
      baseZ.push(z);
      attrs.push(...attrs.slice(a * 4, a * 4 + 4));
      midpoints.set(key, mid);
    }
    split(a, mid, c);
    split(mid, b, c);
  };
  let simpleCount = 0;
  for (let i = 0; i < source.indices.length; i += 3) {
    split(source.indices[i], source.indices[i + 1], source.indices[i + 2]);
    if (i + 3 === source.simpleCount) simpleCount = indices.length;
  }
  return {
    positions: new Float32Array(positions),
    attrs: source.attrs instanceof Uint16Array ? new Uint16Array(attrs) : new Uint8Array(attrs),
    indices: new Uint32Array(indices),
    simpleCount,
    bridges: source.bridges,
    bridgeDomains: source.bridgeDomains,
  };
}
