/**
 * Generate GoWay's own MapLibre sprite — an SDF one, so icons can be coloured.
 *
 * ```bash
 * bun run --cwd packages/frontend map:sprite                 # write public/map/sprites/**
 * bun run --cwd packages/frontend map:sprite:check           # fail on drift
 * bun run --cwd packages/frontend map:sprite --inspect goway-park
 * ```
 *
 * ## Why not keep using OpenFreeMap's sprite
 *
 * Two reasons, and the second is the one that matters.
 *
 * The first is the same reason the glyphs moved: `tiles.openfreemap.org` is not
 * GoWay's hostname, and a map platform whose icons come from somebody else's
 * server is not serving its own map.
 *
 * The second is that OpenFreeMap's sprite (`ofm_f384/ofm`, 264 images) is
 * **not SDF**. Every icon in it is a fixed dark-on-transparent PNG. MapLibre
 * only honours `icon-color`, `icon-halo-color` and `icon-halo-width` on images
 * flagged `"sdf": true`; on a plain image those three properties are ignored
 * silently. That single flag is why GoWay could not tint a POI icon per
 * category, and it is why road shields were rejected earlier in this work as
 * unrecolourable. Generating the sprite ourselves is the only way to get the
 * flag, because the flag is a property of how the image was rasterised, not a
 * setting that can be flipped afterwards.
 *
 * ## Status: available, not yet rendering
 *
 * Stated plainly because it would be easy to read this file as a feature: **no
 * layer in `lib/map/style/**` currently sets `icon-image`, and this change does
 * not add one.** The sprite is published, referenced by the style document's
 * `sprite` URL, and downloaded by MapLibre — and then nothing asks for an image
 * out of it. It is infrastructure placed ahead of the cartography that will use
 * it. Whoever wires up the first `icon-image` should expect to iterate on sizes
 * and on which icons exist; that is a cheap change, because this file is where
 * the set is defined.
 *
 * ## The licence, quoted from the file in node_modules
 *
 * `node_modules/@oxy.so/bloom/src/icons/remix/LICENSE.txt` is the Remix Icon
 * License v1.0 (Copyright (c) 2017-2026 Remix Design). The operative grant:
 *
 * > Subject to the terms and conditions of this License, Remix Design grants
 * > you a worldwide, royalty-free, non-exclusive license to use, copy, modify,
 * > merge, and distribute the Icons, as permitted below.
 *
 * and, on this exact use:
 *
 * > 2.3 Distribution as Part of a Larger Work — Include the Icons (modified or
 * > unmodified) as part of a larger product, provided that: the Icons are
 * > functional or decorative components of the product, and the Icons are not
 * > marketed or sold as the primary value of the product.
 *
 * Rasterising 35 of them into an atlas that GoWay's map uses as UI is squarely
 * inside 2.2 (Modification) and 2.3. The three restrictions in section 3 —
 * selling the icons standalone, building a competing icon library, using an
 * icon as a logo or brand identifier — are none of them what this is. Section 5
 * requires the copyright notice to be retained when distributing "the complete
 * Icon library or substantial portions thereof"; 35 of ~3000 icons is neither,
 * so no notice is strictly owed, and attribution is explicitly optional (2.4).
 * It belongs in the repository's `NOTICE` regardless — see the same paragraph
 * in `build-map-glyphs.ts`, which `NOTICE` does not yet reflect.
 *
 * ## The encoding, and the one place it differs from the glyphs
 *
 * Same distance field, same `radius = 8`, same `cutoff = 0.25` — see
 * `mapgen/sdf.ts` for the measurement that fixes those. Two deliberate
 * differences:
 *
 *  - **Fixed cells.** Every icon is rendered into the same 24x24 box (48x48 at
 *    `@2x`) rather than cropped to its own ink, so swapping `icon-image`
 *    between categories cannot move the mark or change its collision box.
 *  - **Even-odd fill.** Bloom renders every Remix icon with
 *    `fillRule="evenodd"` (see `@oxy.so/bloom/src/icons/TEMPLATE.tsx`). Using
 *    nonzero here would fill counters that the app leaves open, and the map's
 *    icons would stop matching the app's — on exactly the subset of icons
 *    whose subpaths happen to wind the same way.
 *
 * `radius` stays 8 at `@2x` rather than doubling, because the shader's
 * `SDF_PX = 8` is a constant in ATLAS TEXELS, not in CSS pixels: MapLibre
 * samples the sprite with `u_texsize` set to the atlas it actually loaded. The
 * buffer doubles (3 -> 6 texels) so the `@2x` cell is exactly twice the 1x
 * cell, which keeps `pixelRatio: 2` honest, and so the field still truncates at
 * the same 3 CSS pixels out.
 *
 * ## What breaks silently if this is wrong
 *
 * All of it. A sprite that fails to parse leaves `ImageManager` empty and every
 * `icon-image` resolves to nothing: the map renders, the labels render, the
 * icons are absent, and the only trace is a console warning per id. A sprite
 * whose JSON coordinates disagree with its PNG renders a slice of the
 * neighbouring icon — a real image, in the right place, of the wrong thing.
 * Neither is an error anywhere. Hence `--check`, which re-decodes the PNG it
 * just wrote and verifies that every declared rectangle actually contains the
 * icon it claims.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkTree, formatBytes, writeTree, type EmitTree } from './mapgen/emit';
import { decodePng, encodePng, type RgbaImage } from './mapgen/png';
import { flattenPath, renderSdf, SDF_DEFAULTS, sdfToAscii } from './mapgen/sdf';
import { shelfPack } from './mapgen/shelf-pack';
import { parseSvgPath } from './mapgen/svg-path';

const FRONTEND_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const ICON_DIR = join(FRONTEND_ROOT, '..', '..', 'node_modules', '@oxy.so', 'bloom', 'src', 'icons', 'remix');
const OUTPUT_DIR = join(FRONTEND_ROOT, 'public', 'map', 'sprites');

/** Remix icons are authored on a 24-unit grid; so is Bloom's `<Svg viewBox>`. */
const SOURCE_VIEWBOX = 24;

