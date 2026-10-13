/**
 * Photograph GoWay's map styles — every style, every place, every zoom — and
 * lay the photographs out as one contact sheet (`docs/MAP_STYLES.md` →
 * Quality bar).
 *
 * ```bash
 * bun scripts/serve-map-build.ts --dir=dist --port=8231 --upstream=https://goway.to
 * bun scripts/shoot-map-styles.ts --url=http://localhost:8231 --out=.map-styles \
 *   [--styles=standard:day,standard:night,streets:day] [--places=bcn,nyc] \
 *   [--zooms=5,12,16,18] [--size=640x420] [--playwright=<path to playwright index.mjs>]
 * ```
 *
 * It draws through the embed (`/frame`), which is the map and nothing else:
 * the camera from the address, the style from `style=` and `light=`, the mark
 * and the data credit in their corners. Every shot is the real renderer on
 * real tiles, so the sheet is evidence, not a mock-up.
 *
 * The browser is software-rendered (SwiftShader) so the sheet can be made on a
 * machine with no GPU; it waits for the network to fall quiet before each
 * shot, since a map is finished when its tiles are.
 */
import { existsSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

/** The quality bar's places (`docs/MAP_STYLES.md`). */
const PLACES: Record<string, { name: string; latitude: number; longitude: number }> = {
  bcn: { name: 'Barcelona', latitude: 41.3917, longitude: 2.1649 },
  nyc: { name: 'Manhattan', latitude: 40.7536, longitude: -73.9832 },
  tokyo: { name: 'Tokyo', latitude: 35.6595, longitude: 139.7005 },
  alps: { name: 'Alps (Chamonix)', latitude: 45.9237, longitude: 6.8694 },
  sp: { name: 'São Paulo', latitude: -23.5614, longitude: -46.6559 },
};

const url = arg('url', 'http://localhost:8231').replace(/\/$/, '');
const out = resolve(arg('out', '.map-styles'));
const styles = arg('styles', 'standard:day,standard:night')
  .split(',')
  .map((s) => {
    const [style, light = 'day'] = s.split(':');
    return { style, light };
  });
const places = arg('places', Object.keys(PLACES).join(','))
  .split(',')
  .filter((p) => p in PLACES);
const zooms = arg('zooms', '5,12,16,18').split(',').map(Number);
const [width, height] = arg('size', '640x420').split('x').map(Number);
const playwrightPath = arg('playwright', 'playwright-core');
const settleMs = Number(arg('settle', '1500'));
const features = arg('features', '');
const resume = process.argv.includes('--resume');
/** Under this a screenshot is one flat colour: the tiles never arrived. */
const BLANK_BYTES = 10_000;

interface Shot {
  style: string;
  light: string;
  place: string;
  zoom: number;
  file: string;
}

async function main(): Promise<void> {
  const { chromium } = (await import(playwrightPath)) as typeof import('playwright-core');
  await mkdir(out, { recursive: true });
  const browser = await chromium.launch({
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  if (features) {
    // A production build ignores the address's feature switches; the choices
    // are stored as the settings modal stores them.
    const choices = Object.fromEntries(
      features.split(',').map((f) => [f.replace(/^-/, ''), !f.startsWith('-')]),
    );
    await context.addInitScript(
      (stored: string) => {
        try {
          localStorage.setItem('goway.mapFeatures', stored);
        } catch {
          // No storage: the defaults draw.
        }
      },
      JSON.stringify({ v: 1, choices, labs: false }),
    );
  }
  const shots: Shot[] = [];
  for (const { style, light } of styles) {
    for (const place of places) {
      for (const zoom of zooms) {
        const file = `${style}-${light}-${place}-z${zoom}.png`;
        // `--resume`: a shot already taken (and not blank) is kept.
        if (resume && existsSync(join(out, file)) && statSync(join(out, file)).size > BLANK_BYTES) {
          shots.push({ style, light, place, zoom, file });
          continue;
        }
        for (let attempt = 1; attempt <= 4; attempt += 1) {
          const page = await context.newPage();
          // The sky and the night passes read the device clock: every shot is
          // taken on the March equinox — sunrise and sunset at 06:00 and 18:00
          // local solar time at every latitude — at noon for day, 23:00 for
          // night, and with the sun just under the horizon for dawn and dusk,
          // so a sheet made at night is the same sheet as one made at noon.
          const solarHour =
            light === 'night' ? 23 : light === 'dawn' ? 5.85 : light === 'dusk' ? 18.15 : 12;
          const at = Date.UTC(2026, 2, 20) + (solarHour - PLACES[place].longitude / 15) * 3_600_000;
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
          let dropped = false;
          page.on('request', () => {
            inflight += 1;
            last = Date.now();
          });
          const done = () => {
            inflight = Math.max(0, inflight - 1);
            last = Date.now();
          };
          page.on('requestfinished', (request) => {
            // A tile or style the server refused (rate limit, an edge error)
            // spoils the shot as surely as a dropped connection.
            void request.response().then((response) => {
              const status = response?.status() ?? 0;
              if (status === 429 || status >= 500) dropped = true;
            });
            done();
          });
          // A request the network dropped (not one the page aborted) spoils the
          // shot: a missing tile or style is a blank map, not a style.

          page.on('requestfailed', (request) => {
            if (!/ERR_ABORTED/.test(request.failure()?.errorText ?? '')) dropped = true;
            done();
          });
          const p = PLACES[place];
          const query = new URLSearchParams({
            lat: String(p.latitude),
            lng: String(p.longitude),
            zoom: String(zoom),
            style,
            light,
            theme: light === 'night' ? 'dark' : 'light',
            interactive: '0',
          });
          await page.goto(`${url}/frame?${query}`, { waitUntil: 'load', timeout: 120_000 });
          await page.addStyleTag({
            content: '[aria-label="View this area on the full GoWay map"]{display:none!important}',
          });
          const deadline = Date.now() + 60_000;
          while (Date.now() < deadline && (inflight > 0 || Date.now() - last < settleMs)) {
            await page.waitForTimeout(250);
          }
          await page.waitForTimeout(600);
          const shot = await page.screenshot();
          // A map whose tiles never came is one flat colour: a few KB of PNG.
          const blank = shot.length <= BLANK_BYTES;
          if ((dropped || blank) && attempt < 4) {
            await page.close();
            console.log(`retry ${file}: ${blank ? 'blank' : 'the network dropped a request'}`);
            await new Promise((r) => setTimeout(r, 3000 * attempt));
            continue;
          }
          await writeFile(join(out, file), shot);
          await page.close();
          shots.push({ style, light, place, zoom, file });
          console.log(`shot ${file}`);
          break;
        }
      }
    }
  }

  // The contact sheet: one row per style and place, one column per zoom.
  const rows = shots.reduce<Map<string, Shot[]>>((acc, shot) => {
    const key = `${shot.style}:${shot.light}:${shot.place}`;
    acc.set(key, [...(acc.get(key) ?? []), shot]);
    return acc;
  }, new Map());
  const cell = 320;
  const html = `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;padding:16px;font:13px/1.3 system-ui,sans-serif;background:#111;color:#eee}
    h2{font-size:13px;margin:12px 0 4px} .row{display:flex;gap:6px}
    figure{margin:0} img{width:${cell}px;height:${Math.round((cell * height) / width)}px;display:block}
    figcaption{font-size:11px;color:#aaa}</style>
    ${[...rows.entries()]
      .map(([key, row]) => {
        const [style, light, place] = key.split(':');
        return `<h2>${style} · ${light} · ${PLACES[place].name}</h2><div class="row">${row
          .map((s) => `<figure><img src="${s.file}"><figcaption>z${s.zoom}</figcaption></figure>`)
          .join('')}</div>`;
      })
      .join('')}`;
  const sheetHtml = join(out, 'sheet.html');
  await writeFile(sheetHtml, html, 'utf8');
  const sheet = await browser.newPage({
    viewport: { width: 32 + zooms.length * (cell + 6), height: 800 },
  });
  await sheet.goto(`file://${sheetHtml}`);
  await sheet.screenshot({ path: join(out, 'contact-sheet.png'), fullPage: true });
  await browser.close();
  console.log(`contact sheet: ${join(out, 'contact-sheet.png')}`);
}

await main();
