/**
 * Road rules by place — what differs from one country or city to the next, as
 * the one contract the map, the simulation, routing and every SDK consumer
 * read.
 *
 * Two kinds of fact live here, and neither is a property of a way (that is
 * {@link ./road-access}, read from OSM tags):
 *
 *  - **Country rule sets** ({@link RoadRuleSet}): the side traffic keeps to and
 *    the speed an implicit `maxspeed=ES:urban` means. Data, curated with its
 *    source, never a table of boxes in a client.
 *  - **Zones** ({@link RoadZone}): an area with its own access rule — a low
 *    emission zone, a congestion charge, a restricted centre — a polygon, when
 *    it applies, and a policy over the environmental label of the vehicle.
 *
 * ## A vehicle is a request, never a record
 *
 * {@link VehicleProfile} is what a caller says about the vehicle in the one
 * request that asks. GoWay never stores one: a car's fuel and label are
 * personal data, and the map works signed out.
 *
 * ## One evaluation, in the contract
 *
 * {@link evaluateZone} and {@link environmentalLabelOf} are shared by the API,
 * the SDK and the simulation, so "may this car enter" cannot mean one thing on
 * the map and another in a partner's app. They answer `unknown` rather than
 * guess: a label that needs a fuel and an emission standard the caller did not
 * give is not "no label".
 */

import { z } from 'zod';
import {
  geoBoundingBoxSchema,
  geoGeometryContains,
  geoGeometrySchema,
  latitudeSchema,
  longitudeSchema,
} from './geo';
import { localClock, openingHoursSchema, openingStatusAt, timezoneSchema } from './hours';
import type { Labels } from './labels';
import { cursorSchema, limitSchema, pageSchema } from './pagination';
import type { RoadUser } from './road-access';
import { instantSchema } from './time';

/** A stable lower-case id: `es`, `es-barcelona-zbe`. */
export const roadRuleIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{1,63}$/, 'must be a road rule id');

/** An ISO 3166-1 alpha-2 country code, upper-case. */
export const countryCodeSchema = z
  .string()
  .regex(/^[A-Z]{2}$/, 'must be an ISO 3166-1 alpha-2 code');

