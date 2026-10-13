/** The road-rule syncs GoWay runs, in the order it runs them. */

import type { RoadRuleSync } from './sync';
import { naturalEarthCountries } from './sources/naturalEarthCountries';
import { osmCountryRules } from './sources/osmCountryRules';
import { osmLowEmissionZones } from './sources/osmLowEmissionZones';

export const ROAD_RULE_SYNCS: readonly RoadRuleSync[] = [
  naturalEarthCountries,
  osmCountryRules,
  osmLowEmissionZones,
];
