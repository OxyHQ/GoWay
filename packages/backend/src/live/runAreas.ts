/**
 * `bun run --cwd packages/backend live:areas` — derive every live source's
 * areas from its operator's own stops (`areas.ts`), and the modes its routes
 * name, and rewrite `areas.generated.ts`. A weekly workflow
 * (`.github/workflows/live-areas.yml`) runs it and opens a pull request when
 * anything changed; `areas.test.ts` fails for a source with stops and no
 * areas, `modes.test.ts` for one whose routes name a mode it does not declare.
 *
 * Reads, per source: the static GTFS's `stops.txt` (the shapes where a
 * portal publishes no stops) and `routes.txt`, or a bike share's GBFS
 * stations. Nothing else is fetched, and nothing about anyone is.
 *
 * Each source's entry records the day what it was derived from last changed
 * and a SHA-256 of it (the stops' positions, the route types): a rerun over
 * unchanged data rewrites nothing, so a diff means a network changed.
 */

import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LiveTransitMode } from '@goway/contracts';
import { LIVE_POLICY } from '../config/live';
import { areasOf, type DerivedSource } from './areas';
import { LIVE_SOURCE_AREAS } from './areas.generated';
import { LIVE_SOURCES } from './catalogue';
import { modeOfRouteType, parseCsv } from './staticGtfs';
import type { LiveSourceDefinition } from './types';
import { readZipEntries, readZipEntriesRanged } from './zip';

type Point = readonly [number, number];

interface Read {
  points: Point[];
  /** `route_type` values, as published. */
  routeTypes: string[];
}

const headers = { 'user-agent': LIVE_POLICY.userAgent };

async function bytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(300_000) });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

function column(text: string, ...names: string[]): string[][] {
  const { header, rows } = parseCsv(text);
  const indexes = names.map((name) => header.indexOf(name));
  if (indexes.some((index) => index < 0)) return [];
  return rows.map((row) => indexes.map((index) => row[index] ?? ''));
}

const pointsOf = (text: string, latitude: string, longitude: string): Point[] =>
  column(text, latitude, longitude).map(([la, lo]) => [Number(la), Number(lo)] as const);

const routeTypesOf = (text: string): string[] =>
  column(text, 'route_type').map(([type]) => type ?? '');

/**
 * Where to read a source's static GTFS when its operator's own server
 * refuses this run (Hamilton, STM and TriMet refuse connections from some
 * networks): the Mobility Database's copy of the same feed (MobilityData,
 * `files.mobilitydatabase.org/<id>/latest.zip`, the dataset its catalog lists
 * for that URL). Only for deriving areas and modes — never what is polled.
 */
export const AREA_MIRRORS: Readonly<Record<string, string>> = {
  'hamilton-hsr': 'https://files.mobilitydatabase.org/mdb-2618/latest.zip',
  'montreal-stm': 'https://files.mobilitydatabase.org/mdb-2126/latest.zip',
  'portland-trimet': 'https://files.mobilitydatabase.org/mdb-247/latest.zip',
};

async function gtfs(definition: LiveSourceDefinition): Promise<Read> {
  try {
    return await gtfsOf(definition, definition.staticGtfs);
  } catch (error) {
    const mirror = AREA_MIRRORS[definition.id];
    if (!mirror) throw error;
    console.log(
      `${definition.id}: its server refused (${String(error)}); reading the Mobility Database's copy`,
    );
    return gtfsOf(definition, { zip: mirror });
  }
}

async function gtfsOf(
  _definition: LiveSourceDefinition,
  location: LiveSourceDefinition['staticGtfs'],
): Promise<Read> {
  if (!location) return { points: [], routeTypes: [] };
  const decoder = new TextDecoder();
  if ('routes' in location) {
    return {
      points: pointsOf(
        decoder.decode(await bytes(location.shapes)),
        'shape_pt_lat',
        'shape_pt_lon',
      ),
      routeTypes: routeTypesOf(decoder.decode(await bytes(location.routes))),
    };
  }
  const zips = 'zip' in location ? [location.zip] : location.zips;
  const read: Read = { points: [], routeTypes: [] };
  for (const url of zips) {
    // A network read only for its routes is a big archive (Norway's is
    // 534 MB): its stops are read by range, like its routes (`zip.ts`).
    const entries =
      'zip' in location && location.only
        ? await readZipEntriesRanged(
            async (range) => {
              const response = await fetch(url, {
                headers: { ...headers, range, 'accept-encoding': 'identity' },
                signal: AbortSignal.timeout(300_000),
              });
              if (!response.ok) throw new Error(`${url} answered ${response.status}`);
              return {
                bytes: new Uint8Array(await response.arrayBuffer()),
                partial: response.status === 206,
              };
            },
            ['stops.txt', 'routes.txt'],
          )
        : readZipEntries(await bytes(url), ['stops.txt', 'shapes.txt', 'routes.txt']);
    const stops = entries.get('stops.txt');
    const shapes = entries.get('shapes.txt');
    const routes = entries.get('routes.txt');
    if (stops) read.points.push(...pointsOf(decoder.decode(stops), 'stop_lat', 'stop_lon'));
    else if (shapes)
      read.points.push(...pointsOf(decoder.decode(shapes), 'shape_pt_lat', 'shape_pt_lon'));
    if (routes) read.routeTypes.push(...routeTypesOf(decoder.decode(routes)));
  }
  return read;
}

