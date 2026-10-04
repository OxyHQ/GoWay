/**
 * The capability registry — every key a place can carry, with the TYPE of its
 * value.
 *
 * A capability is one row in `places_capabilities`: a key, a value, a
 * verification tier and a freshness. Before this registry the key space was
 * open and the value was `boolean | string | number` for every key, so
 * `accessibility.wheelchair = 7` and `payments.faircoin.accepted = "maybe"`
 * were both writable and both meaningless. Now each key declares:
 *
 *  - its value shape ({@link CapabilityValueSpec}): a flag, one of a closed set,
 *    a subset of a closed set, a bounded integer, a price level, a URL, or a
 *    short text;
 *  - its label in every label language, and its enum values' labels;
 *  - the group a client renders it under;
 *  - the OpenStreetMap tags it is read from, where OpenStreetMap has one.
 *
 * Every write is validated against its key's spec, and a key that is not here
 * is refused. The verification tiers, the strongest-assertion rule and the
 * provenance rows are unchanged: this registry types the VALUE, it does not
 * touch who may assert it.
 *
 * ## No new table
 *
 * Accessibility, payment methods, amenities, cuisine and social links are all
 * capabilities. Each of them is a claim somebody makes about a place with some
 * strength at some time — the shape `places_capabilities` already has, with
 * the community/business/Oxy tiers kept apart so a passer-by's report cannot
 * overwrite the business's own. A column per attribute would have no
 * provenance at all.
 */

import { z } from 'zod';
import { labels, localizedLabel, type Labels } from './labels';

/**
 * How a capability claim came to be believed.
 *
 * Ordered weakest to strongest, and the ORDER is the contract: it is the rank
 * `strongestCapability` reads and the capability filter applies. A historic
 * community report must never be presented as guaranteed current acceptance
 * without qualification — see `observedAt` on `PlaceCapability`. Hours
 * exceptions carry the same tiers, ranked the same way.
 */
export const CAPABILITY_VERIFICATIONS = [
  'community_reported',
  'external_source',
  'business_asserted',
  'oxy_verified',
] as const;
export type CapabilityVerification = (typeof CAPABILITY_VERIFICATIONS)[number];

/** The sections a client renders capabilities under, in display order. */
export const CAPABILITY_GROUPS = [
  'accessibility',
  'payment',
  'amenities',
  'food',
  'price',
  'social',
  'brand',
  'ecosystem',
] as const;
export type CapabilityGroup = (typeof CAPABILITY_GROUPS)[number];

export const CAPABILITY_GROUP_LABELS: Readonly<Record<CapabilityGroup, Labels>> = {
  accessibility: labels('Accessibility', 'Accesibilidad'),
  payment: labels('Payment', 'Pago'),
  amenities: labels('Amenities', 'Servicios'),
  food: labels('Food', 'Comida'),
  price: labels('Price', 'Precio'),
  social: labels('Social media', 'Redes sociales'),
  brand: labels('Brand', 'Marca'),
  ecosystem: labels('In the Oxy ecosystem', 'En el ecosistema Oxy'),
};

/** The value kinds a capability may declare. */
export const CAPABILITY_VALUE_KINDS = [
  'boolean',
  'enum',
  'enum_set',
  'integer',
  'price_level',
  'url',
  'text',
] as const;
export type CapabilityValueKind = (typeof CAPABILITY_VALUE_KINDS)[number];

/** The values of an enum or an enum set, each with its label, in display order. */
export type CapabilityValueLabels = Readonly<Record<string, Labels>>;

/**
 * What a capability's value is.
 *
 * `enum.absent` names the values that mean the place does NOT have the thing —
 * `wheelchair = no` is an assertion, and it must not make a place match
 * `?capabilities=accessibility.wheelchair`.
 *
 * `url.handle` lets a caller (or a source) give a bare handle — `@cafe`, a
 * phone number for WhatsApp — and stores the canonical URL instead, so one
 * spelling is stored however it arrived. `url.hosts` refuses a link to the
 * wrong service under the key.
 */
export type CapabilityValueSpec =
  | { readonly kind: 'boolean' }
  | { readonly kind: 'enum'; readonly values: CapabilityValueLabels; readonly absent?: readonly string[] }
  | { readonly kind: 'enum_set'; readonly values: CapabilityValueLabels }
  | { readonly kind: 'integer'; readonly min: number; readonly max: number }
  | { readonly kind: 'price_level' }
  | {
      readonly kind: 'url';
      readonly hosts?: readonly string[];
      readonly handle?: { readonly url: string; readonly pattern: RegExp; readonly digitsOnly?: boolean };
    }
  | { readonly kind: 'text'; readonly maxLength: number; readonly pattern?: RegExp };

