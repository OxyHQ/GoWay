/**
 * Which country a position is in — from the borders the sync stored.
 *
 * Held in process: a country border is thousands of points and the lookup is
 * needed on every `GET /roads/rules`. Each country is split into its polygons
 * with their own bounding boxes, so a lookup tests a handful of rings rather
 * than France's overseas departments from the Caribbean to Réunion. Rebuilt
 * from the database at most once per {@link COUNTRY_INDEX_TTL_MS}; borders
 * change when a sync says so, a few times a decade.
 *
 * A position in no country (the open sea) is `null` — never the nearest one.
 * Where borders overlap (disputed areas), the country with the smaller bounding
 * box wins: a claim inside another's territory is the more specific.
 */

import { geoGeometryContains, type GeoBoundingBox } from '@goway/contracts';
import { boundsOf, loadCountryBorders } from '../db/roadRules/roadRulesRepository';
import type { Database } from '../db/postgres';

export const COUNTRY_INDEX_TTL_MS = 3_600_000;

interface Entry {
  countryCode: string;
  box: GeoBoundingBox;
  area: number;
  polygon: { type: 'Polygon'; coordinates: number[][][] };
}

export interface CountryIndex {
  at(position: { latitude: number; longitude: number }): string | null;
}

export function buildCountryIndex(
  borders: readonly Awaited<ReturnType<typeof loadCountryBorders>>[number][],
): CountryIndex {
  const entries: Entry[] = [];
  for (const border of borders) {
    const polygons =
      border.geometry.type === 'Polygon'
        ? [border.geometry.coordinates]
        : border.geometry.coordinates;
    for (const coordinates of polygons) {
      const polygon = { type: 'Polygon' as const, coordinates: coordinates as number[][][] };
      const box = boundsOf(polygon as never);
      entries.push({
        countryCode: border.countryCode,
        box,
        area: (box.east - box.west) * (box.north - box.south),
        polygon,
      });
    }
  }
  entries.sort((a, b) => a.area - b.area);
  return {
    at(position) {
      for (const entry of entries) {
        const { box } = entry;
        if (
          position.longitude < box.west ||
          position.longitude > box.east ||
          position.latitude < box.south ||
          position.latitude > box.north
        ) {
          continue;
        }
        if (geoGeometryContains(entry.polygon as never, position)) return entry.countryCode;
      }
      return null;
    },
  };
}

const cache = new WeakMap<Database, { at: number; index: Promise<CountryIndex> }>();

export function countryIndex(db: Database, now: number = Date.now()): Promise<CountryIndex> {
  const cached = cache.get(db);
  if (cached && now - cached.at < COUNTRY_INDEX_TTL_MS) return cached.index;
  const index = loadCountryBorders(db).then(buildCountryIndex);
  // A failed load must not be remembered for an hour.
  index.catch(() => cache.delete(db));
  cache.set(db, { at: now, index });
  return index;
}
