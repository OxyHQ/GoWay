/**
 * Country rule sets: the side traffic keeps to and the speed an implicit
 * `maxspeed=CC:urban` means.
 *
 *  - **Driving side** is `driving_side` on each country's OpenStreetMap
 *    boundary relation (ODbL 1.0). A country that does not record it gets no
 *    rule set — never a guess.
 *  - **Implicit speeds** are the OSM wiki's "Default speed limits" table
 *    (CC BY-SA 2.0), as the `legal_default_speeds.json` the
 *    `westnordost/osm-legal-default-speeds` parser publishes (BSD-3-Clause
 *    code). Only the general rows named `urban`, `rural`, `motorway`, `trunk`
 *    and `living street` are read; a country's rows for specific road types, and
 *    values that are not a plain speed, are left alone — an `ES:urban` of 30 is
 *    what the table says the default is on an ordinary urban road, and a
 *    narrower rule does not overwrite it.
 *
 * The two come from different projects at different times, so a rule set's
 * `retrievedAt` is when THIS sync read them, and its credit names both.
 */

import {
  DRIVING_SIDES,
  IMPLICIT_SPEED_CLASSES,
  parseMaxspeedKmh,
  type DrivingSide,
  type ImplicitSpeedClass,
  type RoadRuleSet,
} from '@goway/contracts';
import { logger } from '../../utils/logger';
import type { RoadRuleSync, SyncBatch } from '../sync';

export const LEGAL_DEFAULT_SPEEDS_URL =
  'https://raw.githubusercontent.com/westnordost/osm-legal-default-speeds/master/demo/distribution/legal_default_speeds.json';

/** The table's row names that stand for each implicit class. */
const ROW_NAMES: Readonly<Record<ImplicitSpeedClass, string>> = {
  urban: 'urban',
  rural: 'rural',
  trunk: 'trunk',
  motorway: 'motorway',
  living_street: 'living street',
};

interface SpeedRow {
  name?: string;
  tags?: Record<string, string>;
}

interface SpeedTable {
  speedLimitsByCountryCode: Record<string, SpeedRow[]>;
}

/** The implicit speeds a country's rows state, in km/h. */
export function implicitSpeedsOf(rows: readonly SpeedRow[]): RoadRuleSet['speedLimitsKmh'] {
  const speeds: RoadRuleSet['speedLimitsKmh'] = {};
  for (const speedClass of IMPLICIT_SPEED_CLASSES) {
    const row = rows.find((r) => r.name === ROW_NAMES[speedClass]);
    const kmh = parseMaxspeedKmh(row?.tags?.maxspeed);
    if (kmh !== undefined) speeds[speedClass] = kmh;
  }
  return speeds;
}

export const osmCountryRules: RoadRuleSync = {
  id: 'osm-country-rules',
  async read({ overpass, fetch, now }): Promise<SyncBatch> {
    const batch: SyncBatch = {
      ruleSets: [],
      zones: [],
      countries: [],
      completeCountries: [],
      skipped: {},
      failures: [],
    };

    const sides = await overpass.query(
      '[out:json][timeout:90];relation["boundary"="administrative"]["admin_level"="2"]["driving_side"]["ISO3166-1"];out tags;',
    );

    let table: SpeedTable | null = null;
    try {
      const response = await fetch(LEGAL_DEFAULT_SPEEDS_URL, {
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) throw new Error(`answered ${response.status}`);
      table = (await response.json()) as SpeedTable;
    } catch (error) {
      // Rule sets without speeds are still true; they just state no implicit speeds.
      logger.error({ err: error }, 'Default speed limits could not be read');
      batch.failures.push(
        `default speed limits: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const retrievedAt = (sides.dataTimestamp ? new Date(sides.dataTimestamp) : now()).toISOString();
    for (const element of sides.elements) {
      const tags = element.tags ?? {};
      const country = tags['ISO3166-1'];
      const side = tags.driving_side;
      if (!country || !/^[A-Z]{2}$/.test(country)) {
        batch.skipped['no ISO code'] = (batch.skipped['no ISO code'] ?? 0) + 1;
        continue;
      }
      if (!(DRIVING_SIDES as readonly string[]).includes(side as string)) {
        batch.skipped['unreadable driving_side'] =
          (batch.skipped['unreadable driving_side'] ?? 0) + 1;
        continue;
      }
      const rows = table?.speedLimitsByCountryCode[country];
      batch.ruleSets.push({
        countryCode: country,
        drivingSide: side as DrivingSide,
        speedLimitsKmh: rows ? implicitSpeedsOf(rows) : {},
        source: {
          attribution: {
            label: 'OpenStreetMap contributors; OSM wiki: Default speed limits',
            href: 'https://www.openstreetmap.org/copyright',
          },
          licence: {
            label: 'ODbL 1.0 (driving side); CC BY-SA 2.0 (speed limits)',
            href: 'https://wiki.openstreetmap.org/wiki/Wiki_content_license',
          },
          retrievedAt,
        },
      });
    }
    return batch;
  },
};
