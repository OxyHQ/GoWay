/**
 * The city-3D far field: which tiles a camera sees, at which level of detail,
 * within which budget, and how one level hands over to the next.
 *
 * The camera is built here the way MapLibre builds its mercator → clip
 * matrix (a perspective of 36.87° vertical field of view, the eye one focal
 * length from the centre, pitched and turned about it), so the tests exercise
 * the same matrix shape the engine receives — not a matrix produced by the
 * code under test.
 */
import { describe, expect, test } from 'bun:test';

import {
  boxOutsideFrustum,
  eyeFromProjection,
  fitBudget,
  frustumPlanes,
  groundUnderCentre,
  invertMat4,
  LOD_POLICY,
  type Lod,
  type LodPolicy,
  type LodTile,
  lodForDistance,
  lodThresholds,
  metresPerPixel,
  selectLodTiles,
} from '@/components/map/engine/city3d/lod';
import {
  latFromMercatorY,
  mercatorXFromLng,
  mercatorYFromLat,
  mercatorPerMetre,
  multiplyMat4,
  tileKey,
} from '@/components/map/engine/city3d/tileMath';
import { FADE_MS, Transitions } from '@/components/map/engine/city3d/transitions';

// ---------------------------------------------------------------------------
// A MapLibre-shaped camera
// ---------------------------------------------------------------------------

const FOV = (36.87 * Math.PI) / 180;

type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a: V3): V3 => {
  const l = Math.hypot(...a);
  return [a[0] / l, a[1] / l, a[2] / l];
};
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function lookAt(eye: V3, target: V3, up: V3): number[] {
  const f = norm(sub(target, eye));
  const s = norm(cross(f, up));
  const u = cross(s, f);
  // biome-ignore format: a 4×4 matrix reads as four columns.
  return [
    s[0], u[0], -f[0], 0,
    s[1], u[1], -f[1], 0,
    s[2], u[2], -f[2], 0,
    -dot(s, eye), -dot(u, eye), dot(f, eye), 1,
  ];
}

function perspective(fovy: number, aspect: number, near: number, far: number): number[] {
  const f = 1 / Math.tan(fovy / 2);
  // biome-ignore format: a 4×4 matrix reads as four columns.
  return [
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) / (near - far), -1,
    0, 0, (2 * far * near) / (near - far), 0,
  ];
}

interface Camera {
  lng: number;
  lat: number;
  zoom: number;
  pitch: number;
  bearing?: number;
  width?: number;
  height?: number;
  /** The ground's elevation under the camera, metres (3D terrain). */
  groundM?: number;
}

/** The camera's matrix, bounds and centre, as the engine's `CityView` carries them. */
function camera(c: Camera) {
  const width = c.width ?? 1280;
  const height = c.height ?? 800;
  const pitch = (c.pitch * Math.PI) / 180;
  const bearing = ((c.bearing ?? 0) * Math.PI) / 180;
  const focal = 0.5 / Math.tan(FOV / 2);
  // The eye is one focal length (in pixels) from the centre; in mercator units:
  const distance = (focal * height) / (512 * 2 ** c.zoom);
  const groundZ = (c.groundM ?? 0) * mercatorPerMetre(c.lat);
  const centre: V3 = [mercatorXFromLng(c.lng), mercatorYFromLat(c.lat), groundZ];
  // Mercator y grows south: "north" is -y. Bearing turns clockwise from north.
  const north: V3 = [Math.sin(bearing), -Math.cos(bearing), 0];
  const eye: V3 = [
    centre[0] - north[0] * distance * Math.sin(pitch),
    centre[1] - north[1] * distance * Math.sin(pitch),
    groundZ + distance * Math.cos(pitch),
  ];
  // Far plane just past the top of the screen, or the horizon, as MapLibre does.
  const topAngle = pitch + FOV / 2;
  const far = topAngle < Math.PI / 2 - 0.01 ? (1.01 * eye[2]) / Math.cos(topAngle) : distance * 100;
  const matrix = multiplyMat4(
    perspective(FOV, width / height, distance / 50, far),
    lookAt(eye, centre, north),
  );

  // Bounds: the ground under the four screen corners (or as far as the far plane).
  const inverse = invertMat4(matrix) as number[];
  const unproject = (x: number, y: number, z: number): V3 => {
    const v = [0, 1, 2, 3].map(
      (row) => inverse[row] * x + inverse[4 + row] * y + inverse[8 + row] * z + inverse[12 + row],
    );
    return [v[0] / v[3], v[1] / v[3], v[2] / v[3]];
  };
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [sx, sy] of [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ]) {
    const a = unproject(sx, sy, -1);
    const b = unproject(sx, sy, 1);
    const t = b[2] < groundZ ? (a[2] - groundZ) / (a[2] - b[2]) : 1;
    xs.push(a[0] + (b[0] - a[0]) * t);
    ys.push(a[1] + (b[1] - a[1]) * t);
  }
  const lngOf = (x: number) => x * 360 - 180;
  return {
    mercatorToClip: matrix,
    zoom: c.zoom,
    center: { lng: c.lng, lat: c.lat },
    bounds: {
      west: lngOf(Math.min(...xs)),
      east: lngOf(Math.max(...xs)),
      north: latFromMercatorY(Math.min(...ys)),
      south: latFromMercatorY(Math.max(...ys)),
    },
    eye,
    groundCorners: xs.map((x, i) => [x, ys[i]] as [number, number]),
  };
}

