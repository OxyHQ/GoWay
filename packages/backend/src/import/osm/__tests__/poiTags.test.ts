/**
 * What counts as a POI, reconciled against the map style rather than asserted.
 *
 * Two of these tests READ `packages/frontend/lib/map/style/layers.ts` and
 * `schema.ts` and compare against what is in them today. That is deliberate:
 * `poiTags.ts` copies a list of classes out of the frontend because the backend
 * must not depend on the frontend package, and a copy with a comment saying
 * where it came from is a copy that silently goes stale. Reading the source
 * makes "copied from layers.ts" a checked claim.
 *
 * If the frontend moves those files, these tests fail — which is exactly the
 * moment somebody should be looking at whether the import still covers what the
 * basemap draws.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLUTTER_CLASSES_FOR_TEST, classifyPoi, isPoiMappingKey, poiCategories } from '../poiTags';

const STYLE_DIRECTORY = join(__dirname, '../../../../../frontend/lib/map/style');

/** The single-quoted identifiers of a `const NAME = [ … ]`, comments stripped. */
function stringArray(source: string, name: string): string[] {
  const start = source.indexOf(`const ${name} = [`);
  if (start < 0) throw new Error(`${name} is no longer declared where this test expects it.`);
  const end = source.indexOf('];', start);
  const body = source
    .slice(start, end)
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
  return [...body.matchAll(/'([a-z0-9_]+)'/g)].map((match) => match[1] as string);
}

function tags(entries: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(entries));
}

describe('the imported set against the basemap', () => {
  test('excludes at least every class the map style draws nowhere', () => {
    const layers = readFileSync(join(STYLE_DIRECTORY, 'layers.ts'), 'utf8');
    const clutter = stringArray(layers, 'POI_CLUTTER_CLASSES');
    expect(clutter.length).toBeGreaterThan(10);
    for (const className of clutter) {
      expect(CLUTTER_CLASSES_FOR_TEST.has(className)).toBe(true);
    }
  });

  test('every class the style groups and colours is reachable from a tag', () => {
    const layers = readFileSync(join(STYLE_DIRECTORY, 'layers.ts'), 'utf8');
    const grouped = new Set(
      [...layers.matchAll(/\['(?:foodDrink|shopping|outdoors|transit|lodging|health|civic|culture|worship|vehicle)', \[([^\]]*)\]\]/g)]
        .flatMap((match) => [...(match[1] ?? '').matchAll(/'([a-z0-9_]+)'/g)].map((entry) => entry[1] as string)),
    );
    expect(grouped.size).toBeGreaterThan(50);

    const produced = new Set(
      REPRESENTATIVE_TAGS.map(([element]) => classifyPoi(tags(element))?.className).filter(
        (className): className is string => className !== undefined,
      ),
    );
    // `POI_STATION_CLASSES` is spread into the transit group, so the regex above
    // sees `...POI_STATION_CLASSES` rather than its members; they are covered by
    // the representative table instead.
    const missing = [...grouped].filter((className) => !produced.has(className));
    expect(missing).toEqual([]);
  });

  test('the poi class vocabulary the style records still contains what we produce', () => {
    const schema = readFileSync(join(STYLE_DIRECTORY, 'schema.ts'), 'utf8');
    const known = new Set(stringArray(schema, 'POI_CLASSES'));
    expect(known.size).toBeGreaterThan(80);
    for (const [element, expected] of REPRESENTATIVE_TAGS) {
      expect({ element, known: known.has(expected) }).toEqual({ element, known: true });
    }
  });
});

/**
 * One tag combination per class the basemap colours, and the class it must
 * produce.
 *
 * This table IS the reconciliation. Written out rather than generated, because
 * "which OpenStreetMap tag becomes a pharmacy" is a decision and a generated
 * version would only restate the code under test.
 */
