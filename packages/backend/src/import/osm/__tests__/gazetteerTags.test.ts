/**
 * What counts as a gazetteer place, and which kind it is.
 *
 * The `admin_level` mapping is a convention with real per-country variation, so
 * these tests pin the exact ranges this importer commits to rather than leaving
 * them to be inferred from the one example a reader happens to try.
 */

import { describe, expect, test } from 'bun:test';
import { classifyGazetteer, isGazetteerMappingKey } from '../gazetteerTags';

function tags(entries: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(entries));
}

describe('isGazetteerMappingKey', () => {
  test('only `boundary` gates a gazetteer place', () => {
    expect(isGazetteerMappingKey('boundary')).toBe(true);
    expect(isGazetteerMappingKey('place')).toBe(false);
    expect(isGazetteerMappingKey('amenity')).toBe(false);
  });
});

describe('classifyGazetteer', () => {
  test('a city boundary (admin_level 8) is a locality', () => {
    // Barcelona is `relation/347950`, `admin_level=8` — the element the
    // geocoders key a city search to.
    expect(
      classifyGazetteer(tags({ boundary: 'administrative', admin_level: '8', name: 'Barcelona' })),
    ).toEqual({
      kind: 'locality',
      categories: ['locality'],
    });
  });

  test('a province or state boundary (admin_level 4–6) is a region', () => {
    for (const level of ['4', '5', '6']) {
      expect(
        classifyGazetteer(tags({ boundary: 'administrative', admin_level: level }))?.kind,
      ).toBe('region');
    }
  });

  test('a municipality or suburb boundary (admin_level 7–11) is a locality', () => {
    for (const level of ['7', '8', '9', '10', '11']) {
      expect(
        classifyGazetteer(tags({ boundary: 'administrative', admin_level: level }))?.kind,
      ).toBe('locality');
    }
  });

  test('a country or supranational boundary (admin_level 2–3) is not kept', () => {
    // There is no GoWay-owned copy of a country, for the same reason there is no
    // GoWay-owned copy of the planet.
    expect(
      classifyGazetteer(tags({ boundary: 'administrative', admin_level: '2', name: 'España' })),
    ).toBeNull();
    expect(classifyGazetteer(tags({ boundary: 'administrative', admin_level: '3' }))).toBeNull();
  });

  test('a level finer than a suburb is not kept', () => {
    expect(classifyGazetteer(tags({ boundary: 'administrative', admin_level: '12' }))).toBeNull();
  });

  test('a non-administrative boundary is not a gazetteer place', () => {
    // Postal and statistical boundaries carry `boundary` but are not the
    // administrative hierarchy a city lives in.
    expect(classifyGazetteer(tags({ boundary: 'postal_code', admin_level: '8' }))).toBeNull();
    expect(classifyGazetteer(tags({ boundary: 'census', admin_level: '8' }))).toBeNull();
  });

  test('an administrative boundary with no admin_level is not kept', () => {
    expect(classifyGazetteer(tags({ boundary: 'administrative', name: 'Somewhere' }))).toBeNull();
  });

  test('a non-integer admin_level is not kept', () => {
    expect(
      classifyGazetteer(tags({ boundary: 'administrative', admin_level: 'eight' })),
    ).toBeNull();
    expect(classifyGazetteer(tags({ boundary: 'administrative', admin_level: '8.5' }))).toBeNull();
  });

  test('an element with no boundary is not a gazetteer place', () => {
    expect(classifyGazetteer(tags({ place: 'city', name: 'Barcelona' }))).toBeNull();
    expect(classifyGazetteer(tags({ amenity: 'cafe', name: 'Cafè' }))).toBeNull();
  });
});