/** A link a client renders as text: a credit or a licence. */
export const roadRuleLinkSchema = z.object({
  label: z.string().trim().min(1).max(160),
  href: z.string().regex(/^https:\/\//, 'must be an https URL'),
});
export type RoadRuleLink = z.infer<typeof roadRuleLinkSchema>;

/**
 * Where a rule comes from: whose data it is, under what licence, and when GoWay
 * last read it. Every rule carries one, and a client that shows a rule shows its
 * credit.
 */
export const roadRuleSourceSchema = z.object({
  attribution: roadRuleLinkSchema,
  licence: roadRuleLinkSchema,
  retrievedAt: instantSchema,
});
export type RoadRuleSource = z.infer<typeof roadRuleSourceSchema>;

// ── Country rule sets ───────────────────────────────────────────────────────

export const DRIVING_SIDES = ['left', 'right'] as const;
export type DrivingSide = (typeof DRIVING_SIDES)[number];
export const drivingSideSchema = z.enum(DRIVING_SIDES);

/**
 * The classes OSM's implicit `maxspeed` values name: `ES:urban`, `DE:rural`,
 * `FR:motorway`. A country with no limit for a class leaves it out.
 */
export const IMPLICIT_SPEED_CLASSES = [
  'urban',
  'rural',
  'trunk',
  'motorway',
  'living_street',
] as const;
export type ImplicitSpeedClass = (typeof IMPLICIT_SPEED_CLASSES)[number];

const speedLimitSchema = z.number().int().min(5).max(200);

export const roadRuleSetSchema = z.object({
  countryCode: countryCodeSchema,
  drivingSide: drivingSideSchema,
  /** km/h per implicit class; absent where the country states none. */
  speedLimitsKmh: z.object(
    Object.fromEntries(
      IMPLICIT_SPEED_CLASSES.map((c) => [c, speedLimitSchema.optional()]),
    ) as Record<ImplicitSpeedClass, z.ZodOptional<typeof speedLimitSchema>>,
  ),
  source: roadRuleSourceSchema,
});
export type RoadRuleSet = z.infer<typeof roadRuleSetSchema>;

/**
 * An OSM `maxspeed` value in km/h: a number, `N mph`, `N km/h`, `walk`, or an
 * implicit `CC:class` (`ES:urban`) read from the country's rule set. `undefined`
 * where it names nothing GoWay knows — never a guess, and `none` is no number.
 */
export function parseMaxspeedKmh(
  value: string | undefined,
  ruleSets?: (countryCode: string) => RoadRuleSet | undefined,
): number | undefined {
  if (value === undefined) return undefined;
  const raw = value.trim().toLowerCase();
  if (raw === 'walk') return 6;
  const implicit = /^([a-z]{2}):([a-z_]+)$/.exec(raw);
  if (implicit) {
    const [, country = '', speedClass = ''] = implicit;
    return ruleSets?.(country.toUpperCase())?.speedLimitsKmh[speedClass as ImplicitSpeedClass];
  }
  const match = /^(\d{1,3}(?:\.\d+)?)\s*(km\/h|kmh|kph|mph|knots)?$/.exec(raw);
  if (!match) return undefined;
  const n = Number(match[1]);
  const kmh = match[2] === 'mph' ? n * 1.609344 : match[2] === 'knots' ? n * 1.852 : n;
  return kmh >= 5 && kmh <= 200 ? Math.round(kmh) : undefined;
}

// ── Vehicles and environmental labels ───────────────────────────────────────

export const VEHICLE_FUELS = [
  'petrol',
  'diesel',
  'hybrid',
  'plug_in_hybrid',
  'electric',
  'hydrogen',
  'lpg',
  'cng',
] as const;
export type VehicleFuel = (typeof VEHICLE_FUELS)[number];

/** The European emission standard of the vehicle; `euro_6` includes 6b, 6c, 6d and VI. */
export const EMISSION_STANDARDS = [
  'euro_1',
  'euro_2',
  'euro_3',
  'euro_4',
  'euro_5',
  'euro_6',
] as const;
export type EmissionStandard = (typeof EMISSION_STANDARDS)[number];

/**
 * The label systems zones are written in. Closed: each is a regulation with its
 * own values, derived from a vehicle by {@link environmentalLabelOf}.
 */
export const ENVIRONMENTAL_LABEL_SCHEMES = [
  'es_dgt',
  'fr_critair',
  'de_plakette',
  'uk_ulez',
] as const;
export type EnvironmentalLabelScheme = (typeof ENVIRONMENTAL_LABEL_SCHEMES)[number];
export const environmentalLabelSchemeSchema = z.enum(ENVIRONMENTAL_LABEL_SCHEMES);

/** The values of each scheme; `none` is a vehicle that has no label under it. */
export const ENVIRONMENTAL_LABEL_VALUES = {
  /** Spain's DGT: `0` zero emissions, `eco`, `c`, `b`. */
  es_dgt: ['0', 'eco', 'c', 'b', 'none'],
  /** France's Crit'Air: `e` electric or hydrogen, then 1 (cleanest) to 5. */
  fr_critair: ['e', '1', '2', '3', '4', '5', 'none'],
  /** Germany's Feinstaubplakette. */
  de_plakette: ['green', 'yellow', 'red', 'none'],
  /** London's ULEZ standard: a vehicle meets it or it does not. */
  uk_ulez: ['compliant', 'non_compliant'],
} as const satisfies Record<EnvironmentalLabelScheme, readonly string[]>;

/** What a client calls each scheme, in every label language. */
export const ENVIRONMENTAL_LABEL_SCHEME_LABELS: Readonly<Record<EnvironmentalLabelScheme, Labels>> =
  {
    es_dgt: {
      en: 'DGT environmental label',
      ar: 'ملصق DGT البيئي',
      bn: 'DGT পরিবেশ লেবেল',
      ca: 'Distintiu ambiental DGT',
      de: 'DGT-Umweltplakette',
      es: 'Distintivo ambiental DGT',
      fr: 'Vignette environnementale DGT',
      hi: 'DGT पर्यावरण लेबल',
      ja: 'DGT環境ラベル',
      'pt-BR': 'Selo ambiental DGT',
      ru: 'Экологическая наклейка DGT',
      'zh-Hans': 'DGT环保标签',
    },
    fr_critair: {
      en: "Crit'Air sticker",
      ar: "ملصق Crit'Air",
      bn: "Crit'Air স্টিকার",
      ca: "Adhesiu Crit'Air",
      de: "Crit'Air-Vignette",
      es: "Pegatina Crit'Air",
      fr: "Vignette Crit'Air",
      hi: "Crit'Air स्टिकर",
      ja: "Crit'Airステッカー",
      'pt-BR': "Selo Crit'Air",
      ru: "Наклейка Crit'Air",
      'zh-Hans': "Crit'Air贴纸",
    },
    de_plakette: {
      en: 'German environmental badge',
      ar: 'ملصق البيئة الألماني',
      bn: 'জার্মান পরিবেশ ব্যাজ',
      ca: 'Distintiu ambiental alemany',
      de: 'Feinstaubplakette',
      es: 'Distintivo ambiental alemán',
      fr: 'Vignette environnementale allemande',
      hi: 'जर्मन पर्यावरण बैज',
      ja: 'ドイツの環境ステッカー',
      'pt-BR': 'Selo ambiental alemão',
      ru: 'Немецкая экологическая наклейка',
      'zh-Hans': '德国环保标识',
    },
    uk_ulez: {
      en: 'ULEZ emission standard',
      ar: 'معيار الانبعاثات ULEZ',
      bn: 'ULEZ নির্গমন মান',
      ca: "Estàndard d'emissions ULEZ",
      de: 'ULEZ-Abgasnorm',
      es: 'Norma de emisiones ULEZ',
      fr: "Norme d'émissions ULEZ",
      hi: 'ULEZ उत्सर्जन मानक',
      ja: 'ULEZ排出基準',
      'pt-BR': 'Padrão de emissões ULEZ',
      ru: 'Стандарт выбросов ULEZ',
      'zh-Hans': 'ULEZ排放标准',
    },
  };

/** The motor users a vehicle profile may name: what a zone's policy is written over. */
export const VEHICLE_USERS = [
  'car',
  'taxi',
  'van',
  'hgv',
  'bus',
  'motorcycle',
  'moped',
] as const satisfies readonly RoadUser[];
export type VehicleUser = (typeof VEHICLE_USERS)[number];
export const vehicleUserSchema = z.enum(VEHICLE_USERS);

/**
 * A vehicle as the one request that asks describes it. Never stored.
 *
 * Only what a zone's rules read: the kind of vehicle, its fuel and emission
 * standard, or a label it already holds. Dimensions and weight are not here
 * because no rule GoWay serves reads them yet; a field accepted and ignored
 * would be a promise nothing keeps.
 *
 * `labels` states a label the caller already holds, and wins over the one
 * derived from `fuel` and `standard`: the sticker on the windscreen is the
 * vehicle's label even where the rules would derive another.
 */
export const vehicleProfileSchema = z
  .object({
    user: vehicleUserSchema.default('car'),
    fuel: z.enum(VEHICLE_FUELS).optional(),
    standard: z.enum(EMISSION_STANDARDS).optional(),
    /** A plug-in hybrid's electric range, km: Spain labels one `0` from 40 km. */
    electricRangeKm: z.number().min(0).max(2000).optional(),
    labels: z
      .object({
        es_dgt: z.enum(ENVIRONMENTAL_LABEL_VALUES.es_dgt).optional(),
        fr_critair: z.enum(ENVIRONMENTAL_LABEL_VALUES.fr_critair).optional(),
        de_plakette: z.enum(ENVIRONMENTAL_LABEL_VALUES.de_plakette).optional(),
        uk_ulez: z.enum(ENVIRONMENTAL_LABEL_VALUES.uk_ulez).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type VehicleProfile = z.input<typeof vehicleProfileSchema>;

const standardIndex = (standard: EmissionStandard) => EMISSION_STANDARDS.indexOf(standard) + 1;
const ZERO_EMISSION: readonly VehicleFuel[] = ['electric', 'hydrogen'];
/** Vehicles the four schemes' passenger-car rules cover: cars, taxis and vans. */
const LIGHT_USERS: readonly VehicleUser[] = ['car', 'taxi', 'van'];

/**
 * A vehicle's label under `scheme`, or `undefined` when it cannot be told: the
 * caller gave neither the label nor the fuel and standard it follows from, or
 * the scheme's rules for this kind of vehicle are not modelled. Never `none` by
 * default — an unknown vehicle is not an unlabelled one.
 *
 * The tables are the regulations': Spain's DGT resolution (2016), France's
 * arrêté of 21 June 2016, Germany's 35th BImSchV, London's ULEZ standard. A
 * plug-in or other hybrid is read as the petrol vehicle it is under France and
 * Germany; only Spain labels it by its own rules.
 */
export function environmentalLabelOf(
  scheme: EnvironmentalLabelScheme,
  vehicle: VehicleProfile,
): string | undefined {
  const stated = vehicle.labels?.[scheme];
  if (stated !== undefined) return stated;
  const user = vehicle.user ?? 'car';
  const { fuel } = vehicle;
  if (fuel === undefined) return undefined;
  const zero = ZERO_EMISSION.includes(fuel);
  const euro = vehicle.standard ? standardIndex(vehicle.standard) : undefined;
  const light = LIGHT_USERS.includes(user);
  const diesel = fuel === 'diesel';

  switch (scheme) {
    case 'es_dgt': {
      if (zero) return '0';
      if (!light || euro === undefined) return undefined;
      if (fuel === 'plug_in_hybrid' && (vehicle.electricRangeKm ?? 0) >= 40) return '0';
      const eco =
        fuel === 'hybrid' || fuel === 'plug_in_hybrid' || fuel === 'lpg' || fuel === 'cng';
      if (eco && euro >= 4) return 'eco';
      if (diesel) return euro >= 6 ? 'c' : euro >= 4 ? 'b' : 'none';
      return euro >= 4 ? 'c' : euro === 3 ? 'b' : 'none';
    }
    case 'fr_critair': {
      if (zero) return 'e';
      if (!light || euro === undefined) return undefined;
      if (diesel)
        return euro >= 5 ? '2' : euro === 4 ? '3' : euro === 3 ? '4' : euro === 2 ? '5' : 'none';
      return euro >= 5 ? '1' : euro === 4 ? '2' : euro >= 2 ? '3' : 'none';
    }
    case 'de_plakette': {
      if (zero) return 'green';
      if (!light || euro === undefined) return undefined;
      if (diesel) return euro >= 4 ? 'green' : euro === 3 ? 'yellow' : euro === 2 ? 'red' : 'none';
      return 'green';
    }
    case 'uk_ulez': {
      if (zero) return 'compliant';
      if (euro === undefined) return undefined;
      if (light) return (diesel ? euro >= 6 : euro >= 4) ? 'compliant' : 'non_compliant';
      if (user === 'motorcycle' || user === 'moped')
        return euro >= 3 ? 'compliant' : 'non_compliant';
      return euro >= 6 ? 'compliant' : 'non_compliant';
    }
  }
}

// ── Zones ───────────────────────────────────────────────────────────────────

/**
 * What kind of regulation a zone is. Closed: a client icons and explains each.
 *
 * - `low_emission` — entry depends on the vehicle's emissions (Spain's ZBE,
 *   France's ZFE, Germany's Umweltzone, London's ULEZ).
 * - `congestion_charge` — entry costs money (London, Stockholm, Milan Area C).
 * - `restricted_access` — entry is for residents, permit holders or no one
 *   (Italy's ZTL, a car-free centre).
 */
export const ROAD_ZONE_KINDS = ['low_emission', 'congestion_charge', 'restricted_access'] as const;
export type RoadZoneKind = (typeof ROAD_ZONE_KINDS)[number];
export const roadZoneKindSchema = z.enum(ROAD_ZONE_KINDS);

export const ROAD_ZONE_KIND_LABELS: Readonly<Record<RoadZoneKind, Labels>> = {
  low_emission: {
    en: 'Low emission zone',
    ar: 'منطقة منخفضة الانبعاثات',
    bn: 'নিম্ন নির্গমন অঞ্চল',
    ca: 'Zona de baixes emissions',
    de: 'Niedrigemissionszone',
    es: 'Zona de bajas emisiones',
    fr: 'Zone à faibles émissions',
    hi: 'कम उत्सर्जन क्षेत्र',
    ja: '低排出ガスゾーン',
    'pt-BR': 'Zona de baixas emissões',
    ru: 'Зона низких выбросов',
    'zh-Hans': '低排放区',
  },
  congestion_charge: {
    en: 'Congestion charge zone',
    ar: 'منطقة رسوم الازدحام',
    bn: 'যানজট শুল্ক অঞ্চল',
    ca: 'Zona de peatge urbà',
    de: 'Citymaut-Zone',
    es: 'Zona de peaje urbano',
    fr: 'Zone de péage urbain',
    hi: 'भीड़ शुल्क क्षेत्र',
    ja: '混雑課金ゾーン',
    'pt-BR': 'Zona de pedágio urbano',
    ru: 'Зона платного въезда',
    'zh-Hans': '拥堵收费区',
  },
  restricted_access: {
    en: 'Restricted access zone',
    ar: 'منطقة وصول مقيّد',
    bn: 'সীমিত প্রবেশাধিকার অঞ্চল',
    ca: "Zona d'accés restringit",
    de: 'Zone mit beschränkter Zufahrt',
    es: 'Zona de acceso restringido',
    fr: 'Zone à accès restreint',
    hi: 'प्रतिबंधित प्रवेश क्षेत्र',
    ja: '進入制限ゾーン',
    'pt-BR': 'Zona de acesso restrito',
    ru: 'Зона ограниченного въезда',
    'zh-Hans': '限行区域',
  },
};

/**
 * What a zone says to a vehicle, from most to least permissive.
 *
 * - `allowed` — may enter freely.
 * - `fee` — may enter by paying.
 * - `permit` — may enter with a permit (resident, delivery, disabled…).
 * - `denied` — may not enter.
 */
export const ZONE_DECISIONS = ['allowed', 'fee', 'permit', 'denied'] as const;
export type ZoneDecision = (typeof ZONE_DECISIONS)[number];
export const zoneDecisionSchema = z.enum(ZONE_DECISIONS);

export const MAX_ZONE_RULES = 32;

/**
 * One line of a zone's policy: vehicles of these `users` (all, if none named)
 * whose `scheme` label is one of `labels` get `decision`. Rules are read in
 * order; the first that matches decides.
 */
export const roadZoneRuleSchema = z
  .object({
    users: z.array(vehicleUserSchema).min(1).max(VEHICLE_USERS.length).optional(),
    scheme: environmentalLabelSchemeSchema,
    labels: z.array(z.string().min(1).max(16)).min(1).max(8),
    decision: zoneDecisionSchema,
  })
  .strict()
  .superRefine((rule, ctx) => {
    const known: readonly string[] = ENVIRONMENTAL_LABEL_VALUES[rule.scheme];
    rule.labels.forEach((label, i) => {
      if (!known.includes(label)) {
        ctx.addIssue({
          code: 'custom',
          path: ['labels', i],
          message: `${label} is not a ${rule.scheme} label`,
        });
      }
    });
  });
export type RoadZoneRule = z.infer<typeof roadZoneRuleSchema>;

/**
 * A zone's policy: the rules in order, and what applies when none matches.
 * `otherwise: 'unknown'` is a zone GoWay knows the extent of and not the rules
 * of — shown on the map, never answered "allowed".
 */
export const roadZonePolicySchema = z
  .object({
    rules: z.array(roadZoneRuleSchema).max(MAX_ZONE_RULES),
    otherwise: z.union([zoneDecisionSchema, z.literal('unknown')]),
  })
  .strict();
export type RoadZonePolicy = z.infer<typeof roadZonePolicySchema>;

const zoneGeometrySchema = z.discriminatedUnion('type', [
  geoGeometrySchema.options[2],
  geoGeometrySchema.options[3],
]);

export const roadZoneSchema = z.object({
  id: roadRuleIdSchema,
  /** The zone's own name, in the local language (`Zona de Bajas Emisiones Rondas de Barcelona`). */
  name: z.string().trim().min(1).max(160),
  kind: roadZoneKindSchema,
  countryCode: countryCodeSchema,
  geometry: zoneGeometrySchema,
  boundingBox: geoBoundingBoxSchema,
  timezone: timezoneSchema,
  /** When it is in force, weekly and local; absent: always. */
  schedule: openingHoursSchema.optional(),
  /** First and last local day it is in force (`YYYY-MM-DD`); absent: no bound. */
  effectiveFrom: z.string().optional(),
  effectiveUntil: z.string().optional(),
  policy: roadZonePolicySchema,
  /** The ordinance or page that states the rule, for a client to link. */
  rulesUrl: z
    .string()
    .regex(/^https:\/\//)
    .optional(),
  source: roadRuleSourceSchema,
});
export type RoadZone = z.infer<typeof roadZoneSchema>;

/** What one zone says to one vehicle at one time. */
export const roadZoneVerdictSchema = z.object({
  zoneId: roadRuleIdSchema,
  name: z.string(),
  kind: roadZoneKindSchema,
  /** `unknown`: the vehicle was not described well enough for this zone's rules. */
  decision: z.union([zoneDecisionSchema, z.literal('unknown')]),
  /** Whether the zone is in force at that time; where it is not, `decision` is `allowed`. */
  inForce: z.boolean(),
  /** The label the decision rests on, when one did. */
  scheme: environmentalLabelSchemeSchema.optional(),
  label: z.string().optional(),
});
export type RoadZoneVerdict = z.infer<typeof roadZoneVerdictSchema>;

/**
 * Whether `zone` is in force at `at`: inside its effective days and, where it
 * has a schedule, inside it, both in the zone's own timezone. `undefined` when
 * that cannot be told (a schedule in a zone this runtime cannot evaluate).
 */
export function zoneInForce(zone: RoadZone, at: Date): boolean | undefined {
  const clock = localClock(zone.timezone, at);
  if (!clock) return zone.schedule || zone.effectiveFrom || zone.effectiveUntil ? undefined : true;
  if (zone.effectiveFrom && clock.date < zone.effectiveFrom) return false;
  if (zone.effectiveUntil && clock.date > zone.effectiveUntil) return false;
  if (!zone.schedule || zone.schedule.intervals.length === 0) return true;
  const status = openingStatusAt({ timezone: zone.timezone, openingHours: zone.schedule }, at);
  return status.state === 'unknown' ? undefined : status.state === 'open';
}

/** What `zone` says to `vehicle` at `at`. */
export function evaluateZone(zone: RoadZone, vehicle: VehicleProfile, at: Date): RoadZoneVerdict {
  const base = { zoneId: zone.id, name: zone.name, kind: zone.kind };
  const inForce = zoneInForce(zone, at);
  if (inForce === undefined) return { ...base, decision: 'unknown', inForce: false };
  if (!inForce) return { ...base, decision: 'allowed', inForce: false };
  const user = vehicle.user ?? 'car';
  let undetermined: EnvironmentalLabelScheme | undefined;
  /** The label that was read and matched no rule: why `otherwise` applied. */
  let unmatched: { scheme: EnvironmentalLabelScheme; label: string } | undefined;
  for (const rule of zone.policy.rules) {
    if (rule.users && !rule.users.includes(user)) continue;
    const label = environmentalLabelOf(rule.scheme, vehicle);
    if (label === undefined) {
      undetermined ??= rule.scheme;
      continue;
    }
    if (rule.labels.includes(label)) {
      return { ...base, decision: rule.decision, inForce: true, scheme: rule.scheme, label };
    }
    unmatched ??= { scheme: rule.scheme, label };
  }
  // Rules that could not be read for this vehicle might have decided it.
  if (undetermined) return { ...base, decision: 'unknown', inForce: true, scheme: undetermined };
  return { ...base, decision: zone.policy.otherwise, inForce: true, ...unmatched };
}

/** The strictest of several decisions: `denied` over `permit` over `fee` over `allowed`. */
export function strictestDecision(
  decisions: readonly (ZoneDecision | 'unknown')[],
): ZoneDecision | 'unknown' {
  if (decisions.includes('denied')) return 'denied';
  if (decisions.includes('unknown')) return 'unknown';
  return (
    ZONE_DECISIONS.slice()
      .reverse()
      .find((d) => decisions.includes(d)) ?? 'allowed'
  );
}

// ── Reading by position ─────────────────────────────────────────────────────

/** `GET /roads/rules?latitude=&longitude=` */
export const roadRulesQuerySchema = z
  .object({
    latitude: latitudeSchema,
    longitude: longitudeSchema,
    /**
     * The country the position is in, when the caller already knows it (a
     * reverse geocode's `countryCode`). Without it GoWay finds it from its own
     * country borders.
     */
    country: countryCodeSchema.optional(),
  })
  .strict();
export type RoadRulesQuery = z.input<typeof roadRulesQuerySchema>;

/** What applies at a position: its country's rule set and the zones that cover it. */
export const roadRulesSchema = z.object({
  /** The country the position is in; `null` over open water or where GoWay holds no border. */
  countryCode: countryCodeSchema.nullable(),
  /** That country's rule set; `null` where GoWay holds none. */
  ruleSet: roadRuleSetSchema.nullable(),
  zones: z.array(roadZoneSchema),
});
export type RoadRules = z.infer<typeof roadRulesSchema>;

export const MAX_ROAD_LIST_LIMIT = 200;
export const DEFAULT_ROAD_LIST_LIMIT = 50;

/** `GET /roads/rule-sets` */
export const roadRuleSetListQuerySchema = z
  .object({
    limit: limitSchema(MAX_ROAD_LIST_LIMIT, DEFAULT_ROAD_LIST_LIMIT),
    cursor: cursorSchema.optional(),
  })
  .strict();
export type RoadRuleSetListQuery = z.input<typeof roadRuleSetListQuerySchema>;
export const roadRuleSetPageSchema = pageSchema(roadRuleSetSchema);
export type RoadRuleSetPage = z.infer<typeof roadRuleSetPageSchema>;

/** `GET /roads/zones` — the zones in a box, or a country's, ordered by id. */
export const roadZoneListQuerySchema = z
  .object({
    west: longitudeSchema.optional(),
    south: latitudeSchema.optional(),
    east: longitudeSchema.optional(),
    north: latitudeSchema.optional(),
    country: countryCodeSchema.optional(),
    kind: roadZoneKindSchema.optional(),
    limit: limitSchema(MAX_ROAD_LIST_LIMIT, DEFAULT_ROAD_LIST_LIMIT),
    cursor: cursorSchema.optional(),
  })
  .strict()
  .refine(
    (q) =>
      [q.west, q.south, q.east, q.north].every((v) => v === undefined) ||
      [q.west, q.south, q.east, q.north].every((v) => v !== undefined),
    { message: 'west, south, east and north go together', path: ['west'] },
  )
  .refine((q) => q.west !== undefined || q.country !== undefined, {
    message: 'name a country or a box',
    path: ['country'],
  });
export type RoadZoneListQuery = z.input<typeof roadZoneListQuerySchema>;
export const roadZonePageSchema = pageSchema(roadZoneSchema);
export type RoadZonePage = z.infer<typeof roadZonePageSchema>;

// ── May this vehicle go there? ──────────────────────────────────────────────

/** `POST /roads/access` — a vehicle, a position, and when (now by default). */
export const roadAccessInputSchema = z
  .object({
    latitude: latitudeSchema,
    longitude: longitudeSchema,
    vehicle: vehicleProfileSchema.default({ user: 'car' }),
    at: instantSchema.optional(),
  })
  .strict();
export type RoadAccessInput = z.input<typeof roadAccessInputSchema>;

/**
 * The answer: the strictest decision among the zones covering the position at
 * that time, with each zone's own verdict so a client can say which and why.
 * `allowed` with no verdicts means no zone GoWay holds covers the position — not
 * that none exists.
 */
export const roadAccessDecisionSchema = z.object({
  decision: z.union([zoneDecisionSchema, z.literal('unknown')]),
  verdicts: z.array(roadZoneVerdictSchema),
  at: instantSchema,
});
export type RoadAccessDecision = z.infer<typeof roadAccessDecisionSchema>;

/** The decision for a position, over the zones that cover it. Pure: the server and an offline client agree. */
export function decideAccess(
  zones: readonly RoadZone[],
  position: Readonly<{ latitude: number; longitude: number }>,
  vehicle: VehicleProfile,
  at: Date,
): RoadAccessDecision {
  const verdicts = zones
    .filter((zone) => geoGeometryContains(zone.geometry, position))
    .map((zone) => evaluateZone(zone, vehicle, at));
  return {
    decision: strictestDecision(verdicts.map((v) => v.decision)),
    verdicts,
    at: at.toISOString(),
  };
}