/**
 * Where OpenStreetMap says it.
 *
 * - `tags` — read in order. For a boolean, any `yes` value wins over any `no`
 *   (`payment:credit_cards=yes` with `payment:cards` absent is cards); for an
 *   enum the value is taken when it is one of the enum's; for an enum set the
 *   value is a `;`-separated list; for a URL or text the first non-empty value.
 * - `prefix` — an enum set read from keys: `diet:vegan=yes` puts `vegan` in.
 * - `yes` / `no` — the tag values that mean true and false. `['yes']` and
 *   `['no']` when absent.
 */
export interface CapabilityOsmTags {
  readonly tags?: readonly string[];
  readonly prefix?: string;
  readonly yes?: readonly string[];
  readonly no?: readonly string[];
}

export interface CapabilityDefinition {
  readonly group: CapabilityGroup;
  readonly labels: Labels;
  readonly value: CapabilityValueSpec;
  readonly osm?: CapabilityOsmTags;
}

const BOOLEAN = { kind: 'boolean' } as const;

const CUISINES: CapabilityValueLabels = {
  regional: labels('Regional', 'Regional'),
  spanish: labels('Spanish', 'Española'),
  tapas: labels('Tapas', 'Tapas'),
  catalan: labels('Catalan', 'Catalana'),
  mediterranean: labels('Mediterranean', 'Mediterránea'),
  italian: labels('Italian', 'Italiana'),
  pizza: labels('Pizza', 'Pizza'),
  french: labels('French', 'Francesa'),
  portuguese: labels('Portuguese', 'Portuguesa'),
  greek: labels('Greek', 'Griega'),
  german: labels('German', 'Alemana'),
  turkish: labels('Turkish', 'Turca'),
  kebab: labels('Kebab', 'Kebab'),
  lebanese: labels('Lebanese', 'Libanesa'),
  arab: labels('Arabic', 'Árabe'),
  african: labels('African', 'Africana'),
  indian: labels('Indian', 'India'),
  nepalese: labels('Nepalese', 'Nepalí'),
  chinese: labels('Chinese', 'China'),
  japanese: labels('Japanese', 'Japonesa'),
  sushi: labels('Sushi', 'Sushi'),
  ramen: labels('Ramen', 'Ramen'),
  korean: labels('Korean', 'Coreana'),
  thai: labels('Thai', 'Tailandesa'),
  vietnamese: labels('Vietnamese', 'Vietnamita'),
  asian: labels('Asian', 'Asiática'),
  mexican: labels('Mexican', 'Mexicana'),
  peruvian: labels('Peruvian', 'Peruana'),
  argentinian: labels('Argentinian', 'Argentina'),
  american: labels('American', 'Americana'),
  burger: labels('Burgers', 'Hamburguesas'),
  chicken: labels('Chicken', 'Pollo'),
  sandwich: labels('Sandwiches', 'Bocadillos'),
  barbecue: labels('Barbecue', 'Barbacoa'),
  steak_house: labels('Steakhouse', 'Asador'),
  seafood: labels('Seafood', 'Marisco'),
  fish: labels('Fish', 'Pescado'),
  international: labels('International', 'Internacional'),
  coffee_shop: labels('Coffee', 'Café'),
  breakfast: labels('Breakfast', 'Desayunos'),
  ice_cream: labels('Ice cream', 'Helados'),
  crepe: labels('Crêpes', 'Crepes'),
  bubble_tea: labels('Bubble tea', 'Té de burbujas'),
};

const DIETS: CapabilityValueLabels = {
  vegan: labels('Vegan', 'Vegana'),
  vegetarian: labels('Vegetarian', 'Vegetariana'),
  gluten_free: labels('Gluten-free', 'Sin gluten'),
  halal: labels('Halal', 'Halal'),
  kosher: labels('Kosher', 'Kosher'),
};