const BARCELONA = { lng: 2.1686, lat: 41.3874 };

// ---------------------------------------------------------------------------

describe('the camera, from its projection alone', () => {
  test('the eye is recovered from the matrix', () => {
    for (const pitch of [0, 45, 60, 80]) {
      const view = camera({ ...BARCELONA, zoom: 16, pitch, bearing: 30 });
      const eye = eyeFromProjection(view.mercatorToClip);
      expect(eye).not.toBeNull();
      const scale = view.eye[2] || 1e-9;
      expect(Math.abs((eye?.x ?? 0) - view.eye[0]) / scale).toBeLessThan(1e-6);
      expect(Math.abs((eye?.y ?? 0) - view.eye[1]) / scale).toBeLessThan(1e-6);
      expect(Math.abs((eye?.z ?? 0) - view.eye[2]) / scale).toBeLessThan(1e-6);
    }
  });

  test('the ground under the screen centre is the map centre', () => {
    const view = camera({ ...BARCELONA, zoom: 16, pitch: 60, bearing: -40 });
    const ground = groundUnderCentre(view.mercatorToClip);
    const unit = view.eye[2];
    expect(Math.abs((ground?.x ?? 0) - mercatorXFromLng(BARCELONA.lng)) / unit).toBeLessThan(1e-6);
    expect(Math.abs((ground?.y ?? 0) - mercatorYFromLat(BARCELONA.lat)) / unit).toBeLessThan(1e-6);
  });

  test('a box in front of the camera is inside the frustum, one behind it is not', () => {
    const view = camera({ ...BARCELONA, zoom: 16, pitch: 60 });
    const planes = frustumPlanes(view.mercatorToClip);
    const cx = mercatorXFromLng(BARCELONA.lng);
    const cy = mercatorYFromLat(BARCELONA.lat);
    const d = 1e-5;
    expect(boxOutsideFrustum(planes, [cx - d, cy - d, 0], [cx + d, cy + d, d])).toBe(false);
    // Bearing 0 looks north (-y): a box well SOUTH of the eye is behind it.
    const behind = view.eye[1] + 0.001;
    expect(boxOutsideFrustum(planes, [cx - d, behind, 0], [cx + d, behind + d, d])).toBe(true);
  });
});

