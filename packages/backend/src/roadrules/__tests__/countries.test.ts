import { describe, expect, it } from 'bun:test';
import type { GeoJsonPolygon } from '@goway/contracts';
import { buildCountryIndex } from '../countryIndex';
import { simplifyArea, simplifyLine } from '../simplify';

const source = {
  attribution: { label: 'Natural Earth', href: 'https://www.naturalearthdata.com/' },
  licence: { label: 'Public domain', href: 'https://www.naturalearthdata.com/about/terms-of-use/' },
  retrievedAt: '2026-10-13T00:00:00.000Z',
};

describe('simplification', () => {
  it('drops points within tolerance of the line and keeps the ones that bend it', () => {
    const wobble: [number, number][] = [
      [0, 0],
      [1, 0.0001],
      [2, 0],
      [3, 0.0001],
      [4, 0],
    ];
    expect(simplifyLine(wobble, 0.01)).toEqual([
      [0, 0],
      [4, 0],
    ]);
    const bend: [number, number][] = [
      [0, 0],
      [2, 3],
      [4, 0],
    ];
    expect(simplifyLine(bend, 0.01)).toEqual(bend);
  });

  it('rounds to a metre and drops a ring the tolerance erases', () => {
    const tiny: GeoJsonPolygon = {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [0.0001, 0],
          [0.0001, 0.0001],
          [0, 0],
        ],
      ],
    };
    expect(simplifyArea(tiny, 0.01)).toBeNull();
    const square: GeoJsonPolygon = {
      type: 'Polygon',
      coordinates: [
        [
          [0.123456789, 0],
          [10, 0],
          [10, 10],
          [0.123456789, 10],
          [0.123456789, 0],
        ],
      ],
    };
    expect(simplifyArea(square, 0.01)?.coordinates[0]?.[0]).toEqual([0.12346, 0]);
  });
});

describe('the country index', () => {
  const index = buildCountryIndex([
    {
      countryCode: 'AA',
      name: 'Mainland',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [10, 0],
            [10, 10],
            [0, 10],
            [0, 0],
          ],
        ],
      },
      source,
    },
    {
      // An enclave inside Mainland's box: the smaller box wins where they overlap.
      countryCode: 'BB',
      name: 'Enclave',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [4, 4],
            [6, 4],
            [6, 6],
            [4, 6],
            [4, 4],
          ],
        ],
      },
      source,
    },
    {
      // Two separate islands in one country.
      countryCode: 'CC',
      name: 'Archipelago',
      geometry: {
        type: 'MultiPolygon',
        coordinates: [
          [
            [
              [20, 0],
              [21, 0],
              [21, 1],
              [20, 1],
              [20, 0],
            ],
          ],
          [
            [
              [30, 0],
              [31, 0],
              [31, 1],
              [30, 1],
              [30, 0],
            ],
          ],
        ],
      },
      source,
    },
  ]);

  it('finds the country, the enclave over its host, every island, and none at sea', () => {
    expect(index.at({ latitude: 1, longitude: 1 })).toBe('AA');
    expect(index.at({ latitude: 5, longitude: 5 })).toBe('BB');
    expect(index.at({ latitude: 0.5, longitude: 20.5 })).toBe('CC');
    expect(index.at({ latitude: 0.5, longitude: 30.5 })).toBe('CC');
    expect(index.at({ latitude: 0.5, longitude: 25 })).toBeNull();
    expect(index.at({ latitude: 50, longitude: 50 })).toBeNull();
  });
});
