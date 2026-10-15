/**
 * Satellite imagery at the edge (`worker/satellite.js`): which set's archive
 * answers a tile, the fall-through to the next set where the first has no
 * tile, and what the client is told.
 *
 * Built from the real pieces: archives by the compiler's PMTiles writer,
 * the manifest by `build-satellite-manifest.ts` (`mergeEntries`,
 * `mergeManifest`), coverage trees by `scripts/imagery/cells.ts`.
 *
 * Two detail sets over the same z13 cell, the finer listed first (catalogue
 * order): `icgc-ortofoto-2025` has tile 14/8288/6116 only; a second stamp of
 * the same set rebuilt one cell; and the base `worldcover-2021` has z8 cell
 * 128/94.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { IMAGERY_TIERS } from '../../lib/map/imagery';
import { mergeEntries, mergeManifest } from '../../scripts/build-satellite-manifest';
import { writePmtiles } from '../../scripts/citygen/pmtilesWriter';
import { MEMORY_BUDGET } from '../budget.js';
import worker from '../index.js';
import { COMPRESSION, TILE_TYPE } from '../pmtiles.js';
import { forgetDirectories } from '../tiles.js';
import {
  candidatesFor,
  forgetSatelliteManifest,
  parseSatelliteManifest,
  satelliteManifestBytes,
  satelliteTiers,
  serveImageryStyle,
  serveSatellite,
  withImageryBounds,
} from '../satellite.js';

const MANIFEST_KEY = 'satellite/manifest.json';
const encoder = new TextEncoder();

function archive(tiles, tileType = TILE_TYPE.WEBP) {
  return writePmtiles(
    tiles.map(([z, x, y, body]) => ({ z, x, y, bytes: encoder.encode(body) })),
    {
      minZoom: Math.min(...tiles.map((t) => t[0])),
      maxZoom: Math.max(...tiles.map((t) => t[0])),
      bounds: [-180, -85, 180, 85],
      center: [0, 0, 0],
      metadata: {},
      tileType,
      tileCompression: COMPRESSION.NONE,
    },
  );
}

function entry(id, stamp, cellKeys, extra = {}) {
  const base = {
    'icgc-ortofoto-2025': {
      name: 'ICGC',
      tiers: ['detail'],
      minZoom: 13,
      maxZoom: 18,
      cellZoom: 13,
      sources: ['icgc-ortofoto'],
      vintage: '2025',
      format: 'webp',
    },
    'worldcover-2021': {
      name: 'WorldCover',
      tiers: ['base'],
      minZoom: 8,
      maxZoom: 13,
      cellZoom: 8,
      sources: ['esa-worldcover-2021'],
      vintage: '2021',
      format: 'webp',
    },
  }[id];
  return {
    id,
    stamp,
    ...base,
    bbox: [0, 40, 4, 43],
    cellKeys,
    tiles: 1,
    bytes: 1,
    builtAt: '2026-10-13T00:00:00.000Z',
    ...extra,
  };
}

const OLD = '20261012-a';
const NEW = '20261013-b';

function fixture() {
  const { manifest: first } = mergeManifest(
    null,
    mergeEntries([
      entry('icgc-ortofoto-2025', OLD, ['13/4144/3058', '13/4145/3058']),
      entry('worldcover-2021', OLD, ['8/129/95']),
    ]),
    '2026-10-12T00:00:00.000Z',
  );
  // A rebuild of one ICGC cell under a new stamp.
  const { manifest, retired } = mergeManifest(
    first,
    mergeEntries([entry('icgc-ortofoto-2025', NEW, ['13/4145/3058'])]),
    '2026-10-13T00:00:00.000Z',
  );
  const objects = new Map([
    [MANIFEST_KEY, encoder.encode(JSON.stringify(manifest))],
    [
      `satellite/icgc-ortofoto-2025/${OLD}/13/4144/3058.pmtiles`,
      archive([
        [14, 8288, 6116, 'icgc old 14/8288/6116'],
        [13, 4144, 3058, 'icgc old 13/4144/3058'],
      ]),
    ],
    [
      `satellite/icgc-ortofoto-2025/${OLD}/13/4144/3058.pmtiles.receipt.json`,
      encoder.encode('{"receipt":"old"}'),
    ],
    [
      `satellite/icgc-ortofoto-2025/${NEW}/13/4145/3058.pmtiles`,
      archive([[14, 8290, 6116, 'icgc new 14/8290/6116']]),
    ],
    [
      `satellite/worldcover-2021/${OLD}/8/129/95.pmtiles`,
      archive([[13, 4144, 3058, 'worldcover 13/4144/3058']]),
    ],
    ['planet/20260921.pmtiles', encoder.encode('the basemap')],
  ]);
  return { manifest, retired, objects };
}

function bucket(objects) {
  const reads = [];
  const object = (bytes) => ({
    size: bytes.length,
    httpEtag: '"e"',
    body: new Blob([bytes]).stream(),
    arrayBuffer: async () => bytes.slice().buffer,
    text: async () => new TextDecoder().decode(bytes),
  });
  return {
    reads,
    async get(key, options = {}) {
      reads.push(key);
      const bytes = objects.get(key);
      if (!bytes) return null;
      const range = options.range;
      if (!range) return object(bytes);
      return object(
        bytes.subarray(range.offset, Math.min(bytes.length, range.offset + range.length)),
      );
    },
    async head(key) {
      const bytes = objects.get(key);
      return bytes ? { size: bytes.length, httpEtag: '"h"' } : null;
    },
  };
}

function cacheStore() {
  const store = new Map();
  return {
    store,
    default: {
      async match(request) {
        const hit = store.get(request.url);
        return hit ? hit.clone() : undefined;
      },
      async put(request, response) {
        store.set(request.url, response);
      },
    },
  };
}

const ctx = { waitUntil: (promise) => promise };
const realCaches = globalThis.caches;
beforeEach(() => {
  globalThis.caches = cacheStore();
  forgetSatelliteManifest();
  forgetDirectories();
});
afterEach(() => {
  globalThis.caches = realCaches;
});

async function get(path, env, method = 'GET') {
  const url = new URL(`https://goway.to${path}`);
  return serveSatellite(url, new Request(url, { method }), env, ctx);
}

describe('the tiers', () => {
  test('are the client’s (lib/map/imagery.ts)', () => {
    const fromLib = Object.fromEntries(
      Object.entries(IMAGERY_TIERS).map(([id, t]) => [
        id,
        { minZoom: t.minZoom, maxZoom: t.maxZoom },
      ]),
    );
    expect(satelliteTiers()).toEqual(fromLib);
  });
});

describe('the manifest', () => {
  test('a rebuilt cell moves to the new stamp, listed first, and the old one is retired', () => {
    const { manifest, retired } = fixture();
    const icgc = manifest.sets.filter((set) => set.id === 'icgc-ortofoto-2025');
    expect(icgc.map((set) => [set.stamp, set.cellCount])).toEqual([
      [NEW, 1],
      [OLD, 1],
    ]);
    expect(retired).toEqual([
      `satellite/icgc-ortofoto-2025/${OLD}/13/4145/3058.pmtiles`,
      `satellite/icgc-ortofoto-2025/${OLD}/13/4145/3058.pmtiles.receipt.json`,
    ]);
    // Catalogue order: the orthophoto before the base mosaic.
    expect(manifest.sets.map((set) => set.id)).toEqual([
      'icgc-ortofoto-2025',
      'icgc-ortofoto-2025',
      'worldcover-2021',
    ]);
  });

  test('the parser refuses what the builder would never write', () => {
    const { manifest } = fixture();
    const broken = (patch) =>
      expect(() =>
        parseSatelliteManifest({ ...manifest, sets: [{ ...manifest.sets[0], ...patch }] }),
      ).toThrow();
    broken({ tiers: ['street'] });
    broken({ cellZoom: 14 });
    broken({ stamp: 'yesterday' });
    broken({ cells: { maxZoom: 12, bits: manifest.sets[0].cells.bits } });
    broken({ minZoom: 19, maxZoom: 20 });
    expect(() => parseSatelliteManifest({ schema: 2, sets: [] })).toThrow();
  });

  test('candidates are the sets whose published cell holds the tile, in order', () => {
    const { manifest } = fixture();
    const parsed = parseSatelliteManifest(JSON.parse(JSON.stringify(manifest)));
    expect(candidatesFor(parsed, 'detail', 14, 8290, 6116).map((c) => c.key)).toEqual([
      `satellite/icgc-ortofoto-2025/${NEW}/13/4145/3058.pmtiles`,
    ]);
    expect(candidatesFor(parsed, 'base', 13, 4144, 3058).map((c) => c.key)).toEqual([
      `satellite/worldcover-2021/${OLD}/8/129/95.pmtiles`,
    ]);
    // Not in any published cell.
    expect(candidatesFor(parsed, 'detail', 14, 8300, 6116)).toEqual([]);
  });
});

describe('tiles', () => {
  test('the set that has the tile answers, with the stored WebP bytes', async () => {
    const { objects } = fixture();
    const env = { MAP_TILES: bucket(objects), MAP_SATELLITE_MANIFEST: MANIFEST_KEY };
    const old = await get('/map/satellite/detail/14/8288/6116.webp', env);
    expect(old.status).toBe(200);
    expect(old.headers.get('content-type')).toBe('image/webp');
    expect(old.headers.get('access-control-allow-origin')).toBe('*');
    expect(await old.text()).toBe('icgc old 14/8288/6116');
    const rebuilt = await get('/map/satellite/detail/14/8290/6116.webp', env);
    expect(await rebuilt.text()).toBe('icgc new 14/8290/6116');
    const base = await get('/map/satellite/base/13/4144/3058.webp', env);
    expect(await base.text()).toBe('worldcover 13/4144/3058');
  });

  test('a tile no set has is 404, so the tier below shows through', async () => {
    const { objects } = fixture();
    const env = { MAP_TILES: bucket(objects), MAP_SATELLITE_MANIFEST: MANIFEST_KEY };
    // In a published cell, absent from its archive (outside the flight).
    expect((await get('/map/satellite/detail/14/8289/6117.webp', env)).status).toBe(404);
    // No published cell: decided from the manifest, no archive read.
    const reads = env.MAP_TILES.reads.length;
    expect((await get('/map/satellite/detail/16/1/1.webp', env)).status).toBe(404);
    expect(env.MAP_TILES.reads.length).toBe(reads);
  });

  test('a cached answer is not read again', async () => {
    const { objects } = fixture();
    const env = { MAP_TILES: bucket(objects), MAP_SATELLITE_MANIFEST: MANIFEST_KEY };
    await get('/map/satellite/detail/14/8288/6116.webp', env);
    const reads = env.MAP_TILES.reads.length;
    const again = await get('/map/satellite/detail/14/8288/6116.webp', env);
    expect(await again.text()).toBe('icgc old 14/8288/6116');
    expect(env.MAP_TILES.reads.length).toBe(reads);
  });

  test('outside a tier or the world: 404 before storage is touched', async () => {
    const { objects } = fixture();
    const env = { MAP_TILES: bucket(objects), MAP_SATELLITE_MANIFEST: MANIFEST_KEY };
    expect((await get('/map/satellite/detail/11/0/0.webp', env)).status).toBe(404);
    expect((await get('/map/satellite/base/14/0/0.webp', env)).status).toBe(404);
    expect((await get('/map/satellite/fine/21/0/0.webp', env)).status).toBe(404);
    expect((await get('/map/satellite/base/2/4/0.webp', env)).status).toBe(404);
    expect((await get('/map/satellite/street/2/0/0.webp', env)).status).toBe(404);
    expect(env.MAP_TILES.reads).toEqual([]);
  });

  test('HEAD answers the status without a body', async () => {
    const { objects } = fixture();
    const env = { MAP_TILES: bucket(objects), MAP_SATELLITE_MANIFEST: MANIFEST_KEY };
    const head = await get('/map/satellite/detail/14/8288/6116.webp', env, 'HEAD');
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
  });
});

/**
 * The fixture plus a second detail set over the SAME z13 cell, after ICGC in
 * priority (not in the catalogue, so listed last): it has 14/8289/6116, which
 * ICGC's archive lacks, and its own 14/8288/6116, which ICGC answers first.
 */