describe('level thresholds', () => {
  test('metres per pixel halves with every zoom level', () => {
    const at16 = metresPerPixel(16, BARCELONA.lat);
    // MapLibre's 512-pixel tiles: 0.9 m a pixel at zoom 16 in Barcelona.
    expect(at16).toBeCloseTo(0.895, 3);
    expect(metresPerPixel(17, BARCELONA.lat)).toBeCloseTo(at16 / 2, 10);
  });

  test('zoomed in, full detail reaches further; the floors hold zoomed out', () => {
    const z16 = lodThresholds(LOD_POLICY, metresPerPixel(16, BARCELONA.lat));
    const z18 = lodThresholds(LOD_POLICY, metresPerPixel(18, BARCELONA.lat));
    const z14 = lodThresholds(LOD_POLICY, metresPerPixel(14, BARCELONA.lat));
    expect(z18[0]).toBeGreaterThan(z16[0]);
    expect(z18[1]).toBeGreaterThan(z16[1]);
    expect(z14[0]).toBe(LOD_POLICY.minFullWithin);
    expect(z14[1]).toBe(LOD_POLICY.minSimpleWithin);
    for (const limits of [z14, z16, z18]) {
      expect(limits[0]).toBeLessThanOrEqual(limits[1]);
      expect(limits[1]).toBeLessThanOrEqual(limits[2]);
    }
  });

  test('each level’s error stays under the pixel tolerance where it is drawn', () => {
    for (const zoom of [15.5, 16, 17, 18]) {
      const mpp = metresPerPixel(zoom, BARCELONA.lat);
      const [full, simple] = lodThresholds(LOD_POLICY, mpp);
      // Level 1 starts at `full`, level 2 at `simple`: error / (r · mpp) pixels.
      expect(LOD_POLICY.levelErrorM[0] / (full * mpp)).toBeLessThanOrEqual(
        LOD_POLICY.pixelTolerance + 1e-9,
      );
      expect(LOD_POLICY.levelErrorM[1] / (simple * mpp)).toBeLessThanOrEqual(
        LOD_POLICY.pixelTolerance + 1e-9,
      );
    }
  });

  test('hysteresis holds a level near its threshold, in both directions', () => {
    const limits: [number, number, number] = [1, 3, 12];
    expect(lodForDistance(0.9, limits, 0.1)).toBe(0);
    expect(lodForDistance(1.05, limits, 0.1)).toBe(1);
    // Was full detail, now just past the limit: stays full…
    expect(lodForDistance(1.05, limits, 0.1, 0)).toBe(0);
    // …until past it by the margin.
    expect(lodForDistance(1.15, limits, 0.1, 0)).toBe(1);
    // Was level 1, now just inside the full limit: stays level 1…
    expect(lodForDistance(0.95, limits, 0.1, 1)).toBe(1);
    expect(lodForDistance(0.85, limits, 0.1, 1)).toBe(0);
    // Beyond the draw limit nothing, unless it was drawn and is within the margin.
    expect(lodForDistance(12.5, limits, 0.1)).toBeNull();
    expect(lodForDistance(12.5, limits, 0.1, 2)).toBe(2);
  });
});

/** Every z14 tile under the visible ground, sampled on a grid. */
function visibleTiles(view: ReturnType<typeof camera>): Set<string> {
  const n = 2 ** 14;
  const [a, b, c, d] = view.groundCorners;
  const out = new Set<string>();
  for (let i = 0; i <= 40; i++) {
    for (let j = 0; j <= 40; j++) {
      const u = i / 40;
      const v = j / 40;
      // Bilinear over the ground quad (bottom-left, bottom-right, top-right, top-left).
      const x = (1 - v) * ((1 - u) * a[0] + u * b[0]) + v * ((1 - u) * d[0] + u * c[0]);
      const y = (1 - v) * ((1 - u) * a[1] + u * b[1]) + v * ((1 - u) * d[1] + u * c[1]);
      out.add(tileKey({ z: 14, x: Math.floor(x * n), y: Math.floor(y * n) }));
    }
  }
  return out;
}

