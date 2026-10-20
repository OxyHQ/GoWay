/**
 * Which catalogue sources serve stops and departures, and that each one may.
 */

import { describe, expect, it } from 'bun:test';
import { LIVE_SOURCES } from '../catalogue';
import { archivesOf, isServable } from '../transit/service';

const enrolled = LIVE_SOURCES.filter((source) => source.departures);

describe('the sources enrolled in departures', () => {
  it('are the six whose archives were measured (docs/TRANSIT_NEARBY.md), and no others', () => {
    expect(enrolled.map((source) => source.id).sort()).toEqual([
      'amb-bus',
      'emt-fuenlabrada',
      'mta-lirr',
      'mta-mnr',
      'mta-subway',
      'renfe-cercanias',
    ]);
  });

  it('each carry a read licence, a credit and a whole archive to read stop times from', () => {
    for (const source of enrolled) {
      expect(isServable(source)).toBe(true);
      expect(archivesOf(source).length).toBeGreaterThan(0);
      for (const url of archivesOf(source)) expect(url).toMatch(/^https:\/\//);
      expect(source.awaiting).toBeUndefined();
      expect(source.requiresKey).toBe(false);
    }
  });

  it('read predictions only from a keyless https feed of their own', () => {
    for (const source of enrolled) {
      const urls =
        source.departures?.realtimeUrls?.({
          url: source.defaultUrl,
          userAgent: 't',
          maxRegionsPerPoll: 1,
        }) ?? [];
      for (const url of urls) expect(url).toMatch(/^https:\/\//);
    }
    // AMB's trip ids join its timetable (425 of 425 when measured); the MTA subway's do not.
    const amb = LIVE_SOURCES.find((source) => source.id === 'amb-bus');
    expect(amb?.departures?.realtimeUrls).toBeDefined();
    expect(
      LIVE_SOURCES.find((source) => source.id === 'mta-subway')?.departures?.realtimeUrls,
    ).toBeUndefined();
  });
});
