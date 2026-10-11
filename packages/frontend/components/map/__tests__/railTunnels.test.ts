/**
 * Which railway a train is on, and whether OSM says it runs underground —
 * read from the basemap's `transportation` features.
 */
import { describe, expect, test } from 'bun:test';

import { isTunnel, RAIL_MATCH_METERS, RailIndex, railLinesOf } from '@/components/map/railTunnels';

// Puerta del Sol: Cercanías in a tunnel under the square; a surface line
// 30 m to the south of it (as at a station where tracks surface beside it).
const SOL = { latitude: 40.4169, longitude: -3.7035 };
const DEG_PER_M = 1 / 111_195;

const tunnel = {
  properties: { class: 'rail', subclass: 'rail', brunnel: 'tunnel', layer: -3 },
  geometry: {
    type: 'MultiLineString',
    coordinates: [
      [
        [-3.71, SOL.latitude],
        [-3.7, SOL.latitude],
      ],
    ],
  },
};
const surface = {
  properties: { class: 'rail', subclass: 'rail' },
  geometry: {
    type: 'LineString',
    coordinates: [
      [-3.71, SOL.latitude - 30 * DEG_PER_M],
      [-3.7, SOL.latitude - 30 * DEG_PER_M],
    ],
  },
};
const road = {
  properties: { class: 'primary', brunnel: 'tunnel' },
  geometry: {
    type: 'LineString',
    coordinates: [
      [-3.71, SOL.latitude],
      [-3.7, SOL.latitude],
    ],
  },
};

describe('isTunnel', () => {
  test('a tunnel, or anything below layer 0', () => {
    expect(isTunnel({ brunnel: 'tunnel' })).toBe(true);
    expect(isTunnel({ layer: -1 })).toBe(true);
    expect(isTunnel({ layer: '-2' })).toBe(true);
    expect(isTunnel({ brunnel: 'bridge', layer: 1 })).toBe(false);
    expect(isTunnel({})).toBe(false);
  });
});

describe('railLinesOf', () => {
  test('keeps railways (line and multi-line), drops roads and malformed geometry', () => {
    const lines = railLinesOf([
      tunnel,
      surface,
      road,
      {
        properties: { class: 'transit', subclass: 'subway' },
        geometry: { type: 'Point', coordinates: [0, 0] },
      },
      { properties: { class: 'rail' }, geometry: { type: 'LineString', coordinates: [[0, 0]] } },
    ]);
    expect(lines.map((line) => line.tunnel)).toEqual([true, false]);
  });
});

describe('RailIndex', () => {
  const index = new RailIndex(railLinesOf([tunnel, surface]));

  test('the NEAREST railway decides', () => {
    expect(index.underground(SOL.latitude, SOL.longitude)).toBe(true);
    // 25 m south: nearer the surface line (5 m) than the tunnel (25 m).
    expect(index.underground(SOL.latitude - 25 * DEG_PER_M, SOL.longitude)).toBe(false);
  });

  test('no railway within the match distance: unknown', () => {
    expect(
      index.underground(SOL.latitude + (RAIL_MATCH_METERS + 5) * DEG_PER_M, SOL.longitude),
    ).toBeNull();
    expect(index.underground(41.39, 2.17)).toBeNull();
    expect(new RailIndex([]).empty).toBe(true);
  });
});
