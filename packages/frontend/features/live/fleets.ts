/**
 * Which simplified vehicle a live entity is drawn as — a REGISTRY, so a new
 * operator or fleet is one entry, not new code.
 *
 * Each fleet is a generic form (an electric multiple unit, a bus, a coach…)
 * with its real proportions and a livery as flat colour bands, approximating
 * the operator's vehicles as seen in public photographs. Colours and
 * proportions ONLY: no logo, wordmark, emblem, number or text is ever drawn
 * on a vehicle (they are trademarks, and none of them is data). The line's
 * colour stays on the 2D glyph and label.
 *
 * Matching uses only what the feed itself says — source, mode, line, vehicle
 * label — first rule wins, and falls back to a generic train or bus. The
 * liveries are approximations and say so (`docs/MAP_LIVE.md` → Vehicles).
 */
import type { LiveEntity } from '@goway.to/sdk/live';

import type { MapLiveModel } from '@/components/map';

const STAINLESS = '#B9BEC3';
const GLASS = '#26313A';
const WHITE = '#F3F4F2';

export const FLEETS = {
  // Renfe Civia units in Rodalies de Catalunya colours: long, low, five cars,
  // white with an orange-red band.
  'rodalies-civia': {
    form: 'emu',
    cars: 5,
    carLength: 19.6,
    gap: 0.6,
    width: 2.94,
    height: 4.2,
    livery: { lower: '#5F6368', stripe: '#E4471F', body: WHITE, window: GLASS, roof: '#CFD2D4' },
  },
  // The same units elsewhere in Spain, in Cercanías red.
  'cercanias-civia': {
    form: 'emu',
    cars: 5,
    carLength: 19.6,
    gap: 0.6,
    width: 2.94,
    height: 4.2,
    livery: { lower: '#5F6368', stripe: '#D7182A', body: WHITE, window: GLASS, roof: '#CFD2D4' },
  },
  // FGC Barcelona–Vallès units: four shorter cars, white, dark glazing band, orange.
  'fgc-bv': {
    form: 'emu',
    cars: 4,
    carLength: 18.8,
    gap: 0.5,
    width: 2.9,
    height: 3.9,
    livery: {
      lower: '#7A7F84',
      stripe: '#F08A00',
      body: '#F2F2F2',
      window: GLASS,
      roof: '#C8CBCD',
    },
  },
  // FGC Llobregat–Anoia (metre gauge): three narrower cars.
  'fgc-lla': {
    form: 'emu',
    cars: 3,
    carLength: 18.0,
    gap: 0.5,
    width: 2.7,
    height: 3.7,
    livery: {
      lower: '#7A7F84',
      stripe: '#F08A00',
      body: '#F2F2F2',
      window: GLASS,
      roof: '#C8CBCD',
    },
  },
  // LIRR M7/M9: long stainless cars with a blue stripe; shown as eight.
  'lirr-emu': {
    form: 'emu',
    cars: 8,
    carLength: 25.9,
    gap: 0.6,
    width: 3.2,
    height: 4.0,
    livery: {
      lower: '#4B5157',
      stripe: '#1B4F9C',
      body: STAINLESS,
      window: GLASS,
      roof: '#A9AEB3',
    },
  },
  // Metro-North M7A/M8: stainless with a red stripe; shown as eight.
  'mnr-emu': {
    form: 'emu',
    cars: 8,
    carLength: 25.9,
    gap: 0.6,
    width: 3.2,
    height: 4.0,
    livery: {
      lower: '#4B5157',
      stripe: '#C8102E',
      body: STAINLESS,
      window: GLASS,
      roof: '#A9AEB3',
    },
  },
  // MTA New York City buses: white with a blue band.
  'mta-bus': {
    form: 'bus',
    cars: 1,
    carLength: 12.2,
    gap: 0,
    width: 2.6,
    height: 3.1,
    livery: { lower: WHITE, stripe: '#0039A6', body: WHITE, window: GLASS, roof: WHITE },
  },
  // Articulated (Select Bus Service, the `+` routes): two sections.
  'mta-bus-articulated': {
    form: 'bus',
    cars: 2,
    carLength: 9.0,
    gap: 0.4,
    width: 2.6,
    height: 3.1,
    livery: { lower: WHITE, stripe: '#0039A6', body: WHITE, window: GLASS, roof: WHITE },
  },
  // Express coaches.
  'mta-coach': {
    form: 'coach',
    cars: 1,
    carLength: 13.7,
    gap: 0,
    width: 2.6,
    height: 3.5,
    livery: { lower: WHITE, stripe: '#0039A6', body: WHITE, window: GLASS, roof: WHITE },
  },
  // Staten Island express runs double-deckers.
  'mta-double-deck': {
    form: 'double-deck',
    cars: 1,
    carLength: 13.0,
    gap: 0,
    width: 2.6,
    height: 4.3,
    livery: { lower: WHITE, stripe: '#0039A6', body: WHITE, window: GLASS, roof: WHITE },
  },
  // TMB Barcelona: red buses, standard and articulated (no realtime feed yet;
  // see docs/MAP_LIVE.md), ready for one.
  'tmb-bus': {
    form: 'bus',
    cars: 1,
    carLength: 12.0,
    gap: 0,
    width: 2.55,
    height: 3.1,
    livery: {
      lower: '#3A3D40',
      stripe: '#D7261E',
      body: '#D7261E',
      window: GLASS,
      roof: '#ECECEC',
    },
  },
  'tmb-bus-articulated': {
    form: 'bus',
    cars: 2,
    carLength: 8.9,
    gap: 0.4,
    width: 2.55,
    height: 3.1,
    livery: {
      lower: '#3A3D40',
      stripe: '#D7261E',
      body: '#D7261E',
      window: GLASS,
      roof: '#ECECEC',
    },
  },
  // New York City subway, estimated only (drawn flat — never in 3D): the
  // numbered lines' narrower 51-ft cars and the lettered lines' 60-ft ones,
  // stainless, ten to a train. The model sets the glyph's length.
  'mta-subway-a': {
    form: 'emu',
    cars: 10,
    carLength: 15.5,
    gap: 0.5,
    width: 2.68,
    height: 3.6,
    livery: {
      lower: '#4B5157',
      stripe: '#6D747B',
      body: STAINLESS,
      window: GLASS,
      roof: '#A9AEB3',
    },
  },
  'mta-subway-b': {
    form: 'emu',
    cars: 10,
    carLength: 18.4,
    gap: 0.5,
    width: 3.05,
    height: 3.7,
    livery: {
      lower: '#4B5157',
      stripe: '#6D747B',
      body: STAINLESS,
      window: GLASS,
      roof: '#A9AEB3',
    },
  },
  // TMB Barcelona metro (no keyless feed yet; docs/MAP_LIVE.md): five cars, red band.
  'tmb-metro': {
    form: 'emu',
    cars: 5,
    carLength: 17.5,
    gap: 0.5,
    width: 2.9,
    height: 3.6,
    livery: {
      lower: '#3A3D40',
      stripe: '#D7261E',
      body: '#E9EAEB',
      window: GLASS,
      roof: '#C9CCCF',
    },
  },
  // AMB metropolitan buses (estimated only): white with a yellow band.
  'amb-bus': {
    form: 'bus',
    cars: 1,
    carLength: 12.0,
    gap: 0,
    width: 2.55,
    height: 3.1,
    livery: { lower: '#5F6368', stripe: '#F2B705', body: WHITE, window: GLASS, roof: WHITE },
  },
  'generic-train': {
    form: 'emu',
    cars: 4,
    carLength: 20,
    gap: 0.6,
    width: 2.9,
    height: 4.0,
    livery: {
      lower: '#5F6368',
      stripe: '#8A9096',
      body: '#E8E9EA',
      window: GLASS,
      roof: '#C9CCCF',
    },
  },
  'generic-bus': {
    form: 'bus',
    cars: 1,
    carLength: 12,
    gap: 0,
    width: 2.55,
    height: 3.1,
    livery: {
      lower: '#5F6368',
      stripe: '#8A9096',
      body: '#E8E9EA',
      window: GLASS,
      roof: '#E8E9EA',
    },
  },
  aircraft: {
    form: 'aircraft',
    cars: 1,
    carLength: 38,
    gap: 0,
    width: 34,
    height: 11,
    // A generic white airliner; the tail in the layer's aircraft colour, not an airline's.
    livery: {
      lower: '#C9CCD0',
      stripe: '#7C3AED',
      body: '#F5F5F5',
      window: GLASS,
      roof: '#F5F5F5',
    },
  },
  vessel: {
    form: 'vessel',
    cars: 1,
    carLength: 110,
    gap: 0,
    width: 18,
    height: 14,
    livery: {
      lower: '#24435E',
      stripe: '#B23A2E',
      body: '#F4F4F4',
      window: GLASS,
      roof: '#D9DCDF',
    },
  },
} as const satisfies Record<string, MapLiveModel>;