/** The icon cell at `pixelRatio: 1`, before the buffer. */
const ICON_BOX = 24;

/** Buffer at 1x. Doubles at 2x. Same number as the glyphs' `GLYPH_PBF_BORDER`. */
const ICON_BUFFER = 3;

/**
 * Atlas width at 1x.
 *
 * 256 fits eight 30px cells per shelf with 16px to spare, and the packer rounds
 * the height to the next power of two. See `mapgen/shelf-pack.ts` for why
 * power-of-two at all.
 */
const ATLAS_WIDTH = 256;

/** The `@2x` variant. Everything scales by exactly this. */
const PIXEL_RATIOS = [1, 2] as const;

/**
 * The icon set.
 *
 * Scoped, not exhaustive. OpenFreeMap's sprite carries 264 images for a
 * schema-wide POI vocabulary GoWay does not use; this carries one mark per
 * category `lib/goway/categories.ts` actually declares, three for the
 * ecosystem capabilities `lib/goway/capabilities.ts` presents, and the handful
 * of generic map marks a map needs regardless of its data (a pin, a star, a
 * flag, the transport modes). Every one of them is a Remix icon Bloom already
 * vendors, so the map's marks and the app's list rows are the same drawings.
 *
 * `component` is the file in `@oxy.so/bloom/src/icons/remix/`. Adding an icon
 * that Bloom does not vendor means adding it to Bloom first — deliberately,
 * because the whole point is that these two surfaces cannot drift apart.
 */
interface IconSpec {
  /** Sprite id, as a style's `icon-image` would name it. */
  name: string;
  /** The Bloom/Remix component file, without `.tsx`. */
  component: string;
  /** Why it is in the set. Categories name their key; marks say what they are for. */
  note: string;
}

