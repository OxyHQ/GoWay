import { describe, expect, it } from 'bun:test';
import { decideAccess, type RoadZone } from '@goway/contracts';
import { boundsOf } from '../../db/roadRules/roadRulesRepository';
import { parseOsmHours } from '../osmHours';
import type { OverpassElement } from '../overpass';
import { assembleRings, multiPolygonOf } from '../rings';
import { implicitSpeedsOf } from '../sources/osmCountryRules';
import { OSM_SOURCE_LINKS, zoneFromRelation } from '../sources/osmLowEmissionZones';

const source = { ...OSM_SOURCE_LINKS, retrievedAt: '2026-10-13T00:00:00.000Z' };

/** A square in Barcelona's centre, split over two ways that meet end to end, one reversed. */
const SQUARE: OverpassElement = {
  type: 'relation',
  id: 8972953,
  tags: {
    boundary: 'low_emission_zone',
    name: 'Zona de Baixes Emissions Rondes de Barcelona',
    opening_hours: 'Mo-Fr 07:00-20:00; PH off',
    'access:note': 'B,C,ECO,0',
    start_date: '2020-01-01',
    website: 'https://www.zbe.barcelona/',
  },
  members: [
    {
      type: 'way',
      ref: 1,
      role: 'outer',
      geometry: [
        { lon: 2.1, lat: 41.35 },
        { lon: 2.2, lat: 41.35 },
        { lon: 2.2, lat: 41.43 },
      ],
    },
    {
      // Runs the other way: joined by reversing it.
      type: 'way',
      ref: 2,
      role: 'outer',
      geometry: [
        { lon: 2.1, lat: 41.35 },
        { lon: 2.1, lat: 41.43 },
        { lon: 2.2, lat: 41.43 },
      ],
    },
  ],
};

describe('rings', () => {
  it('joins ways end to end, reversing where needed, into one closed ring', () => {
    const rings = assembleRings([
      [
        [0, 0],
        [1, 0],
        [1, 1],
      ],
      [
        [0, 0],
        [0, 1],
        [1, 1],
      ],
    ]);
    expect(rings).toHaveLength(1);
    expect(rings?.[0]?.[0]).toEqual(rings?.[0]?.at(-1));
  });

  it('refuses an outline that does not close', () => {
    expect(
      assembleRings([
        [
          [0, 0],
          [1, 0],
          [1, 1],
        ],
      ]),
    ).toBeNull();
  });

  it('puts a hole in the outer ring that contains it', () => {
    const outer = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [0, 0],
    ] as [number, number][];
    const hole = [
      [4, 4],
      [6, 4],
      [6, 6],
      [4, 6],
      [4, 4],
    ] as [number, number][];
    const shape = multiPolygonOf([outer], [hole]);
    expect(shape?.coordinates[0]).toHaveLength(2);
    expect(
      multiPolygonOf(
        [outer],
        [
          [
            [20, 20],
            [21, 20],
            [21, 21],
            [20, 20],
          ],
        ],
      ),
    ).toBeNull();
  });
});

describe('OSM opening_hours', () => {
  it('reads weekdays and spans, and reports ignored holiday clauses', () => {
    const parsed = parseOsmHours('Mo-Fr 07:00-20:00; PH off');
    expect(parsed?.holidaysIgnored).toBe(true);
    expect(parsed?.hours.intervals.map((i) => i.day)).toEqual([1, 2, 3, 4, 5]);
    expect(parseOsmHours('Sa,Su 10:00-14:00,16:00-20:00')?.hours.intervals).toHaveLength(4);
    expect(parseOsmHours('24/7')?.hours.intervals).toHaveLength(7);
    expect(parseOsmHours('Fr-Mo 08:00-18:00')?.hours.intervals.map((i) => i.day)).toEqual([
      0, 1, 5, 6,
    ]);
  });

  it('refuses what it cannot read instead of guessing', () => {
    expect(parseOsmHours('sunrise-sunset')).toBeNull();
    expect(parseOsmHours('Mo-Fr 07:00-20:00; Jan off')).toBeNull();
    expect(parseOsmHours('week 1-10 Mo 08:00-09:00')).toBeNull();
    expect(parseOsmHours('')).toBeNull();
  });
});

