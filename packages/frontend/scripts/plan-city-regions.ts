/**
 * Plan the planet build's regions: walk Geofabrik's hierarchy and choose the
 * extracts the world is compiled from, sized to the build machine.
 *
 * ```bash
 * bun run --cwd packages/frontend map:city-plan --cache=<dir>
 * #  → rewrites scripts/citygen/regions.json; review the diff, commit it.
 * ```
 *
 * Reads Geofabrik's `index-v1.json` (hierarchy and polygons), asks each
 * candidate extract's size with a HEAD request, and fetches the `.poly` of any
 * region the index carries no geometry for. Everything fetched is cached under
 * `--cache`, so a re-plan is cheap and offline once warm. It plans; it never
 * downloads an extract.
 *
 * ## The rules
 *
 * 1. **Fit the machine.** A region is built whole when its estimated peak
 *    memory (`peakMbPerPbfMb` × extract size — measured, see the doc) fits
 *    the runner; otherwise its Geofabrik children are used instead, and a
 *    region with no children is built in PARTS (`build-city-region.ts`).
 * 2. **No region twice.** Geofabrik also publishes groupings that overlap
 *    their members (`us` and its states, `dach`, `alps`,
 *    `britain-and-ireland`…). A chosen region whose polygon lies almost
 *    entirely inside the others chosen is dropped, largest first, so the
 *    grouping goes and the members stay. Overlap that remains is harmless (a
 *    tile owned twice is answered by the first region in the manifest) but
 *    costs a build.
 * 3. **Official data where it exists.** Regions inside a dataset's coverage
 *    are tagged with it (`official`), for the compiler's `--lod2` hook.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { geoJsonRings, parsePoly, type Ring } from './citygen/ownership';
import type { CityRegion, CityRegionCatalogue } from './citygen/regions';

const FRONTEND_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(FRONTEND_ROOT, 'scripts', 'citygen', 'regions.json');
const INDEX_URL = 'https://download.geofabrik.de/index-v1.json';
const GEOFABRIK = 'https://download.geofabrik.de/';

/**
 * The build machine and what one region costs on it.
 *
 * GitHub's standard Linux runner for a PUBLIC repository: 4 vCPU, 16 GB. The
 * peak per extract megabyte is the worst measured across the two compilers
 * and two countries (`docs/MAP_CITY_PLANET.md` → "Measured"): the
 * Netherlands' buildings, 19,076 MB peak from a 1,405 MB extract (13.6), the
 * dense end — rounded up to 14.
 */
const BUDGET = {
  runnerMemoryMb: 16_384,
  usableMemoryMb: 14_000,
  peakMbPerPbfMb: 14,
};
const MAX_PART_BYTES = Math.floor((BUDGET.usableMemoryMb / BUDGET.peakMbPerPbfMb) * 1e6);

/**
 * Official 3D building datasets, by the regions they cover (ids or prefixes
 * ending in `/`). Spain's Catastro covers the country except the two foral
 * territories, which keep their own cadastres; NYC's model covers New York
 * City, inside the state extract. Names are `feat/city-lod2`'s source ids.
 */
const OFFICIAL: { source: string; include: string[]; exclude: string[] }[] = [
  {
    source: 'es-catastro',
    include: ['europe/spain', 'europe/spain/', 'africa/canary-islands'],
    exclude: ['europe/spain/pais-vasco', 'europe/spain/navarra'],
  },
  { source: 'nyc-3dbm', include: ['north-america/us/new-york'], exclude: [] },
];

/**
 * Regions built in more parts than their extract needs, by id. The planner
 * sizes by extract bytes alone; a region that merges official data
 * (`OFFICIAL` above) also holds its official buildings, ~4 GB of RAM per GB of
 * GML (`docs/MAP_CITY_PLANET.md` → "Official data"). Raise a region here
 * when a dry run with `official: true` shows it does not fit, and re-plan.
 */
const MIN_PARTS: Record<string, number> = {
  // Measured 2026-10-12 on the runner: one part's roads were 302 MB (wrangler
  // stops at 314.6) and 13.2 GB of memory — the outback's tracks.
  'australia-oceania/australia': 2,
  // Measured the same day: in 4 parts, one part's roads passed 300 MiB.
  'asia/sea': 8,
  // Published whole on 2026-10-12 with a roads archive of 311.8 MB (Nigeria)
  // and 300.4 MB (Mexico), against wrangler's 314.6: two parts for headroom.
  'africa/nigeria': 2,
  'north-america/mexico': 2,
};

