/**
 * Build, verify and publish GoWay's own vector tiles.
 *
 * ```bash
 * # One city first. Proves the whole chain in about a minute.
 * bun run --cwd packages/frontend map:tiles --area=monaco
 *
 * # A real metro, and the fixture the id join is asserted against.
 * bun run --cwd packages/frontend map:tiles --area=cataluna
 *
 * # The planet. Hours, not minutes. Read the section below first.
 * bun run --cwd packages/frontend map:tiles --area=planet
 *
 * # Assert against the artefact rather than against the build log.
 * bun run --cwd packages/frontend map:tiles:verify --archive=<path>
 *
 * # Put it in R2. Needs credentials that are deliberately not in this repo.
 * bun run --cwd packages/frontend map:tiles:upload --archive=<path> --key=<key>
 * ```
 *
 * ## Why GoWay builds its own tiles
 *
 * Until this script, `worker/index.js` PROXIED `tiles.openfreemap.org`. That
 * removed the third-party origin from the browser and bought a seam, and its
 * own header said plainly what it did not buy: "If OpenFreeMap is down,
 * GoWay's map is down, exactly as it was before." A map platform whose map has
 * a single upstream it does not operate is not a map platform.
 *
 * There is a second reason, and it turned out to be the more interesting one.
 * Running the build means choosing what goes in the tile — and what GoWay
 * needs in the tile is the OpenStreetMap element id, so that a GoWay place
 * whose provenance is `openstreetmap:way/188938001` can be joined to the
 * basemap's own label for the same thing. Planetiler puts it there already:
 * see {@link OSM_ID_MULTIPLIER} and the verification below, which asserts it
 * rather than hoping.
 *
 * ## Why Planetiler, and why the schema does not change
 *
 * `lib/map/style/schema.ts` records the OpenMapTiles v3 vocabulary the style
 * speaks, and `build-map-style.ts` fails on a `source-layer` or a `class` that
 * no tile carries. Changing the schema would mean changing the cartography in
 * the same breath, so the question is whether a self-hosted build can keep it.
 *
 * It can, and not by coincidence: Planetiler's basemap profile IS an
 * OpenMapTiles v3 implementation, and it is the same generator OpenFreeMap
 * runs. Measured on this repository's first Catalonia build, the archive's
 * `vector_layers` are the same sixteen ids {@link OPENMAPTILES_SOURCE_LAYERS}
 * already records, and the observed `class` values are a superset of the ones
 * sampled from OpenFreeMap. So the schema is unchanged, the style document is
 * unchanged, and the only schema work this created was widening the recorded
 * vocabularies with classes the earlier sampling had not happened to see.
 *
 * ## Reproducibility is the deliverable, not the artefact
 *
 * A planet build that happened once on somebody's laptop is not infrastructure.
 * Everything that decides the output is pinned or recorded here:
 *
 *  - **Planetiler** is pinned to {@link PLANETILER_VERSION} and its jar is
 *    checked against {@link PLANETILER_SHA256} after download. An unpinned
 *    build tool is an unpinned schema.
 *  - **The OSM extract** comes from {@link AREAS}, which names a real URL per
 *    area rather than relying on Planetiler's `--area` shorthand, so the
 *    provenance is in the diff.
 *  - **What actually went in** is recorded in a build receipt beside the
 *    archive: the OSM replication sequence and timestamp read back OUT of the
 *    finished file, the Planetiler version and git hash it reports, the wall
 *    clock, and the verification results. Two builds of the same replication
 *    sequence with the same pinned Planetiler are the same map.
 *
 * ## What `--verify` is for
 *
 * A Planetiler run that drops a layer, stops a zoom short or writes ids that
 * decode to nothing exits 0 and prints nothing alarming. So nothing may
 * replace the live archive until this has opened it, walked its directories,
 * gunzipped real tiles and asserted on what is inside — using
 * `worker/pmtiles.js`, the same reader the edge serves with, so that "the
 * archive is readable" and "GoWay can read the archive" are the same claim.
 *
 * @see `worker/pmtiles.js` — the reader, shared with the Worker.
 * @see `packages/frontend/README.md` — R2, the one-time human setup, the cost.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, open, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PMTiles, COMPRESSION, TILE_TYPE } from '../worker/pmtiles.js';
import {
  decodeVectorTile,
  osmElementFor,
  osmElementKey,
  OSM_ID_MULTIPLIER,
  type VectorTileLayer,
} from './mapgen/mvt';
import { OPENMAPTILES_SOURCE_LAYER_NAMES, OPENMAPTILES_SOURCE_LAYERS } from '../lib/map/style/schema';

const FRONTEND_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Where builds land.
 *
 * Gitignored, and it has to be: a city is 186 MB and the planet is two orders
 * of magnitude past what a git repository should ever be asked to hold. The
 * archive is a deploy artefact that lives in R2; what is committed is the
 * recipe that produces it and the receipt that describes the one in R2 now.
 */
