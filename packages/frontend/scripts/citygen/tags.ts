/**
 * OSM building tags → the normalised properties a city tile carries.
 *
 * Everything here is a PARSER over untrusted text. OSM's values are free-form
 * and the junk is real: `height=yes`, `height=~12`, `height=12;15`,
 * `building:levels=-1`, `roof:shape=pitched`, `building:colour=light_grey`,
 * `roof:direction=NNW`. A value this cannot read with confidence is DROPPED
 * — absent from the tile — never coerced into a plausible number, because a
 * plausible wrong number is the one kind of error nobody can see on a map
 * (`docs/MAP_3D_CITY.md` → Honesty). `__tests__/cityTags.test.ts` pins every
 * rule, junk included.
 *
 * The resolved heights follow OpenMapTiles' building layer (`height`, else
 * `building:levels × 3.66`, else 5 m; `min_height`, else
 * `building:min_level × 3.66`, else 0), so a building with no 3D tags stands
 * exactly as it does in the basemap, and differs only where OSM says more.
 * The one addition is the roof: Simple 3D Buildings defines `height` as the
 * TOP of the roof and `building:levels` as the storeys BELOW it, so a shaped
 * roof is carved out of a tagged `height` but stacked on top of levels.
 */
import {
  CITY_PROPS,
  METRES_PER_LEVEL,
  ROOF_MATERIALS,
  ROOF_SHAPES,
  type RoofMaterial,
  type RoofShape,
  UNKNOWN_HEIGHT_M,
  WALL_MATERIALS,
  type WallMaterial,
} from '../../lib/map/cityTiles';
import { CSS_NAMED_COLOURS } from './cssColours';

/** Tags as read off an element. */
export type Tags = Readonly<Record<string, string>>;

/** The tallest structure on Earth is 828 m; anything above this is a typo. */
const MAX_HEIGHT_M = 1000;
/** The most storeys any building has (Burj Khalifa: 163). */
const MAX_LEVELS = 200;
const FEET = 0.3048;
const INCHES = 0.0254;

/**
 * A length in metres, or `undefined` when the value is not one.
 *
 * Accepts what the OSM wiki documents and what mappers actually write: a bare
 * number (metres), a decimal comma, an `m`/`meters`/`metres` suffix, and feet
 * with optional inches (`40'`, `40 ft`, `40'6"`). Rejects ranges, lists,
 * approximations (`~12`), signs, exponents and anything over
 * {@link MAX_HEIGHT_M}. `allowZero` is for `min_height`, where 0 is a fact.
 */
export function parseLength(value: string | undefined, allowZero = false): number | undefined {
  if (value === undefined) return undefined;
  const text = value.trim().toLowerCase();
  let metres: number | undefined;
  const metric = /^(\d+(?:[.,]\d+)?)\s*(?:m|meters?|metres?)?$/.exec(text);
  if (metric) {
    metres = Number(metric[1].replace(',', '.'));
  } else {
    const imperial = /^(\d+(?:\.\d+)?)\s*(?:'|ft|feet)\s*(?:(\d+(?:\.\d+)?)\s*(?:"|in))?$/.exec(
      text,
    );
    if (imperial) metres = Number(imperial[1]) * FEET + Number(imperial[2] ?? 0) * INCHES;
  }
  if (metres === undefined || !Number.isFinite(metres)) return undefined;
  if (metres > MAX_HEIGHT_M) return undefined;
  if (metres < 0 || (metres === 0 && !allowZero)) return undefined;
  return metres;
}

/**
 * A storey count, or `undefined`. Whole numbers only, 0–{@link MAX_LEVELS}: a
 * `2.5` is a mapper describing an attic, which `roof:levels` exists for, and
 * rounding it would be inventing which half they meant.
 */
export function parseLevels(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const text = value.trim();
  if (!/^\d+$/.test(text)) return undefined;
  const levels = Number(text);
  return levels <= MAX_LEVELS ? levels : undefined;
}

