/**
 * OpenStreetMap `natural=tree` tags → the city tiles' tree properties
 * (`lib/map/cityTiles.ts` → `CITY_TREE_PROPS`).
 *
 * Only what is recorded: a crown form when `leaf_type` or the botanical name
 * says it, a height, a crown diameter or a trunk circumference when tagged
 * with a readable number, and `street` when the tree is recorded as a street
 * or avenue tree (a node of a `natural=tree_row`, `denotation=avenue|urban`).
 * Nothing is inferred from position, neighbours or the area's other trees —
 * the client reads the setting from the tiles around it (`treeContext.ts`).
 */
import type { CityTileTree, TreeCrown } from '../../lib/map/cityTiles';

/** The `natural=tree` keys the compiler keeps (everything {@link treeProperties} reads). */
export const TREE_KEYS = new Set([
  'leaf_type',
  'genus',
  'species',
  'taxon',
  'taxon:family',
  'genus:en',
  'species:en',
  'height',
  'diameter_crown',
  'circumference',
  'denotation',
]);

/** `denotation` values that record a street or avenue tree. */
const STREET_DENOTATIONS = new Set(['avenue', 'urban']);

/** Families drawn as palms or conifers (`taxon:family`, or a family as `taxon`). */
const PALM_FAMILIES = new Set(['arecaceae', 'palmae']);
const CONIFER_FAMILIES = new Set([
  'pinaceae',
  'cupressaceae',
  'taxaceae',
  'araucariaceae',
  'podocarpaceae',
]);

/** Genera drawn as palms (Arecaceae commonly planted in streets and parks). */
const PALM_GENERA = new Set([
  'phoenix',
  'washingtonia',
  'trachycarpus',
  'chamaerops',
  'butia',
  'syagrus',
  'cocos',
  'roystonea',
  'livistona',
  'sabal',
  'archontophoenix',
  'howea',
  'brahea',
  'jubaea',
]);

/** Genera drawn as conifers. */
const CONIFER_GENERA = new Set([
  'pinus',
  'cedrus',
  'cupressus',
  'abies',
  'picea',
  'taxus',
  'juniperus',
  'thuja',
  'sequoia',
  'sequoiadendron',
  'larix',
  'araucaria',
  'pseudotsuga',
  'cryptomeria',
  'chamaecyparis',
  'tsuga',
  'metasequoia',
  'taxodium',
  'calocedrus',
  'platycladus',
  'cupressocyparis',
  'xcupressocyparis',
  'podocarpus',
]);

/** A metre count from an OSM length (`12`, `12 m`, `12.5m`), or `undefined`. */
export function parseMetres(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = /^\s*(\d+(?:[.,]\d+)?)\s*(m)?\s*$/.exec(value);
  if (!match) return undefined;
  const metres = Number(match[1].replace(',', '.'));
  return metres > 0 && metres < 150 ? metres : undefined;
}

/**
 * A trunk circumference in metres (`1.2`, `1.2 m`, `120 cm` — OSM's default
 * unit is the metre), or `undefined`. 5 cm to 20 m.
 */
export function parseCircumference(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = /^\s*(\d+(?:[.,]\d+)?)\s*(m|cm)?\s*$/.exec(value);
  if (!match) return undefined;
  const number = Number(match[1].replace(',', '.'));
  const metres = match[2] === 'cm' ? number / 100 : number;
  return metres >= 0.05 && metres <= 20 ? metres : undefined;
}

/** The genus a botanical name starts with, lower case (`Platanus x hispanica` → `platanus`). */
function genusOf(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const first = name
    .trim()
    .split(/[\s_]+/)[0]
    ?.toLowerCase();
  return first && /^[a-z×x-]+$/.test(first) ? first.replace(/^×/, '') : undefined;
}

/** The crown form the tags record, or `undefined`. */
export function treeCrown(tags: Record<string, string>): TreeCrown | undefined {
  for (const name of [tags.genus, tags.species, tags.taxon, tags['genus:en'], tags['species:en']]) {
    const genus = genusOf(name);
    if (!genus) continue;
    if (PALM_GENERA.has(genus)) return 'palm';
    if (CONIFER_GENERA.has(genus)) return 'conifer';
  }
  for (const name of [tags['taxon:family'], tags.taxon]) {
    const family = name?.trim().toLowerCase();
    if (!family) continue;
    if (PALM_FAMILIES.has(family)) return 'palm';
    if (CONIFER_FAMILIES.has(family)) return 'conifer';
  }
  if (tags.leaf_type === 'palm') return 'palm';
  if (tags.leaf_type === 'needleleaved') return 'conifer';
  if (tags.leaf_type === 'broadleaved') return 'broadleaf';
  return undefined;
}

/**
 * The tile properties of one `natural=tree` node's tags. `inTreeRow`: the
 * node is a node of a `natural=tree_row` way (the compiler's way pass).
 */
export function treeProperties(
  tags: Record<string, string>,
  inTreeRow = false,
): CityTileTree['properties'] {
  const properties: CityTileTree['properties'] = {};
  const crown = treeCrown(tags);
  if (crown) properties.crown = crown;
  const height = parseMetres(tags.height);
  if (height !== undefined) properties.height = height;
  const diameter = parseMetres(tags.diameter_crown);
  if (diameter !== undefined) properties.crown_diameter = diameter;
  const circumference = parseCircumference(tags.circumference);
  if (circumference !== undefined) properties.circumference = circumference;
  if (inTreeRow || STREET_DENOTATIONS.has(tags.denotation)) properties.street = true;
  return properties;
}