interface IndexFeature {
  properties: { id: string; parent?: string; name: string; urls: { pbf: string } };
  geometry: { type: string; coordinates: unknown } | null;
}

interface Node {
  key: string; // Geofabrik's short id
  id: string; // download path
  name: string;
  parent?: string;
  children: string[];
  rings: Ring[] | null;
}

function pathOf(pbfUrl: string): string {
  if (!pbfUrl.startsWith(GEOFABRIK) || !pbfUrl.endsWith('-latest.osm.pbf')) {
    throw new Error(`unexpected extract URL ${pbfUrl}`);
  }
  return pbfUrl.slice(GEOFABRIK.length, -'-latest.osm.pbf'.length);
}

async function cached(
  cache: string,
  name: string,
  fetcher: () => Promise<string>,
): Promise<string> {
  const path = join(cache, name);
  if (existsSync(path)) return readFile(path, 'utf8');
  const text = await fetcher();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
  return text;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { 'user-agent': 'goway-city-plan (https://goway.to)' },
  });
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return response.text();
}

async function sizeOf(url: string): Promise<number> {
  const response = await fetch(url, {
    method: 'HEAD',
    redirect: 'follow',
    headers: { 'user-agent': 'goway-city-plan (https://goway.to)' },
  });
  const length = Number(response.headers.get('content-length'));
  if (!response.ok || !Number.isFinite(length) || length <= 0) {
    throw new Error(`${url}: no size (${response.status})`);
  }
  return length;
}

/** Even–odd point in polygon over all rings. */
function inside(rings: readonly Ring[], x: number, y: number): boolean {
  let c = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
  }
  return c;
}

function bboxOf(rings: readonly Ring[]): [number, number, number, number] {
  let w = 180;
  let s = 90;
  let e = -180;
  let n = -90;
  for (const ring of rings) {
    for (const [x, y] of ring) {
      w = Math.min(w, x);
      e = Math.max(e, x);
      s = Math.min(s, y);
      n = Math.max(n, y);
    }
  }
  return [w, s, e, n];
}

/** Deterministic points inside a polygon (a fixed-seed sequence, rejection-sampled from its box). */
function samplePoints(rings: readonly Ring[], count: number): [number, number][] {
  const [w, s, e, n] = bboxOf(rings);
  let seed = 0x2545f491;
  const random = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 0x100000000;
  };
  const out: [number, number][] = [];
  for (let tries = 0; out.length < count && tries < count * 2000; tries++) {
    const x = w + random() * (e - w);
    const y = s + random() * (n - s);
    if (inside(rings, x, y)) out.push([x, y]);
  }
  return out;
}