describe('selectLodTiles', () => {
  test('a tilted wide view draws every tile it sees — more than the old six', () => {
    const view = camera({
      ...BARCELONA,
      zoom: 15.6,
      pitch: 60,
      bearing: -35,
      width: 1920,
      height: 1080,
    });
    const tiles = selectLodTiles(view, 14);
    const selected = new Set(tiles.map(tileKey));
    const seen = visibleTiles(view);
    expect(seen.size).toBeGreaterThan(6);
    for (const key of seen) expect(selected.has(key)).toBe(true);
  });

  test('a turned view culls the corners of its bounding box', () => {
    // Turned 45°, the visible ground is a rotated trapezoid; its lng/lat box
    // holds tiles no ray from the camera reaches.
    const view = camera({
      ...BARCELONA,
      zoom: 15.6,
      pitch: 60,
      bearing: 45,
      width: 1920,
      height: 1080,
    });
    const n = 2 ** 14;
    const x0 = Math.floor(mercatorXFromLng(view.bounds.west) * n);
    const x1 = Math.floor(mercatorXFromLng(view.bounds.east) * n);
    const y0 = Math.floor(mercatorYFromLat(view.bounds.north) * n);
    const y1 = Math.floor(mercatorYFromLat(view.bounds.south) * n);
    const inBox = (x1 - x0 + 1) * (y1 - y0 + 1);
    const tiles = selectLodTiles(view, 14);
    expect(tiles.length).toBeLessThan(inBox);
    // …and still draws every tile it sees.
    const selected = new Set(tiles.map(tileKey));
    for (const key of visibleTiles(view)) expect(selected.has(key)).toBe(true);
  });

  test('a steep view reaches the coarse level toward the horizon', () => {
    const view = camera({ ...BARCELONA, zoom: 16, pitch: 80 });
    const tiles = selectLodTiles(view, 14);
    expect(tiles.some((t) => t.lod === 2)).toBe(true);
    expect(tiles.some((t) => t.lod === 0)).toBe(true);
    expect(tiles.length).toBeLessThanOrEqual(LOD_POLICY.maxTiles);
  });

  test('levels never get finer with distance, and full detail is capped', () => {
    for (const pitch of [0, 40, 60, 75]) {
      const view = camera({ ...BARCELONA, zoom: 16.5, pitch, bearing: 15 });
      const tiles = selectLodTiles(view, 14);
      expect(tiles.length).toBeGreaterThan(0);
      for (let i = 1; i < tiles.length; i++) {
        expect(tiles[i].r).toBeGreaterThanOrEqual(tiles[i - 1].r);
        expect(tiles[i].lod).toBeGreaterThanOrEqual(tiles[i - 1].lod);
      }
      expect(tiles.filter((t) => t.lod === 0).length).toBeLessThanOrEqual(LOD_POLICY.maxFullTiles);
    }
  });

  test('the budgets of the policy bound the set', () => {
    const tight: LodPolicy = { ...LOD_POLICY, maxFullTiles: 1, maxTiles: 3 };
    const view = camera({ ...BARCELONA, zoom: 16, pitch: 80 });
    const tiles = selectLodTiles(view, 14, tight);
    expect(tiles.length).toBe(3);
    expect(tiles.filter((t) => t.lod === 0).length).toBe(1);
    expect(tiles[0].lod).toBe(0);
  });

  test('nothing behind the camera, nothing for a camera under the ground', () => {
    const view = camera({ ...BARCELONA, zoom: 16, pitch: 60 });
    const eyeTileY = Math.floor(view.eye[1] * 2 ** 14);
    // Looking north (-y): every tile drawn is at or north of the eye's own row.
    for (const tile of selectLodTiles(view, 14)) expect(tile.y).toBeLessThanOrEqual(eyeTileY);
    const flipped = view.mercatorToClip.map((v, i) => (i === 14 ? -v : v));
    expect(selectLodTiles({ ...view, mercatorToClip: flipped }, 14).length).toBeLessThanOrEqual(
      selectLodTiles(view, 14).length,
    );
  });

  test('across the antimeridian both sides are drawn, each in its own world copy', () => {
    const view = camera({ lng: 179.995, lat: 0, zoom: 16, pitch: 0 });
    const tiles = selectLodTiles(view, 14);
    const east = tiles.find((t) => t.x === 0);
    const west = tiles.find((t) => t.x === 2 ** 14 - 1);
    expect(east?.wrap).toBe(1);
    expect(west?.wrap).toBe(0);
  });

  test('on terrain, a city on a high plateau is still seen (its boxes stand on the ground)', () => {
    // 2,000 m up; MapLibre's far plane ends just past the ground, so a box at
    // sea level is beyond it.
    const view = camera({ ...BARCELONA, zoom: 16, pitch: 50, groundM: 2000 });
    const seaLevel = selectLodTiles(view, 14);
    const terrain = selectLodTiles(
      { ...view, terrain: { centreM: 2000, minM: 1700, maxM: 2300 } },
      14,
    );
    const centre = tileKey({
      z: 14,
      x: Math.floor(mercatorXFromLng(BARCELONA.lng) * 2 ** 14),
      y: Math.floor(mercatorYFromLat(BARCELONA.lat) * 2 ** 14),
    });
    expect(seaLevel.map(tileKey)).not.toContain(centre);
    expect(terrain.map(tileKey)).toContain(centre);
    // Distances are to the ground the camera looks at, so the tile under the
    // centre is about one camera distance away.
    const under = terrain.find((t) => tileKey(t) === centre);
    expect(under?.r).toBeLessThan(1.05);
  });

  test('a level held by hysteresis is the one passed in', () => {
    const view = camera({ ...BARCELONA, zoom: 16, pitch: 60 });
    const first = selectLodTiles(view, 14);
    const previous = new Map<string, Lod>(first.map((t) => [tileKey(t), t.lod]));
    const again = selectLodTiles(view, 14, LOD_POLICY, previous);
    expect(again.map((t) => `${tileKey(t)}@${t.lod}`)).toEqual(
      first.map((t) => `${tileKey(t)}@${t.lod}`),
    );
  });
});