export type FleetKey = keyof typeof FLEETS;

interface FleetRule {
  fleet: FleetKey;
  sourceId?: string;
  mode?: string;
  line?: RegExp;
  vehicleLabel?: RegExp;
}

/** First match wins. */
export const FLEET_RULES: readonly FleetRule[] = [
  { sourceId: 'renfe-cercanias', line: /^R/, fleet: 'rodalies-civia' },
  { sourceId: 'renfe-cercanias', fleet: 'cercanias-civia' },
  // Barcelona–Vallès: S1, S2, L6, L7, L12; everything else FGC runs is Llobregat–Anoia or rural.
  { sourceId: 'fgc-geotren', line: /^(S1|S2|L6|L7|L12)$/, fleet: 'fgc-bv' },
  { sourceId: 'fgc-geotren', fleet: 'fgc-lla' },
  { sourceId: 'mta-lirr', fleet: 'lirr-emu' },
  { sourceId: 'mta-mnr', fleet: 'mnr-emu' },
  { sourceId: 'mta-bus', line: /\+$/, fleet: 'mta-bus-articulated' },
  { sourceId: 'mta-bus', line: /^SIM/, fleet: 'mta-double-deck' },
  { sourceId: 'mta-bus', line: /^(X\d|BM|BXM|QM)/, fleet: 'mta-coach' },
  { sourceId: 'mta-bus', fleet: 'mta-bus' },
  { sourceId: 'mta-subway', line: /^([1-7]X?|GS)$/, fleet: 'mta-subway-a' },
  { sourceId: 'mta-subway', fleet: 'mta-subway-b' },
  { sourceId: 'tmb-metro', fleet: 'tmb-metro' },
  { sourceId: 'amb-bus', fleet: 'amb-bus' },
];

/** The fleet a live entity is drawn as; generic when nothing in the registry knows it. */
export function fleetOf(entity: LiveEntity): FleetKey {
  if (entity.kind === 'aircraft') return 'aircraft';
  if (entity.kind === 'vessel') return 'vessel';
  if (entity.kind !== 'transit') return 'generic-bus';
  for (const rule of FLEET_RULES) {
    if (rule.sourceId && rule.sourceId !== entity.sourceId) continue;
    if (rule.mode && rule.mode !== entity.mode) continue;
    if (rule.line && !(entity.line && rule.line.test(entity.line))) continue;
    if (rule.vehicleLabel && !(entity.vehicleLabel && rule.vehicleLabel.test(entity.vehicleLabel)))
      continue;
    return rule.fleet;
  }
  return entity.mode === 'bus' ? 'generic-bus' : 'generic-train';
}

/** A consist's whole length, metres. */
export function fleetLength(fleet: FleetKey): number {
  const model: MapLiveModel = FLEETS[fleet];
  return model.cars * model.carLength + (model.cars - 1) * model.gap;
}
