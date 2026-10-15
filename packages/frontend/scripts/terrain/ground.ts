/**
 * The bare-earth test of an elevation grid, and the one correction GoWay may
 * make to it (`docs/MAP_TERRAIN_GLOBE.md` → "The archive" → Contamination).
 *
 * A bare-earth model (DTM) knows no ground under a building: its producer
 * interpolates across the footprint from the ground measured around it — a
 * LiDAR DTM triangulates the ground points of the streets, yards and parks
 * around the walls. So under a footprint a clean DTM is a smooth surface
 * spanning the ground around it, and a DTM that RISES under a footprint above
 * every such surface has kept part of the building (a classification miss —
 * the Sagrada Família's +31 m in IGN's MDT02). The same holds for small tree
 * stands: a surface model (GLO-30) keeps the canopy.
 *
 * The surface spanning the ground around a hole is the MEMBRANE (harmonic)
 * interpolation: the smoothest surface that meets every known pixel on the
 * hole's edge — a plane on a plane, a saddle between streets that climb
 * differently, never higher than the highest edge pixel nor lower than the
 * lowest (the maximum principle). No shape is assumed and nothing is fitted:
 * it is the ground the data itself has around the hole.
 *
 * The test: how far the grid stands above its own membrane inside each
 * footprint. The correction (a set that needs it, `catalogue.ts`): the
 * membrane, only inside the footprints that fail the test — every footprint
 * by the same rule, none by name.
 */

/** A row-major grid of heights; `NaN` where the source has none. */
export interface HeightGrid {
  width: number;
  height: number;
  data: Float32Array;
}

/** How a fill stops: the largest change of one sweep (m), or the sweep count. */
export interface MembraneOptions {
  toleranceM?: number;
  maxSweeps?: number;
}

/**
 * The membrane over `hole` (1 = unknown, solve here): every hole pixel becomes
 * the mean of its four neighbours, every other finite pixel stays. Pixels that
 * are `NaN` and not in the hole are no data and bound nothing; a hole with no
 * known pixel on its edge stays `NaN`.
 *
 * Solved by successive over-relaxation from a push-pull start (each hole pixel
 * first takes the mean of the known pixels of the smallest pyramid block that
 * has any), which converges in tens of sweeps instead of thousands.
 */
export function membraneFill(
  grid: HeightGrid,
  hole: Uint8Array,
  options: MembraneOptions = {},
): { data: Float32Array; sweeps: number; residualM: number } {
  const { width: w, height: h } = grid;
  const toleranceM = options.toleranceM ?? 0.002;
  const maxSweeps = options.maxSweeps ?? 4000;
  const out = Float32Array.from(grid.data);
  const holes: number[] = [];
  for (let i = 0; i < out.length; i++) {
    if (hole[i]) {
      holes.push(i);
      out[i] = Number.NaN;
    }
  }
  if (holes.length === 0) return { data: out, sweeps: 0, residualM: 0 };
  pushPull(out, w, h, holes);

  // A hole pixel with no finite pixel reachable stays NaN after push-pull
  // (a grid with no data at all); it is skipped below.
  const index = Int32Array.from(holes.filter((i) => Number.isFinite(out[i])));
  // Over-relaxation: ω from the largest hole's extent would be optimal; 1.9
  // is close for holes of tens to hundreds of pixels and stable for all.
  const omega = 1.9;
  let sweeps = 0;
  let residual = Number.POSITIVE_INFINITY;
  while (sweeps < maxSweeps && residual > toleranceM) {
    residual = 0;
    for (let k = 0; k < index.length; k++) {
      const i = index[k];
      const x = i % w;
      let sum = 0;
      let n = 0;
      if (x > 0) {
        const v = out[i - 1];
        if (!Number.isNaN(v)) {
          sum += v;
          n++;
        }
      }
      if (x < w - 1) {
        const v = out[i + 1];
        if (!Number.isNaN(v)) {
          sum += v;
          n++;
        }
      }
      if (i >= w) {
        const v = out[i - w];
        if (!Number.isNaN(v)) {
          sum += v;
          n++;
        }
      }
      if (i + w < out.length) {
        const v = out[i + w];
        if (!Number.isNaN(v)) {
          sum += v;
          n++;
        }
      }
      if (n === 0) continue;
      const delta = sum / n - out[i];
      out[i] += omega * delta;
      const change = Math.abs(delta);
      if (change > residual) residual = change;
    }
    sweeps++;
  }
  return { data: out, sweeps, residualM: residual };
}