const REPRESENTATIVE_TAGS: [Record<string, string>, string][] = [
  [{ amenity: 'restaurant' }, 'restaurant'],
  [{ amenity: 'fast_food' }, 'fast_food'],
  [{ amenity: 'cafe' }, 'cafe'],
  [{ amenity: 'bar' }, 'bar'],
  [{ amenity: 'pub' }, 'beer'],
  [{ amenity: 'ice_cream' }, 'ice_cream'],
  [{ shop: 'gift' }, 'shop'],
  [{ shop: 'clothes' }, 'clothing_store'],
  [{ shop: 'supermarket' }, 'grocery'],
  [{ shop: 'alcohol' }, 'alcohol_shop'],
  [{ shop: 'bakery' }, 'bakery'],
  [{ shop: 'butcher' }, 'butcher'],
  [{ shop: 'hairdresser' }, 'hairdresser'],
  [{ shop: 'laundry' }, 'laundry'],
  [{ leisure: 'park' }, 'park'],
  [{ leisure: 'garden' }, 'garden'],
  [{ leisure: 'playground' }, 'playground'],
  [{ leisure: 'pitch' }, 'pitch'],
  [{ leisure: 'dog_park' }, 'dog_park'],
  [{ tourism: 'picnic_site' }, 'picnic_site'],
  [{ leisure: 'golf_course' }, 'golf'],
  [{ tourism: 'zoo' }, 'zoo'],
  [{ leisure: 'sports_centre' }, 'sports_centre'],
  [{ leisure: 'stadium' }, 'stadium'],
  [{ leisure: 'swimming_pool' }, 'swimming_pool'],
  [{ leisure: 'ice_rink' }, 'ice_rink'],
  [{ sport: 'athletics' }, 'athletics'],
  [{ sport: 'cycling' }, 'cycling'],
  [{ sport: 'running' }, 'running'],
  [{ sport: 'yoga' }, 'yoga'],
  [{ sport: 'boxing' }, 'boxing'],
  [{ sport: 'gymnastics' }, 'gymnastics'],
  [{ sport: 'equestrian' }, 'equestrian'],
  [{ highway: 'bus_stop' }, 'bus'],
  [{ railway: 'station' }, 'railway'],
  [{ railway: 'tram_stop' }, 'railway'],
  [{ aerialway: 'station' }, 'aerialway'],
  [{ amenity: 'ferry_terminal' }, 'ferry_terminal'],
  [{ tourism: 'hotel' }, 'lodging'],
  [{ tourism: 'hostel' }, 'lodging'],
  [{ amenity: 'hospital' }, 'hospital'],
  [{ amenity: 'pharmacy' }, 'pharmacy'],
  [{ amenity: 'doctors' }, 'doctors'],
  [{ amenity: 'dentist' }, 'dentist'],
  [{ amenity: 'veterinary' }, 'veterinary'],
  [{ amenity: 'school' }, 'school'],
  [{ amenity: 'university' }, 'college'],
  [{ amenity: 'library' }, 'library'],
  [{ amenity: 'townhall' }, 'town_hall'],
  [{ amenity: 'police' }, 'police'],
  [{ amenity: 'fire_station' }, 'fire_station'],
  [{ amenity: 'post_office' }, 'post'],
  [{ office: 'insurance' }, 'office'],
  [{ amenity: 'bank' }, 'bank'],
  [{ amenity: 'atm' }, 'atm'],
  [{ tourism: 'museum' }, 'museum'],
  [{ tourism: 'gallery' }, 'art_gallery'],
  [{ amenity: 'theatre' }, 'theatre'],
  [{ amenity: 'cinema' }, 'cinema'],
  [{ tourism: 'attraction' }, 'attraction'],
  [{ historic: 'monument' }, 'monument'],
  [{ historic: 'castle' }, 'castle'],
  [{ tourism: 'aquarium' }, 'aquarium'],
  [{ shop: 'music' }, 'music'],
  [{ leisure: 'escape_game' }, 'escape_game'],
  [{ leisure: 'hackerspace' }, 'hackerspace'],
  [{ tourism: 'theme_park' }, 'theme_park'],
  [{ amenity: 'place_of_worship' }, 'place_of_worship'],
  [{ landuse: 'cemetery' }, 'cemetery'],
  [{ amenity: 'parking' }, 'parking'],
  [{ amenity: 'fuel' }, 'fuel'],
  [{ shop: 'car' }, 'car'],
  [{ shop: 'bicycle' }, 'bicycle'],
  [{ amenity: 'bicycle_rental' }, 'bicycle_rental'],
  [{ shop: 'motorcycle' }, 'motorcycle'],
  [{ leisure: 'marina' }, 'harbor'],
  [{ amenity: 'toilets' }, 'toilets'],
  [{ tourism: 'information' }, 'information'],
  [{ tourism: 'camp_site' }, 'campsite'],
  [{ leisure: 'swimming_area' }, 'swimming'],
];

