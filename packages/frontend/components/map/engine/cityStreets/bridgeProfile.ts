import earcut from 'earcut';
import { pointAt, polyline, project } from '../roads/roadGraph';

/**
 * Terrain-derived deck between mapped abutments. The crossfall joins the
 * ground across both complete end sections; a concave longitudinal profile
 * clears terrain under the full footprint, not only under its centreline.
 * Elevations are estimates, not surveyed bridge heights.
 */
export function bridgeProfile(
  points: [number, number][],
  ground: (x: number, y: number) => number,
  footprint: readonly (readonly [number, number])[] = [],
  domains: readonly (readonly [number, number][])[] = [],
  refinement?: { errorM: number; minEdgeM: number },
) {
  const line = polyline(points);
  const first = { x: 0, y: 0, h: 0 },
    last = { x: 0, y: 0, h: 0 };
  pointAt(line, 0, first);
  pointAt(line, line.length, last);
  // Estimate the crossfall on the centre of each approach. Sampling the
  // terrain anew at every lateral offset folds a deck over the bank beyond
  // its abutment: a bridge section is a plane, not a draped terrain slice.
  const endSection = (p: typeof first) => {
    const nx = -Math.sin(p.h),
      ny = Math.cos(p.h);
    const z = ground(p.x, p.y);
    const slope = (ground(p.x + nx, p.y + ny) - ground(p.x - nx, p.y - ny)) / 2;
    return (lateral: number) => z + slope * lateral;
  };
  const firstHeight = endSection(first),
    lastHeight = endSection(last);
  const base = (s: number, lateral: number) => {
    const t = line.length > 0 ? s / line.length : 0;
    return firstHeight(lateral) * (1 - t) + lastHeight(lateral) * t;
  };
  const station = (x: number, y: number) => {
    const { s } = project(line, x, y),
      at = { x: 0, y: 0, h: 0 };
    pointAt(line, s, at);
    return { s, lateral: -(x - at.x) * Math.sin(at.h) + (y - at.y) * Math.cos(at.h) };
  };
  const samples: { s: number; z: number }[] = [];
  const add = (x: number, y: number) => {
    const { s, lateral } = station(x, y);
    const z = ground(x, y) - base(s, lateral);
    samples.push({ s, z });
    return z;
  };
  const count = Math.max(1, Math.ceil(line.length / 6));
  const at = { x: 0, y: 0, h: 0 };
  for (let i = 0; i <= count; i++) {
    pointAt(line, (line.length * i) / count, at);
    add(at.x, at.y);
  }
  for (const [x, y] of footprint) add(x, y);
  // A regular point grid can miss a crest between samples, especially at an
  // abutment. Resolve the terrain residual over the complete corridor with
  // the same accuracy budget as the rendered road mesh. This happens before
  // tile clipping, so adjacent tiles solve an identical longitudinal profile.
  type Sample = { x: number; y: number; z: number };
  const sample = (x: number, y: number): Sample => ({ x, y, z: add(x, y) });
  const visit = (a: Sample, b: Sample, c: Sample): void => {
    const ab = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
    const bc = (c.x - b.x) ** 2 + (c.y - b.y) ** 2;
    const ca = (a.x - c.x) ** 2 + (a.y - c.y) ** 2;
    const edge = Math.max(ab, bc, ca);
    if (bc > ab && bc >= ca) [a, b, c] = [b, c, a];
    else if (ca > ab && ca > bc) [a, b, c] = [c, a, b];
    const mid = sample((a.x + b.x) / 2, (a.y + b.y) / 2);
    let error = Math.abs(mid.z - (a.z + b.z) / 2);
    for (const weights of [
      [0, 0.5, 0.5],
      [0.5, 0, 0.5],
      [1 / 3, 1 / 3, 1 / 3],
    ]) {
      const p = sample(
        a.x * weights[0] + b.x * weights[1] + c.x * weights[2],
        a.y * weights[0] + b.y * weights[1] + c.y * weights[2],
      );
      error = Math.max(
        error,
        Math.abs(p.z - a.z * weights[0] - b.z * weights[1] - c.z * weights[2]),
      );
    }
    if (
      edge <= 36 &&
      (!refinement || error <= refinement.errorM || edge <= refinement.minEdgeM ** 2)
    )
      return;
    visit(a, mid, c);
    visit(mid, b, c);
  };
  for (const ring of domains) {
    const vertices = ring.map(([x, y]) => sample(x, y));
    const indices = earcut(ring.flat());
    for (let i = 0; i < indices.length; i += 3)
      visit(vertices[indices[i]], vertices[indices[i + 1]], vertices[indices[i + 2]]);
  }
  samples.sort((a, b) => a.s - b.s || b.z - a.z);
  const stations: { s: number; z: number }[] = [];
  for (const sample of samples) {
    const previous = stations[stations.length - 1];
    if (previous && sample.s - previous.s < 1e-7) previous.z = Math.max(previous.z, sample.z);
    else stations.push(sample);
  }
  const profile: { s: number; z: number }[] = [];
  for (const next of stations) {
    while (profile.length >= 2) {
      const a = profile[profile.length - 2],
        b = profile[profile.length - 1];
      if ((b.z - a.z) * (next.s - b.s) > (next.z - b.z) * (b.s - a.s)) break;
      profile.pop();
    }
    profile.push(next);
  }
  return (x: number, y: number) => {
    const { s, lateral } = station(x, y);
    let lo = 0,
      hi = profile.length - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (profile[mid].s <= s) lo = mid;
      else hi = mid;
    }
    const a = profile[lo],
      b = profile[hi];
    const t = b.s > a.s ? (s - a.s) / (b.s - a.s) : 0;
    return base(s, lateral) + a.z + (b.z - a.z) * t;
  };
}