/**
 * Fill every `NaN` in `holes` with the mean of the finite pixels of the
 * smallest enclosing 2^k block that has any (a pyramid pushed down, then
 * pulled back up): a start close to the membrane, so over-relaxation only
 * has to smooth it.
 */
function pushPull(data: Float32Array, w: number, h: number, holes: number[]) {
  const sums: Float64Array[] = [];
  const counts: Float64Array[] = [];
  const sizes: [number, number][] = [];
  let lw = w;
  let lh = h;
  let sum = new Float64Array(lw * lh);
  let count = new Float64Array(lw * lh);
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (!Number.isNaN(v)) {
      sum[i] = v;
      count[i] = 1;
    }
  }
  sums.push(sum);
  counts.push(count);
  sizes.push([lw, lh]);
  while (lw > 1 || lh > 1) {
    const nw = Math.ceil(lw / 2);
    const nh = Math.ceil(lh / 2);
    const s = new Float64Array(nw * nh);
    const c = new Float64Array(nw * nh);
    for (let y = 0; y < lh; y++) {
      for (let x = 0; x < lw; x++) {
        const j = (y >> 1) * nw + (x >> 1);
        s[j] += sum[y * lw + x];
        c[j] += count[y * lw + x];
      }
    }
    sum = s;
    count = c;
    lw = nw;
    lh = nh;
    sums.push(sum);
    counts.push(count);
    sizes.push([lw, lh]);
  }
  for (const i of holes) {
    let x = i % w;
    let y = (i / w) | 0;
    for (let level = 0; level < sums.length; level++) {
      const [sw] = sizes[level];
      const j = y * sw + x;
      if (counts[level][j] > 0) {
        data[i] = sums[level][j] / counts[level][j];
        break;
      }
      x >>= 1;
      y >>= 1;
    }
  }
}

/** A polygon ring in grid pixel coordinates (x right, y down; pixel centres at +0.5). */
export type PixelRing = readonly (readonly [number, number])[];

/**
 * Burn polygons into a label grid: a pixel whose CENTRE is inside polygon `k`
 * (even–odd over all its rings, so courtyards stay out) gets `k + 1`, unless
 * an earlier polygon already holds it. Returns the labels (0 = none).
 */
export function rasterizePolygons(
  width: number,
  height: number,
  polygons: readonly (readonly PixelRing[])[],
): Int32Array {
  const labels = new Int32Array(width * height);
  const xs: number[] = [];
  for (let k = 0; k < polygons.length; k++) {
    const rings = polygons[k];
    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const ring of rings) {
      for (const [, y] of ring) {
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    const y0 = Math.max(0, Math.ceil(minY - 0.5));
    const y1 = Math.min(height - 1, Math.floor(maxY - 0.5));
    for (let py = y0; py <= y1; py++) {
      const cy = py + 0.5;
      xs.length = 0;
      for (const ring of rings) {
        for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
          const [ax, ay] = ring[a];
          const [bx, by] = ring[b];
          if (ay > cy !== by > cy) xs.push(ax + ((cy - ay) / (by - ay)) * (bx - ax));
        }
      }
      xs.sort((p, q) => p - q);
      for (let s = 0; s + 1 < xs.length; s += 2) {
        const x0 = Math.max(0, Math.ceil(xs[s] - 0.5));
        const x1 = Math.min(width - 1, Math.floor(xs[s + 1] - 0.5));
        const row = py * width;
        for (let px = x0; px <= x1; px++) if (labels[row + px] === 0) labels[row + px] = k + 1;
      }
    }
  }
  return labels;
}

/** Grow a mask by `pixels` (a square neighbourhood), so the edge of a hole is off its walls. */
export function dilate(
  mask: Uint8Array,
  width: number,
  height: number,
  pixels: number,
): Uint8Array {
  let current = mask;
  for (let step = 0; step < pixels; step++) {
    const next = Uint8Array.from(current);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (current[i]) continue;
        if (
          (x > 0 && current[i - 1]) ||
          (x < width - 1 && current[i + 1]) ||
          (y > 0 && current[i - width]) ||
          (y < height - 1 && current[i + width]) ||
          (x > 0 && y > 0 && current[i - width - 1]) ||
          (x < width - 1 && y > 0 && current[i - width + 1]) ||
          (x > 0 && y < height - 1 && current[i + width - 1]) ||
          (x < width - 1 && y < height - 1 && current[i + width + 1])
        ) {
          next[i] = 1;
        }
      }
    }
    current = next;
  }
  return current;
}