const BUILD_DIR = join(FRONTEND_ROOT, '.tiles');

/** The pinned build tool. An unpinned build tool is an unpinned schema. */
const PLANETILER_VERSION = 'v0.10.2';
const PLANETILER_SHA256 = 'f310bd0413e2e4512b27f4046d418664e8e1d3bf31603c2a70e23de06c167e4d';
const PLANETILER_URL = `https://github.com/onthegomap/planetiler/releases/download/${PLANETILER_VERSION}/planetiler.jar`;

/**
 * The maximum zoom GoWay builds to, and the number the rest of the stack
 * already assumes.
 *
 * `buildTileJson()` in `build-map-style.ts` declares 14 so MapLibre overzooms
 * rather than requesting z15, and `worker/index.js` refuses a higher zoom
 * without touching storage. Raising it is a three-file change and roughly a
 * four-fold increase in both the archive and the build, so it is stated here
 * once and asserted against the finished archive.
 */
const MAX_ZOOM = 14;

/**
 * The areas this repository knows how to build, with their sources named.
 *
 * Planetiler's own `--area=monaco` shorthand resolves a Geofabrik URL at
 * runtime, which means the provenance of a build would live in a tool's
 * lookup table rather than in this repository. Naming the URL here puts it in
 * the diff, where a change of source is a reviewable change.
 *
 * The planet comes from `planet.openstreetmap.org` rather than a mirror
 * because it is the origin the mirrors copy, it publishes a replication
 * sequence the receipt records, and 85 GB at the ~40 MB/s measured on the
 * build machine is half an hour — not enough to justify the ambiguity of a
 * mirror.
 */
const AREAS: Record<string, { url: string; file?: string; note: string }> = {
  monaco: {
    url: 'https://download.geofabrik.de/europe/monaco-latest.osm.pbf',
    note: 'The fast loop. ~700 kB in, ~420 kB out, about a minute end to end.',
  },
  cataluna: {
    url: 'https://download.geofabrik.de/europe/spain/cataluna-latest.osm.pbf',
    note: 'The reference extract: Barcelona, and the two places the OSM id join is asserted on.',
  },
  planet: {
    // A MIRROR, and not `planet.openstreetmap.org`, which is a measurement
    // rather than a preference: on the build machine the origin dropped every
    // long TLS connection with `SSL_read: decryption failed or bad record
    // mac`, repeatedly, and never once completed. Measured throughput of the
    // two official mirrors that carry the file: ftp.osuosl.org 34–72 MB/s,
    // ftpmirror.your.org 7 MB/s.
    url:
      process.env.GOWAY_PLANET_URL ||
      'https://ftp.osuosl.org/pub/openstreetmap/pbf/planet-latest.osm.pbf',
    // Named explicitly, and NOT `planet.osm.pbf`. The routing engine pulls
    // this same file under the name the upstream gives it, and a pipeline that
    // insisted on its own name would download 95 GB a second time — which is
    // the one mistake `OSM_DIR` exists to prevent.
    //
    // `GOWAY_PLANET_SNAPSHOT=260914` stores it under the DATED name instead,
    // which is what a reproducible build wants: `-latest` rotates weekly, and
    // a download resumed across a rotation is a corrupt planet that still
    // parses. The receipt records the replication sequence either way, so a
    // build can always be identified after the fact — but only a dated file
    // can be re-fetched.
    file: process.env.GOWAY_PLANET_SNAPSHOT
      ? `planet-${process.env.GOWAY_PLANET_SNAPSHOT}.osm.pbf`
      : 'planet-latest.osm.pbf',
    note: 'The real thing. ~95 GB in, hours of build, ~60–100 GB out.',
  },
};