describe('a zone from an OSM relation', () => {
  it("reads outline, hours, start date and website, and derives Spain's DGT policy", () => {
    const outcome = zoneFromRelation(SQUARE, 'ES', source);
    if (!('zone' in outcome)) throw new Error(outcome.skipped);
    const { zone } = outcome;
    expect(zone).toMatchObject({
      id: 'osm-relation-8972953',
      kind: 'low_emission',
      timezone: 'Europe/Madrid',
      effectiveFrom: '2020-01-01',
      rulesUrl: 'https://www.zbe.barcelona/',
      policy: { otherwise: 'denied' },
    });
    expect(zone.policy.rules[0]?.labels).toEqual(['b', 'c', 'eco', '0']);
  });

  it('answers a real question with it: a diesel Euro 3 car is refused on a weekday, a hybrid is not', () => {
    const outcome = zoneFromRelation(SQUARE, 'ES', source);
    if (!('zone' in outcome)) throw new Error(outcome.skipped);
    const zone: RoadZone = { ...outcome.zone, boundingBox: boundsOf(outcome.zone.geometry) };
    const wednesday = new Date('2026-10-14T10:00:00Z');
    const centre = { latitude: 41.39, longitude: 2.16 };
    expect(
      decideAccess([zone], centre, { fuel: 'diesel', standard: 'euro_3' }, wednesday).decision,
    ).toBe('denied');
    expect(
      decideAccess([zone], centre, { fuel: 'hybrid', standard: 'euro_6' }, wednesday).decision,
    ).toBe('allowed');
    expect(
      decideAccess(
        [zone],
        centre,
        { fuel: 'diesel', standard: 'euro_3' },
        new Date('2026-10-18T10:00:00Z'),
      ).decision,
    ).toBe('allowed');
  });

  it('leaves the policy unknown when the hours or the note cannot be read, and outside Spain', () => {
    const noHours: OverpassElement = {
      ...SQUARE,
      tags: { ...SQUARE.tags, opening_hours: 'sunrise-sunset' },
    };
    const a = zoneFromRelation(noHours, 'ES', source);
    expect('zone' in a && a.zone.policy).toEqual({ rules: [], otherwise: 'unknown' });
    expect('zone' in a && a.zone.schedule).toBeFalsy();
    const b = zoneFromRelation(SQUARE, 'DE', source);
    expect('zone' in b && b.zone.policy.otherwise).toBe('unknown');
    const badNote: OverpassElement = { ...SQUARE, tags: { ...SQUARE.tags, 'access:note': 'B,X' } };
    const c = zoneFromRelation(badNote, 'ES', source);
    expect('zone' in c && c.zone.policy.otherwise).toBe('unknown');
  });

  it('skips what it cannot draw, with the reason', () => {
    expect(zoneFromRelation({ ...SQUARE, tags: {} }, 'ES', source)).toEqual({ skipped: 'no name' });
    expect(
      zoneFromRelation({ ...SQUARE, members: [SQUARE.members?.[0] as never] }, 'ES', source),
    ).toEqual({ skipped: 'outline does not close' });
  });
});

describe('implicit speeds', () => {
  it('reads the general rows only, in km/h', () => {
    expect(
      implicitSpeedsOf([
        { name: 'living street', tags: { maxspeed: '20' } },
        { name: 'urban road with 2 or more lanes in each direction', tags: { maxspeed: '50' } },
        { name: 'urban', tags: { maxspeed: '30' } },
        { name: 'rural', tags: { maxspeed: '60 mph' } },
        { name: 'motorway', tags: { maxspeed: 'none' } },
      ]),
    ).toEqual({ living_street: 20, urban: 30, rural: 97 });
  });
});