const ICONS: readonly IconSpec[] = [
  // One per category in lib/goway/categories.ts.
  { name: 'goway-place', component: 'RiMapPin2Line', note: 'category: the generic fallback' },
  { name: 'goway-park', component: 'RiTreeLine', note: 'category: park' },
  { name: 'goway-museum', component: 'RiPaletteLine', note: 'category: museum' },
  { name: 'goway-hospital', component: 'RiHospitalLine', note: 'category: hospital' },
  { name: 'goway-transit-station', component: 'RiSubwayLine', note: 'category: transit_station' },
  { name: 'goway-civic', component: 'RiCommunityLine', note: 'category: civic' },
  { name: 'goway-hotel', component: 'RiHotelLine', note: 'category: hotel' },
  { name: 'goway-restaurant', component: 'RiRestaurantLine', note: 'category: restaurant' },
  { name: 'goway-grocery', component: 'RiShoppingBasketLine', note: 'category: grocery' },
  // categories.ts draws pharmacy with RiHospitalLine. On a list row that is
  // fine, because the label is right there. On a map two different categories
  // sharing one mark is a cartography bug, so the sprite splits them.
  { name: 'goway-pharmacy', component: 'RiCapsuleFill', note: 'category: pharmacy' },
  { name: 'goway-bank', component: 'RiBankLine', note: 'category: bank' },
  { name: 'goway-coworking', component: 'RiBriefcase4Line', note: 'category: coworking' },
  { name: 'goway-bicycle-rental', component: 'RiBikeLine', note: 'category: bicycle_rental' },
  { name: 'goway-bakery', component: 'RiCake2Line', note: 'category: bakery' },
  { name: 'goway-bookshop', component: 'RiBookOpenLine', note: 'category: bookshop' },
  { name: 'goway-shop', component: 'RiStore2Line', note: 'category: shop' },

  // The ecosystem capabilities lib/goway/capabilities.ts knows by name.
  { name: 'goway-coins', component: 'RiCoinsLine', note: 'capability: payments.faircoin.accepted' },
  { name: 'goway-home', component: 'RiHome5Line', note: 'capability: housing.homiio.listings' },
  { name: 'goway-verified', component: 'RiVerifiedBadgeFill', note: 'capability: oxy_verified provenance' },

  // Marks a map needs whatever its data says.
  { name: 'goway-pin', component: 'RiMapPin2Fill', note: 'mark: the selected place' },
  { name: 'goway-star', component: 'RiStarFill', note: 'mark: saved' },
  { name: 'goway-bookmark', component: 'RiBookmarkFill', note: 'mark: in a list' },
  { name: 'goway-navigation', component: 'RiCompass3Line', note: 'mark: heading / compass' },
  { name: 'goway-route', component: 'RiRouteLine', note: 'mark: a route' },
  { name: 'goway-flag', component: 'RiFlagLine', note: 'mark: destination' },
  { name: 'goway-search', component: 'RiSearchLine', note: 'mark: a search result' },
  { name: 'goway-parking', component: 'RiParkingBoxLine', note: 'mark: parking' },
  { name: 'goway-charging', component: 'RiPlugLine', note: 'mark: EV charging' },
  { name: 'goway-airport', component: 'RiFlightTakeoffLine', note: 'mark: airport' },
  { name: 'goway-ferry', component: 'RiShip2Line', note: 'mark: ferry terminal' },
  { name: 'goway-train', component: 'RiTrainLine', note: 'mark: rail station' },
  { name: 'goway-bus', component: 'RiBusLine', note: 'mark: bus stop' },
  { name: 'goway-walk', component: 'RiWalkLine', note: 'mode: walking' },
  { name: 'goway-camera', component: 'RiCameraLine', note: 'mark: a street capture' },
  { name: 'goway-accessible', component: 'RiWheelchairLine', note: 'mark: step-free access' },
];