/**
 * Every capability key GoWay accepts.
 *
 * `payments.faircoin.accepted` keeps its original spelling, and the other
 * payment methods join it under `payments.`, so the key FairCoin integrated
 * against in 0.1 still names the same assertion. The ecosystem keys keep the
 * `<domain>.<product>.<capability>` shape for the same reason.
 *
 * `accessibility.*` holds the four flags Mercaria records on a pickup
 * location (`stepFreeAccess`, `accessibleToilet`, `parkingOnSite`,
 * `hearingLoop`) plus OpenStreetMap's three-valued `wheelchair`, so a Mercaria
 * location and the GoWay place it trades from say the same thing in one place.
 */
export const CAPABILITY_DEFINITIONS = {
  // ── Accessibility ─────────────────────────────────────────────────────────
  'accessibility.wheelchair': {
    group: 'accessibility',
    labels: labels('Wheelchair access', 'Acceso en silla de ruedas'),
    value: {
      kind: 'enum',
      values: {
        yes: labels('Wheelchair accessible', 'Accesible en silla de ruedas'),
        limited: labels('Partly wheelchair accessible', 'Parcialmente accesible'),
        no: labels('Not wheelchair accessible', 'No accesible en silla de ruedas'),
      },
      absent: ['no'],
    },
    osm: { tags: ['wheelchair'] },
  },
  'accessibility.toilets_wheelchair': {
    group: 'accessibility',
    labels: labels('Accessible toilet', 'Aseo adaptado'),
    value: BOOLEAN,
    osm: { tags: ['toilets:wheelchair'] },
  },
  'accessibility.step_free_entrance': {
    group: 'accessibility',
    labels: labels('Step-free entrance', 'Entrada sin escalones'),
    value: BOOLEAN,
  },
  'accessibility.parking_accessible': {
    group: 'accessibility',
    labels: labels('Accessible parking', 'Aparcamiento adaptado'),
    value: BOOLEAN,
  },
  'accessibility.hearing_loop': {
    group: 'accessibility',
    labels: labels('Hearing loop', 'Bucle magnético'),
    value: BOOLEAN,
    osm: { tags: ['hearing_loop'], yes: ['yes', 'limited'] },
  },

  // ── Payment ───────────────────────────────────────────────────────────────
  'payments.cash': {
    group: 'payment',
    labels: labels('Cash', 'Efectivo'),
    value: BOOLEAN,
    osm: { tags: ['payment:cash', 'payment:notes', 'payment:coins'] },
  },
  'payments.cards': {
    group: 'payment',
    labels: labels('Cards', 'Tarjetas'),
    value: BOOLEAN,
    osm: {
      tags: ['payment:cards', 'payment:credit_cards', 'payment:debit_cards', 'payment:visa', 'payment:mastercard'],
    },
  },
  'payments.contactless': {
    group: 'payment',
    labels: labels('Contactless', 'Pago sin contacto'),
    value: BOOLEAN,
    osm: { tags: ['payment:contactless'] },
  },
  'payments.faircoin.accepted': {
    group: 'payment',
    labels: labels('Accepts FairCoin', 'Acepta FairCoin'),
    value: BOOLEAN,
    osm: { tags: ['payment:faircoin'] },
  },

  // ── Amenities ─────────────────────────────────────────────────────────────
  'amenities.wifi': {
    group: 'amenities',
    labels: labels('Wi-Fi', 'Wifi'),
    value: BOOLEAN,
    osm: { tags: ['internet_access'], yes: ['wlan', 'wifi', 'yes'], no: ['no'] },
  },
  'amenities.outdoor_seating': {
    group: 'amenities',
    labels: labels('Outdoor seating', 'Terraza'),
    value: BOOLEAN,
    osm: { tags: ['outdoor_seating'] },
  },
  'amenities.takeaway': {
    group: 'amenities',
    labels: labels('Takeaway', 'Para llevar'),
    value: BOOLEAN,
    osm: { tags: ['takeaway'], yes: ['yes', 'only'] },
  },
  'amenities.delivery': {
    group: 'amenities',
    labels: labels('Delivery', 'Entrega a domicilio'),
    value: BOOLEAN,
    osm: { tags: ['delivery'], yes: ['yes', 'only'] },
  },
  'amenities.reservations': {
    group: 'amenities',
    labels: labels('Takes reservations', 'Admite reservas'),
    value: BOOLEAN,
    osm: { tags: ['reservation'], yes: ['yes', 'required', 'recommended'] },
  },
  'amenities.drive_through': {
    group: 'amenities',
    labels: labels('Drive-through', 'Servicio para coches'),
    value: BOOLEAN,
    osm: { tags: ['drive_through'] },
  },
  'amenities.toilets': {
    group: 'amenities',
    labels: labels('Toilets', 'Aseos'),
    value: BOOLEAN,
    osm: { tags: ['toilets'] },
  },
  'amenities.air_conditioning': {
    group: 'amenities',
    labels: labels('Air conditioning', 'Aire acondicionado'),
    value: BOOLEAN,
    osm: { tags: ['air_conditioning'] },
  },

  // ── Food ──────────────────────────────────────────────────────────────────
  'food.cuisine': {
    group: 'food',
    labels: labels('Cuisine', 'Cocina'),
    value: { kind: 'enum_set', values: CUISINES },
    osm: { tags: ['cuisine'] },
  },
  'food.diet': {
    group: 'food',
    labels: labels('Dietary options', 'Opciones dietéticas'),
    value: { kind: 'enum_set', values: DIETS },
    osm: { prefix: 'diet:', yes: ['yes', 'only'] },
  },

  // ── Price ─────────────────────────────────────────────────────────────────
  'price.level': {
    group: 'price',
    labels: labels('Price level', 'Nivel de precio'),
    value: { kind: 'price_level' },
  },

  // ── Social ────────────────────────────────────────────────────────────────
  'social.instagram': {
    group: 'social',
    labels: labels('Instagram', 'Instagram'),
    value: {
      kind: 'url',
      hosts: ['instagram.com'],
      handle: { url: 'https://www.instagram.com/{handle}', pattern: /^[A-Za-z0-9._]{1,30}$/ },
    },
    osm: { tags: ['contact:instagram', 'instagram'] },
  },
  'social.facebook': {
    group: 'social',
    labels: labels('Facebook', 'Facebook'),
    value: {
      kind: 'url',
      hosts: ['facebook.com', 'fb.com'],
      handle: { url: 'https://www.facebook.com/{handle}', pattern: /^[A-Za-z0-9.-]{1,80}$/ },
    },
    osm: { tags: ['contact:facebook', 'facebook'] },
  },
  'social.x': {
    group: 'social',
    labels: labels('X', 'X'),
    value: {
      kind: 'url',
      hosts: ['x.com', 'twitter.com'],
      handle: { url: 'https://x.com/{handle}', pattern: /^[A-Za-z0-9_]{1,15}$/ },
    },
    osm: { tags: ['contact:x', 'contact:twitter', 'twitter'] },
  },
  'social.tiktok': {
    group: 'social',
    labels: labels('TikTok', 'TikTok'),
    value: {
      kind: 'url',
      hosts: ['tiktok.com'],
      handle: { url: 'https://www.tiktok.com/@{handle}', pattern: /^[A-Za-z0-9._]{1,24}$/ },
    },
    osm: { tags: ['contact:tiktok', 'tiktok'] },
  },
  'social.whatsapp': {
    group: 'social',
    labels: labels('WhatsApp', 'WhatsApp'),
    value: {
      kind: 'url',
      hosts: ['wa.me', 'whatsapp.com'],
      handle: { url: 'https://wa.me/{handle}', pattern: /^[0-9]{6,15}$/, digitsOnly: true },
    },
    osm: { tags: ['contact:whatsapp', 'whatsapp'] },
  },

  // ── Brand ─────────────────────────────────────────────────────────────────
  'brand.wikidata': {
    group: 'brand',
    labels: labels('Brand (Wikidata)', 'Marca (Wikidata)'),
    value: { kind: 'text', maxLength: 16, pattern: /^Q[1-9][0-9]*$/ },
    osm: { tags: ['brand:wikidata'] },
  },

  // ── The Oxy ecosystem ─────────────────────────────────────────────────────
  'commerce.mercaria.store': {
    group: 'ecosystem',
    labels: labels('Mercaria store', 'Tienda en Mercaria'),
    // The Mercaria location id, opaque: GoWay stores the reference, Mercaria
    // owns the store.
    value: { kind: 'text', maxLength: 128 },
  },
  'mobility.moovo.pickup': {
    group: 'ecosystem',
    labels: labels('Moovo pickup point', 'Punto de recogida Moovo'),
    value: BOOLEAN,
  },
  'housing.homiio.listings': {
    group: 'ecosystem',
    labels: labels('Homiio listings', 'Anuncios en Homiio'),
    value: { kind: 'integer', min: 0, max: 100_000 },
  },
  'social.mention.location': {
    group: 'ecosystem',
    labels: labels('Mention location', 'Ubicación en Mention'),
    value: BOOLEAN,
  },
} as const satisfies Readonly<Record<string, CapabilityDefinition>>;

