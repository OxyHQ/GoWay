/**
 * Road-rule syncs: how rule sets and zones get into the database and stay
 * current (`docs/ROAD_RULES.md` §2).
 *
 * A {@link RoadRuleSync} READS one upstream source into the contract's shapes
 * and never touches the database; {@link applySync} writes what it read through
 * the repository, which records every change with the value it replaced. So an
 * adapter is a pure-ish reader that can be tested with a recorded answer, and
 * the rules about what may be overwritten or withdrawn live in one place.
 *
 * ## Withdrawing is explicit
 *
 * A zone disappears from the API only when a sync says it read a country
 * COMPLETELY (`completeCountries`) and the zone was not in it. A request that
 * failed, timed out or came back partial lists the country as incomplete and
 * withdraws nothing: the previous answer stands until a whole one replaces it.
 */

import type { RoadRuleSet, RoadZone } from '@goway/contracts';
import {
  type CountryBorder,
  upsertCountry,
  upsertRuleSet,
  upsertZone,
  withdrawZonesNotIn,
  type UpsertOutcome,
} from '../db/roadRules/roadRulesRepository';
import type { Database } from '../db/postgres';
import { logger } from '../utils/logger';
import type { Overpass } from './overpass';

export interface SyncContext {
  overpass: Overpass;
  fetch: typeof fetch;
  now(): Date;
}

export interface SyncBatch {
  ruleSets: RoadRuleSet[];
  zones: Omit<RoadZone, 'boundingBox'>[];
  countries: CountryBorder[];
  /** Countries whose zones this batch lists in full; the rest are left as they are. */
  completeCountries: string[];
  /** Things read and deliberately not kept, by reason: reported, never silent. */
  skipped: Record<string, number>;
  /** Countries (or other units) that failed to read, with why. */
  failures: string[];
}

export interface RoadRuleSync {
  /** Recorded on every change this sync makes: `osm-low-emission-zones`. */
  readonly id: string;
  read(context: SyncContext): Promise<SyncBatch>;
}

export interface SyncReport {
  id: string;
  ruleSets: Record<UpsertOutcome, number>;
  zones: Record<UpsertOutcome, number>;
  countries: Record<UpsertOutcome, number>;
  withdrawn: string[];
  skipped: Record<string, number>;
  failures: string[];
}

const zero = (): Record<UpsertOutcome, number> => ({
  created: 0,
  updated: 0,
  restored: 0,
  unchanged: 0,
});

export async function applySync(
  db: Database,
  sync: RoadRuleSync,
  context: SyncContext,
  options: { dryRun?: boolean } = {},
): Promise<SyncReport> {
  const batch = await sync.read(context);
  const report: SyncReport = {
    id: sync.id,
    ruleSets: zero(),
    zones: zero(),
    countries: zero(),
    withdrawn: [],
    skipped: batch.skipped,
    failures: batch.failures,
  };
  if (options.dryRun) return report;
  for (const ruleSet of batch.ruleSets) {
    report.ruleSets[await upsertRuleSet(db, sync.id, ruleSet)]++;
  }
  for (const country of batch.countries) {
    report.countries[await upsertCountry(db, sync.id, country)]++;
  }
  for (const zone of batch.zones) {
    report.zones[await upsertZone(db, sync.id, zone)]++;
  }
  for (const country of batch.completeCountries) {
    const listed = batch.zones.filter((z) => z.countryCode === country).map((z) => z.id);
    report.withdrawn.push(...(await withdrawZonesNotIn(db, sync.id, country, listed)));
  }
  logger.info({ ...report, skipped: report.skipped }, 'Road-rule sync applied');
  return report;
}
