/**
 * Render, validate and drift-check GoWay's MapLibre style documents.
 *
 * ```bash
 * bun run --cwd packages/frontend map:style          # write public/map/*.json
 * bun run --cwd packages/frontend map:style:check    # validate + fail on drift
 * bun run --cwd packages/frontend map:style:check --online   # also verify the live tile schema
 * ```
 *
 * ## Why this script exists rather than a hand-written JSON file
 *
 * A style document fails **silently**. A wrong `source-layer` renders nothing
 * and logs nothing. A `text-font` the glyph server does not have renders no
 * text and logs nothing. A layer id that moved breaks an overlay's `beforeId`
 * and MapLibre quietly appends the overlay on top instead. None of that is a
 * crash, a type error or a failing render — it is a map that looks *almost*
 * right, which is the hardest kind of bug to notice and the easiest to ship.
 *
 * So the checks below stand in for the eyes that cannot be in CI:
 *
 *  1. **The real MapLibre style spec.** `validateStyleMin` from
 *     `@maplibre/maplibre-gl-style-spec` is the same validator the renderer
 *     uses. If it complains, the map would have been broken.
 *  2. **Schema reality.** Every `source-layer` named must exist in the
 *     OpenMapTiles v3 schema recorded in `lib/map/style/schema.ts`, which was
 *     read off OpenFreeMap's live TileJSON and real decoded `.pbf` tiles.
 *     `--online` re-reads the TileJSON and checks the recording is still true.
 *  3. **Font reality.** Only fontstacks OpenFreeMap actually serves, and only
 *     single-family stacks, because combined stacks 404 there.
 *  4. **The id contract.** Ids are unique, are all declared in
 *     `GOWAY_STYLE_LAYER_IDS`, and are IDENTICAL between light and dark —
 *     which is the property that lets `beforeLabels` be a promise.
 *  5. **The anchor's position.** Everything above it is type, everything below
 *     it is terrain. An overlay inserted at the anchor therefore always lands
 *     over the roads and under the labels.
 *  6. **No drift.** The committed JSON must equal what the source produces, so
 *     a palette edit that was never re-rendered cannot ship.
 *
 * ## Dependencies
 *
 * `@maplibre/maplibre-gl-style-spec` is not a new dependency: it is pinned
 * exactly (26.2.1) by `@maplibre/maplibre-react-native`, which the frontend
 * depends on directly, and it is what that package types its own `<Layer>`
 * props with. Nothing is added to `package.json` or `bun.lock` for this script.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';
import type { LayerSpecification, StyleSpecification } from '@maplibre/maplibre-gl-style-spec';

import {
  ATTRIBUTION_HTML,
  GOWAY_BASEMAP_SOURCE_ID,
  GOWAY_LABEL_ANCHOR_LAYER_ID,
  OPENFREEMAP_ENDPOINTS,
  type MapAppearance,
} from '../lib/map/provider';
import { buildGowayMapStyle } from '../lib/map/style';
import { GOWAY_STYLE_LAYER_ID_LIST } from '../lib/map/style/layers';
import { AVAILABLE_FONTS, OPENMAPTILES_SOURCE_LAYER_NAMES } from '../lib/map/style/schema';

const FRONTEND_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Where the documents land.
 *
 * `public/` is copied into `dist/` verbatim by `expo export --platform web`,
 * and `wrangler.toml` serves `dist/`, so writing here is the entire deploy.
 * Unlike `public/vendor/` (a verbatim copy of an installed dependency, and
 * therefore gitignored) these files are COMMITTED: they are generated from
 * source in this repo, and having them in the diff is what makes a cartography
 * change reviewable as a colour change rather than as a code change.
 */
const OUTPUT_DIR = join(FRONTEND_ROOT, 'public', 'map');

const OUTPUTS: Record<MapAppearance, string> = {
  light: join(OUTPUT_DIR, 'goway-light.json'),
  dark: join(OUTPUT_DIR, 'goway-dark.json'),
};