/** What the grid does inside one footprint, against the open ground around it. */
export interface FootprintGround {
  /** The footprint's label (`rasterizePolygons`: index + 1). */
  label: number;
  /** Pixels inside it. */
  pixels: number;
  /** Open-ground pixels the plane was fitted to. */
  ringPixels: number;
  /** The largest height above the ring's plane (m). */
  maxAboveM: number;
  /** The 90th percentile of the height above the ring's plane (m). */
  p90AboveM: number;
  /**
   * The median height above the ring's plane of the footprint's EDGE — its
   * pixels within one source pixel of the outline (m). The verdict: a
   * building kept as ground is a wall, up at its very edge; a hill under a
   * building (or a wood) rises from the street through its edge, which stays
   * on the street's plane.
   */
  edgeAboveM: number;
  /** Where the largest height is (pixel index). */
  at: number;
}

/** The ring a footprint is judged against: open ground between these distances (pixels). */
export interface RingBand {
  /** Nearest ring pixel: past the source's own pixel, so the ring is out of a kept building's smear. */
  fromPx: number;
  /** Farthest ring pixel. */
  toPx: number;
  /** Fewest ring pixels for a verdict (a footprint walled in by others has none of its own). */
  minPixels: number;
}

/**
 * Per footprint: its heights against the PLANE through the open ground around
 * it — every pixel in no footprint (streets, yards, squares) and not `closed`
 * (tree cover, which a surface model lifts) between `band.fromPx` and
 * `band.toPx` of it, least squares.
 *
 * A building kept as ground is a STEP up from the ground beside it; a hill a
 * building stands on rises through the streets beside it as well, so the
 * plane follows the hill and the footprint stays on it (over a 30 m
 * footprint, a hill of 200 m radius departs from a plane by ~0.6 m). Unlike a
 * membrane spanned over a whole built-up block, the ring is the ground next
 * to each footprint, so a hilltop covered in houses is not mistaken for one
 * enormous building.
 */
export function footprintGround(
  grid: Float32Array,
  width: number,
  height: number,
  labels: Int32Array,
  footprints: number,
  band: RingBand,
  closed: Uint8Array | null = null,
): FootprintGround[] {
  // Each footprint's pixel bounding box.
  const box = new Int32Array(footprints * 4);
  for (let k = 0; k < footprints; k++) {
    box[k * 4] = width;
    box[k * 4 + 1] = height;
    box[k * 4 + 2] = -1;
    box[k * 4 + 3] = -1;
  }
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i];
    if (!label) continue;
    const k = (label - 1) * 4;
    const x = i % width;
    const y = (i / width) | 0;
    if (x < box[k]) box[k] = x;
    if (y < box[k + 1]) box[k + 1] = y;
    if (x > box[k + 2]) box[k + 2] = x;
    if (y > box[k + 3]) box[k + 3] = y;
  }
  const out: FootprintGround[] = [];
  const reach = band.toPx;
  let distance = new Int32Array(0);
  let inner = new Int32Array(0);
  const far = 1 << 20;
  for (let k = 0; k < footprints; k++) {
    if (box[k * 4 + 2] < 0) continue;
    const label = k + 1;
    const x0 = Math.max(0, box[k * 4] - reach);
    const y0 = Math.max(0, box[k * 4 + 1] - reach);
    const x1 = Math.min(width - 1, box[k * 4 + 2] + reach);
    const y1 = Math.min(height - 1, box[k * 4 + 3] + reach);
    const bw = x1 - x0 + 1;
    const bh = y1 - y0 + 1;
    if (distance.length < bw * bh) distance = new Int32Array(bw * bh * 2);
    // Chessboard distance to the footprint: two passes over the local box.
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        distance[y * bw + x] = labels[(y0 + y) * width + x0 + x] === label ? 0 : far;
      }
    }
    chessboard(distance, bw, bh);
    // Least squares z = a + b·u + c·v over the ring, in coordinates centred on the box.
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    let n = 0;
    let su = 0;
    let sv = 0;
    let sz = 0;
    let suu = 0;
    let svv = 0;
    let suv = 0;
    let suz = 0;
    let svz = 0;
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        const d = distance[y * bw + x];
        if (d < band.fromPx || d > band.toPx) continue;
        const i = (y0 + y) * width + x0 + x;
        if (labels[i] || closed?.[i]) continue;
        const z = grid[i];
        if (Number.isNaN(z)) continue;
        const u = x0 + x - cx;
        const v = y0 + y - cy;
        n++;
        su += u;
        sv += v;
        sz += z;
        suu += u * u;
        svv += v * v;
        suv += u * v;
        suz += u * z;
        svz += v * z;
      }
    }
    if (n < band.minPixels) continue;
    const [a, b, c] = solvePlane(n, su, sv, sz, suu, svv, suv, suz, svz);
    // Distance INTO the footprint from its outline (chessboard, the same two passes).
    if (inner.length < bw * bh) inner = new Int32Array(bw * bh * 2);
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        inner[y * bw + x] = labels[(y0 + y) * width + x0 + x] === label ? far : 0;
      }
    }
    chessboard(inner, bw, bh);
    const above: number[] = [];
    const edge: number[] = [];
    let max = Number.NEGATIVE_INFINITY;
    let at = -1;
    for (let y = box[k * 4 + 1]; y <= box[k * 4 + 3]; y++) {
      for (let x = box[k * 4]; x <= box[k * 4 + 2]; x++) {
        const i = y * width + x;
        if (labels[i] !== label) continue;
        const z = grid[i];
        if (Number.isNaN(z)) continue;
        const d = z - (a + b * (x - cx) + c * (y - cy));
        above.push(d);
        if (inner[(y - y0) * bw + (x - x0)] <= band.fromPx) edge.push(d);
        if (d > max) {
          max = d;
          at = i;
        }
      }
    }
    if (above.length === 0) continue;
    above.sort((p, q) => p - q);
    edge.sort((p, q) => p - q);
    out.push({
      label,
      pixels: above.length,
      ringPixels: n,
      maxAboveM: max,
      p90AboveM: above[Math.min(above.length - 1, Math.floor(above.length * 0.9))],
      edgeAboveM: edge.length ? edge[edge.length >> 1] : above[above.length >> 1],
      at,
    });
  }
  return out;
}