function overlapFixture() {
  const { manifest, objects } = fixture();
  const { manifest: overlapped } = mergeManifest(
    manifest,
    mergeEntries([
      entry('icgc-ortofoto-2025', OLD, ['13/4144/3058'], {
        id: 'pnoa-2024',
        sources: ['pnoa'],
        bbox: [-10, 35, 5, 44],
      }),
    ]),
    '2026-10-14T00:00:00.000Z',
  );
  objects.set(MANIFEST_KEY, encoder.encode(JSON.stringify(overlapped)));
  objects.set(
    `satellite/pnoa-2024/${OLD}/13/4144/3058.pmtiles`,
    archive([
      [14, 8288, 6116, 'pnoa 14/8288/6116'],
      [14, 8289, 6116, 'pnoa 14/8289/6116'],
    ]),
  );
  return { manifest: overlapped, objects };
}

const configuredEnv = (objects) => ({
  MAP_TILES: bucket(objects),
  MAP_SATELLITE_MANIFEST: MANIFEST_KEY,
});

describe('several sets over one cell', () => {
  test('a tile the first set lacks is answered by the next', async () => {
    const env = configuredEnv(overlapFixture().objects);
    const fallen = await get('/map/satellite/detail/14/8289/6116.webp', env);
    expect(fallen.status).toBe(200);
    expect(await fallen.text()).toBe('pnoa 14/8289/6116');
    // Where both have it, the first in priority answers.
    const first = await get('/map/satellite/detail/14/8288/6116.webp', env);
    expect(await first.text()).toBe('icgc old 14/8288/6116');
  });

  test('each archive’s answer is cached under its own key', async () => {
    const env = configuredEnv(overlapFixture().objects);
    // ICGC lacks 14/8289/6116: its cached "no tile" must not stand in for
    // PNOA's, which has it — first cold, then from the cache.
    for (let i = 0; i < 2; i++) {
      const answer = await get('/map/satellite/detail/14/8289/6116.webp', env);
      expect(await answer.text()).toBe('pnoa 14/8289/6116');
    }
    // The same z/x/y in two archives of two tiers: each its own bytes.
    const base = await get('/map/satellite/base/13/4144/3058.webp', env);
    expect(await base.text()).toBe('worldcover 13/4144/3058');
    const detail = await get('/map/satellite/detail/13/4144/3058.webp', env);
    expect(await detail.text()).toBe('icgc old 13/4144/3058');
    // And both cached, so neither is read again.
    const reads = env.MAP_TILES.reads.length;
    expect(await (await get('/map/satellite/base/13/4144/3058.webp', env)).text()).toBe(
      'worldcover 13/4144/3058',
    );
    expect(await (await get('/map/satellite/detail/13/4144/3058.webp', env)).text()).toBe(
      'icgc old 13/4144/3058',
    );
    expect(env.MAP_TILES.reads.length).toBe(reads);
  });
});

