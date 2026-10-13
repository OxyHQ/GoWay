/**
 * A source is woken by viewers near its operator's own stops, not anywhere in
 * one box round its whole network: Renfe's box took in Toulouse.
 */
import { describe, expect, it } from 'bun:test';
import { liveTileOf } from '@goway/contracts';
import { areasOf, sourceAreas } from '../areas';
import { LIVE_SOURCES_UNREAD } from '../areas.generated';
import { LIVE_SOURCES } from '../catalogue';
import { LiveHub } from '../hub';
import type { LiveSourceDefinition } from '../types';

const contains = (
  box: { west: number; south: number; east: number; north: number },
  [latitude, longitude]: readonly [number, number],
) =>
  box.south <= latitude && latitude <= box.north && box.west <= longitude && longitude <= box.east;

describe('areas from stops', () => {
  it('follow a network round its corners, and leave the land between out', () => {
    // An L: stations west to east along 42°N, then north along 3°E.
    const line: [number, number][] = [];
    for (let lon = -1; lon <= 3; lon += 0.1) line.push([42, lon]);
    for (let lat = 42; lat <= 44.5; lat += 0.1) line.push([lat, 3]);
    const derived = areasOf(line);
    if (!derived) throw new Error('no areas');
    const inAny = (point: [number, number]) => derived.areas.some((area) => contains(area, point));
    expect(inAny([42, 0.5])).toBe(true);
    expect(inAny([44, 3])).toBe(true);
    // The corner's inside, ~150 km from either arm: in the outer box, in no area.
    expect(contains(derived.outer, [43.6, 1.44])).toBe(true);
    expect(inAny([43.6, 1.44])).toBe(false);
    expect(areasOf([])).toBeNull();
    expect(areasOf([[0, 0]])).toBeNull();
  });

  it('exist for every source whose stops are published, and are its coverage', () => {
    for (const source of LIVE_SOURCES) {
      // Its stops are published, and were read when `live:areas` last ran
      // (an operator's server down that day is listed, not hidden).
      const stops =
        (Boolean(source.staticGtfs) || source.kind === 'bikeshare') &&
        !LIVE_SOURCES_UNREAD.includes(source.id);
      const derived = sourceAreas(source.id);
      expect({ id: source.id, derived: Boolean(derived) }).toEqual({
        id: source.id,
        derived: stops,
      });
      if (!derived) continue;
      expect(source.coverage).toEqual(derived.outer);
      for (const area of derived.areas) {
        expect(area.west).toBeGreaterThanOrEqual(derived.outer.west);
        expect(area.east).toBeLessThanOrEqual(derived.outer.east);
        expect(area.south).toBeGreaterThanOrEqual(derived.outer.south);
        expect(area.north).toBeLessThanOrEqual(derived.outer.north);
      }
    }
  });
});

describe('demand by area', () => {
  it('a street view of Toulouse wakes no Spanish feed; one of Barcelona does', async () => {
    const renfe = LIVE_SOURCES.find((s) => s.id === 'renfe-cercanias') as LiveSourceDefinition;
    const polls: string[] = [];
    const statics: string[] = [];
    const hub = new LiveHub({
      sources: [
        {
          definition: {
            ...renfe,
            create: () => ({
              poll: async () => {
                polls.push('renfe');
                return { entities: [], rejected: 0 };
              },
            }),
          },
          settings: { url: renfe.defaultUrl, userAgent: 'test', maxRegionsPerPoll: 1 },
        },
      ],
      fetch: async (url) => {
        statics.push(url);
        throw new Error('not fetched in this test');
      },
      publish: () => {},
    });
    const street = (latitude: number, longitude: number) => [
      { tile: liveTileOf({ latitude, longitude }, 'transit'), kind: 'transit' as const },
    ];
    hub.watch('viewer', street(43.6045, 1.444));
    await hub.tick();
    expect([polls, statics]).toEqual([[], []]);
    hub.watch('viewer', street(41.39, 2.17));
    await hub.tick();
    expect(polls).toEqual(['renfe']);
    hub.stop();
  });
});