/** Chessboard distance transform in place: 0 pixels are the seeds, the rest start far. */
function chessboard(distance: Int32Array, bw: number, bh: number) {
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const j = y * bw + x;
      let d = distance[j];
      if (x > 0) d = Math.min(d, distance[j - 1] + 1);
      if (y > 0) {
        d = Math.min(d, distance[j - bw] + 1);
        if (x > 0) d = Math.min(d, distance[j - bw - 1] + 1);
        if (x < bw - 1) d = Math.min(d, distance[j - bw + 1] + 1);
      }
      distance[j] = d;
    }
  }
  for (let y = bh - 1; y >= 0; y--) {
    for (let x = bw - 1; x >= 0; x--) {
      const j = y * bw + x;
      let d = distance[j];
      if (x < bw - 1) d = Math.min(d, distance[j + 1] + 1);
      if (y < bh - 1) {
        d = Math.min(d, distance[j + bw] + 1);
        if (x < bw - 1) d = Math.min(d, distance[j + bw + 1] + 1);
        if (x > 0) d = Math.min(d, distance[j + bw - 1] + 1);
      }
      distance[j] = d;
    }
  }
}

/**
 * The least-squares plane from its sums; a ring too thin to tilt (all on one
 * line) is its mean, level.
 */
function solvePlane(
  n: number,
  su: number,
  sv: number,
  sz: number,
  suu: number,
  svv: number,
  suv: number,
  suz: number,
  svz: number,
): [number, number, number] {
  // Normal equations [n su sv; su suu suv; sv suv svv] · [a b c] = [sz suz svz], by Cramer.
  const det = n * (suu * svv - suv * suv) - su * (su * svv - suv * sv) + sv * (su * suv - suu * sv);
  if (Math.abs(det) <= 1e-9 * n * Math.max(1, suu * svv)) return [sz / n, 0, 0];
  const a =
    (sz * (suu * svv - suv * suv) - su * (suz * svv - suv * svz) + sv * (suz * suv - suu * svz)) /
    det;
  const b =
    (n * (suz * svv - suv * svz) - sz * (su * svv - suv * sv) + sv * (su * svz - suz * sv)) / det;
  const c =
    (n * (suu * svz - suz * suv) - su * (su * svz - suz * sv) + sz * (su * suv - suu * sv)) / det;
  return [a, b, c];
}