/** Common spellings of the Simple 3D Buildings roof shapes. */
const ROOF_SHAPE_ALIASES: Readonly<Record<string, RoofShape>> = {
  pitched: 'gabled',
  gable: 'gabled',
  hip: 'hipped',
  half_hipped: 'half-hipped',
  'half-hip': 'half-hipped',
  pyramid: 'pyramidal',
  lean_to: 'skillion',
  shed: 'skillion',
  conical: 'cone',
  barrel: 'round',
};

/** `roof:shape` normalised, or `undefined` for a shape the renderer does not know. */
export function parseRoofShape(value: string | undefined): RoofShape | undefined {
  if (value === undefined) return undefined;
  const text = value.trim().toLowerCase();
  if ((ROOF_SHAPES as readonly string[]).includes(text)) return text as RoofShape;
  return ROOF_SHAPE_ALIASES[text];
}

const CARDINALS = [
  'n',
  'nne',
  'ne',
  'ene',
  'e',
  'ese',
  'se',
  'sse',
  's',
  'ssw',
  'sw',
  'wsw',
  'w',
  'wnw',
  'nw',
  'nnw',
];

/**
 * `roof:direction` as a compass bearing in `[0, 360)`: a number of degrees or
 * one of the sixteen cardinal points. It is the direction the roof's slope
 * FACES (downhill), per the wiki.
 */
export function parseDirection(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const text = value.trim().toLowerCase();
  const cardinal = CARDINALS.indexOf(text);
  if (cardinal >= 0) return cardinal * 22.5;
  if (!/^-?\d+(?:\.\d+)?$/.test(text)) return undefined;
  const degrees = Number(text);
  if (!Number.isFinite(degrees) || Math.abs(degrees) > 720) return undefined;
  return ((degrees % 360) + 360) % 360;
}

/** `roof:orientation`: `along` (the default) or `across`. */
export function parseOrientation(value: string | undefined): 'along' | 'across' | undefined {
  const text = value?.trim().toLowerCase();
  return text === 'along' || text === 'across' ? text : undefined;
}

/** `roof:angle` in degrees, strictly between 0 and 80. */
export function parseAngle(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const text = value.trim().replace(/\s*°$/, '');
  if (!/^\d+(?:\.\d+)?$/.test(text)) return undefined;
  const degrees = Number(text);
  return degrees > 0 && degrees < 80 ? degrees : undefined;
}

/**
 * A colour as `#rrggbb`: a CSS name (spaces, hyphens and underscores ignored),
 * `#rgb`, `#rrggbb`, or six hex digits without the `#`. `undefined` otherwise —
 * including for values like `brick` or `multi` that name a look, not a colour.
 */
export function parseColour(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const text = value.trim().toLowerCase();
  let hex = /^#?([0-9a-f]{6})$/.exec(text)?.[1];
  if (!hex) {
    const short = /^#([0-9a-f]{3})$/.exec(text)?.[1];
    if (short) hex = [...short].map((digit) => digit + digit).join('');
  }
  if (!hex) {
    const named = CSS_NAMED_COLOURS[text.replace(/[\s_-]+/g, '')];
    if (named !== undefined) hex = named.toString(16).padStart(6, '0');
  }
  return hex ? `#${hex}` : undefined;
}

const WALL_MATERIAL_ALIASES: Readonly<Record<string, WallMaterial>> = {
  bricks: 'brick',
  reinforced_concrete: 'concrete',
  cement_block: 'concrete',
  concrete_block: 'concrete',
  timber: 'wood',
  render: 'plaster',
  stucco: 'plaster',
  metal_plates: 'metal',
  glass_facade: 'glass',
};

const ROOF_MATERIAL_ALIASES: Readonly<Record<string, RoofMaterial>> = {
  tile: 'roof_tiles',
  tiles: 'roof_tiles',
  clay_tiles: 'roof_tiles',
  metal_sheet: 'metal',
  steel: 'metal',
  zinc: 'metal',
  asphalt: 'tar_paper',
  bitumen: 'tar_paper',
  eternit: 'concrete',
  slate_tiles: 'slate',
  vegetation: 'grass',
  green: 'grass',
  solar_panel: 'solar_panels',
};