/**
 * Sprite ids that share another id's image.
 *
 * Bloom's vendored Remix subset has no cup and no glass, so there is no
 * drawing in reach that distinguishes a cafe or a bar from a restaurant —
 * `categories.ts` already draws all three with `RiRestaurantLine`. Rather than
 * silently omit two categories from the sprite, both names are published and
 * both point at the restaurant rectangle: an alias costs one JSON entry and
 * zero atlas pixels, and it keeps `icon-image: ['concat', 'goway-', category]`
 * from resolving to nothing.
 *
 * The fix, when it is worth doing, is upstream: add `RiCupLine` and a glass to
 * Bloom's subset and promote these two to real icons.
 */
const ALIASES: Readonly<Record<string, string>> = {
  'goway-cafe': 'goway-restaurant',
  'goway-bar': 'goway-restaurant',
};

/** One entry of a Mapbox/MapLibre sprite index. */
interface SpriteEntry {
  x: number;
  y: number;
  width: number;
  height: number;
  pixelRatio: number;
  sdf: true;
}

/**
 * Pull the `d` out of a Bloom icon component.
 *
 * Bloom's icons are all `createSinglePathSVG({ path: '...' })` — checked across
 * all 461 files in the directory — so one regex is the whole extractor, and a
 * file that stops matching it throws rather than producing an empty icon.
 */
async function readIconPath(component: string): Promise<string> {
  const source = await readFile(join(ICON_DIR, `${component}.tsx`), 'utf8');
  const match = /path:\s*'([^']+)'/.exec(source);
  if (!match) {
    throw new Error(`${component}.tsx does not look like createSinglePathSVG({ path: '...' })`);
  }
  if (/viewBox:/.test(source)) {
    // A custom viewBox would silently rescale the icon inside its cell.
    throw new Error(`${component}.tsx declares its own viewBox; mapgen assumes 0 0 24 24`);
  }
  return match[1];
}

/** Render one icon's fixed cell at one pixel ratio. */
function renderIcon(pathData: string, pixelRatio: number): Uint8Array {
  const box = ICON_BOX * pixelRatio;
  const buffer = ICON_BUFFER * pixelRatio;
  const scale = box / SOURCE_VIEWBOX;

  // SVG is y-down with the origin top-left; the SDF is y-up with the origin at
  // the cell's bottom-left, so y flips about the box.
  const contours = flattenPath(parseSvgPath(pathData), (x, y) => [x * scale, box - y * scale]);
  const image = renderSdf(contours, {
    buffer,
    radius: SDF_DEFAULTS.radius,
    cutoff: SDF_DEFAULTS.cutoff,
    fillRule: 'evenodd',
    bounds: { left: 0, top: box, width: box, height: box },
  });
  if (image === null) throw new Error('icon path encloses no area');
  return image.data;
}

interface Sheet {
  pixelRatio: number;
  png: Uint8Array;
  json: string;
  atlasWidth: number;
  atlasHeight: number;
  index: Record<string, SpriteEntry>;
  /** Kept for `--inspect` and for the self-check. */
  image: RgbaImage;
}

