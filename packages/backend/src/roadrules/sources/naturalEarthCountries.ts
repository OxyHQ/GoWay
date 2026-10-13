/**
 * Country borders from Natural Earth (public domain), for putting a position in
 * a country (`countryIndex.ts`).
 *
 * The 1:10m "Admin 0 – Countries" layer, keyed by `ISO_A2_EH` — the code with
 * France and Norway resolved, which `ISO_A2` leaves as `-99`. Entities with no
 * code (Northern Cyprus, Somaliland) are counted as skipped, not guessed: they
 * have no ISO country to carry rules for. Simplified to {@link TOLERANCE_DEGREES} and rounded to ~1 m.
 *
 * Natural Earth draws borders as de facto lines and is deliberate about
 * disputes; GoWay takes its lines as given and makes no claim of its own.
 */

import type { GeoGeometry, GeoPosition } from '@goway/contracts';
import type { RoadRuleSync, SyncBatch } from '../sync';
import { simplifyArea } from '../simplify';

export const NATURAL_EARTH_COUNTRIES_URL =
  'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_0_countries.geojson';

/** ~110 m of latitude: finer than the 1:10m source's own accuracy of a border. */
export const TOLERANCE_DEGREES = 0.001;

interface Feature {
  properties?: { ISO_A2_EH?: string; NAME?: string };
  geometry?: GeoGeometry;
}

export const naturalEarthCountries: RoadRuleSync = {
  id: 'natural-earth-countries',
  async read({ fetch, now }): Promise<SyncBatch> {
    const batch: SyncBatch = {
      ruleSets: [],
      zones: [],
      countries: [],
      completeCountries: [],
      skipped: {},
      failures: [],
    };
    const skip = (reason: string) => {
      batch.skipped[reason] = (batch.skipped[reason] ?? 0) + 1;
    };
    const response = await fetch(NATURAL_EARTH_COUNTRIES_URL, {
      signal: AbortSignal.timeout(180_000),
    });
    if (!response.ok) throw new Error(`Natural Earth answered ${response.status}`);
    const collection = (await response.json()) as { features?: Feature[] };
    const retrievedAt = now().toISOString();
    // Natural Earth draws some territories as rows of their own that carry their
    // sovereign's code (Norfolk Island is `AU`, Baikonur `KZ`): one country to
    // GoWay, with the rules of the sovereign, so their polygons join its.
    const merged = new Map<string, { name: string; polygons: GeoPosition[][][] }>();
    for (const feature of collection.features ?? []) {
      const code = feature.properties?.ISO_A2_EH;
      const name = feature.properties?.NAME;
      const geometry = feature.geometry;
      if (!code || !/^[A-Z]{2}$/.test(code) || !name) {
        skip('no ISO code');
        continue;
      }
      if (geometry?.type !== 'Polygon' && geometry?.type !== 'MultiPolygon') {
        skip('no area');
        continue;
      }
      const simplified = simplifyArea(geometry, TOLERANCE_DEGREES);
      if (!simplified) {
        skip('collapsed by simplification');
        continue;
      }
      const polygons =
        simplified.type === 'Polygon' ? [simplified.coordinates] : simplified.coordinates;
      const existing = merged.get(code);
      if (existing) existing.polygons.push(...polygons);
      else merged.set(code, { name, polygons: [...polygons] });
    }
    for (const [code, { name, polygons }] of merged) {
      batch.countries.push({
        countryCode: code,
        name,
        geometry: { type: 'MultiPolygon', coordinates: polygons },
        source: {
          attribution: { label: 'Natural Earth', href: 'https://www.naturalearthdata.com/' },
          licence: {
            label: 'Public domain',
            href: 'https://www.naturalearthdata.com/about/terms-of-use/',
          },
          retrievedAt,
        },
      });
    }
    return batch;
  },
};
