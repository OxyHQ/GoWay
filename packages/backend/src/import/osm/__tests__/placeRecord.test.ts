/**
 * Turning an element into a place: the source id, every name, and the address.
 */

import { describe, expect, test } from 'bun:test';
import { SEEDED_CATALOG } from '../../../__tests__/categoryFixtures';
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
    const place = toImportedPlace('way', 188_938_001, 41.385_262, 2.180_75, MUSEU_PICASSO, SEEDED_CATALOG);
    expect(place).not.toBeNull();
    expect(place?.sourceId).toBe('way/188938001');
    expect(place?.columns.name).toBe('Museu Picasso');
    expect(place?.columns.categories).toEqual(['culture.museum']);
    expect(place?.columns.addressStreet).toBe('Carrer de Montcada');
    expect(place?.columns.addressHouseNumber).toBe('15-23');
    expect(place?.columns.addressCity).toBe('Barcelona');
    expect(place?.columns.addressPostalCode).toBe('08003');
    // `addr:country` is lower-case in the wild and the column's CHECK is not.
    expect(place?.columns.addressCountryCode).toBe('ES');
    expect(place?.columns.contactWebsite).toBe('https://www.museupicasso.bcn.cat');
    expect(place?.columns.contactPhone).toBe('+34 932 56 30 00');
    expect(place?.columns.timezone).toBe('Europe/Madrid');
    expect(place?.names).toHaveLength(3);
  });

  test('refuses an element with no name, whatever else it carries', () => {
    expect(toImportedPlace('node', 1, 41, 2, tags({ amenity: 'restaurant' }), SEEDED_CATALOG)).toBeNull();
    expect(toImportedPlace('node', 1, 41, 2, tags({ amenity: 'restaurant', name: '   ' }), SEEDED_CATALOG)).toBeNull();
  });

  test('refuses a named element that is not a POI', () => {
    expect(toImportedPlace('node', 1, 41, 2, tags({ place: 'town', name: 'Girona' }), SEEDED_CATALOG)).toBeNull();
  });

  test('refuses a position outside the ordinate ranges the table checks', () => {
    expect(toImportedPlace('node', 1, 120, 2, tags({ amenity: 'cafe', name: 'X' }), SEEDED_CATALOG)).toBeNull();
    expect(toImportedPlace('node', 1, 41, 200, tags({ amenity: 'cafe', name: 'X' }), SEEDED_CATALOG)).toBeNull();
    expect(toImportedPlace('node', 1, Number.NaN, 2, tags({ amenity: 'cafe', name: 'X' }), SEEDED_CATALOG)).toBeNull();
  });

  test('rejects an implausibly long country code rather than failing the CHECK later', () => {
    const place = toImportedPlace('node', 1, 41, 2, tags({ amenity: 'cafe', name: 'X', 'addr:country': 'Spain' }), SEEDED_CATALOG);
    expect(place?.columns.addressCountryCode).toBeNull();
  });
});

describe('roundCoordinate and sourceDataOf', () => {
  test('rounds to OpenStreetMap s own precision, so two runs compare equal', () => {
    expect(roundCoordinate(41.38526239999999)).toBe(41.3852624);
    expect(roundCoordinate(roundCoordinate(2.1807501))).toBe(roundCoordinate(2.1807501));
  });

  test('records every raw tag and exactly the normalized values that went into the columns', () => {
    const place = toImportedPlace(
      'node',
      7,
      41.1,
      2.2,
      tags({ amenity: 'cafe', name: 'Bar Pepe', 'payment:cash': 'yes', fixme: 'check hours' }),
      SEEDED_CATALOG,
    );
    expect(place).not.toBeNull();
    const stated = sourceDataOf(place!);
    expect(stated.v).toBe(2);
    // EVERY tag, including the ones no mapping reads today.
    expect(stated.tags).toEqual({ amenity: 'cafe', name: 'Bar Pepe', 'payment:cash': 'yes', fixme: 'check hours' });
    expect(stated.normalized.name).toBe('Bar Pepe');
    expect(stated.normalized.latitude).toBe(place!.columns.latitude);
    expect(stated.normalized.categories).toEqual(place!.columns.categories);
    expect(stated.normalized.capabilities).toEqual({ 'payments.cash': true });
  });
});

describe('what the tags say beyond the name and the address', () => {
  test('reads opening hours, and keeps the raw expression when it cannot', () => {
    const readable = toImportedPlace('node', 1, 41.38, 2.17, tags({ amenity: 'cafe', name: 'X', opening_hours: 'Mo-Fr 08:00-20:00; Sa 09:00-14:00' }), SEEDED_CATALOG);
    expect(readable?.columns.openingHours?.intervals).toHaveLength(6);
    expect(readable?.columns.openingHours?.raw).toBe('Mo-Fr 08:00-20:00; Sa 09:00-14:00');

    const seasonal = toImportedPlace('node', 1, 41.38, 2.17, tags({ amenity: 'cafe', name: 'X', opening_hours: 'Jun-Sep Mo-Su 10:00-22:00' }), SEEDED_CATALOG);
    expect(seasonal?.columns.openingHours).toEqual({ intervals: [], raw: 'Jun-Sep Mo-Su 10:00-22:00' });
  });

  test('turns accessibility, payment, amenity, food, brand and social tags into typed capabilities', () => {
    const place = toImportedPlace(
      'node',
      1,
      41.38,
      2.17,
      tags({
        amenity: 'restaurant',
        name: 'Can Tapes',
        wheelchair: 'limited',
        'toilets:wheelchair': 'no',
        'payment:cash': 'yes',
        'payment:credit_cards': 'yes',
        'payment:contactless': 'no',
        internet_access: 'wlan',
        outdoor_seating: 'yes',
        takeaway: 'only',
        reservation: 'recommended',
        cuisine: 'tapas;Spanish;unheard_of',
        'diet:vegan': 'yes',
        'diet:gluten_free': 'only',
        'diet:halal': 'no',
        'brand:wikidata': 'Q123',
        'contact:instagram': '@cantapes',
        'contact:whatsapp': '+34 600 11 22 33',
      }),
      SEEDED_CATALOG,
    );
    expect(Object.fromEntries(place!.capabilities.map((capability) => [capability.key, capability.value]))).toEqual({
      'accessibility.wheelchair': 'limited',
      'accessibility.toilets_wheelchair': false,
      'payments.cash': true,
      'payments.cards': true,
      'payments.contactless': false,
      'amenities.wifi': true,
      'amenities.outdoor_seating': true,
      'amenities.takeaway': true,
      'amenities.reservations': true,
      // Registry order, unknown values dropped, case folded.
      'food.cuisine': ['spanish', 'tapas'],
      'food.diet': ['vegan', 'gluten_free'],
      'brand.wikidata': 'Q123',
      'social.instagram': 'https://www.instagram.com/cantapes',
      'social.whatsapp': 'https://wa.me/34600112233',
    });
  });

  test('says nothing about a capability the tags say nothing about', () => {
    const place = toImportedPlace('node', 1, 41.38, 2.17, tags({ amenity: 'cafe', name: 'X', wheelchair: 'perhaps' }), SEEDED_CATALOG);
    expect(place?.capabilities).toEqual([]);
  });
});
