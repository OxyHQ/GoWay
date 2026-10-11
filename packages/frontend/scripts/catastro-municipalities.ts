/**
 * Which Spanish Catastro INSPIRE Buildings downloads cover an area: reads the
 * Catastro's own ATOM feeds (the national one, then each territorial office
 * whose box meets the area) and prints one zip URL per municipality whose box
 * meets it, for `curl`. It fetches only those feeds — the downloads themselves
 * are the operator's, and the city-tile compiler never fetches anything
 * (`build-city-tiles.ts`).
 *
 * ```bash
 * bun run --cwd packages/frontend map:catastro-list --area=barcelona > urls.txt
 * mkdir catastro && cd catastro && xargs -n1 curl -fLO < ../urls.txt
 * for z in *.zip; do unzip -o "$z" '*.buildingpart.gml'; done
 * bun run --cwd packages/frontend map:city-tiles --pbf=<extract> --area=barcelona \
 *   --lod2=es-catastro:$(ls $PWD/*.buildingpart.gml | paste -sd, -)
 * ```
 *
 * Navarra and the Basque Country keep their own cadastres (and feeds); they
 * are listed by the national feed and skipped here, with a note on stderr.
 * The feeds are ISO-8859-1 and untrusted: a URL is printed only if it is an
 * https Catastro URL ending in `.zip`.
 */
import { AREAS } from './build-city-tiles';

const NATIONAL = 'https://www.catastro.hacienda.gob.es/INSPIRE/buildings/ES.SDGC.BU.atom.xml';
const CATASTRO =
  /^https?:\/\/www\.catastro\.hacienda\.gob\.es\/INSPIRE\/[Bb]uildings\/[\w./ -]+\.zip$/;

type Box = [number, number, number, number];

/** A GeoRSS polygon (`lat lon …`) → `[west, south, east, north]`. */
export function georssBox(text: string): Box | null {
  const values = text.trim().split(/\s+/).map(Number);
  if (values.length < 6 || values.length % 2 !== 0 || values.some((v) => !Number.isFinite(v))) {
    return null;
  }
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (let i = 0; i < values.length; i += 2) {
    south = Math.min(south, values[i]);
    north = Math.max(north, values[i]);
    west = Math.min(west, values[i + 1]);
    east = Math.max(east, values[i + 1]);
  }
  return [west, south, east, north];
}

const meets = (a: Box, b: Box) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];

/** Each `<entry>`'s enclosure link and GeoRSS box. */
export function feedEntries(xml: string): { href: string; box: Box | null; title: string }[] {
  const out: { href: string; box: Box | null; title: string }[] = [];
  for (const entry of xml.split(/<entry>/).slice(1)) {
    const href = /<link[^>]*rel="enclosure"[^>]*href="([^"]+)"/.exec(entry)?.[1];
    const polygon = /<georss:polygon>([^<]+)<\/georss:polygon>/.exec(entry)?.[1];
    const title = /<title>\s*([^<]*?)\s*<\/title>/.exec(entry)?.[1] ?? '';
    if (href) out.push({ href, box: polygon ? georssBox(polygon) : null, title });
  }
  return out;
}

async function feed(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return new TextDecoder('latin1').decode(await response.arrayBuffer());
}

async function main(): Promise<void> {
  let box: Box | null = null;
  for (const arg of process.argv.slice(2)) {
    const [flag, value] = arg.replace(/^--/, '').split('=', 2);
    if (flag === 'area' && value && AREAS[value]) box = AREAS[value].bbox;
    else if (flag === 'bbox' && value) {
      const parts = value.split(',').map(Number);
      if (parts.length === 4 && parts.every(Number.isFinite)) box = parts as Box;
    }
  }
  if (!box) throw new Error(`--area=<${Object.keys(AREAS).join('|')}> or --bbox=w,s,e,n`);
  const offices = feedEntries(await feed(NATIONAL));
  for (const office of offices) {
    if (!office.box || !meets(office.box, box)) continue;
    if (!/catastro\.hacienda\.gob\.es/.test(office.href)) {
      console.error(`· skipped (its own cadastre): ${office.title} ${office.href}`);
      continue;
    }
    for (const municipality of feedEntries(await feed(office.href))) {
      if (!municipality.box || !meets(municipality.box, box)) continue;
      const href = municipality.href.replace(/^http:/, 'https:');
      if (!CATASTRO.test(href)) continue;
      console.log(encodeURI(href));
    }
  }
}

if (import.meta.main) {
  await main();
}