describe('an image response', () => {
  test('is the same bytes for every client: no Vary, no Content-Encoding', async () => {
    const env = configuredEnv(fixture().objects);
    const tile = await get('/map/satellite/detail/14/8288/6116.webp', env);
    expect(tile.status).toBe(200);
    expect(tile.headers.get('vary')).toBeNull();
    expect(tile.headers.get('content-encoding')).toBeNull();
    expect(tile.headers.get('content-length')).toBe(String('icgc old 14/8288/6116'.length));
  });

  test('from an archive whose tile type is not the set’s format: 502, never cached', async () => {
    const { objects } = fixture();
    objects.set(
      `satellite/worldcover-2021/${OLD}/8/129/95.pmtiles`,
      archive([[13, 4144, 3058, 'a png']], TILE_TYPE.PNG),
    );
    const env = configuredEnv(objects);
    const refused = await get('/map/satellite/base/13/4144/3058.webp', env);
    expect(refused.status).toBe(502);
    expect(await refused.text()).toContain('tile type');
    const cached = [...globalThis.caches.store.keys()].filter((key) => key.includes('/tiles/'));
    expect(cached).toEqual([]);
  });
});

describe('the manifest’s memory budget', () => {
  const padded = (manifest, chars) => ({ ...manifest, padding: 'x'.repeat(chars) });

  test('counts the text twice (UTF-16) and every set’s tree and overhead', () => {
    const parsed = parseSatelliteManifest(JSON.parse(JSON.stringify(fixture().manifest)));
    const trees = parsed.sets.reduce((sum, set) => sum + set.tree.bytes, 0);
    expect(trees).toBeGreaterThan(0);
    expect(satelliteManifestBytes(parsed, 1000)).toBe(2000 + trees + 1024 * parsed.sets.length);
  });

  test('a manifest past its 1 MiB line is refused, one just inside is kept', () => {
    const { manifest } = fixture();
    const parsed = parseSatelliteManifest(JSON.parse(JSON.stringify(manifest)));
    const fixed = satelliteManifestBytes(parsed, 0);
    // The padding field adds `,"padding":""` (13 chars) plus its value.
    const room =
      Math.floor((MEMORY_BUDGET.satellite - fixed) / 2) - JSON.stringify(manifest).length - 13;
    expect(() => parseSatelliteManifest(padded(manifest, room))).not.toThrow();
    // Over by one character: the text alone would fit, the trees on top do not.
    expect(() => parseSatelliteManifest(padded(manifest, room + 1))).toThrow(/budget/);
  });

  test('a tile under an oversized manifest is 502, not served from it anyway', async () => {
    const { manifest, objects } = fixture();
    objects.set(MANIFEST_KEY, encoder.encode(JSON.stringify(padded(manifest, 600_000))));
    const response = await get('/map/satellite/detail/14/8288/6116.webp', configuredEnv(objects));
    expect(response.status).toBe(502);
    expect(await response.text()).toContain('budget');
  });

  test('concurrent cold requests share one manifest read', async () => {
    const env = configuredEnv(fixture().objects);
    const answers = await Promise.all(
      Array.from({ length: 6 }, () => get('/map/satellite/detail/14/8288/6116.webp', env)),
    );
    expect(answers.map((a) => a.status)).toEqual([200, 200, 200, 200, 200, 200]);
    expect(env.MAP_TILES.reads.filter((key) => key === MANIFEST_KEY)).toEqual([MANIFEST_KEY]);
  });
});