/** A registered capability key: `accessibility.wheelchair`, `payments.faircoin.accepted`, … */
export type CapabilityKey = keyof typeof CAPABILITY_DEFINITIONS;

/** Every registered key, in display order. */
export const CAPABILITY_KEYS = Object.keys(CAPABILITY_DEFINITIONS) as unknown as readonly [
  CapabilityKey,
  ...CapabilityKey[],
];

/** Whether a string is a registered capability key. */
export function isCapabilityKey(value: string): value is CapabilityKey {
  return Object.prototype.hasOwnProperty.call(CAPABILITY_DEFINITIONS, value);
}

/** The definition of a key, or `undefined` for a key this build does not know. */
export function capabilityDefinition(key: string): CapabilityDefinition | undefined {
  return isCapabilityKey(key) ? CAPABILITY_DEFINITIONS[key] : undefined;
}

/** The group a key renders under, or `undefined` for a key this build does not know. */
export function capabilityGroupOf(key: string): CapabilityGroup | undefined {
  return capabilityDefinition(key)?.group;
}

/** The kind of value a key holds, or `undefined` for a key this build does not know. */
export function capabilityValueKind(key: string): CapabilityValueKind | undefined {
  return capabilityDefinition(key)?.value.kind;
}

/** The label for a key in a locale; the key itself for one this build does not know. */
export function capabilityLabel(key: string, locale?: string | null): string {
  const definition = capabilityDefinition(key);
  return definition ? localizedLabel(definition.labels, locale) : key;
}

