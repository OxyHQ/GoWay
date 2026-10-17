/**
 * What a vector tile looks like ON THE WIRE, served by the real Workers
 * runtime (workerd, through Miniflare) — the one thing the unit tests cannot
 * see, because Bun's `Response` ignores `encodeBody` and their cache is a Map.
 *
 * ```bash
 * bun run --cwd packages/frontend check:worker-wire            # this tree's Worker (packages/map-service/src)
 * bun packages/frontend/scripts/check-worker-wire.ts --worker=<dir with index.js>
 * ```
 *
 * Seeds a local R2 bucket with a gzip vector-tile archive, then asks for a
 * tile twice (the edge-cache miss, then the hit) as four clients: one that
 * takes gzip, one that asks for identity, one that takes only brotli, one that
 * sends no Accept-Encoding. Each raw body is counted for gzip layers.
 *
 * Correct: the gzip client gets exactly one layer, declared with
 * `content-encoding: gzip`; every other client gets zero layers and no
 * declaration; every body decodes to the tile. Measured against history: #66
 * (stored gzip, header set by hand) and #68 (`encodeBody: 'manual'`, cached
 * response returned as is) fail; #69 (decode every tile) fails the gzip
 * client — it sends the tile uncompressed.
 *
 * Then the same four clients ask `/map/satellite/…` for a WebP tile stored as
 * it is (`tileCompression: NONE`, `docs/MAP_SATELLITE.md`): every one must get
 * exactly the stored bytes, `image/webp`, and NO `content-encoding` — an image
 * is its own compression, and a gzip layer or a declared encoding on it is
 * the same class of wire bug as above.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { request as httpRequest } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';

import { convertV4MiniflareOptions, Miniflare } from 'miniflare';

import { mergeEntries, mergeManifest } from './build-satellite-manifest';
import { writePmtiles } from './citygen/pmtilesWriter';
import { COMPRESSION, TILE_TYPE } from '@goway/map-service/pmtiles.js';

const args = Object.fromEntries(
  process.argv.slice(2).map((raw) => {
    const [flag, value] = raw.replace(/^--/, '').split('=', 2);
    return [flag, value ?? 'true'];
  }),
);
/** The Worker's package: its npm modules (`maplibre-contour`, `@jsquash/webp`) resolve from here. */
const MAP_SERVICE_DIR = join(import.meta.dir, '..', '..', 'map-service');
const workerDir = resolve(args.worker ?? join(MAP_SERVICE_DIR, 'src'));

/** The deployed Worker's compatibility date, so the runtime behaves as it does. */
const COMPATIBILITY_DATE = (() => {
  const toml = readFileSync(join(import.meta.dir, '..', 'wrangler.toml'), 'utf8');
  const date = /^compatibility_date\s*=\s*"([0-9-]+)"/m.exec(toml)?.[1];
  if (!date) throw new Error('wrangler.toml names no compatibility_date');
  return date;
})();

const KEY = 'planet/wire-test.pmtiles';
const TILE = { z: 14, x: 8290, y: 6119 };
const TILE_BODY = new TextEncoder().encode(
  // MVT-ish: a layer tag, then a body that compresses like a real tile.
  `\x1a${'road residential building yes '.repeat(400)}`,
);

const archive = writePmtiles([{ ...TILE, bytes: Bun.gzipSync(TILE_BODY) }], {
  minZoom: 14,
  maxZoom: 14,
  bounds: [-180, -85, 180, 85],
  center: [0, 0, 14],
  metadata: {},
  tileType: TILE_TYPE.MVT,
  tileCompression: COMPRESSION.GZIP,
});

/** A satellite cell archive holding one WebP tile, and the manifest that publishes it. */
const SAT_TILE = { z: 16, x: 33166, y: 24476 };
// A WebP header and then incompressible bytes: what an image tile is.
const SAT_BODY = new Uint8Array([
  ...new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '),
  ...Array.from({ length: 4096 }, (_, i) => (i * 2654435761) >>> 24),
]);
const SAT_STAMP = '20261013-wire';
const SAT_KEY = `satellite/icgc-ortofoto-2025/${SAT_STAMP}/13/4145/3059.pmtiles`;
const SAT_ARCHIVE = writePmtiles([{ ...SAT_TILE, bytes: SAT_BODY }], {
  minZoom: 16,
  maxZoom: 16,
  bounds: [-180, -85, 180, 85],
  center: [0, 0, 16],
  metadata: {},
  tileType: TILE_TYPE.WEBP,
  tileCompression: COMPRESSION.NONE,
});
const SAT_MANIFEST = mergeManifest(
  null,
  mergeEntries([
    {
      id: 'icgc-ortofoto-2025',
      stamp: SAT_STAMP,
      name: 'wire',
      tiers: ['detail'],
      minZoom: 13,
      maxZoom: 18,
      cellZoom: 13,
      sources: ['icgc-ortofoto'],
      vintage: '2025',
      format: 'webp',
      bbox: [2.1, 41.3, 2.3, 41.5],
      cellKeys: ['13/4145/3059'],
      tiles: 1,
      bytes: SAT_ARCHIVE.length,
      builtAt: '2026-10-13T00:00:00.000Z',
    },
  ]),
  '2026-10-13T00:00:00.000Z',
).manifest;