const ENDPOINTS = {
  sourceId: GOWAY_BASEMAP_SOURCE_ID,
  tileJsonUrl: OPENFREEMAP_ENDPOINTS.tileJson,
  glyphs: OPENFREEMAP_ENDPOINTS.glyphs,
  sprite: OPENFREEMAP_ENDPOINTS.sprite,
  attribution: ATTRIBUTION_HTML,
};

const APPEARANCES: readonly MapAppearance[] = ['light', 'dark'];

function serialise(style: StyleSpecification): string {
  return `${JSON.stringify(style, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

/** A layer's `source-layer`, when it has one. */
function sourceLayerOf(layer: LayerSpecification): string | undefined {
  return 'source-layer' in layer ? layer['source-layer'] : undefined;
}

function checkOne(appearance: MapAppearance, style: StyleSpecification, problems: string[]): void {
  const where = (message: string): string => `[${appearance}] ${message}`;

  // 1. The real spec.
  for (const error of validateStyleMin(style)) {
    problems.push(where(`style-spec: ${error.message}`));
  }

  const declaredSources = new Set(Object.keys(style.sources));
  const knownSourceLayers = new Set(OPENMAPTILES_SOURCE_LAYER_NAMES);
  const knownFonts = new Set<string>(AVAILABLE_FONTS);
  const catalogue = new Set(GOWAY_STYLE_LAYER_ID_LIST);
  const seen = new Set<string>();

  style.layers.forEach((layer, index) => {
    // 4. The id contract.
    if (seen.has(layer.id)) problems.push(where(`duplicate layer id "${layer.id}"`));
    seen.add(layer.id);
    if (!catalogue.has(layer.id)) {
      problems.push(
        where(`layer "${layer.id}" is not declared in GOWAY_STYLE_LAYER_IDS — the published id contract`),
      );
    }

    if ('source' in layer && layer.source && !declaredSources.has(layer.source)) {
      problems.push(where(`layer "${layer.id}" reads undeclared source "${layer.source}"`));
    }

    // 2. Schema reality. This is the check that catches the failure mode with
    //    no symptom: a source-layer that does not exist renders nothing at all.
    const sourceLayer = sourceLayerOf(layer);
    if (sourceLayer !== undefined && !knownSourceLayers.has(sourceLayer)) {
      problems.push(
        where(`layer "${layer.id}" reads source-layer "${sourceLayer}", which is not in the OpenMapTiles v3 schema`),
      );
    }

    // 3. Font reality.
    const font = layer.type === 'symbol' ? layer.layout?.['text-font'] : undefined;
    if (font !== undefined) {
      if (!Array.isArray(font) || font.length !== 1 || typeof font[0] !== 'string') {
        problems.push(
          where(`layer "${layer.id}" has a text-font that is not a single-family stack; OpenFreeMap serves no combined stacks`),
        );
      } else if (!knownFonts.has(font[0])) {
        problems.push(where(`layer "${layer.id}" uses font "${font[0]}", which the glyph server does not serve`));
      }
    }

    void index;
  });

  // 5. The anchor's position.
  const anchorIndex = style.layers.findIndex((layer) => layer.id === GOWAY_LABEL_ANCHOR_LAYER_ID);
  if (anchorIndex < 0) {
    problems.push(where(`the reserved anchor layer "${GOWAY_LABEL_ANCHOR_LAYER_ID}" is missing`));
  } else {
    const below = style.layers.slice(0, anchorIndex);
    const above = style.layers.slice(anchorIndex + 1);
    for (const layer of below) {
      if (layer.type === 'symbol') {
        problems.push(where(`symbol layer "${layer.id}" sits BELOW the label anchor; overlays would cover it`));
      }
    }
    for (const layer of above) {
      if (layer.type !== 'symbol' && layer.type !== 'circle') {
        problems.push(where(`"${layer.id}" (${layer.type}) sits ABOVE the label anchor but is not type`));
      }
    }
  }

  const metadata = style.metadata as Record<string, unknown> | undefined;
  if (metadata?.['goway:anchor:beforeLabels'] !== GOWAY_LABEL_ANCHOR_LAYER_ID) {
    problems.push(where('metadata does not advertise the anchor id that provider.ts promises'));
  }

  const source = style.sources[GOWAY_BASEMAP_SOURCE_ID];
  if (!source) {
    problems.push(where(`the basemap source "${GOWAY_BASEMAP_SOURCE_ID}" that provider.ts documents is missing`));
  } else if (!('attribution' in source) || !source.attribution) {
    problems.push(where('the basemap source carries no attribution — the OSM/ODbL credit must travel with the document'));
  }
}

/** Light and dark must be the same map in two palettes. */
function checkPair(light: StyleSpecification, dark: StyleSpecification, problems: string[]): void {
  const lightIds = light.layers.map((layer) => layer.id);
  const darkIds = dark.layers.map((layer) => layer.id);
  if (lightIds.join('\u0000') !== darkIds.join('\u0000')) {
    problems.push(
      'light and dark do not emit the same layer ids in the same order — `beforeLabels` and every overlay anchor depend on that being true',
    );
  }

  for (let i = 0; i < Math.min(light.layers.length, dark.layers.length); i += 1) {
    const a = light.layers[i];
    const b = dark.layers[i];
    if (a.type !== b.type) problems.push(`layer "${a.id}" is ${a.type} in light and ${b.type} in dark`);
    if (sourceLayerOf(a) !== sourceLayerOf(b)) {
      problems.push(`layer "${a.id}" reads different source-layers in light and dark`);
    }
  }

  if (serialise(light) === serialise(dark)) {
    problems.push('light and dark are byte-identical — one of the palettes is not being applied');
  }
}

/** Optional: re-read OpenFreeMap's TileJSON and confirm the recorded schema. */
async function checkOnline(problems: string[]): Promise<void> {
  const response = await fetch(OPENFREEMAP_ENDPOINTS.tileJson);
  if (!response.ok) {
    problems.push(`could not read TileJSON at ${OPENFREEMAP_ENDPOINTS.tileJson}: HTTP ${response.status}`);
    return;
  }
  const tileJson = (await response.json()) as { vector_layers?: { id: string }[] };
  const live = new Set((tileJson.vector_layers ?? []).map((layer) => layer.id));
  for (const name of OPENMAPTILES_SOURCE_LAYER_NAMES) {
    if (!live.has(name)) {
      problems.push(`source-layer "${name}" is recorded in schema.ts but the live TileJSON no longer serves it`);
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const checkOnly = argv.includes('--check');
  const online = argv.includes('--online');

  const built = Object.fromEntries(
    APPEARANCES.map((appearance) => [appearance, buildGowayMapStyle(appearance, ENDPOINTS)]),
  ) as Record<MapAppearance, StyleSpecification>;

  const problems: string[] = [];
  for (const appearance of APPEARANCES) checkOne(appearance, built[appearance], problems);
  checkPair(built.light, built.dark, problems);
  if (online) await checkOnline(problems);

  if (checkOnly) {
    for (const appearance of APPEARANCES) {
      const path = OUTPUTS[appearance];
      let committed: string;
      try {
        committed = await readFile(path, 'utf8');
      } catch {
        problems.push(`${path} is missing — run \`bun run map:style\``);
        continue;
      }
      if (committed !== serialise(built[appearance])) {
        problems.push(`${path} is out of date — run \`bun run map:style\` and commit the result`);
      }
    }
  }

  if (problems.length > 0) {
    console.error(`\nmap style: ${problems.length} problem(s)\n`);
    for (const problem of problems) console.error(`  • ${problem}`);
    console.error('');
    process.exit(1);
  }

  if (checkOnly) {
    const layerCount = built.light.layers.length;
    console.log(`map style: OK — ${layerCount} layers, light + dark in step${online ? ', live schema verified' : ''}`);
    return;
  }

  await mkdir(OUTPUT_DIR, { recursive: true });
  for (const appearance of APPEARANCES) {
    await writeFile(OUTPUTS[appearance], serialise(built[appearance]), 'utf8');
    console.log(`map style: wrote ${OUTPUTS[appearance]} (${built[appearance].layers.length} layers)`);
  }
}

await main();
