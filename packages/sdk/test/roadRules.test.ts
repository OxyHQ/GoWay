import { describe, expect, it } from 'vitest';
import {
  decideAccess,
  environmentalLabelOf,
  evaluateZone,
  geoGeometryContains,
  parseMaxspeedKmh,
  type RoadRuleSet,
  type RoadZone,
  zoneInForce,
} from '../src/index';

const source = {
  attribution: { label: 'Ajuntament de Barcelona', href: 'https://example.org/credit' },
  licence: { label: 'CC BY 4.0', href: 'https://example.org/licence' },
  retrievedAt: '2026-10-13T00:00:00.000Z',
};

/** A square around Barcelona's centre, a Spanish ZBE: weekdays 07:00–20:00, no label B or none. */
const ZBE: RoadZone = {
  id: 'es-barcelona-zbe',
  name: 'ZBE Rondes de Barcelona',
  kind: 'low_emission',
  countryCode: 'ES',
  geometry: {
    type: 'Polygon',
    coordinates: [
      [
        [2.1, 41.35],
        [2.2, 41.35],
        [2.2, 41.43],
        [2.1, 41.43],
        [2.1, 41.35],
      ],
    ],
  },
  boundingBox: { west: 2.1, south: 41.35, east: 2.2, north: 41.43 },
  timezone: 'Europe/Madrid',
  schedule: {
    intervals: [1, 2, 3, 4, 5].map((day) => ({ day: day as 1, opens: '07:00', closes: '20:00' })),
  },
  policy: {
    rules: [{ scheme: 'es_dgt', labels: ['b', 'none'], decision: 'denied' }],
    otherwise: 'allowed',
  },
  source,
};

// 2026-10-14 is a Wednesday; Madrid is UTC+2 in October.
const WEDNESDAY_NOON = new Date('2026-10-14T10:00:00Z');
const SUNDAY_NOON = new Date('2026-10-18T10:00:00Z');
const CENTRE = { latitude: 41.39, longitude: 2.16 };

describe('environmental labels', () => {
  it("derives Spain's DGT label from fuel and standard", () => {
    expect(environmentalLabelOf('es_dgt', { fuel: 'electric' })).toBe('0');
    expect(environmentalLabelOf('es_dgt', { fuel: 'hybrid', standard: 'euro_6' })).toBe('eco');
    expect(environmentalLabelOf('es_dgt', { fuel: 'petrol', standard: 'euro_5' })).toBe('c');
    expect(environmentalLabelOf('es_dgt', { fuel: 'petrol', standard: 'euro_3' })).toBe('b');
    expect(environmentalLabelOf('es_dgt', { fuel: 'diesel', standard: 'euro_5' })).toBe('b');
    expect(environmentalLabelOf('es_dgt', { fuel: 'diesel', standard: 'euro_3' })).toBe('none');
    expect(
      environmentalLabelOf('es_dgt', {
        fuel: 'plug_in_hybrid',
        standard: 'euro_6',
        electricRangeKm: 50,
      }),
    ).toBe('0');
  });

  it("derives Crit'Air and the German badge", () => {
    expect(environmentalLabelOf('fr_critair', { fuel: 'petrol', standard: 'euro_5' })).toBe('1');
    expect(environmentalLabelOf('fr_critair', { fuel: 'diesel', standard: 'euro_4' })).toBe('3');
    expect(environmentalLabelOf('de_plakette', { fuel: 'diesel', standard: 'euro_3' })).toBe(
      'yellow',
    );
    expect(environmentalLabelOf('uk_ulez', { fuel: 'diesel', standard: 'euro_5' })).toBe(
      'non_compliant',
    );
    expect(environmentalLabelOf('uk_ulez', { fuel: 'petrol', standard: 'euro_4' })).toBe(
      'compliant',
    );
  });

  it('says nothing rather than guess, and lets a stated label win', () => {
    expect(environmentalLabelOf('es_dgt', {})).toBeUndefined();
    expect(environmentalLabelOf('es_dgt', { fuel: 'petrol' })).toBeUndefined();
    expect(
      environmentalLabelOf('es_dgt', {
        fuel: 'petrol',
        standard: 'euro_3',
        labels: { es_dgt: 'c' },
      }),
    ).toBe('c');
  });
});

describe('zones', () => {
  it('finds a point inside a polygon and not outside it', () => {
    expect(geoGeometryContains(ZBE.geometry, CENTRE)).toBe(true);
    expect(geoGeometryContains(ZBE.geometry, { latitude: 41.5, longitude: 2.16 })).toBe(false);
  });

  it('is in force on its schedule, in its own timezone', () => {
    expect(zoneInForce(ZBE, WEDNESDAY_NOON)).toBe(true);
    expect(zoneInForce(ZBE, SUNDAY_NOON)).toBe(false);
    // 04:00 UTC is 06:00 in Madrid: before it opens.
    expect(zoneInForce(ZBE, new Date('2026-10-14T04:00:00Z'))).toBe(false);
  });

  it('denies a vehicle without a label, in force, and allows it outside the hours', () => {
    const old = { fuel: 'diesel', standard: 'euro_3' } as const;
    expect(evaluateZone(ZBE, old, WEDNESDAY_NOON)).toMatchObject({
      decision: 'denied',
      label: 'none',
    });
    expect(evaluateZone(ZBE, old, SUNDAY_NOON)).toMatchObject({
      decision: 'allowed',
      inForce: false,
    });
    expect(evaluateZone(ZBE, { fuel: 'electric' }, WEDNESDAY_NOON).decision).toBe('allowed');
  });

  it('answers unknown for a vehicle it cannot label, never allowed', () => {
    expect(evaluateZone(ZBE, { user: 'car' }, WEDNESDAY_NOON).decision).toBe('unknown');
  });

  it('decides a position over every covering zone, strictest first', () => {
    const decision = decideAccess(
      [ZBE],
      CENTRE,
      { fuel: 'diesel', standard: 'euro_3' },
      WEDNESDAY_NOON,
    );
    expect(decision.decision).toBe('denied');
    expect(decision.verdicts).toHaveLength(1);
    const outside = decideAccess([ZBE], { latitude: 40, longitude: -3 }, {}, WEDNESDAY_NOON);
    expect(outside).toMatchObject({ decision: 'allowed', verdicts: [] });
  });
});

describe('implicit maxspeed', () => {
  const spain = {
    countryCode: 'ES',
    drivingSide: 'right',
    speedLimitsKmh: { urban: 50, rural: 90 },
    source,
  } satisfies RoadRuleSet;
  const rules = (code: string) => (code === 'ES' ? spain : undefined);

  it("reads numbers, mph and walk, and an implicit value from the country's rule set", () => {
    expect(parseMaxspeedKmh('50')).toBe(50);
    expect(parseMaxspeedKmh('30 mph')).toBe(48);
    expect(parseMaxspeedKmh('walk')).toBe(6);
    expect(parseMaxspeedKmh('ES:urban', rules)).toBe(50);
    expect(parseMaxspeedKmh('ES:urban')).toBeUndefined();
    expect(parseMaxspeedKmh('FR:urban', rules)).toBeUndefined();
    expect(parseMaxspeedKmh('ES:motorway', rules)).toBeUndefined();
    expect(parseMaxspeedKmh('none', rules)).toBeUndefined();
  });
});