/** A fresh runtime (empty edge cache, empty bucket) holding the archives. */
/**
 * The Worker as wrangler deploys it: ONE bundle of `index.js` and everything
 * it imports — the npm modules the contour route uses (`maplibre-contour`,
 * `@jsquash/webp`) included — with each WebAssembly import kept as its own
 * `CompiledWasm` module, as wrangler's default rule does. Loading the Worker's
 * files one by one instead fails at the first bare npm import.
 */
async function bundle(
  workerDir: string,
): Promise<{ dir: string; modules: { type: 'ESModule' | 'CompiledWasm'; path: string }[] }> {
  const dir = mkdtempSync(join(tmpdir(), 'worker-wire-bundle-'));
  const built = await Bun.build({
    entrypoints: [join(workerDir, 'index.js')],
    target: 'browser',
    format: 'esm',
    outdir: dir,
    naming: 'index.js',
    // npm modules resolve from this package, wherever the worker dir under
    // test was copied to (the control below is a copy in a temp dir); a
    // `.wasm` import stays an import, of the module listed next to the bundle.
    plugins: [
      {
        name: 'map-service-node-modules',
        setup(build) {
          build.onResolve({ filter: /^[^./]/ }, (args) =>
            args.path.endsWith('.wasm')
              ? { path: args.path, external: true }
              : { path: Bun.resolveSync(args.path, MAP_SERVICE_DIR) },
          );
        },
      },
    ],
  });
  if (!built.success) throw new Error(`worker bundle: ${built.logs.join('\n')}`);
  const code = readFileSync(join(dir, 'index.js'), 'utf8');
  const modules: { type: 'ESModule' | 'CompiledWasm'; path: string }[] = [
    { type: 'ESModule', path: join(dir, 'index.js') },
  ];
  for (const [, specifier] of code.matchAll(/from\s*["']([^"']+\.wasm)["']/g)) {
    const target = join(dir, specifier);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(Bun.resolveSync(specifier, MAP_SERVICE_DIR), target);
    modules.push({ type: 'CompiledWasm', path: target });
  }
  return { dir, modules };
}

/** A fresh runtime (empty edge cache, empty bucket) holding the archive. */
async function runtime(workerDir: string) {
  const bundled = await bundle(workerDir);
  const mf = new Miniflare(
    // Miniflare 5 takes its options in a new shape; the v4 shape, converted,
    // is the documented one (and what the reviewer's rig used).
    convertV4MiniflareOptions({
      modules: bundled.modules,
      modulesRoot: bundled.dir,
      // wrangler.toml's, so the runtime behaves as the deployed Worker does.
      compatibilityDate: COMPATIBILITY_DATE,
      r2Buckets: ['MAP_TILES'],
      bindings: { MAP_TILE_ARCHIVE: KEY, MAP_SATELLITE_MANIFEST: 'satellite/manifest.json' },
    }),
  );
  const origin = await mf.ready;
  const url = new URL(`/map/tiles/${TILE.z}/${TILE.x}/${TILE.y}.pbf`, origin);
  const satellite = new URL(
    `/map/satellite/detail/${SAT_TILE.z}/${SAT_TILE.x}/${SAT_TILE.y}.webp`,
    origin,
  );
  // Miniflare's R2 type is the workers-types one, which this program's DOM
  // types cannot name; only `put` is used.
  const bucket = (await mf.getR2Bucket('MAP_TILES')) as unknown as {
    put(key: string, value: Uint8Array): Promise<unknown>;
  };
  await bucket.put(KEY, archive);
  await bucket.put(SAT_KEY, SAT_ARCHIVE);
  await bucket.put(
    'satellite/manifest.json',
    new TextEncoder().encode(JSON.stringify(SAT_MANIFEST)),
  );
  return { mf, url, satellite };
}

