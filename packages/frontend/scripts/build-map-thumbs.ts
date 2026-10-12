/**
 * Render the style picker's thumbnails with the REAL renderer, and check they
 * are current (`docs/MAP_STYLES.md` → The picker).
 *
 * ```bash
 * bun run map:style                       # the documents first
 * bunx expo export --platform web --output-dir dist
 * bun scripts/serve-map-build.ts --dir=dist --port=8231 --upstream=https://goway.to
 * bun run map:thumbs --url=http://localhost:8231 [--playwright=<playwright index.mjs>]
 * bun run map:thumbs:check                # no browser: are they current?
 * ```
 *
 * A thumbnail is a photograph of the style's own document drawn by MapLibre
 * through the embed, at one fixed view, in day and in night — never a drawing
 * of one. Each is recorded in `thumbs/manifest.json` with a hash of the
 * document's LAYERS it was taken from, so `--check` fails the moment a style
 * changes and its picture does not: a stale thumbnail would promise a map
 * the person does not get.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MAP_STYLES,
  type MapStyleSelection,
  mapStylePath,
  mapStyleThumbnailPath,
} from '../lib/map/style/catalogue';

const FRONTEND_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = join(FRONTEND_ROOT, 'public');
const MANIFEST = join(PUBLIC_DIR, 'map', 'styles', 'thumbs', 'manifest.json');

/**
 * The one view every thumbnail shows: Barcelona's Ciutadella and its port —
 * water, a park, the grid, an arterial and the Ronda — at a zoom below the 3D
 * city's, so the picture is the style and nothing else.
 */
const VIEW = { latitude: 41.3872, longitude: 2.1862, zoom: 13.4 } as const;
/**
 * Drawn at 480 × 320 at 1×, shown at 240 × 160: sharp on a 2× phone, and the
 * map's own mark and credit are drawn at half their size, as befits a tile.
 */
const SIZE = { width: 480, height: 320, scale: 1 } as const;

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

/** Every thumbnail the picker can show: each style's day and night, as published. */
export const THUMBNAILS: readonly MapStyleSelection[] = MAP_STYLES.flatMap((entry) =>
  entry.presets
    .filter((preset) => preset === 'day' || preset === 'night')
    .map((preset) => ({ style: entry.id, preset })),
);

const fileOf = (path: string) => join(PUBLIC_DIR, ...path.split('/').filter(Boolean));

/** The hash a thumbnail is pinned to: its document's layers, as committed. */
async function layersHash(selection: MapStyleSelection): Promise<string> {
  const document = JSON.parse(await readFile(fileOf(mapStylePath(selection)), 'utf8')) as {
    layers: unknown;
  };
  return createHash('sha256').update(JSON.stringify(document.layers)).digest('hex').slice(0, 16);
}

type Manifest = {
  v: 1;
  view: typeof VIEW;
  thumbs: Record<string, { file: string; layers: string }>;
};

async function check(): Promise<void> {
  const problems: string[] = [];
  let manifest: Manifest | null = null;
  try {
    manifest = JSON.parse(await readFile(MANIFEST, 'utf8')) as Manifest;
  } catch {
    problems.push(`${MANIFEST} is missing — run \`bun run map:thumbs\``);
  }
  for (const selection of THUMBNAILS) {
    const key = `${selection.style}/${selection.preset}`;
    const entry = manifest?.thumbs[key];
    if (!entry) {
      problems.push(`no thumbnail for ${key} — run \`bun run map:thumbs\``);
      continue;
    }
    try {
      await readFile(fileOf(entry.file));
    } catch {
      problems.push(`${entry.file} is missing — run \`bun run map:thumbs\``);
    }
    if (entry.layers !== (await layersHash(selection))) {
      problems.push(
        `the ${key} thumbnail was taken of an older document — run \`bun run map:thumbs\` against a build of this one`,
      );
    }
  }
  if (problems.length > 0) {
    console.error(`\nmap thumbs: ${problems.length} problem(s)\n`);
    for (const problem of problems) console.error(`  • ${problem}`);
    process.exit(1);
  }
  console.log(`map thumbs: OK — ${THUMBNAILS.length} thumbnails, each of its current document`);
}

