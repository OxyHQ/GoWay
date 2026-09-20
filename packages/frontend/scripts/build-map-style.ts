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
 *  3. **Font reality.** Only fontstacks GoWay's own glyph endpoint answers
 *     with (`AVAILABLE_FONTS`), and only single-family stacks, because a
 *     combined stack is a separate document nobody composes.
 *  4. **The id contract.** Ids are unique, are all declared in
 *     `GOWAY_STYLE_LAYER_IDS`, and are IDENTICAL between light and dark —
 *     which is the property that lets `beforeLabels` be a promise.
 *  5. **The anchor's position.** Everything above it is type, everything below
 *     it is terrain. An overlay inserted at the anchor therefore always lands
 *     over the roads and under the labels.
 *  6. **No drift.** The committed JSON must equal what the source produces, so
 *     a palette edit that was never re-rendered cannot ship.
 *  7. **First-party origins.** Not one URL in either document may point
 *     anywhere but GoWay. This is a gate rather than a convention because the
 *     failure is invisible: a style that names a vendor host renders
 *     perfectly, and the only symptom is a line in a network panel nobody is
 *     looking at.
 *  8. **No throwing filter.** An ordering comparison (`<`, `<=`, `>`, `>=`)
 *     whose operand is a bare property read is wrapped by MapLibre in a
 *     numeric assertion that THROWS on a feature that lacks the property.
 *     GoWay shipped three of those and 17.6% of real `boundary` features hit
 *     them; see the note above the boundary layers in `layers.ts` for the
 *     measurement and for why the obvious fix is worse than the bug.
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
  GOWAY_MAP_ORIGIN,
  gowayMapEndpoints,
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

/**
 * GoWay's TileJSON, emitted and drift-checked exactly like the styles.
 *
 * It is generated rather than hand-written for the same reason they are: it
 * names the tile URL that the style's source points at, and a hand-written
 * copy is a second place for that URL to live and a first place for it to go
 * stale.
 */
const TILEJSON_OUTPUT = join(OUTPUT_DIR, 'tiles.json');

/**
 * Every URL the generated documents name — all four of them on GoWay's own
 * origin.
 *
 * They used to be OpenFreeMap's, and the consequence was measurable in any
 * network panel: loading GoWay's map made the browser talk to
 * `tiles.openfreemap.org` three times and to `goway.to` for the style document
 * alone. `gowayMapEndpoints` is what moved them, and `checkFirstPartyOrigins`
 * below is what keeps them moved — see that function for why a convention was
 * not enough.
 */
const ENDPOINTS = {
  sourceId: GOWAY_BASEMAP_SOURCE_ID,
  tileJsonUrl: gowayMapEndpoints(GOWAY_MAP_ORIGIN).tileJson,
  glyphs: gowayMapEndpoints(GOWAY_MAP_ORIGIN).glyphs,
  sprite: gowayMapEndpoints(GOWAY_MAP_ORIGIN).sprite,
  attribution: ATTRIBUTION_HTML,
};

/**
 * GoWay's own TileJSON, emitted beside the style documents.
 *
 * ## Why there is a TileJSON at all rather than a `tiles` array in the style
 *
 * Because the tile path is the one map resource GoWay does not hold. The
 * Worker proxies it, and a proxy has to resolve the upstream's DATE-STAMPED
 * planet build at request time; pinning `{z}/{x}/{y}` into two style documents
 * would be pinning a build that gets deleted. Indirecting through a document
 * of our own keeps the style honest — it names `goway.to` and nothing else —
 * and leaves the one moving part in the one place that can move.
 *
 * `minzoom`/`maxzoom` are the planet build's, not ours to invent: OpenMapTiles
 * stops at z14 and MapLibre overzooms above it. Declaring 14 is what makes the
 * renderer overzoom instead of requesting z15 tiles that cannot exist, which
 * is also what `worker/index.js` refuses rather than forwards.
 */
function buildTileJson(): Record<string, unknown> {
  const endpoints = gowayMapEndpoints(GOWAY_MAP_ORIGIN);
  return {
    tilejson: '3.0.0',
    name: 'GoWay',
    description: 'GoWay vector tiles, OpenMapTiles v3 schema.',
    scheme: 'xyz',
    tiles: [endpoints.tiles],
    minzoom: 0,
    maxzoom: 14,
    bounds: [-180, -85.0511, 180, 85.0511],
    attribution: ATTRIBUTION_HTML,
  };
}

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