describe('fitBudget', () => {
  const tile = (x: number, r: number, lod: Lod): LodTile => ({ z: 14, x, y: 0, wrap: 0, lod, r });
  // Level 0 costs 10 (bytes and vertices), level 1 5, level 2 2.
  const COST = [10, 5, 2];
  const cost = (_: LodTile, lod: Lod) => ({ bytes: COST[lod], vertices: COST[lod] });

  test('within budget, nothing changes', () => {
    const tiles = [tile(0, 0.5, 0), tile(1, 2, 1)];
    expect(fitBudget(tiles, cost, { bytes: 100, vertices: 100 })).toEqual(tiles);
  });

  test('the farthest tile gives up detail first; the nearest keeps it', () => {
    const tiles = [tile(0, 0.5, 0), tile(1, 1, 0), tile(2, 3, 1), tile(3, 5, 1)];
    // 10 + 10 + 5 + 5 = 30; budget 24.
    const out = fitBudget(tiles, cost, { bytes: 24, vertices: 1000 });
    expect(out.map((t) => t.lod)).toEqual([0, 0, 2, 2]);
    // Tighter: the second-nearest goes too, the nearest never before them.
    const tighter = fitBudget(tiles, cost, { bytes: 16, vertices: 1000 });
    expect(tighter.map((t) => t.lod)).toEqual([0, 2, 2, 2]);
  });

  test('when even level 2 is over, the farthest are dropped, never the last', () => {
    const tiles = [tile(0, 0.5, 0), tile(1, 1, 1), tile(2, 3, 2)];
    const out = fitBudget(tiles, cost, { bytes: 4, vertices: 1000 });
    expect(out.map((t) => t.x)).toEqual([0, 1]);
    expect(out.every((t) => t.lod === 2)).toBe(true);
    expect(fitBudget(tiles, cost, { bytes: 0, vertices: 0 }).length).toBe(1);
  });

  test('the vertex budget is a budget too', () => {
    const tiles = [tile(0, 0.5, 0), tile(1, 1, 0)];
    const out = fitBudget(tiles, cost, { bytes: 1000, vertices: 15 });
    expect(out.map((t) => t.lod)).toEqual([0, 1]);
  });

  test('the input is not modified', () => {
    const tiles = [tile(0, 0.5, 0), tile(1, 1, 0)];
    fitBudget(tiles, cost, { bytes: 1, vertices: 1 });
    expect(tiles.map((t) => t.lod)).toEqual([0, 0]);
  });
});

