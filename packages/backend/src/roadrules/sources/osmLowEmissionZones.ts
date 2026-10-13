/**
 * Low emission zones from OpenStreetMap (`boundary=low_emission_zone`).
 *
 * OpenStreetMap maps the OUTLINE of a zone, its name, its website and often its
 * hours, so those are read; what it does not carry is the regulation, so the
 * policy is derived only where the mapping states it in a form this reads
 * without guessing, and is `unknown` everywhere else:
 *
 *  - Spain: `access:note=B,C,ECO,0` lists the DGT labels admitted; every other
 *    vehicle (no label) is refused. Read only together with a schedule this can
 *    parse, because a zone whose hours are unknown is not known to be in force.
 *
 * One query per country, from the constant list below, so a country that fails
 * to read leaves every other country's zones alone. The list is a tuning
 * constant: the countries whose zones OpenStreetMap maps well enough to be
 * worth drawing. A zone outside it is simply not read; adding a country is a
 * line here and a test.
 *
 * Licence: ODbL 1.0. Zones are a database derived from OSM; the credit travels
 * with every zone (`source`), as the map's data credit requires.
 */

import {
  ENVIRONMENTAL_LABEL_VALUES,
  type RoadRuleSource,
  type RoadZone,
  type RoadZonePolicy,
} from '@goway/contracts';
import { timezoneAt } from '../../places/timezone';
import { logger } from '../../utils/logger';
import { parseOsmHours } from '../osmHours';
import type { OverpassElement } from '../overpass';
import { multiPolygonOf } from '../rings';
import type { RoadRuleSync, SyncBatch } from '../sync';

/** Countries read, by ISO 3166-1 code. */
export const LOW_EMISSION_ZONE_COUNTRIES = [
  'ES',
  'FR',
  'DE',
  'IT',
  'GB',
  'NL',
  'BE',
  'PT',
  'AT',
  'DK',
  'SE',
  'NO',
  'FI',
  'PL',
  'CZ',
  'SK',
  'HU',
  'RO',
  'GR',
  'IE',
  'CH',
  'LT',
  'LV',
  'EE',
  'SI',
  'HR',
  'BG',
] as const;

export const OSM_SOURCE_LINKS = {
  attribution: {
    label: 'OpenStreetMap contributors',
    href: 'https://www.openstreetmap.org/copyright',
  },
  licence: { label: 'ODbL 1.0', href: 'https://opendatacommons.org/licenses/odbl/1-0/' },
} as const;

const FULL_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The DGT labels `access:note` may list, as the contract spells them. */
const DGT_NOTE: Readonly<Record<string, string>> = { '0': '0', ECO: 'eco', C: 'c', B: 'b' };

type PolicyReader = (tags: Record<string, string>, hasSchedule: boolean) => RoadZonePolicy | null;

/** Country-specific readers of what a zone's tags say about who may enter. */
const POLICY_READERS: Readonly<Record<string, PolicyReader>> = {
  ES(tags, hasSchedule) {
    const note = tags['access:note'];
    if (!note || !hasSchedule) return null;
    const labels = note.split(',').map((label) => DGT_NOTE[label.trim()]);
    if (labels.length === 0 || labels.some((label) => label === undefined)) return null;
    const known: readonly string[] = ENVIRONMENTAL_LABEL_VALUES.es_dgt;
    if (labels.some((label) => !known.includes(label as string))) return null;
    return {
      rules: [{ scheme: 'es_dgt', labels: labels as string[], decision: 'allowed' }],
      otherwise: 'denied',
    };
  },
};

const UNKNOWN_POLICY: RoadZonePolicy = { rules: [], otherwise: 'unknown' };

function httpsUrl(value: string | undefined): string | undefined {
  return value && /^https:\/\//.test(value) ? value : undefined;
}

/** One OSM relation as a zone, or the reason it is not one. */
export function zoneFromRelation(
  element: OverpassElement,
  countryCode: string,
  source: RoadRuleSource,
): { zone: Omit<RoadZone, 'boundingBox'> } | { skipped: string } {
  const tags = element.tags ?? {};
  const name = (tags.name ?? tags.short_name)?.trim();
  if (!name) return { skipped: 'no name' };
  const members = element.members ?? [];
  const wayOf = (role: string) =>
    members
      .filter((m) => m.type === 'way' && (m.role === role || (role === 'outer' && m.role === '')))
      .map((m) => (m.geometry ?? []).map((p): [number, number] => [p.lon, p.lat]));
  if (members.some((m) => m.type === 'way' && !m.geometry))
    return { skipped: 'way without geometry' };
  const geometry = multiPolygonOf(wayOf('outer'), wayOf('inner'));
  if (!geometry) return { skipped: 'outline does not close' };

  const lons = geometry.coordinates.flat(2).map((p) => p[0]);
  const lats = geometry.coordinates.flat(2).map((p) => p[1]);
  const timezone = timezoneAt(
    (Math.min(...lats) + Math.max(...lats)) / 2,
    (Math.min(...lons) + Math.max(...lons)) / 2,
  );
  if (!timezone) return { skipped: 'no timezone' };

  const parsedHours = tags.opening_hours ? parseOsmHours(tags.opening_hours) : null;
  const policy = POLICY_READERS[countryCode]?.(tags, parsedHours !== null) ?? UNKNOWN_POLICY;
  // Without readable hours there is no claim about WHEN, so no claim about who:
  // a zone drawn "always in force" from silence would be an invention.
  const known = parsedHours !== null && policy !== UNKNOWN_POLICY;
  const startDate = tags.start_date;
  const rulesUrl = httpsUrl(tags.website) ?? httpsUrl(tags.url);
  return {
    zone: {
      id: `osm-relation-${element.id}`,
      name,
      kind: 'low_emission',
      countryCode,
      geometry,
      timezone,
      ...(known && parsedHours ? { schedule: parsedHours.hours } : {}),
      ...(startDate && FULL_DATE.test(startDate) ? { effectiveFrom: startDate } : {}),
      policy: known ? policy : UNKNOWN_POLICY,
      ...(rulesUrl ? { rulesUrl } : {}),
      source,
    },
  };
}

export const osmLowEmissionZones: RoadRuleSync = {
  id: 'osm-low-emission-zones',
  async read({ overpass, now }): Promise<SyncBatch> {
    const batch: SyncBatch = {
      ruleSets: [],
      zones: [],
      countries: [],
      completeCountries: [],
      skipped: {},
      failures: [],
    };
    for (const country of LOW_EMISSION_ZONE_COUNTRIES) {
      try {
        const result = await overpass.query(
          `[out:json][timeout:120];area["ISO3166-1"="${country}"]->.a;` +
            `relation["boundary"="low_emission_zone"](area.a);out geom;`,
        );
        const source: RoadRuleSource = {
          ...OSM_SOURCE_LINKS,
          retrievedAt: (result.dataTimestamp
            ? new Date(result.dataTimestamp)
            : now()
          ).toISOString(),
        };
        for (const element of result.elements) {
          if (element.type !== 'relation') continue;
          const outcome = zoneFromRelation(element, country, source);
          if ('zone' in outcome) batch.zones.push(outcome.zone);
          else batch.skipped[outcome.skipped] = (batch.skipped[outcome.skipped] ?? 0) + 1;
        }
        batch.completeCountries.push(country);
      } catch (error) {
        logger.error({ err: error, country }, 'Low emission zones could not be read');
        batch.failures.push(
          `${country}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return batch;
  },
};
