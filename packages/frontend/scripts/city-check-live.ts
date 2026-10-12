/**
 * After a manifest is published: is it what the edge serves, and does every
 * region it adds answer?
 *
 * ```bash
 * bun packages/frontend/scripts/city-check-live.ts --manifest=<manifest.json> \
 *   --entries=<dir with entries/ and the receipts> [--origin=https://goway.to] \
 *   [--probe=<name>:<lat>,<lng>[,<status>]]…
 * ```
 *
 * Waits (up to ~10 minutes: the Worker keeps a manifest five minutes per colo
 * and one per isolate) until `/map/city/manifest.json` is this manifest, then
 * checks that `/map/city/coverage.json` lists every region in it, and that
 * each region of THIS run answers its densest building tile (the receipt's
 * `tileRawBytes.maxTile`) with 200 and the same tile's roads with 200 or 204.
 * `--probe` adds named points anywhere (default expected status 200). Exit 1
 * names every failure.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

interface Entry {
  id: string;
  city: { key: string; receipt: string } | null;
  roads: { key: string; receipt: string } | null;
}

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .filter((raw) => !raw.startsWith('--probe='))
    .map((raw) => {
      const [flag, value] = raw.replace(/^--/, '').split('=', 2);
      return [flag, value ?? 'true'];
    }),
);
const probes = process.argv
  .slice(2)
  .filter((raw) => raw.startsWith('--probe='))
  .map((raw) => {
    const [name, rest] = raw.slice('--probe='.length).split(':', 2);
    const [lat, lng, status] = rest.split(',');
    return { name, lat: Number(lat), lng: Number(lng), status: Number(status ?? 200) };
  });
const origin = (args.origin ?? 'https://goway.to').replace(/\/+$/, '');
if (!args.manifest) throw new Error('--manifest=<file> is required');

const manifest = JSON.parse(await readFile(args.manifest, 'utf8')) as {
  generatedAt: string;
  regions: Entry[];
};
const fresh: Entry[] = [];
if (args.entries) {
  const dir = join(args.entries, 'entries');
  for (const name of (await readdir(dir)).filter((n) => n.endsWith('.json'))) {
    fresh.push(JSON.parse(await readFile(join(dir, name), 'utf8')));
  }
}

const problems: string[] = [];
const get = (path: string) =>
  fetch(`${origin}${path}`, { headers: { 'cache-control': 'no-cache' } });

// 1. The edge serves this manifest.
let served = '';
for (let attempt = 0; attempt < 40; attempt++) {
  const response = await get('/map/city/manifest.json');
  served = response.ok
    ? (((await response.json()) as { generatedAt?: string }).generatedAt ?? '')
    : '';
  if (served === manifest.generatedAt) break;
  await Bun.sleep(15_000);
}
if (served !== manifest.generatedAt) {
  problems.push(
    `the edge serves the manifest of ${served || 'nothing'}, not ${manifest.generatedAt}`,
  );
} else {
  console.log(`· ${origin} serves the manifest of ${served}`);
}

// 2. Coverage lists every region.
const coverage = (await (await get('/map/city/coverage.json')).json()) as {
  regions?: { id: string }[];
};
const listed = new Set((coverage.regions ?? []).map((region) => region.id));
for (const region of manifest.regions) {
  if (!listed.has(region.id)) problems.push(`coverage does not list ${region.id}`);
}
console.log(
  `· coverage lists ${listed.size} regions (the manifest has ${manifest.regions.length})`,
);

// 3. Each region of this run answers its densest tile.
const tileOf = (lat: number, lng: number) => {
  const n = 2 ** 15;
  const phi = (lat * Math.PI) / 180;
  return {
    x: Math.floor(((lng + 180) / 360) * n),
    y: Math.floor(((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2) * n),
  };
};
for (const entry of fresh) {
  if (!entry.city) continue;
  const receipt = JSON.parse(
    await readFile(join(args.entries as string, entry.city.receipt), 'utf8'),
  ) as { tileRawBytes?: { maxTile?: string } };
  const tile = receipt.tileRawBytes?.maxTile;
  if (!tile) {
    problems.push(`${entry.id}: its receipt names no densest tile`);
    continue;
  }
  const city = await get(`/map/city/${tile}.pbf`);
  const bytes = (await city.arrayBuffer()).byteLength;
  if (city.status !== 200 || bytes === 0)
    problems.push(`${entry.id}: /map/city/${tile} → ${city.status}, ${bytes} B`);
  const roads = await get(`/map/city-roads/${tile}.pbf`);
  await roads.arrayBuffer();
  if (entry.roads && roads.status !== 200 && roads.status !== 204) {
    problems.push(`${entry.id}: /map/city-roads/${tile} → ${roads.status}`);
  }
  console.log(`· ${entry.id}: ${tile} city ${city.status} (${bytes} B), roads ${roads.status}`);
}

// 4. Named probes.
for (const probe of probes) {
  const { x, y } = tileOf(probe.lat, probe.lng);
  const response = await get(`/map/city/15/${x}/${y}.pbf`);
  const bytes = (await response.arrayBuffer()).byteLength;
  const ok = response.status === probe.status;
  if (!ok)
    problems.push(`${probe.name} 15/${x}/${y}: ${response.status}, expected ${probe.status}`);
  console.log(`· ${probe.name} 15/${x}/${y}: ${response.status} (${bytes} B)${ok ? '' : ' ✗'}`);
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`✗ ${problem}`);
  process.exit(1);
}
console.log('✓ live');