function parseVocabulary<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  aliases: Readonly<Record<string, T>>,
): T | undefined {
  if (value === undefined) return undefined;
  const text = value.trim().toLowerCase().replace(/\s+/g, '_');
  if ((allowed as readonly string[]).includes(text)) return text as T;
  return aliases[text];
}

export const parseWallMaterial = (value: string | undefined) =>
  parseVocabulary(value, WALL_MATERIALS, WALL_MATERIAL_ALIASES);
export const parseRoofMaterial = (value: string | undefined) =>
  parseVocabulary(value, ROOF_MATERIALS, ROOF_MATERIAL_ALIASES);

/** Whether a key=value pair says "this is (part of) a building". */
function affirmative(value: string | undefined): boolean {
  return value !== undefined && value !== 'no' && value !== '';
}

/** What an element is, for the compiler: an outline, a part, or nothing it draws. */
export function buildingKind(tags: Tags): 'building' | 'part' | null {
  // Underground structures are real buildings and are not part of the skyline.
  if (tags.location === 'underground' || tags.building === 'underground') return null;
  if (affirmative(tags['building:part'])) return 'part';
  if (affirmative(tags.building)) return 'building';
  return null;
}

/**
 * The roof's footprint geometry the default roof height needs, measured on
 * the WHOLE building by the compiler (`components/map/engine/city3d/roofs.ts`
 * → `roofFrame`). `halfWidth` is half the side across the ridge.
 */
export interface RoofSpan {
  halfWidth: number;
  halfLength: number;
}

/** Pitch used when a shape is tagged and nothing says how steep it is. */
export const DEFAULT_ROOF_PITCH_DEG = 30;

/**
 * The height a shaped roof is drawn at when only its shape is recorded.
 *
 * The SHAPE is a fact (`roof:shape`); the pitch is not, so this is the
 * styling half of a tagged roof, and it is stated as such in the tile
 * (`roof_height_source=default`). Domes rise by their radius and onions a
 * little more; everything else takes {@link DEFAULT_ROOF_PITCH_DEG}, or the
 * tagged `roof:angle`, over the half-width it spans.
 */
export function defaultRoofHeight(shape: RoofShape, span: RoofSpan, angleDeg?: number): number {
  const tan = Math.tan(((angleDeg ?? DEFAULT_ROOF_PITCH_DEG) * Math.PI) / 180);
  const radius = Math.min(span.halfWidth, span.halfLength);
  switch (shape) {
    case 'flat':
      return 0;
    case 'dome':
      return radius;
    case 'onion':
      return radius * 1.5;
    case 'cone':
      return radius * (angleDeg ? tan : 2);
    case 'skillion':
      // One slope across the whole width, not half of it.
      return 2 * span.halfWidth * Math.tan(((angleDeg ?? 15) * Math.PI) / 180);
    case 'pyramidal':
      return radius * tan;
    default:
      return span.halfWidth * tan;
  }
}

/** The normalised, resolved properties one feature carries into a tile. */
export type CityFeatureProperties = Record<string, string | number | boolean>;

const round1 = (value: number) => Math.round(value * 10) / 10;

/**
 * Tags → tile properties.
 *
 * `span` is the footprint's roof frame, needed only when a shaped roof has
 * neither `roof:height` nor `roof:levels`; pass `undefined` and such a roof
 * draws flat (which is what happens to a footprint too degenerate to frame).
 */