/**
 * Places that MUST be joinable to an OpenStreetMap element by tile feature id.
 *
 * These two are not arbitrary. They are the features an earlier measurement
 * used to conclude that "OpenFreeMap's tile feature ids are unrelated to OSM
 * element ids", which was the stated reason de-duplicating a GoWay place
 * against the basemap's own label was impossible. The ids were never
 * unrelated: Planetiler encodes `osmId * 10 + sourceId`, the tile id 62887353
 * is relation/6288735, and relation/6288735 is La Boqueria. Asserting it on
 * every build is how that stays true rather than staying folklore.
 */
const EXPECTED_JOINS: Record<string, { osm: string; name: string }[]> = {
  cataluna: [
    { osm: 'relation/6288735', name: 'Mercat de Sant Josep - La Boqueria' },
    { osm: 'way/188938001', name: 'Museu Picasso' },
  ],
};

/** Tiles the verifier opens, per area: a z14 block plus the zoom spine above it. */
const SAMPLES: Record<string, { lat: number; lon: number; radius: number }> = {
  monaco: { lat: 43.7384, lon: 7.4246, radius: 1 },
  cataluna: { lat: 41.3851, lon: 2.1734, radius: 3 },
  planet: { lat: 41.3851, lon: 2.1734, radius: 3 },
};

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