function buildSheet(paths: Map<string, string>, pixelRatio: number): Sheet {
  const cell = (ICON_BOX + 2 * ICON_BUFFER) * pixelRatio;

  const packed = shelfPack(
    ICONS.map((icon) => ({ name: icon.name, width: cell, height: cell })),
    ATLAS_WIDTH * pixelRatio,
  );

  const { atlasWidth, atlasHeight } = packed;
  const data = new Uint8Array(atlasWidth * atlasHeight * 4);

  const index: Record<string, SpriteEntry> = {};
  for (const box of packed.boxes) {
    const field = renderIcon(paths.get(box.name)!, pixelRatio);
    if (field.length !== cell * cell) {
      throw new Error(`${box.name}: rendered ${field.length} bytes, expected ${cell * cell}`);
    }
    for (let row = 0; row < cell; row += 1) {
      for (let column = 0; column < cell; column += 1) {
        const target = ((box.y + row) * atlasWidth + box.x + column) * 4;
        // RGB is opaque white and carries nothing: for an `"sdf": true` image
        // MapLibre reads only the alpha channel and multiplies by `icon-color`.
        // White is chosen over black so that anything which renders the atlas
        // as an ordinary image (a debug view, a thumbnail) shows the icon
        // rather than a black square.
        data[target] = 255;
        data[target + 1] = 255;
        data[target + 2] = 255;
        data[target + 3] = field[row * cell + column];
      }
    }
    index[box.name] = { x: box.x, y: box.y, width: cell, height: cell, pixelRatio, sdf: true };
  }

  for (const [alias, target] of Object.entries(ALIASES)) {
    const entry = index[target];
    if (!entry) throw new Error(`alias "${alias}" points at "${target}", which is not in the sprite`);
    index[alias] = { ...entry };
  }

  const image: RgbaImage = { width: atlasWidth, height: atlasHeight, data };
  const ordered: Record<string, SpriteEntry> = {};
  for (const name of Object.keys(index).sort()) ordered[name] = index[name];

  return {
    pixelRatio,
    png: encodePng(image),
    json: `${JSON.stringify(ordered, null, 2)}\n`,
    atlasWidth,
    atlasHeight,
    index: ordered,
    image,
  };
}

/**
 * Re-decode what was just encoded and prove the index describes the image.
 *
 * Three separate claims, each of which can be wrong on its own:
 *
 *  1. The PNG round-trips pixel for pixel. Catches a filter bug, which
 *     produces a valid PNG of the wrong picture.
 *  2. Every declared rectangle is inside the atlas and contains ink. An entry
 *     pointing at empty padding renders nothing and reports nothing.
 *  3. `@2x` is exactly twice `@1x` — same ids, same layout doubled. If it is
 *     not, retina devices get icons at the wrong size and `pixelRatio: 2` is a
 *     lie the renderer will believe.
 */
function verifySheets(sheets: Sheet[], problems: string[]): void {
  for (const sheet of sheets) {
    const label = sheet.pixelRatio === 1 ? 'goway' : `goway@${sheet.pixelRatio}x`;
    const decoded = decodePng(sheet.png);
    if (decoded.width !== sheet.image.width || decoded.height !== sheet.image.height) {
      problems.push(`${label}.png decodes to ${decoded.width}x${decoded.height}, encoded ${sheet.image.width}x${sheet.image.height}`);
      continue;
    }
    let mismatches = 0;
    for (let i = 0; i < decoded.data.length; i += 1) {
      if (decoded.data[i] !== sheet.image.data[i]) mismatches += 1;
    }
    if (mismatches > 0) problems.push(`${label}.png does not round-trip: ${mismatches} byte(s) differ`);

    for (const [name, entry] of Object.entries(sheet.index)) {
      if (entry.pixelRatio !== sheet.pixelRatio) {
        problems.push(`${label}: "${name}" declares pixelRatio ${entry.pixelRatio}`);
      }
      if (entry.x < 0 || entry.y < 0 || entry.x + entry.width > decoded.width || entry.y + entry.height > decoded.height) {
        problems.push(`${label}: "${name}" rectangle falls outside the atlas`);
        continue;
      }
      let ink = 0;
      for (let row = 0; row < entry.height; row += 1) {
        for (let column = 0; column < entry.width; column += 1) {
          const alpha = decoded.data[((entry.y + row) * decoded.width + entry.x + column) * 4 + 3];
          // 191 is the fill threshold; a pixel above it is inside the drawing.
          if (alpha > 191) ink += 1;
        }
      }
      if (ink === 0) problems.push(`${label}: "${name}" rectangle contains no ink — the index and the atlas disagree`);
    }
  }

  const [one, two] = sheets;
  if (one && two) {
    if (two.atlasWidth !== one.atlasWidth * 2 || two.atlasHeight !== one.atlasHeight * 2) {
      problems.push(
        `@2x atlas is ${two.atlasWidth}x${two.atlasHeight}, not exactly twice ${one.atlasWidth}x${one.atlasHeight}`,
      );
    }
    const oneIds = Object.keys(one.index).join(',');
    const twoIds = Object.keys(two.index).join(',');
    if (oneIds !== twoIds) problems.push('@2x publishes a different set of icon ids than @1x');
    else {
      for (const name of Object.keys(one.index)) {
        const a = one.index[name];
        const b = two.index[name];
        if (b.x !== a.x * 2 || b.y !== a.y * 2 || b.width !== a.width * 2 || b.height !== a.height * 2) {
          problems.push(`@2x "${name}" is not exactly twice its @1x rectangle`);
        }
      }
    }
  }
}