describe('classifyPoi', () => {
  test('maps every representative tag to the class the style expects', () => {
    for (const [element, expected] of REPRESENTATIVE_TAGS) {
      expect({ element, className: classifyPoi(tags(element))?.className }).toEqual({
        element,
        className: expected,
      });
    }
  });

  test('refuses the classes the map never draws', () => {
    const clutter: Record<string, string>[] = [
      { barrier: 'gate' },
      { barrier: 'bollard' },
      { amenity: 'waste_basket' },
      { amenity: 'bicycle_parking' },
      { amenity: 'shelter' },
      { railway: 'subway_entrance' },
      { landuse: 'brownfield' },
      { amenity: 'drinking_water' },
    ];
    for (const element of clutter) {
      expect({ element, kind: classifyPoi(tags(element)) }).toEqual({ element, kind: null });
    }
  });

  test('refuses a tag key that qualifies nothing, and a value the key does not accept', () => {
    expect(classifyPoi(tags({ building: 'yes' }))).toBeNull();
    expect(classifyPoi(tags({ landuse: 'residential' }))).toBeNull();
    expect(classifyPoi(tags({ highway: 'residential' }))).toBeNull();
    expect(classifyPoi(tags({ place: 'town' }))).toBeNull();
    expect(classifyPoi(tags({ amenity: 'no' }))).toBeNull();
  });

  test('accepts any value of an open key, so the set cannot fall behind OpenStreetMap', () => {
    // A tag that did not exist when this table was written still becomes a
    // place, which is the property that keeps the import a superset of the
    // basemap as OpenMapTiles widens its own whitelist.
    const kind = classifyPoi(tags({ amenity: 'mobility_hub' }));
    expect(kind).toEqual({ mappingKey: 'amenity', subclass: 'mobility_hub', className: 'mobility_hub' });
  });

  test('a restaurant that is also an attraction is a restaurant', () => {
    expect(classifyPoi(tags({ amenity: 'restaurant', tourism: 'attraction' }))?.className).toBe(
      'restaurant',
    );
  });

  test('isPoiMappingKey answers for the keys the table opens', () => {
    expect(isPoiMappingKey('amenity')).toBe(true);
    expect(isPoiMappingKey('shop')).toBe(true);
    expect(isPoiMappingKey('name')).toBe(false);
    expect(isPoiMappingKey('addr:street')).toBe(false);
  });
});

describe('poiCategories', () => {
  test('is most specific first and collapses a subclass equal to its class', () => {
    expect(poiCategories({ mappingKey: 'amenity', subclass: 'cafe', className: 'cafe' })).toEqual([
      'cafe',
      'food_drink',
    ]);
    expect(poiCategories({ mappingKey: 'shop', subclass: 'supermarket', className: 'grocery' })).toEqual([
      'supermarket',
      'grocery',
      'shopping',
    ]);
  });

  test('omits the group rather than inventing one for a class in no group', () => {
    expect(poiCategories({ mappingKey: 'amenity', subclass: 'toilets', className: 'toilets' })).toEqual([
      'toilets',
    ]);
  });
});
