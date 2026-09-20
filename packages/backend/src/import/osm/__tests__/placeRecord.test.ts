/**
 * Turning an element into a place: the source id, every name, and the address.
 */

import { describe, expect, test } from 'bun:test';
import {
  importedNames,
  osmSourceId,
  roundCoordinate,
  sourceDataOf,
  toImportedPlace,
} from '../placeRecord';

function tags(entries: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(entries));
}

const MUSEU_PICASSO = tags({
  tourism: 'museum',
  name: 'Museu Picasso',
  'name:ca': 'Museu Picasso',
  'name:es': 'Museo Picasso',
  'name:en': 'Picasso Museum',
  'name:ja': 'ピカソ美術館',
  'name:etymology': 'Pablo Picasso',
  'name:left': 'nonsense',
  'addr:street': 'Carrer de Montcada',
  'addr:housenumber': '15-23',
  'addr:city': 'Barcelona',
  'addr:postcode': '08003',
  'addr:country': 'es',
  website: 'https://www.museupicasso.bcn.cat',
  phone: '+34 932 56 30 00',
});

describe('osmSourceId', () => {
  test('carries the element type, which is the whole of issue #58', () => {
    expect(osmSourceId('way', 34_633_854)).toBe('way/34633854');
    expect(osmSourceId('node', 34_633_854)).toBe('node/34633854');
    expect(osmSourceId('relation', 6_288_735)).toBe('relation/6288735');
  });
});

describe('importedNames', () => {
  test('imports every language and skips the keys that are not languages', () => {
    expect(importedNames(MUSEU_PICASSO, 'Museu Picasso').sort((a, b) => a.language.localeCompare(b.language))).toEqual([
      { language: 'en', name: 'Picasso Museum' },
      { language: 'es', name: 'Museo Picasso' },
      { language: 'ja', name: 'ピカソ美術館' },
    ]);
  });

  test('drops a translation identical to the default name', () => {
    // `name:ca` repeats `name` here, as it does on a large share of Spanish
    // elements. Storing it would be several million rows that say nothing.
    expect(importedNames(MUSEU_PICASSO, 'Museu Picasso').map((name) => name.language)).not.toContain('ca');
  });

  test('normalizes the tag rather than storing what the key happened to spell', () => {
    const element = tags({ 'name:ZH_hant': '巴塞隆納', 'name:PT-br': 'Barcelona (BR)' });
    expect(importedNames(element, 'Barcelona').map((name) => name.language).sort()).toEqual([
      'pt-BR',
      'zh-Hant',
    ]);
  });
});

describe('toImportedPlace', () => {
  test('flattens the address and takes every contact detail', () => {
    const place = toImportedPlace('way', 188_938_001, 41.385_262, 2.180_75, MUSEU_PICASSO);
    expect(place).not.toBeNull();
    expect(place?.sourceId).toBe('way/188938001');
    expect(place?.name).toBe('Museu Picasso');
    expect(place?.categories).toEqual(['museum', 'culture']);
    expect(place?.addressStreet).toBe('Carrer de Montcada');
    expect(place?.addressHouseNumber).toBe('15-23');
    expect(place?.addressCity).toBe('Barcelona');
    expect(place?.addressPostalCode).toBe('08003');
    // `addr:country` is lower-case in the wild and the column's CHECK is not.
    expect(place?.addressCountryCode).toBe('ES');
    expect(place?.contactWebsite).toBe('https://www.museupicasso.bcn.cat');
    expect(place?.contactPhone).toBe('+34 932 56 30 00');
    expect(place?.names).toHaveLength(3);
  });

  test('refuses an element with no name, whatever else it carries', () => {
    expect(toImportedPlace('node', 1, 41, 2, tags({ amenity: 'restaurant' }))).toBeNull();
    expect(toImportedPlace('node', 1, 41, 2, tags({ amenity: 'restaurant', name: '   ' }))).toBeNull();
  });

  test('refuses a named element that is not a POI', () => {
    expect(toImportedPlace('node', 1, 41, 2, tags({ place: 'town', name: 'Girona' }))).toBeNull();
  });

  test('refuses a position outside the ordinate ranges the table checks', () => {
    expect(toImportedPlace('node', 1, 120, 2, tags({ amenity: 'cafe', name: 'X' }))).toBeNull();
    expect(toImportedPlace('node', 1, 41, 200, tags({ amenity: 'cafe', name: 'X' }))).toBeNull();
    expect(toImportedPlace('node', 1, Number.NaN, 2, tags({ amenity: 'cafe', name: 'X' }))).toBeNull();
  });

  test('rejects an implausibly long country code rather than failing the CHECK later', () => {
    const place = toImportedPlace('node', 1, 41, 2, tags({ amenity: 'cafe', name: 'X', 'addr:country': 'Spain' }));
    expect(place?.addressCountryCode).toBeNull();
  });
});

describe('roundCoordinate and sourceDataOf', () => {
  test('rounds to OpenStreetMap s own precision, so two runs compare equal', () => {
    expect(roundCoordinate(41.38526239999999)).toBe(41.3852624);
    expect(roundCoordinate(roundCoordinate(2.1807501))).toBe(roundCoordinate(2.1807501));
  });

  test('records exactly the normalized values that went into the columns', () => {
    const place = toImportedPlace('node', 7, 41.1, 2.2, tags({ amenity: 'cafe', name: 'Bar Pepe' }));
    expect(place).not.toBeNull();
    const stated = sourceDataOf(place!);
    expect(stated.name).toBe('Bar Pepe');
    expect(stated.latitude).toBe(place!.latitude);
    expect(stated.categories).toEqual(place!.categories);
    // Not the raw tags: what is stored is what the comparison on the next run
    // needs, in the form the column holds it.
    expect(stated).not.toHaveProperty('amenity');
  });
});