export function resolveProperties(
  tags: Tags,
  kind: 'building' | 'part',
  span: RoofSpan | undefined,
): CityFeatureProperties {
  const props: CityFeatureProperties = {};

  const height = parseLength(tags.height);
  const minHeight = parseLength(tags.min_height, true);
  const levels = parseLevels(tags['building:levels']);
  const minLevel = parseLevels(tags['building:min_level']);
  const roofLevels = parseLevels(tags['roof:levels']);

  // The roof, if it has a shape.
  let shape = parseRoofShape(tags['roof:shape']);
  let roofHeight = 0;
  let roofSource: string | undefined;
  if (shape && shape !== 'flat') {
    const tagged = parseLength(tags['roof:height'], true);
    const angle = parseAngle(tags['roof:angle']);
    if (tagged !== undefined) {
      roofHeight = tagged;
      roofSource = 'tag';
    } else if (roofLevels !== undefined && roofLevels > 0) {
      roofHeight = roofLevels * METRES_PER_LEVEL;
      roofSource = 'levels';
    } else if (span) {
      roofHeight = defaultRoofHeight(shape, span, angle);
      roofSource = angle !== undefined ? 'angle' : 'default';
    }
    if (!(roofHeight > 0)) {
      // A shape with no height to draw it at is a flat roof, honestly.
      shape = undefined;
      roofHeight = 0;
      roofSource = undefined;
    }
  }

  // The base.
  let base = minHeight ?? (minLevel !== undefined ? minLevel * METRES_PER_LEVEL : 0);

  // The top: `height` is the top of the roof; levels are the storeys below it.
  let top: number;
  if (height !== undefined) {
    top = height;
  } else if (levels !== undefined) {
    top = levels * METRES_PER_LEVEL + roofHeight;
  } else {
    top = UNKNOWN_HEIGHT_M + roofHeight;
  }

  // An inverted span (`min_height` at or above the top) drops to the ground,
  // exactly as `buildingSpan` in the OpenMapTiles mesher does.
  if (base >= top) base = 0;

  // A roof cannot be taller than the building; a DEFAULT roof (a styling
  // choice, see `defaultRoofHeight`) may use at most half of it.
  if (shape && shape !== 'flat') {
    const span3d = top - base;
    const cap = roofSource === 'default' || roofSource === 'angle' ? span3d / 2 : span3d;
    roofHeight = Math.min(roofHeight, cap);
  }

  // `building=roof`: a roof on pillars — a canopy, a market hall's roof. It
  // records that there are no walls, so draw the roof's thickness only.
  if (tags.building === 'roof' && minHeight === undefined && minLevel === undefined) {
    base = Math.max(base, top - Math.max(1, roofHeight));
  }

  props[CITY_PROPS.renderHeight] = round1(top);
  props[CITY_PROPS.renderMinHeight] = round1(base);
  if (height !== undefined) props[CITY_PROPS.height] = round1(height);
  // Recorded by OSM: the client must not replace it with a measurement.
  if (height !== undefined || levels !== undefined) props[CITY_PROPS.heightSource] = 'osm';
  if (levels !== undefined) props[CITY_PROPS.levels] = levels;
  if (minLevel !== undefined) props[CITY_PROPS.minLevel] = minLevel;
  if (shape) {
    props[CITY_PROPS.roofShape] = shape;
    if (shape !== 'flat') {
      props[CITY_PROPS.roofHeight] = round1(roofHeight);
      if (roofSource) props[CITY_PROPS.roofHeightSource] = roofSource;
    }
  }
  const direction = parseDirection(tags['roof:direction']);
  if (direction !== undefined) props[CITY_PROPS.roofDirection] = round1(direction);
  if (parseOrientation(tags['roof:orientation']) === 'across') {
    props[CITY_PROPS.roofOrientation] = 'across';
  }
  // `building:colour` is the documented key; a bare `colour` on a building
  // means the same thing and is widespread enough to read.
  const colour = parseColour(tags['building:colour'] ?? tags.colour);
  if (colour) props[CITY_PROPS.colour] = colour;
  const roofColour = parseColour(tags['roof:colour']);
  if (roofColour) props[CITY_PROPS.roofColour] = roofColour;
  const material = parseWallMaterial(tags['building:material']);
  if (material) props[CITY_PROPS.material] = material;
  const roofMaterial = parseRoofMaterial(tags['roof:material']);
  if (roofMaterial) props[CITY_PROPS.roofMaterial] = roofMaterial;
  if (kind === 'part') props[CITY_PROPS.part] = true;
  return props;
}