describe('the imagery style documents', () => {
  const style = () => ({
    version: 8,
    sources: {
      openmaptiles: { type: 'vector', url: 'https://goway.to/map/tiles.json' },
      'goway:imagery:base': { type: 'raster', tiles: ['b'], minzoom: 0, maxzoom: 13 },
      'goway:imagery:detail': { type: 'raster', tiles: ['d'], minzoom: 12, maxzoom: 18 },
      'goway:imagery:fine': { type: 'raster', tiles: ['f'], minzoom: 19, maxzoom: 20 },
    },
    layers: [],
  });
  const NO_COVERAGE = [-180, -85.0511, -179.9999, -85.05];

  test('bound each tier to the union of its sets, and a tier with none to nothing', () => {
    const parsed = parseSatelliteManifest(JSON.parse(JSON.stringify(overlapFixture().manifest)));
    const bounded = withImageryBounds(style(), parsed);
    expect(bounded.sources['goway:imagery:detail'].bounds).toEqual([-10, 35, 5, 44]);
    expect(bounded.sources['goway:imagery:base'].bounds).toEqual([0, 40, 4, 43]);
    expect(bounded.sources['goway:imagery:fine'].bounds).toEqual(NO_COVERAGE);
    expect(bounded.sources.openmaptiles).toEqual(style().sources.openmaptiles);
    expect(bounded.sources['goway:imagery:detail'].tiles).toEqual(['d']);
  });

  test('no manifest: no tier asks for anything', () => {
    const bounded = withImageryBounds(style(), null);
    for (const tier of ['base', 'detail', 'fine']) {
      expect(bounded.sources[`goway:imagery:${tier}`].bounds).toEqual(NO_COVERAGE);
    }
  });

  const assets = (files) => ({
    async fetch(request) {
      const body = files.get(new URL(request.url).pathname);
      if (body === undefined) {
        return new Response('<!doctype html>shell', { headers: { 'content-type': 'text/html' } });
      }
      return new Response(JSON.stringify(body), {
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  test('are served by the Worker, bounded by the live manifest', async () => {
    const committed = JSON.parse(
      await Bun.file(new URL('../../public/map/styles/satellite/day.json', import.meta.url)).text(),
    );
    const env = {
      ...configuredEnv(fixture().objects),
      ASSETS: assets(new Map([['/map/styles/satellite/day.json', committed]])),
    };
    const response = await worker.fetch(
      new Request('https://goway.to/map/styles/satellite/day.json'),
      env,
      ctx,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('max-age=300');
    const body = await response.json();
    expect(body.sources['goway:imagery:detail'].bounds).toEqual([0, 40, 4, 43]);
    expect(body.sources['goway:imagery:fine'].bounds).toEqual(NO_COVERAGE);
    expect(body.layers).toEqual(committed.layers);
  });

  test('off until configured: every tier bounded to nothing', async () => {
    const env = { ASSETS: assets(new Map([['/map/styles/hybrid/day.json', style()]])) };
    const url = new URL('https://goway.to/map/styles/hybrid/day.json');
    const body = await (await serveImageryStyle(url, new Request(url), env, ctx)).json();
    expect(body.sources['goway:imagery:base'].bounds).toEqual(NO_COVERAGE);
  });

  test('anything that is not a style document passes through as the asset', async () => {
    const env = { ASSETS: assets(new Map()) };
    for (const path of ['/map/styles/satellite/missing.json', '/map/styles/satellite/thumb.jpg']) {
      const url = new URL(`https://goway.to${path}`);
      const response = await serveImageryStyle(url, new Request(url), env, ctx);
      expect(await response.text()).toBe('<!doctype html>shell');
    }
  });

  test('reach the Worker before the asset pipeline (wrangler.toml)', async () => {
    const wrangler = await Bun.file(new URL('../../wrangler.toml', import.meta.url)).text();
    expect(wrangler).toContain('"/map/styles/satellite/*"');
    expect(wrangler).toContain('"/map/styles/hybrid/*"');
  });
});

describe('off until configured', () => {
  test('every tile 404, no sets, no storage', async () => {
    const env = { MAP_TILES: bucket(new Map()) };
    expect((await get('/map/satellite/detail/14/8288/6116.webp', env)).status).toBe(404);
    const coverage = await get('/map/satellite/coverage.json', env);
    expect(await coverage.json()).toEqual({ schema: 1, sets: [] });
    expect((await get('/map/satellite/manifest.json', env)).status).toBe(404);
    expect(env.MAP_TILES.reads).toEqual([]);
  });
});

describe('the documents', () => {
  test('coverage.json: sets, sources and cells, nothing about storage', async () => {
    const { objects } = fixture();
    const env = { MAP_TILES: bucket(objects), MAP_SATELLITE_MANIFEST: MANIFEST_KEY };
    const body = await (await get('/map/satellite/coverage.json', env)).json();
    expect(body.sets.map((set) => [set.id, set.tiers, set.sources])).toEqual([
      ['icgc-ortofoto-2025', ['detail'], ['icgc-ortofoto']],
      ['icgc-ortofoto-2025', ['detail'], ['icgc-ortofoto']],
      ['worldcover-2021', ['base'], ['esa-worldcover-2021']],
    ]);
    expect(JSON.stringify(body)).not.toContain('.pmtiles');
  });

  test('a receipt the manifest publishes is served; anything else is not', async () => {
    const { objects } = fixture();
    // The retired cell's receipt is still in the bucket (retired keys are
    // deleted later, by hand): only the manifest decides it is not served.
    objects.set(
      `satellite/icgc-ortofoto-2025/${OLD}/13/4145/3058.pmtiles.receipt.json`,
      encoder.encode('{"receipt":"retired"}'),
    );
    const env = { MAP_TILES: bucket(objects), MAP_SATELLITE_MANIFEST: MANIFEST_KEY };
    const ok = await get(
      `/map/satellite/data/satellite/icgc-ortofoto-2025/${OLD}/13/4144/3058.pmtiles.receipt.json`,
      env,
    );
    expect(await ok.json()).toEqual({ receipt: 'old' });
    // The retired cell's receipt is no longer the current manifest's.
    const retired = await get(
      `/map/satellite/data/satellite/icgc-ortofoto-2025/${OLD}/13/4145/3058.pmtiles.receipt.json`,
      env,
    );
    expect(retired.status).toBe(404);
    expect(await retired.text()).toContain('current manifest');
    // Archives and the rest of the bucket are not offered here.
    expect(
      (
        await get(
          `/map/satellite/data/satellite/icgc-ortofoto-2025/${OLD}/13/4144/3058.pmtiles`,
          env,
        )
      ).status,
    ).toBe(404);
    expect((await get('/map/satellite/data/planet/20260921.pmtiles', env)).status).toBe(404);
  });
});
