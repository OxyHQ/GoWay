/**
 * Measure the city-life simulation on a real road archive, off the browser:
 * network build time and size, step time at budget, and the invariants the
 * renderer depends on (no two cars overlapping on a lane, every car on a
 * path heading its way).
 *
 * ```bash
 * bun run --cwd packages/frontend scripts/bench-city-life.ts \
 *   --archive=.tiles/city-roads-barcelona-z15.pmtiles --lat=41.3925 --lng=2.164 --zoom=17
 * ```
 *
 * The numbers in `docs/MAP_CITY_LIFE.md` → "Performance" come from here.
 */
import { open } from 'node:fs/promises';

import {
  decodeOmtRoads,
  healRoads,
  type OmtLine,
  piecesForTiles,
} from '../components/map/engine/cityLife/omtRoads';
import { type DecodedRoadTile, decodeRoadTile } from '../components/map/engine/cityLife/roadTiles';
import { drivingSideAt } from '../components/map/engine/cityLife/sim/drivingSide';
import { buildNetwork, simFrame } from '../components/map/engine/cityLife/sim/network';
import {
  activeRadius,
  CitySimulation,
  STEP_S,
} from '../components/map/engine/cityLife/sim/simulation';
import { CITY_TILE_ZOOM } from '../lib/map/cityTiles';
import { PMTiles } from '../worker/pmtiles.js';

const args = Object.fromEntries(
  process.argv.slice(2).map((raw) => {
    const [key, value] = raw.replace(/^--/, '').split('=', 2);
    return [key, value ?? 'true'];
  }),
);
const archivePath = args.archive;
// `--basemap=<{z}/{x}/{y} template>`: heal the basemap's roads instead (worldwide).
const basemapTemplate = args.basemap;
if (!archivePath && !basemapTemplate) {
  throw new Error('--archive=<roads.pmtiles> or --basemap=<https://…/{z}/{x}/{y}.pbf>');
}
const lat = Number(args.lat ?? 41.3925);
const lng = Number(args.lng ?? 2.164);
const zoom = Number(args.zoom ?? 17);
const seconds = Number(args.seconds ?? 120);
const budget = { cars: Number(args.cars ?? 1500), people: Number(args.people ?? 1500) };