async function gbfs(definition: LiveSourceDefinition): Promise<Read> {
  const json = async (url: string) =>
    JSON.parse(new TextDecoder().decode(await bytes(url))) as Record<string, unknown>;
  const discovery = (await json(definition.defaultUrl)).data as Record<
    string,
    { feeds?: { name: string; url: string }[] }
  >;
  const feeds = Object.values(discovery)[0]?.feeds ?? [];
  const information = feeds.find((feed) => feed.name === 'station_information');
  if (!information) return { points: [], routeTypes: [] };
  const stations = ((await json(information.url)).data as { stations?: unknown[] }).stations ?? [];
  return {
    points: stations.map((station) => {
      const { lat, lon } = station as { lat: number; lon: number };
      return [lat, lon] as const;
    }),
    routeTypes: [],
  };
}

/** The input's fingerprint: positions to ~1 m and the route types, sorted. */
function fingerprint(read: Read): string {
  const points = read.points
    .filter(([la, lo]) => Number.isFinite(la) && Number.isFinite(lo))
    .map(([la, lo]) => `${la.toFixed(5)},${lo.toFixed(5)}`)
    .sort();
  const types = [...new Set(read.routeTypes)].sort();
  return createHash('sha256')
    .update(points.join(';'))
    .update('|')
    .update(types.join(','))
    .digest('hex');
}

async function main(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const out: Record<string, DerivedSource> = {};
  const unread: string[] = [];
  for (const definition of LIVE_SOURCES) {
    const previous = LIVE_SOURCE_AREAS[definition.id];
    let read: Read;
    try {
      read = definition.kind === 'bikeshare' ? await gbfs(definition) : await gtfs(definition);
    } catch (error) {
      // An operator's server down today: keep what was derived before, with
      // the day it was — the header says how old it is.
      console.log(
        `${definition.id}: not read (${error instanceof Error ? error.message : error}) — ${previous ? `keeps its areas of ${previous.readOn}` : 'keeps its coverage box'}`,
      );
      if (previous) out[definition.id] = previous;
      else unread.push(definition.id);
      continue;
    }
    const areas = areasOf(read.points);
    if (!areas) {
      console.log(`${definition.id}: no stops known — keeps its coverage box`);
      continue;
    }
    const sha256 = fingerprint(read);
    const modes = [
      ...new Set(
        read.routeTypes
          .map((type) => modeOfRouteType(type))
          .filter((mode): mode is LiveTransitMode => mode !== null),
      ),
    ].sort();
    out[definition.id] = {
      readOn: previous?.sha256 === sha256 ? previous.readOn : today,
      sha256,
      modes,
      ...areas,
    };
    console.log(
      `${definition.id}: ${read.points.length} points → ${areas.areas.length} areas; modes ${modes.join(', ') || '—'}`,
    );
  }
  const index = Object.entries(out)
    .map(
      ([id, entry]) => `//   ${id.padEnd(30)} ${entry.readOn}  sha256:${entry.sha256.slice(0, 16)}`,
    )
    .join('\n');
  // `__dirname`: this package compiles to CommonJS (`db/migrationsFolder.ts`).
  const target = join(__dirname, 'areas.generated.ts');
  writeFileSync(
    target,
    `// Generated by \`bun run --cwd packages/backend live:areas\` (\`runAreas.ts\`): do not edit.\n` +
      `// Refreshed weekly by .github/workflows/live-areas.yml, which opens a pull request on a change.\n` +
      `//\n// Each feed, the day what it was derived from last changed, and its fingerprint:\n${index}\n` +
      `${unread.length > 0 ? `//\n// Not read (no areas yet): ${unread.join(', ')}\n` : ''}` +
      `import type { DerivedSource } from './areas';\n\n` +
      `export const LIVE_SOURCE_AREAS: Readonly<Record<string, DerivedSource>> = ${JSON.stringify(out, null, 2)};\n\n` +
      `/** Sources whose stops could not be read when this was generated: they keep their coverage box. */\n` +
      `export const LIVE_SOURCES_UNREAD: readonly string[] = ${JSON.stringify(unread)};\n`,
  );
  console.log(`wrote ${target}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