function inspect(sheets: Sheet[], name: string): void {
  for (const sheet of sheets) {
    const entry = sheet.index[name];
    if (!entry) {
      console.log(`@${sheet.pixelRatio}x: no icon named "${name}"`);
      continue;
    }
    // Crop straight out of the DECODED png, so what is shown is what shipped.
    const decoded = decodePng(sheet.png);
    const alpha = new Uint8Array(entry.width * entry.height);
    for (let row = 0; row < entry.height; row += 1) {
      for (let column = 0; column < entry.width; column += 1) {
        alpha[row * entry.width + column] =
          decoded.data[((entry.y + row) * decoded.width + entry.x + column) * 4 + 3];
      }
    }
    console.log(
      `\n${name} @${sheet.pixelRatio}x  x=${entry.x} y=${entry.y} ${entry.width}x${entry.height} sdf=${entry.sdf}` +
        `  (atlas ${sheet.atlasWidth}x${sheet.atlasHeight})`,
    );
    console.log(sdfToAscii(entry.width, entry.height, 0, alpha));
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const checkOnly = argv.includes('--check');
  const inspectAt = argv.indexOf('--inspect');

  const names = new Set<string>();
  for (const icon of ICONS) {
    if (names.has(icon.name)) throw new Error(`duplicate sprite id "${icon.name}"`);
    names.add(icon.name);
  }
  for (const alias of Object.keys(ALIASES)) {
    if (names.has(alias)) throw new Error(`alias "${alias}" collides with a real icon`);
  }

  const paths = new Map<string, string>();
  for (const icon of ICONS) paths.set(icon.name, await readIconPath(icon.component));

  const sheets = PIXEL_RATIOS.map((pixelRatio) => buildSheet(paths, pixelRatio));

  const problems: string[] = [];
  verifySheets(sheets, problems);

  if (inspectAt >= 0) {
    inspect(sheets, argv[inspectAt + 1] ?? ICONS[0].name);
    return;
  }

  const tree: EmitTree = new Map();
  const encoder = new TextEncoder();
  for (const sheet of sheets) {
    const base = sheet.pixelRatio === 1 ? 'goway' : `goway@${sheet.pixelRatio}x`;
    tree.set(`${base}.png`, sheet.png);
    tree.set(`${base}.json`, encoder.encode(sheet.json));
  }

  if (checkOnly) await checkTree(OUTPUT_DIR, tree, problems);

  if (problems.length > 0) {
    console.error(`\nmap sprite: ${problems.length} problem(s)\n`);
    for (const problem of problems) console.error(`  • ${problem}`);
    console.error('');
    process.exit(1);
  }

  if (!checkOnly) await writeTree(OUTPUT_DIR, tree);

  const totalBytes = [...tree.values()].reduce((sum, bytes) => sum + bytes.length, 0);
  for (const sheet of sheets) {
    const base = sheet.pixelRatio === 1 ? 'goway' : `goway@${sheet.pixelRatio}x`;
    console.log(
      `map sprite: ${base} — ${sheet.atlasWidth}x${sheet.atlasHeight}, ` +
        `${Object.keys(sheet.index).length} entries (${ICONS.length} images + ${Object.keys(ALIASES).length} aliases), ` +
        `${formatBytes(sheet.png.length)}`,
    );
  }
  console.log(`map sprite: ${checkOnly ? 'OK — ' : ''}${tree.size} files, ${formatBytes(totalBytes)} total`);
}

await main();