/**
 * Check 7 - every URL in the document is GoWay's.
 *
 * The requirement in the user's words: *"nada debe ser de otro origen, GoWay
 * es una plataforma y aplicacion de mapas"*. Before the change that added this
 * function, a browser loading GoWay's map fetched tiles, glyphs and the sprite
 * from `tiles.openfreemap.org` and only the style document from `goway.to`.
 *
 * This is a GATE and not a code-review convention on purpose. Every other
 * failure in this file announces itself somehow - a bad `source-layer` draws
 * nothing, a bad font draws no text. A third-party URL draws a perfect map.
 * The only evidence is a hostname in a network panel, which means the mistake
 * survives review, survives QA, survives launch, and is found by the partner
 * who cannot embed us.
 *
 * It walks the whole document rather than the known fields, because the point
 * is to catch the URL somebody adds in a place this function's author did not
 * anticipate. `attribution` is the deliberate exception: it is HTML full of
 * links to OpenStreetMap, OpenMapTiles and OpenFreeMap, and those links are a
 * LICENCE OBLIGATION. Stripping them to satisfy a first-party rule would be
 * trading a cosmetic property for a legal one.
 */
function checkFirstPartyOrigins(
  appearance: MapAppearance,
  style: StyleSpecification,
  problems: string[],
): void {
  const where = (message: string): string => `[${appearance}] ${message}`;
  const allowed = new URL(GOWAY_MAP_ORIGIN).origin;

  const walk = (node: unknown, path: string): void => {
    if (typeof node === 'string') {
      const match = /\bhttps?:\/\/[^\s"'<>)]+/i.exec(node);
      if (!match) return;
      let origin: string;
      try {
        origin = new URL(match[0]).origin;
      } catch {
        return;
      }
      if (origin !== allowed) {
        problems.push(
          where(
            `${path} points at ${origin}, not ${allowed} - every map resource the browser fetches must come from GoWay`,
          ),
        );
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        // The credit line. See the note above.
        if (key === 'attribution') continue;
        walk(value, path === '' ? key : `${path}.${key}`);
      }
    }
  };

  walk(style, '');
}

/** Expression heads whose value is numeric by construction. */
const NUMERIC_EXPRESSIONS = new Set([
  'zoom', 'heatmap-density', 'line-progress', 'sky-radial-progress', 'measure-light',
  'length', 'pitch', 'distance-from-center', 'distance',
  '+', '-', '*', '/', '%', '^', 'abs', 'round', 'floor', 'ceil', 'min', 'max',
  'sqrt', 'ln', 'ln2', 'log10', 'log2', 'e', 'pi', 'sin', 'cos', 'tan', 'asin',
  'acos', 'atan',
]);

const ORDERING_OPERATORS = new Set(['<', '<=', '>', '>=']);

/**
 * Is this operand safe to hand to an ordering comparison?
 *
 * "Safe" means MapLibre's numeric assertion around it cannot throw. A literal
 * number is safe. An expression that is numeric by construction is safe. An
 * `['number', ..., <literal>]` assertion is safe because `Assertion.evaluate`
 * returns the first argument whose type matches and only throws if the LAST
 * one fails, so a numeric literal in last position makes the throw
 * unreachable.
 *
 * `to-number` is called out separately rather than lumped in with "unsafe",
 * because it is the fix everybody reaches for and it is a trap:
 * `Coercion.evaluate` returns `0` as soon as an argument evaluates to `null`,
 * so its fallback is never consulted for a MISSING property - which is the
 * only case anybody adds a fallback for. Substituting it into GoWay's
 * `boundary-country` filter turned 518 aboriginal-land polygons into country
 * borders. It does not throw, so it passes the letter of this check; the
 * message exists so the next person does not have to rediscover the rest.
 */
function unsafeOrderingOperand(operand: unknown): string | null {
  if (typeof operand === 'number') return null;
  if (!Array.isArray(operand) || typeof operand[0] !== 'string') {
    return 'a non-numeric literal';
  }
  const head = operand[0];
  if (NUMERIC_EXPRESSIONS.has(head)) return null;
  if (head === 'number') {
    return operand.length >= 3 && typeof operand[operand.length - 1] === 'number'
      ? null
      : '["number", ...] with no numeric literal in last position, so the assertion can still throw';
  }
  if (head === 'coalesce') {
    // `Coalesce.evaluate` returns the first argument that is not null, so a
    // numeric literal in last position means it can never yield null and the
    // assertion around it can never see one. This is the guard the POI and
    // building layers already use, and it is genuinely sufficient against the
    // defect this check exists for - a MISSING property.
    //
    // It is nonetheless weaker than `['number', ..., <sentinel>]`, and the
    // difference is worth knowing before anyone copies it onto a new property:
    // coalesce does not TYPE-check, so a property present with a non-numeric
    // value passes straight through and the assertion throws on it. The
    // properties guarded this way (`rank`, `render_min_height`) are declared
    // `Number` in the OpenMapTiles v3 schema, so the gap is closed by the tile
    // schema rather than by the filter. On a property whose type is not
    // guaranteed, use `number`.
    return operand.length >= 3 && typeof operand[operand.length - 1] === 'number'
      ? null
      : '["coalesce", ...] with no numeric literal in last position, so it can still evaluate to null and throw';
  }
  if (head === 'to-number') {
    return '["to-number", ...] - it does not throw, but its fallback is UNREACHABLE for a missing property (it returns 0); use ["number", ["get", ...], <sentinel>] instead';
  }
  return `["${head}", ...], which MapLibre wraps in a numeric assertion that throws on a feature lacking the property; wrap it as ["number", ${JSON.stringify(operand)}, <sentinel>]`;
}

/**
 * Check 8 - no filter or expression that throws on a real feature.
 *
 * Walks every layer's `filter`, `layout` and `paint` looking for an ordering
 * comparison with an unguarded operand. `!=` and `==` are deliberately NOT
 * flagged: `Comparison.parse` applies the assertion only when
 * `isOrderComparison` is true, so equality against a missing property is
 * already `true`/`false` and never throws.
 */
function checkFilterSafety(
  appearance: MapAppearance,
  style: StyleSpecification,
  problems: string[],
): void {
  const where = (message: string): string => `[${appearance}] ${message}`;

  const walk = (node: unknown, layerId: string, path: string): void => {
    if (!Array.isArray(node)) {
      if (node && typeof node === 'object') {
        for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
          walk(value, layerId, `${path}.${key}`);
        }
      }
      return;
    }
    if (typeof node[0] === 'string' && ORDERING_OPERATORS.has(node[0]) && node.length >= 3) {
      for (const index of [1, 2]) {
        const reason = unsafeOrderingOperand(node[index]);
        if (reason) {
          problems.push(
            where(`layer "${layerId}" ${path} compares with "${node[0]}" against ${reason}`),
          );
        }
      }
    }
    // `literal` quotes its argument - nothing inside it is an expression.
    if (node[0] === 'literal') return;
    node.forEach((item, index) => walk(item, layerId, `${path}[${index}]`));
  };

  for (const layer of style.layers) {
    if ('filter' in layer && layer.filter) walk(layer.filter, layer.id, 'filter');
    if ('layout' in layer && layer.layout) walk(layer.layout, layer.id, 'layout');
    if ('paint' in layer && layer.paint) walk(layer.paint, layer.id, 'paint');
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
  for (const appearance of APPEARANCES) {
    checkOne(appearance, built[appearance], problems);
    checkFirstPartyOrigins(appearance, built[appearance], problems);
    checkFilterSafety(appearance, built[appearance], problems);
  }
  checkPair(built.light, built.dark, problems);
  if (online) await checkOnline(problems);

  const tileJson = `${JSON.stringify(buildTileJson(), null, 2)}\n`;

  if (checkOnly) {
    const expected: [string, string][] = [
      ...APPEARANCES.map((appearance): [string, string] => [
        OUTPUTS[appearance],
        serialise(built[appearance]),
      ]),
      [TILEJSON_OUTPUT, tileJson],
    ];
    for (const [path, want] of expected) {
      let committed: string;
      try {
        committed = await readFile(path, 'utf8');
      } catch {
        problems.push(`${path} is missing — run \`bun run map:style\``);
        continue;
      }
      if (committed !== want) {
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
  await writeFile(TILEJSON_OUTPUT, tileJson, 'utf8');
  console.log(`map style: wrote ${TILEJSON_OUTPUT}`);
}

await main();