const z = CITY_TILE_ZOOM;
const n = 2 ** z;
const fx = ((lng + 180) / 360) * n;
const phi = (lat * Math.PI) / 180;
const fy = ((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2) * n;
const origin = { x: Math.floor(fx), y: Math.floor(fy) };
const frame = simFrame(origin.x, origin.y);
const tileMetres = 4096 * frame.metresPerUnit;
const r = activeRadius(zoom);
const reach = Math.ceil((r + 300) / tileMetres);

const tiles: { x: number; y: number; data: DecodedRoadTile }[] = [];
let decodeMs = 0;
if (archivePath) {
  const handle = await open(archivePath, 'r');
  const archive = new PMTiles({
    async read(offset: number, length: number) {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      return new Uint8Array(buffer.subarray(0, bytesRead));
    },
  });
  for (let dx = -reach; dx <= reach; dx++) {
    for (let dy = -reach; dy <= reach; dy++) {
      const tile = await archive.getTile(z, origin.x + dx, origin.y + dy);
      if (!tile) continue;
      const t0 = performance.now();
      const data = decodeRoadTile(Bun.gunzipSync(tile.bytes), {
        x: origin.x + dx,
        y: origin.y + dy,
      });
      decodeMs += performance.now() - t0;
      tiles.push({ x: origin.x + dx, y: origin.y + dy, data });
    }
  }
  await handle.close();
} else if (basemapTemplate) {
  // The basemap's z14 tiles over the same z15 neighbourhood, healed.
  const keep = new Set<string>();
  const parents = new Set<string>();
  for (let dx = -reach; dx <= reach; dx++) {
    for (let dy = -reach; dy <= reach; dy++) {
      keep.add(`${origin.x + dx}/${origin.y + dy}`);
      parents.add(`${(origin.x + dx) >> 1}/${(origin.y + dy) >> 1}`);
    }
  }
  const lines: OmtLine[] = [];
  for (const parent of parents) {
    const [px, py] = parent.split('/').map(Number);
    const url = basemapTemplate
      .replace('{z}', '14')
      .replace('{x}', String(px))
      .replace('{y}', String(py));
    const response = await fetch(url);
    if (!response.ok) continue;
    const bytes = new Uint8Array(await response.arrayBuffer());
    const t0 = performance.now();
    lines.push(...decodeOmtRoads(bytes, { z: 14, x: px, y: py }, 'transportation'));
    decodeMs += performance.now() - t0;
  }
  const t0 = performance.now();
  const result = healRoads(lines, frame.metresPerUnit);
  const byTile = piecesForTiles(result, keep);
  console.log(`heal ${(performance.now() - t0).toFixed(0)} ms`, result.stats);
  for (const key of keep) {
    const [x, y] = key.split('/').map(Number);
    tiles.push({ x, y, data: byTile.get(key) ?? { pieces: [], nodes: [], restrictions: [] } });
  }
}

const network = buildNetwork({ tiles, frame, drivingSide: drivingSideAt(lng, lat), seed: 7 });
console.log(`tiles ${tiles.length} (decode ${decodeMs.toFixed(0)} ms), radius ${r} m`);
console.log('network', network.stats);

const cx = (fx - origin.x) * tileMetres;
const cy = -(fy - origin.y) * tileMetres;
const half = 350 * 2 ** (17 - zoom);
const sim = new CitySimulation(budget, 11);
sim.setNetwork(network);
sim.setView({
  cx,
  cy,
  zoom,
  box: { x0: cx - half, y0: cy - half * 0.7, x1: cx + half, y1: cy + half * 0.7 },
});

const t0 = performance.now();
sim.step(); // includes warm-up
const warmMs = performance.now() - t0;
const times: number[] = [];
let overlaps = 0;
let worst = 0;
for (let i = 0; i < seconds / STEP_S; i++) {
  const t = performance.now();
  sim.step();
  times.push(performance.now() - t);
  // No two cars on one path closer than their half-lengths.
  const byPath = new Map<number, number[]>();
  for (let car = 0; car < sim.cars.capacity; car++) {
    if (!sim.cars.alive[car]) continue;
    const list = byPath.get(sim.cars.path[car]);
    if (list) list.push(car);
    else byPath.set(sim.cars.path[car], [car]);
  }
  for (const list of byPath.values()) {
    list.sort((a, b) => sim.cars.s[a] - sim.cars.s[b]);
    for (let k = 1; k < list.length; k++) {
      const a = list[k - 1];
      const b = list[k];
      const gap = sim.cars.s[b] - sim.cars.s[a] - (sim.cars.length[a] + sim.cars.length[b]) / 2;
      if (gap < -0.01) {
        overlaps++;
        worst = Math.min(worst, gap);
      }
    }
  }
}
times.sort((a, b) => a - b);
const pct = (p: number) => times[Math.floor((p / 100) * (times.length - 1))].toFixed(2);
let moving = 0;
let speedSum = 0;
for (let car = 0; car < sim.cars.capacity; car++) {
  if (!sim.cars.alive[car]) continue;
  speedSum += sim.cars.v[car];
  if (sim.cars.v[car] > 0.5) moving++;
}
console.log(
  `warm-up ${warmMs.toFixed(0)} ms; step p50 ${pct(50)} ms, p95 ${pct(95)} ms, max ${pct(100)} ms`,
);
console.log('sim', sim.stats, {
  moving,
  meanSpeedKmh: ((speedSum / Math.max(1, sim.stats.cars)) * 3.6).toFixed(1),
  overlaps,
  worst,
});