/** A raw GET: the body exactly as it crossed the socket, nothing decoded. */
function raw(url: URL, acceptEncoding: string | null) {
  return new Promise<{ status: number; headers: Record<string, unknown>; body: Buffer }>(
    (resolvePromise, reject) => {
      const headers: Record<string, string> = {};
      if (acceptEncoding !== null) headers['accept-encoding'] = acceptEncoding;
      const req = httpRequest(url.href, { headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolvePromise({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
      });
      req.on('error', reject);
      req.end();
    },
  );
}

function layers(body: Buffer): { count: number; inner: Buffer } {
  let count = 0;
  let inner = body;
  while (inner.length >= 2 && inner[0] === 0x1f && inner[1] === 0x8b) {
    inner = gunzipSync(inner);
    count++;
  }
  return { count, inner };
}

const CLIENTS: { name: string; acceptEncoding: string | null; layers: number }[] = [
  { name: 'gzip', acceptEncoding: 'gzip, deflate, br', layers: 1 },
  { name: 'identity', acceptEncoding: 'identity', layers: 0 },
  { name: 'br only', acceptEncoding: 'br', layers: 0 },
  { name: 'no header', acceptEncoding: null, layers: 0 },
];

/** Every client, a miss and a hit each; the problems found. */
async function check(dir: string, quiet = false): Promise<string[]> {
  const problems: string[] = [];
  for (const client of CLIENTS) {
    // A runtime per client, so each client's first request is the edge-cache
    // miss and its second the hit.
    const { mf, url } = await runtime(dir);
    try {
      for (const pass of ['miss', 'hit']) {
        const response = await raw(url, client.acceptEncoding);
        const { count, inner } = layers(response.body);
        const declared = response.headers['content-encoding'] ?? null;
        const ok =
          response.status === 200 &&
          count === client.layers &&
          (client.layers === 1 ? declared === 'gzip' : declared === null) &&
          Buffer.compare(inner, Buffer.from(TILE_BODY)) === 0;
        if (!quiet) {
          console.log(
            `${ok ? '✓' : '✗'} ${client.name.padEnd(9)} ${pass.padEnd(4)} status ${response.status} · ${response.body.length} B · ${count} gzip layer(s) · content-encoding ${declared ?? '—'}`,
          );
        }
        if (!ok) {
          problems.push(
            `${client.name} ${pass}: ${count} layer(s), content-encoding ${declared ?? 'none'}, expected ${client.layers}`,
          );
        }
      }
    } finally {
      await mf.dispose();
    }
  }
  return problems;
}

/** Every client asks for the satellite tile, miss then hit: the stored bytes, never encoded. */
async function checkSatellite(dir: string): Promise<string[]> {
  const problems: string[] = [];
  for (const client of CLIENTS) {
    const { mf, satellite } = await runtime(dir);
    try {
      for (const pass of ['miss', 'hit']) {
        const response = await raw(satellite, client.acceptEncoding);
        const declared = response.headers['content-encoding'] ?? null;
        const ok =
          response.status === 200 &&
          declared === null &&
          response.headers['content-type'] === 'image/webp' &&
          Buffer.compare(response.body, Buffer.from(SAT_BODY)) === 0;
        console.log(
          `${ok ? '✓' : '✗'} satellite ${client.name.padEnd(9)} ${pass.padEnd(4)} status ${response.status} · ${response.body.length} B · content-encoding ${declared ?? '—'}`,
        );
        if (!ok) {
          problems.push(
            `satellite ${client.name} ${pass}: status ${response.status}, content-encoding ${declared ?? 'none'}, ${response.body.length} B (stored ${SAT_BODY.length})`,
          );
        }
      }
    } finally {
      await mf.dispose();
    }
  }
  return problems;
}

const problems = [...(await check(workerDir)), ...(await checkSatellite(workerDir))];
if (problems.length > 0) {
  for (const problem of problems) console.error(`✗ ${problem}`);
  process.exit(1);
}
console.log(
  '✓ one gzip layer exactly where gzip is accepted, none elsewhere; satellite WebP as stored, never encoded',
);

// The control: this gate must be able to fail. The same Worker with #68's
// mistake put back — the stored gzip declared WITHOUT `encodeBody: 'manual'`,
// so the runtime encodes it again — must be caught. (Run against the real
// #66 and #68 trees with `--worker=`, it fails both; see the PR.)
if (args.worker === undefined) {
  const broken = mkdtempSync(join(tmpdir(), 'goway-wire-control-'));
  try {
    cpSync(workerDir, broken, { recursive: true });
    const tiles = join(broken, 'tiles.js');
    const source = readFileSync(tiles, 'utf8');
    const mutated = source.replace("{ headers: out, encodeBody: 'manual' }", '{ headers: out }');
    if (mutated === source) throw new Error('control: the encodeBody line was not found to break');
    writeFileSync(tiles, mutated);
    const caught = await check(broken, true);
    if (caught.length === 0) {
      console.error(
        '✗ control: a Worker that double-encodes passed this gate — it measures nothing',
      );
      process.exit(1);
    }
    console.log(
      `✓ control: the gate catches a Worker without encodeBody 'manual' (${caught.length} failures)`,
    );
  } finally {
    rmSync(broken, { recursive: true, force: true });
  }
}