describe('Transitions', () => {
  /** How much of the screen a frame's draws cover, by noise window (union). */
  const covered = (draws: { from: number; to: number }[]) => {
    const steps = 1000;
    let hit = 0;
    for (let i = 0; i < steps; i++) {
      const noise = (i + 0.5) / steps;
      if (draws.some((d) => noise >= d.from && noise < d.to)) hit++;
    }
    return hit / steps;
  };
  /** No pixel kept by two meshes at once. */
  const disjoint = (draws: { from: number; to: number }[]) =>
    draws.every((a, i) => draws.every((b, j) => i === j || a.to <= b.from || b.to <= a.from));

  test('a new slot fades in over FADE_MS', () => {
    const t = new Transitions<string>();
    t.begin();
    t.show('a', 'mesh', 0);
    expect(t.draws(0).draws).toEqual([{ value: 'mesh', from: 0, to: 0 }]);
    t.begin();
    t.show('a', 'mesh', FADE_MS / 2);
    const half = t.draws(FADE_MS / 2);
    expect(half.draws[0].to).toBeCloseTo(0.5, 10);
    expect(half.active).toBe(true);
    t.begin();
    t.show('a', 'mesh', FADE_MS);
    expect(t.draws(FADE_MS)).toEqual({ draws: [{ value: 'mesh', from: 0, to: 1 }], active: false });
  });

  test('a level swap is complementary: every pixel drawn exactly once, all the way', () => {
    const t = new Transitions<string>();
    t.begin();
    t.show('a', 'coarse', 0);
    t.draws(0);
    t.begin();
    t.show('a', 'coarse', FADE_MS * 2);
    t.draws(FADE_MS * 2);
    for (const now of [1000, 1000 + FADE_MS / 3, 1000 + (2 * FADE_MS) / 3]) {
      t.begin();
      t.show('a', 'fine', now);
      const { draws } = t.draws(now);
      expect(draws.map((d) => d.value).sort()).toEqual(['coarse', 'fine']);
      expect(disjoint(draws)).toBe(true);
      expect(covered(draws)).toBeCloseTo(1, 2);
    }
    t.begin();
    t.show('a', 'fine', 1000 + FADE_MS);
    expect(t.draws(1000 + FADE_MS).draws).toEqual([{ value: 'fine', from: 0, to: 1 }]);
  });

  test('retargeted mid-fade, the leaving mesh keeps the coverage it had — no jump to opaque', () => {
    const t = new Transitions<string>();
    t.begin();
    t.show('a', 'first', 0);
    t.draws(0);
    // 40% in, the target changes.
    const at = FADE_MS * 0.4;
    t.begin();
    t.show('a', 'first', at);
    const before = covered(t.draws(at).draws);
    expect(before).toBeCloseTo(0.4, 2);
    t.begin();
    t.show('a', 'second', at);
    const after = t.draws(at).draws;
    expect(covered(after)).toBeCloseTo(before, 2);
    expect(disjoint(after)).toBe(true);
    // Coverage only grows from there, and the swap completes.
    let last = before;
    for (const now of [at + FADE_MS * 0.2, at + FADE_MS * 0.6, at + FADE_MS * 0.9]) {
      t.begin();
      t.show('a', 'second', now);
      const draws = t.draws(now).draws;
      const c = covered(draws);
      expect(c).toBeGreaterThanOrEqual(last - 1e-9);
      expect(disjoint(draws)).toBe(true);
      last = c;
    }
    t.begin();
    t.show('a', 'second', at + FADE_MS);
    expect(t.draws(at + FADE_MS).draws).toEqual([{ value: 'second', from: 0, to: 1 }]);
  });

  test('a slot no longer shown dissolves from where it is and is forgotten', () => {
    const t = new Transitions<string>();
    t.begin();
    t.show('a', 'mesh', 0);
    t.draws(FADE_MS);
    t.begin();
    t.show('a', 'mesh', FADE_MS);
    t.draws(FADE_MS);
    t.begin(); // 'a' not shown this frame
    const leaving = t.draws(FADE_MS * 1.5);
    expect(leaving.draws).toEqual([{ value: 'mesh', from: 0, to: 1 }]);
    expect([...t.inUse()]).toEqual(['mesh']);
    t.begin();
    const half = t.draws(FADE_MS * 2);
    expect(half.draws[0].to).toBeCloseTo(0.5, 10);
    t.begin();
    const later = t.draws(FADE_MS * 3);
    expect(later.draws).toEqual([]);
    expect([...t.inUse()]).toEqual([]);
  });

  test('a freed value is dropped from every slot', () => {
    const t = new Transitions<string>();
    t.begin();
    t.show('a', 'mesh', 0);
    t.drop('mesh');
    expect(t.shown('a')).toBeNull();
    expect(t.draws(0).draws).toEqual([]);
  });
});