interface Args {
  area: string;
  archive?: string;
  key?: string;
  verify: boolean;
  upload: boolean;
  force: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { area: 'monaco', verify: false, upload: false, force: false };
  for (const raw of argv) {
    const [flag, value] = raw.startsWith('--') ? raw.slice(2).split('=', 2) : [raw, undefined];
    if (flag === 'area' && value) args.area = value;
    else if (flag === 'archive' && value) args.archive = value;
    else if (flag === 'key' && value) args.key = value;
    else if (flag === 'verify') args.verify = true;
    else if (flag === 'upload') args.upload = true;
    else if (flag === 'force') args.force = true;
  }
  return args;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

function run(command: string, argv: string[], label: string): Promise<void> {
  return new Promise((settle, fail) => {
    const child = spawn(command, argv, { stdio: 'inherit' });
    child.on('error', fail);
    child.on('close', (code) => {
      if (code === 0) settle();
      else fail(new Error(`${label} exited ${code}`));
    });
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(1 << 20);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

/** The `Content-Length` the server reports, or `null` if it will not say. */
async function upstreamSize(url: string): Promise<number | null> {
  try {
    const response = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    const length = response.headers.get('content-length');
    return length ? Number(length) : null;
  } catch {
    return null;
  }
}

/** How many times a stalled or dropped transfer is resumed before giving up. */
const DOWNLOAD_ATTEMPTS = 40;

/**
 * Fetch a file once, resumably, and only if it is not already here.
 *
 * `curl -C -` rather than `fetch`, because the planet is 95 GB and a
 * `Response.arrayBuffer()` of 95 GB is not a download strategy. The existing
 * file is left alone: re-running a build must not re-pull the extract, which
 * is also what lets the routing engine on this machine share the download.
 *
 * ## Why the retry loop is HERE and not `curl --retry`
 *
 * Because `--retry` does not compose with `-C -`, and the failure is silent
 * and expensive. curl computes the resume offset ONCE, when it is invoked; a
 * retry inside the same invocation that the server answers without honouring
 * `Range:` rewrites the file from byte 0. Measured on a real planet pull: the
 * output file went from 62 GB BACKWARDS to 55 GB, leaving a tail that nothing
 * downstream can trust and that no exit code complained about. Re-invoking
 * curl is what recomputes the offset, so the loop has to be out here.
 *
 * `--speed-time`/`--speed-limit` turn a stalled socket into a failed attempt
 * instead of a process that hangs until somebody notices; `-f` is what stops a
 * 404 being written INTO the output as an HTML error page that every later
 * resume then treats as a partial download.
 *
 * ## Why the size is checked
 *
 * A resumed download has no natural completion signal — curl exits 0 on a
 * transfer that ended early just as happily as on one that finished. The
 * upstream `Content-Length` is the only thing that distinguishes "done" from
 * "stopped", so a server that reports one turns this into a real assertion.
 */
async function fetchOnce(url: string, destination: string, label: string): Promise<void> {
  if (await exists(destination)) {
    console.log(`· ${label} already present at ${destination}`);
    return;
  }
  const expected = await upstreamSize(url);
  console.log(
    `· fetching ${label} from ${url}${expected ? ` (${(expected / 1e9).toFixed(1)} GB)` : ''}`,
  );

  let previous = 0;
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
    try {
      await run(
        'curl',
        ['-fsSL', '-C', '-', '--speed-time', '60', '--speed-limit', '200000', '-o', destination, url],
        `curl ${label}`,
      );
    } catch (error) {
      if (attempt === DOWNLOAD_ATTEMPTS) throw error;
    }

    const size = (await exists(destination)) ? (await stat(destination)).size : 0;
    if (expected === null || size === expected) {
      if (expected !== null) console.log(`· ${label} complete: ${size} bytes`);
      return;
    }
    if (size < previous) {
      throw new Error(
        `${label} SHRANK from ${previous} to ${size} bytes: the server is not honouring Range, ` +
          'so the file cannot be resumed and its tail cannot be trusted. Delete it and use a ' +
          'mirror that answers a range request with 206.',
      );
    }
    previous = size;
    console.log(`· ${label} attempt ${attempt}: ${size} of ${expected} bytes`);
  }
  throw new Error(`${label} did not finish in ${DOWNLOAD_ATTEMPTS} attempts`);
}

async function planetilerJar(): Promise<string> {
  const jar = join(BUILD_DIR, `planetiler-${PLANETILER_VERSION}.jar`);
  await fetchOnce(PLANETILER_URL, jar, `Planetiler ${PLANETILER_VERSION}`);
  const digest = await sha256(jar);
  if (digest !== PLANETILER_SHA256) {
    throw new Error(
      `Planetiler jar sha256 is ${digest}, expected ${PLANETILER_SHA256}. ` +
        'Refusing to build a map with an unverified build tool.',
    );
  }
  return jar;
}

/**
 * Where the OSM extracts live, OUTSIDE the repository and outside this
 * package's build directory.
 *
 * Deliberately a machine-wide path rather than `.tiles/`: the planet PBF is
 * 85 GB and the routing engine wants exactly the same file. Two pipelines
 * pulling 85 GB each because each kept its inputs private is the kind of waste
 * that is invisible until the bandwidth bill arrives. `GOWAY_OSM_DIR`
 * overrides it.
 */
const OSM_DIR = process.env.GOWAY_OSM_DIR || join(process.env.HOME ?? '/tmp', 'osm-data');

async function build(area: string, force: boolean): Promise<string> {
  const source = AREAS[area];
  if (!source) {
    throw new Error(`unknown area "${area}"; known areas: ${Object.keys(AREAS).join(', ')}`);
  }

  await mkdir(BUILD_DIR, { recursive: true });
  await mkdir(OSM_DIR, { recursive: true });

  const jar = await planetilerJar();
  const pbf = join(OSM_DIR, source.file ?? `${area}.osm.pbf`);
  await fetchOnce(source.url, pbf, `${area} OSM extract`);

  const archive = join(BUILD_DIR, `${area}.pmtiles`);
  if ((await exists(archive)) && !force) {
    console.log(`· ${archive} already exists; pass --force to rebuild`);
    return archive;
  }

  console.log(`· building ${area} → ${archive}`);
  const started = Date.now();
  await run(
    'java',
    [
      `-Xmx${process.env.GOWAY_TILES_HEAP || '32g'}`,
      '-jar',
      jar,
      `--osm-path=${pbf}`,
      `--output=${archive}`,
      `--maxzoom=${MAX_ZOOM}`,
      `--tmpdir=${join(OSM_DIR, 'planetiler-tmp')}`,
      `--download-dir=${join(OSM_DIR, 'planetiler-sources')}`,
      '--download',
      '--nodemap-type=sparsearray',
      '--force',
    ],
    'planetiler',
  );
  const seconds = Math.round((Date.now() - started) / 1000);
  console.log(`· built in ${seconds}s`);
  process.env.GOWAY_TILES_BUILD_SECONDS = String(seconds);
  return archive;
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

/** A file-backed byte source, the local counterpart of the Worker's R2 one. */
async function fileSource(path: string) {
  const handle = await open(path, 'r');
  return {
    async read(offset: number, length: number): Promise<Uint8Array> {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      return new Uint8Array(buffer.subarray(0, bytesRead));
    },
    close: () => handle.close(),
  };
}

function tileFor(lat: number, lon: number, z: number): { z: number; x: number; y: number } {
  const span = 2 ** z;
  const radians = (lat * Math.PI) / 180;
  return {
    z,
    x: Math.min(span - 1, Math.floor(((lon + 180) / 360) * span)),
    y: Math.min(
      span - 1,
      Math.floor(((1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2) * span),
    ),
  };
}

export interface VerificationReport {
  archive: string;
  bytes: number;
  header: Record<string, unknown>;
  replication: { sequence?: string; timestamp?: string; url?: string };
  planetiler: { version?: string; githash?: string; buildtime?: string };
  vectorLayers: string[];
  tilesOpened: number;
  features: number;
  featuresWithOsmElement: number;
  poiFeatures: number;
  poiWithOsmElement: number;
  classes: Record<string, string[]>;
  joins: { osm: string; name: string; found: string | null }[];
  problems: string[];
}

/**
 * Open the artefact and assert on what is inside it.
 *
 * Every check here stands in for a failure Planetiler reports as success.
 * Numbered to match what the report says, because a verification nobody can
 * read the output of is a verification nobody runs twice.
 */
export async function verify(archivePath: string, area: string): Promise<VerificationReport> {
  const problems: string[] = [];
  const source = await fileSource(archivePath);
  const archive = new PMTiles(source);

  const header = await archive.header();
  const metadata = (await archive.metadata()) as Record<string, unknown>;
  const { size } = await stat(archivePath);

  // 1. The container. A wrong tile type or compression is a map that fetches
  //    and never draws, and the Worker's `content-encoding` depends on it.
  if (header.tileType !== TILE_TYPE.MVT) problems.push(`tile type is ${header.tileType}, expected MVT`);
  if (header.tileCompression !== COMPRESSION.GZIP) {
    problems.push(`tile compression is ${header.tileCompression}, expected gzip`);
  }
  if (header.minZoom !== 0) problems.push(`minzoom is ${header.minZoom}, expected 0`);
  if (header.maxZoom !== MAX_ZOOM) problems.push(`maxzoom is ${header.maxZoom}, expected ${MAX_ZOOM}`);
  if (!header.clustered) {
    problems.push('archive is not clustered; leaf directories will not describe contiguous regions');
  }

  // 2. Schema reality, the other way round from `build-map-style.ts`. That
  //    script proves the style names nothing the schema lacks; this proves the
  //    tiles carry everything the schema promises.
  //
  //    The MISSING direction is asserted only for a world-covering build, and
  //    the distinction is not pedantry: Monaco contains no aerodrome, so its
  //    archive has no `aerodrome_label` layer, and failing that build would
  //    train whoever runs the fast loop to ignore this verifier. A layer
  //    absent from an extract is absent DATA; a layer absent from the planet
  //    is a broken build. The SURPLUS direction is asserted for both, because
  //    a layer nobody recorded is a layer the style will never draw whatever
  //    the extract is.
  const vectorLayers = (
    (metadata.vector_layers as { id: string }[] | undefined) ?? []
  ).map((layer) => layer.id);
  const worldCovering = header.bounds[0] <= -179 && header.bounds[2] >= 179;
  const missing = OPENMAPTILES_SOURCE_LAYER_NAMES.filter((name) => !vectorLayers.includes(name));
  for (const name of missing) {
    const message = `the archive has no "${name}" layer, which lib/map/style/schema.ts promises`;
    if (worldCovering) problems.push(message);
    else console.log(`  note            ${message} (extract, not the planet)`);
  }
  for (const name of vectorLayers) {
    if (!OPENMAPTILES_SOURCE_LAYER_NAMES.includes(name)) {
      problems.push(`the archive carries an unrecorded layer "${name}"; schema.ts has not been told`);
    }
  }

  // 3. Real tiles, decoded. A sample around a dense city plus the whole zoom
  //    spine above it: the spine is what catches a build that silently stopped
  //    producing low zooms, which no city-sized sample would ever notice.
  const sample = SAMPLES[area] ?? SAMPLES.cataluna;
  const centre = tileFor(sample.lat, sample.lon, MAX_ZOOM);
  const coordinates: { z: number; x: number; y: number }[] = [];
  for (let dx = -sample.radius; dx <= sample.radius; dx += 1) {
    for (let dy = -sample.radius; dy <= sample.radius; dy += 1) {
      coordinates.push({ z: MAX_ZOOM, x: centre.x + dx, y: centre.y + dy });
    }
  }
  for (let z = 0; z < MAX_ZOOM; z += 1) coordinates.push(tileFor(sample.lat, sample.lon, z));

  const classes = new Map<string, Set<string>>();
  const joins = (EXPECTED_JOINS[area] ?? []).map((join) => ({ ...join, found: null as string | null }));
  const wanted = new Map(joins.map((join) => [join.osm, join]));

  let tilesOpened = 0;
  let features = 0;
  let featuresWithOsmElement = 0;
  let poiFeatures = 0;
  let poiWithOsmElement = 0;
  const zoomsSeen = new Set<number>();

  for (const { z, x, y } of coordinates) {
    const tile = await archive.getTile(z, x, y);
    if (!tile) continue;
    tilesOpened += 1;
    zoomsSeen.add(z);

    let layers: VectorTileLayer[];
    try {
      layers = decodeVectorTile(Bun.gunzipSync(tile.bytes));
    } catch (error) {
      problems.push(`tile ${z}/${x}/${y} did not decode: ${(error as Error).message}`);
      continue;
    }

    for (const layer of layers) {
      if (layer.version !== 2) problems.push(`layer "${layer.name}" is MVT v${layer.version}, expected 2`);
      if (!classes.has(layer.name)) classes.set(layer.name, new Set());
      for (const feature of layer.features) {
        features += 1;
        const element = osmElementFor(feature.id);
        if (element) featuresWithOsmElement += 1;
        if (layer.name === OPENMAPTILES_SOURCE_LAYERS.poi) {
          poiFeatures += 1;
          if (element) poiWithOsmElement += 1;
        }
        if (element) {
          const match = wanted.get(osmElementKey(element));
          if (match) match.found = `${layer.name} z${z} "${String(feature.properties.name ?? '')}"`;
        }
        if (typeof feature.properties.class === 'string') {
          classes.get(layer.name)?.add(feature.properties.class);
        }
      }
    }
  }

  if (tilesOpened === 0) problems.push('not one sampled tile was present in the archive');
  for (let z = 0; z <= MAX_ZOOM; z += 1) {
    if (!zoomsSeen.has(z)) problems.push(`no tile was returned at z${z} over the sample point`);
  }

  // 4. The whole reason to run the build: the OSM element id in the tile.
  //    Points come straight from an OSM element, so `poi` must be total. The
  //    overall figure is not, and must not be asserted as if it were —
  //    Natural Earth and the water polygons are genuinely not OSM, and merged
  //    road geometries genuinely lose the id of any one way.
  if (poiFeatures === 0) {
    problems.push('the sample found no poi features at all, so the id join proves nothing');
  } else if (poiWithOsmElement !== poiFeatures) {
    problems.push(
      `${poiFeatures - poiWithOsmElement} of ${poiFeatures} poi features carry no OSM element id ` +
        `(expected every one; ids are osmId * ${OSM_ID_MULTIPLIER} + 1|2|3)`,
    );
  }
  for (const join of joins) {
    if (!join.found) problems.push(`${join.osm} (${join.name}) was not found in any sampled tile`);
  }

  await source.close();

  return {
    archive: archivePath,
    bytes: size,
    header: header as unknown as Record<string, unknown>,
    replication: {
      sequence: metadata['planetiler:osm:osmosisreplicationseq'] as string | undefined,
      timestamp: metadata['planetiler:osm:osmosisreplicationtime'] as string | undefined,
      url: metadata['planetiler:osm:osmosisreplicationurl'] as string | undefined,
    },
    planetiler: {
      version: metadata['planetiler:version'] as string | undefined,
      githash: metadata['planetiler:githash'] as string | undefined,
      buildtime: metadata['planetiler:buildtime'] as string | undefined,
    },
    vectorLayers: vectorLayers.sort(),
    tilesOpened,
    features,
    featuresWithOsmElement,
    poiFeatures,
    poiWithOsmElement,
    classes: Object.fromEntries([...classes].map(([name, set]) => [name, [...set].sort()])),
    joins,
    problems,
  };
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

/**
 * Put a verified archive in R2, under a key nothing is serving yet.
 *
 * ## Why the key is versioned and the object is never overwritten
 *
 * A PMTiles archive is read by byte offset. Overwriting the object a Worker is
 * mid-request against does not produce a stale tile, it produces a read of
 * whatever now lives at that offset — a directory decoded as a tile, or a tile
 * from somewhere else on Earth. So a new build goes to a NEW key, the Worker's
 * `MAP_TILE_ARCHIVE` var is pointed at it, and the old key is deleted only
 * after that deploy is live. The cutover is a var change, which is also what
 * makes it a rollback.
 *
 * ## Why `aws s3` and not `wrangler r2 object put`
 *
 * `wrangler r2 object put` reads the whole file into memory and has a 300 MB
 * ceiling; the planet is ~100 GB. R2's S3-compatible endpoint does multipart,
 * which the AWS CLI drives by itself. The credentials are R2 ACCESS KEYS, a
 * different thing from the Cloudflare API token CI deploys with, and they are
 * read from the environment — never from this repository.
 */
async function upload(archivePath: string, key: string): Promise<void> {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const bucket = process.env.GOWAY_R2_BUCKET || 'goway-map-tiles';
  const missing = [
    !account && 'CLOUDFLARE_ACCOUNT_ID',
    !process.env.AWS_ACCESS_KEY_ID && 'AWS_ACCESS_KEY_ID (an R2 access key id)',
    !process.env.AWS_SECRET_ACCESS_KEY && 'AWS_SECRET_ACCESS_KEY (an R2 secret access key)',
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(
      `cannot upload: ${missing.join(', ')} not set. R2 access keys are created in the ` +
        'Cloudflare dashboard under R2 → Manage API tokens; they are NOT the Workers API token.',
    );
  }

  await run(
    'aws',
    [
      's3',
      'cp',
      archivePath,
      `s3://${bucket}/${key}`,
      '--endpoint-url',
      `https://${account}.r2.cloudflarestorage.com`,
      '--region',
      'auto',
      '--content-type',
      'application/vnd.pmtiles',
      '--checksum-algorithm',
      'CRC32',
    ],
    'aws s3 cp',
  );
  console.log(`· uploaded to s3://${bucket}/${key}`);
  console.log(`· now set MAP_TILE_ARCHIVE = "${key}" in packages/frontend/wrangler.toml and deploy`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function summarise(report: VerificationReport): void {
  const mb = (report.bytes / 1e6).toFixed(1);
  console.log(`\n${report.archive} — ${mb} MB`);
  console.log(`  planetiler      ${report.planetiler.version} (${report.planetiler.githash})`);
  console.log(`  osm replication ${report.replication.sequence} @ ${report.replication.timestamp}`);
  console.log(`  zoom            ${report.header.minZoom}–${report.header.maxZoom}`);
  console.log(`  layers          ${report.vectorLayers.join(' ')}`);
  console.log(`  sampled         ${report.tilesOpened} tiles, ${report.features} features`);
  console.log(
    `  osm ids         ${report.featuresWithOsmElement}/${report.features} overall, ` +
      `${report.poiWithOsmElement}/${report.poiFeatures} in poi`,
  );
  for (const join of report.joins) {
    console.log(`  join            ${join.osm} → ${join.found ?? 'NOT FOUND'}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const archivePath = args.archive ?? (args.verify || args.upload ? undefined : await build(args.area, args.force));
  if (!archivePath) {
    throw new Error('--verify and --upload need --archive=<path>');
  }

  if (args.upload) {
    if (!args.key) throw new Error('--upload needs --key=<object key>, e.g. basemap/planet-20260920.pmtiles');
    const report = await verify(archivePath, args.area);
    summarise(report);
    if (report.problems.length > 0) {
      for (const problem of report.problems) console.error(`  ✗ ${problem}`);
      throw new Error('refusing to upload an archive that failed verification');
    }
    await upload(archivePath, args.key);
    return;
  }

  const report = await verify(archivePath, args.area);
  summarise(report);

  const receipt = `${archivePath}.receipt.json`;
  await writeFile(
    receipt,
    `${JSON.stringify(
      {
        ...report,
        area: args.area,
        source: AREAS[args.area]?.url,
        planetilerPin: { version: PLANETILER_VERSION, sha256: PLANETILER_SHA256 },
        buildSeconds: process.env.GOWAY_TILES_BUILD_SECONDS
          ? Number(process.env.GOWAY_TILES_BUILD_SECONDS)
          : undefined,
        verifiedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  console.log(`  receipt         ${receipt}`);

  if (report.problems.length > 0) {
    console.error('');
    for (const problem of report.problems) console.error(`  ✗ ${problem}`);
    console.error(`\n${report.problems.length} problem(s). This archive must not replace the live one.`);
    process.exitCode = 1;
    return;
  }
  console.log('\n  ✓ verified');
}

if (import.meta.main) {
  await main();
}