/** The label for one enum value of a key, or the value itself. */
export function capabilityValueLabel(key: string, value: string, locale?: string | null): string {
  const spec = capabilityDefinition(key)?.value;
  const entry = spec && (spec.kind === 'enum' || spec.kind === 'enum_set') ? spec.values[value] : undefined;
  return entry ? localizedLabel(entry, locale) : value;
}

/** The label for a group in a locale. */
export function capabilityGroupLabel(group: CapabilityGroup, locale?: string | null): string {
  return localizedLabel(CAPABILITY_GROUP_LABELS[group], locale);
}

// ── Values ──────────────────────────────────────────────────────────────────

/**
 * A capability's stored value: the union of every kind's shape.
 *
 * An enum set is a string array; the other kinds are scalars. The table's
 * CHECK admits exactly these jsonb types.
 */
export const capabilityValueSchema = z.union([z.boolean(), z.string(), z.number(), z.array(z.string())]);
export type CapabilityValue = z.infer<typeof capabilityValueSchema>;

/** A value as a write carries it, before its key's schema is applied. Bounded. */
export const capabilityValueInputSchema = z.union([
  z.boolean(),
  z.string().max(2048),
  z.number(),
  z.array(z.string().max(64)).max(64),
]);

/** `{handle}` substituted, or the URL itself, or `undefined` when neither fits. */
function canonicalUrl(spec: Extract<CapabilityValueSpec, { kind: 'url' }>, raw: string): string | undefined {
  const value = raw.trim();
  // A pattern rather than `URL`: this module runs in every runtime the SDK
  // does, and the global is not one this package may assume a type for.
  const link = /^https?:\/\/([^/?#\s:@]+)(?::\d{1,5})?(?:[/?#]\S*)?$/i.exec(value);
  if (link) {
    const host = (link[1] as string).toLowerCase().replace(/^(www\.|m\.|mobile\.)/, '');
    return spec.hosts && !spec.hosts.includes(host) ? undefined : value;
  }
  if (!spec.handle) return undefined;
  const handle = spec.handle.digitsOnly ? value.replace(/[\s()+.-]/g, '') : value.replace(/^@/, '');
  return spec.handle.pattern.test(handle) ? spec.handle.url.replace('{handle}', handle) : undefined;
}

/**
 * The zod schema for one kind of value, normalizing as it validates.
 *
 * An enum set comes back de-duplicated and in the registry's own order, so the
 * same set is always stored as the same array and two writes of it compare
 * equal. A URL comes back canonical, whether it arrived as a link or a handle.
 */
export function capabilityValueSpecSchema(spec: CapabilityValueSpec): z.ZodType<CapabilityValue, unknown> {
  switch (spec.kind) {
    case 'boolean':
      return z.boolean();
    case 'enum':
      return z.enum(Object.keys(spec.values) as [string, ...string[]]);
    case 'enum_set': {
      const order = Object.keys(spec.values);
      return z
        .array(z.enum(order as [string, ...string[]]))
        .min(1)
        .max(64)
        .transform((members) => order.filter((value) => members.includes(value)));
    }
    case 'integer':
      return z.number().int().min(spec.min).max(spec.max);
    case 'price_level':
      return z.number().int().min(1).max(4);
    case 'url':
      return z
        .string()
        .max(2048)
        .transform((value, context) => {
          const url = canonicalUrl(spec, value);
          if (url === undefined) {
            context.addIssue({ code: 'custom', message: 'must be a link to this service, or a handle on it' });
            return z.NEVER;
          }
          return url;
        });
    case 'text': {
      const text = z.string().trim().min(1).max(spec.maxLength);
      return spec.pattern ? text.regex(spec.pattern) : text;
    }
  }
}

/** The value schema of a registered key. */
export function capabilityValueSchemaFor(key: CapabilityKey): z.ZodType<CapabilityValue, unknown> {
  return capabilityValueSpecSchema(CAPABILITY_DEFINITIONS[key].value);
}

/**
 * Whether a VALUE says the place has the capability.
 *
 * `false`, `0`, `''` and `[]` never do. Beyond that it is the key's to say: an
 * enum value listed in `absent` (`wheelchair = no`) is an assertion that the
 * place does NOT have it. The same rule the `?capabilities=` filter applies
 * server-side.
 */
export function capabilityHolds(key: string, value: CapabilityValue): boolean {
  if (value === false || value === 0 || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  const spec = capabilityDefinition(key)?.value;
  if (spec?.kind === 'enum' && typeof value === 'string' && spec.absent?.includes(value)) return false;
  return true;
}

/**
 * Every `(key, value)` pair that is asserted but does not hold — the enum
 * values named `absent`. For the SQL half of {@link capabilityHolds}.
 */
export const ABSENT_CAPABILITY_VALUES: readonly (readonly [CapabilityKey, string])[] = CAPABILITY_KEYS.flatMap(
  (key) => {
    const spec: CapabilityValueSpec = CAPABILITY_DEFINITIONS[key].value;
    return spec.kind === 'enum' ? (spec.absent ?? []).map((value) => [key, value] as const) : [];
  },
);

// ── Filters ─────────────────────────────────────────────────────────────────

/** A registered key as a request names it — in a path, or as a bare filter. */
export const capabilityKeySchema = z.enum(CAPABILITY_KEYS);

/**
 * One `?capabilities=` entry: a key, or a key and a value.
 *
 * `payments.faircoin.accepted` matches a place whose strongest assertion of
 * the key holds. `food.cuisine:italian` matches one whose strongest cuisine
 * assertion includes `italian`; `accessibility.wheelchair:limited` one whose
 * strongest wheelchair assertion IS `limited`; `price.level:2` one priced at 2.
 * A value is accepted only for an enum, an enum set or a price level, and
 * only when the key's schema accepts it.
 */
export interface CapabilityFilter {
  key: CapabilityKey;
  /** The value to match, typed as the key stores it. */
  value?: string | number;
}

/** A filter string read into its parts, or `undefined` when it is not one. */
export function capabilityFilterOf(raw: string): CapabilityFilter | undefined {
  const separator = raw.indexOf(':');
  const key = separator < 0 ? raw : raw.slice(0, separator);
  if (!isCapabilityKey(key)) return undefined;
  if (separator < 0) return { key };

  const text = raw.slice(separator + 1);
  const spec: CapabilityValueSpec = CAPABILITY_DEFINITIONS[key].value;
  if ((spec.kind === 'enum' || spec.kind === 'enum_set') && Object.prototype.hasOwnProperty.call(spec.values, text)) {
    return { key, value: text };
  }
  if (spec.kind === 'price_level' && /^[1-4]$/.test(text)) return { key, value: Number(text) };
  return undefined;
}

/**
 * A filter as a query carries it. Stays a STRING — the SDK sends what this
 * schema outputs — and the server reads it with {@link capabilityFilterOf}.
 */
export const capabilityFilterSchema = z
  .string()
  .max(256)
  .refine((raw) => capabilityFilterOf(raw) !== undefined, {
    message: 'must be a registered capability key, optionally with :value for an enum or a price level',
  });