async function main(): Promise<void> {
  const args = Object.fromEntries(
    process.argv.slice(2).map((raw) => {
      const [flag, value] = raw.replace(/^--/, '').split('=', 2);
      return [flag, value ?? 'true'];
    }),
  );
  const cache = resolve(args.cache ?? join(FRONTEND_ROOT, '.tiles', 'plan-cache'));
  const out = args.out ? resolve(args.out) : OUT;

  const index = JSON.parse(
    args.index
      ? await readFile(args.index, 'utf8')
      : await cached(cache, 'index-v1.json', () => fetchText(INDEX_URL)),
  ) as { features: IndexFeature[] };

  const nodes = new Map<string, Node>();
  for (const feature of index.features) {
    const p = feature.properties;
    const rings = feature.geometry ? geoJsonRings(feature.geometry) : [];
    nodes.set(p.id, {
      key: p.id,
      id: pathOf(p.urls.pbf),
      name: p.name,
      parent: p.parent,
      children: [],
      rings: rings.length > 0 && rings.some((ring) => ring.length >= 3) ? rings : null,
    });
  }
  for (const node of nodes.values())
    if (node.parent) nodes.get(node.parent)?.children.push(node.key);

  // Sizes, cached: one HEAD per region, a few at a time.
  const sizesPath = join(cache, 'sizes.json');
  const sizes: Record<string, number> = existsSync(sizesPath)
    ? JSON.parse(await readFile(sizesPath, 'utf8'))
    : {};
  const queue = [...nodes.values()].filter((node) => sizes[node.id] === undefined);
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      for (let node = queue.shift(); node; node = queue.shift()) {
        sizes[node.id] = await sizeOf(`${GEOFABRIK}${node.id}-latest.osm.pbf`);
      }
    }),
  );
  await mkdir(cache, { recursive: true });
  await writeFile(sizesPath, `${JSON.stringify(sizes, null, 1)}\n`);

  // 1. Fit the machine.
  const chosen: { node: Node; parts: number }[] = [];
  const choose = (node: Node) => {
    const bytes = sizes[node.id];
    if (bytes <= MAX_PART_BYTES || node.children.length === 0) {
      chosen.push({ node, parts: Math.max(1, Math.ceil(bytes / MAX_PART_BYTES)) });
      return;
    }
    for (const child of node.children) choose(nodes.get(child) as Node);
  };
  for (const node of [...nodes.values()]
    .filter((n) => !n.parent)
    .sort((a, b) => a.id.localeCompare(b.id))) {
    choose(node);
  }

  // Polygons for every chosen region: the index omits some, so their .poly.
  // A region whose .poly is empty too cannot be given an ownership — and a
  // bounding box instead would claim its neighbours' tiles — so it is skipped
  // and the report says so (measured 2026-10-11: `asia/myanmar.poly` is 0 bytes).
  const skipped: { id: string; reason: string }[] = [];
  for (const entry of [...chosen]) {
    const { node } = entry;
    if (node.rings) continue;
    const text = await cached(cache, `poly/${node.id}.poly`, () =>
      fetchText(`${GEOFABRIK}${node.id}.poly`),
    );
    if (text.trim() === '') {
      chosen.splice(chosen.indexOf(entry), 1);
      skipped.push({ id: node.id, reason: 'Geofabrik publishes no polygon for it (empty .poly)' });
      continue;
    }
    node.rings = parsePoly(text);
  }

  // 2. No region twice. (A region skipped above for want of a polygon holds
  // data no member does, so the grouping around it — `us-south` around
  // Tennessee, `sea` around Myanmar — falls short of the 98% below and is
  // kept: built in parts, but nothing goes missing.) A GROUPING (`us`, `dach`, `britain-and-ireland`…) is
  // a region whose data the other chosen regions inside it already hold: the
  // extracts of the chosen regions lying within its polygon add up to (nearly)
  // its own size. Extract bytes, not area, because the polygons are drawn
  // with generous sea margins that no member repeats — measured by area,
  // `us` looked 5% uncovered (open Pacific) and its fifty states were dropped
  // instead of it. Largest first, so a grouping of groupings goes before the
  // groupings it contains; members are never dropped by this rule.
  const samples = new Map(
    chosen.map(({ node }) => [node.id, samplePoints(node.rings as Ring[], 200)]),
  );
  const boxes = new Map(chosen.map(({ node }) => [node.id, bboxOf(node.rings as Ring[])]));
  // Mostly inside: members' own sea margins poke out of a grouping's polygon
  // (Indonesia's provinces out of `sea`'s), so "inside" is 90% of the area.
  const within = (inner: Node, outer: Node, share = 0.9): boolean => {
    const points = samples.get(inner.id) ?? [];
    if (points.length === 0) return false;
    const [w, s, e, n] = boxes.get(outer.id) as number[];
    const hits = points.filter(
      ([x, y]) => x >= w && x <= e && y >= s && y <= n && inside(outer.rings as Ring[], x, y),
    ).length;
    return hits / points.length >= share;
  };
  let kept = [...chosen];
  for (const { node, parts } of chosen) {
    if ((samples.get(node.id) ?? []).length === 0) {
      kept = kept.filter((entry) => entry.node !== node);
      skipped.push({ id: node.id, reason: 'its polygon has no interior' });
    }
    void parts;
  }
  for (const candidate of [...kept].sort((a, b) => sizes[b.node.id] - sizes[a.node.id])) {
    const members = kept.filter(
      (other) =>
        other !== candidate &&
        sizes[other.node.id] < sizes[candidate.node.id] &&
        within(other.node, candidate.node),
    );
    const held = members.reduce((sum, member) => sum + sizes[member.node.id], 0);
    if (members.length > 0 && held >= 0.98 * sizes[candidate.node.id]) {
      kept = kept.filter((entry) => entry !== candidate);
      skipped.push({
        id: candidate.node.id,
        reason: `a grouping: ${members.length} chosen regions inside it hold ${((100 * held) / sizes[candidate.node.id]).toFixed(0)}% of its extract`,
      });
    }
  }

  // …and a region drawn INSIDE others (`alps` across six countries, `sea`
  // over its members, Beijing inside Hebei's polygon): by area, once the
  // groupings above are gone, largest first — so of two nested regions the
  // outer one is tested first and kept, and the inner one is then the one
  // found covered.
  for (const candidate of [...kept].sort((a, b) => sizes[b.node.id] - sizes[a.node.id])) {
    const others = kept.filter((other) => other !== candidate);
    const points = samples.get(candidate.node.id) ?? [];
    const covered = points.filter(([x, y]) =>
      others.some(({ node }) => {
        const [w, s, e, n] = boxes.get(node.id) as number[];
        return x >= w && x <= e && y >= s && y <= n && inside(node.rings as Ring[], x, y);
      }),
    ).length;
    if (points.length > 0 && covered / points.length >= 0.98) {
      kept = others;
      skipped.push({
        id: candidate.node.id,
        reason: `${((100 * covered) / points.length).toFixed(0)}% of its polygon lies inside other chosen regions`,
      });
    }
  }

  // 3. Official data.
  const officialFor = (id: string) =>
    OFFICIAL.filter(
      ({ include, exclude }) =>
        include.some((rule) => (rule.endsWith('/') ? id.startsWith(rule) : id === rule)) &&
        !exclude.includes(id),
    ).map(({ source }) => source);

  const regions: CityRegion[] = kept
    .map(({ node, parts }) => ({
      id: node.id,
      name: node.name,
      pbfBytes: sizes[node.id],
      parts: Math.max(parts, MIN_PARTS[node.id] ?? 1),
      official: officialFor(node.id),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  // Report: per continent, the chosen regions' extracts against its own. A
  // ratio well under 1 is data no chosen region holds; a little over 1 is the
  // overlap at borders that every pair of Geofabrik polygons has.
  for (const top of [...nodes.values()].filter((n) => !n.parent)) {
    top.rings ??= parsePoly(
      await cached(cache, `poly/${top.id}.poly`, () => fetchText(`${GEOFABRIK}${top.id}.poly`)),
    );
    boxes.set(top.id, bboxOf(top.rings));
    const inTop = kept.filter(({ node }) => within(node, top, 0.5));
    const bytes = inTop.reduce((sum, { node }) => sum + sizes[node.id], 0);
    console.log(
      `  ${top.id.padEnd(20)} ${String(inTop.length).padStart(3)} regions, ${(bytes / 1e9).toFixed(2)} GB of ${(sizes[top.id] / 1e9).toFixed(2)} GB (${(bytes / sizes[top.id]).toFixed(3)})`,
    );
  }

  const catalogue: CityRegionCatalogue = {
    generated: new Date().toISOString().slice(0, 10),
    source: INDEX_URL,
    budget: { ...BUDGET, maxPartBytes: MAX_PART_BYTES },
    regions,
    skipped: skipped.sort((a, b) => a.id.localeCompare(b.id)),
  };
  await writeFile(out, `${JSON.stringify(catalogue, null, 2)}\n`);
  // In the repository's own format, so a re-plan diffs only what changed.
  const format = Bun.spawn(['bunx', 'biome', 'format', '--write', out], {
    cwd: FRONTEND_ROOT,
    stdout: 'ignore',
    stderr: 'inherit',
  });
  if ((await format.exited) !== 0) throw new Error(`biome could not format ${out}`);
  const total = regions.reduce((sum, region) => sum + region.pbfBytes, 0);
  const builds = regions.reduce((sum, region) => sum + region.parts, 0);
  console.log(
    `\n${out}\n  ${regions.length} regions (${builds} builds incl. parts), ${(total / 1e9).toFixed(1)} GB of extracts; ${skipped.length} skipped`,
  );
}

if (import.meta.main) {
  await main();
}