async function render(): Promise<void> {
  const url = arg('url', 'http://localhost:8231').replace(/\/$/, '');
  const { chromium } = (await import(
    arg('playwright', 'playwright-core')
  )) as typeof import('playwright-core');
  const browser = await chromium.launch({
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  const context = await browser.newContext({
    viewport: { width: SIZE.width, height: SIZE.height },
    deviceScaleFactor: SIZE.scale,
  });
  const thumbs: Manifest['thumbs'] = {};
  for (const selection of THUMBNAILS) {
    let attempt = 0;
    for (;;) {
      attempt += 1;
      const page = await context.newPage();
      // The sky reads the clock: noon for day, 23:00 for night, local solar time.
      const hour = selection.preset === 'night' ? 23 : 12;
      const at = Date.UTC(2026, 5, 21) + (hour - VIEW.longitude / 15) * 3_600_000;
      await page.addInitScript((instant: number) => {
        const offset = instant - Date.now();
        const RealDate = Date;
        class ShiftedDate extends RealDate {
          constructor(...a: unknown[]) {
            if (a.length === 0) super(RealDate.now() + offset);
            else super(...(a as [number]));
          }
          static now() {
            return RealDate.now() + offset;
          }
        }
        (window as unknown as { Date: DateConstructor }).Date = ShiftedDate as DateConstructor;
      }, at);
      let inflight = 0;
      let last = Date.now();
      page.on('request', () => {
        inflight += 1;
        last = Date.now();
      });
      const done = () => {
        inflight = Math.max(0, inflight - 1);
        last = Date.now();
      };
      page.on('requestfinished', done);
      // A request the network dropped (not one the page aborted) is a blank
      // tile in the picture: take it again.
      let dropped = false;
      page.on('requestfailed', (request) => {
        if (!/ERR_ABORTED/.test(request.failure()?.errorText ?? '')) dropped = true;
        done();
      });
      const query = new URLSearchParams({
        lat: String(VIEW.latitude),
        lng: String(VIEW.longitude),
        zoom: String(VIEW.zoom),
        style: selection.style,
        light: selection.preset,
        interactive: '0',
      });
      await page.goto(`${url}/frame?${query}`, { waitUntil: 'load', timeout: 120_000 });
      // The thumbnail is a GoWay map like any other: the mark bottom-left and
      // the data credit bottom-right stay (AGENTS.md), the credit folded to its
      // ⓘ as it is five seconds after load. Only the embed's own link goes.
      await page.addStyleTag({
        content: '[aria-label="View this area on the full GoWay map"]{display:none!important}',
      });
      const loadedAt = Date.now();
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline && (inflight > 0 || Date.now() - last < 1500)) {
        await page.waitForTimeout(250);
      }
      // Past the credit's five seconds after the map loaded, so it is folded.
      await page.waitForTimeout(Math.max(800, 8_000 - (Date.now() - loadedAt)));
      if (dropped && attempt < 4) {
        await page.close();
        console.log(`map thumbs: retaking ${selection.style}/${selection.preset} (network)`);
        continue;
      }
      const path = mapStyleThumbnailPath(selection);
      await mkdir(dirname(fileOf(path)), { recursive: true });
      await page.screenshot({ path: fileOf(path), type: 'jpeg', quality: 82 });
      await page.close();
      thumbs[`${selection.style}/${selection.preset}`] = {
        file: path,
        layers: await layersHash(selection),
      };
      console.log(`map thumbs: ${path}`);
      break;
    }
  }
  await browser.close();
  const manifest: Manifest = { v: 1, view: VIEW, thumbs };
  await writeFile(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`map thumbs: wrote ${MANIFEST}`);
}

if (process.argv.includes('--check')) await check();
else await render();
