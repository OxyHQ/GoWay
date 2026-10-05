/**
 * The stand-in dataset, typed as the real contract.
 *
 * There is no GoWay backend running yet, and the map discovery experience is
 * not something that can be designed against an empty list. So these are real
 * `Place` values from `@goway.to/sdk` — not a bespoke "MockPlace" shape — and
 * `mockTransport.ts` serves them THROUGH the SDK's own parser. Anything here
 * that does not satisfy the published contract fails at the SDK boundary, in
 * development, rather than turning into a UI that the real API cannot feed.
 *
 * The set is chosen to exercise the states issue #7 requires rather than to
 * look impressive:
 *
 *  - places with full metadata, and places with almost none (`plaza-del-sol`,
 *    `fuente-canaletas`) — the "incomplete metadata" state is a fixture, not a
 *    hypothetical;
 *  - capabilities at all four verification levels, including a deliberately
 *    ANCIENT FairCoin report (`bar-marsella`) so the staleness rule is visible;
 *  - categories from the taxonomy ({@link FIXTURE_CATEGORIES}), spread across
 *    the three zoom tiers in `categories.ts`, so zoom-dependent visibility and
 *    clustering have something to do;
 *  - typed capabilities in every group — accessibility, payment, amenities,
 *    cuisine, price, social — so the grouped list has sections to draw;
 *  - dated hours exceptions, relative to today, so "closed today" and an
 *    upcoming holiday both render;
 *  - one `closed` place, because a lifecycle state other than `active` must
 *    render as itself rather than vanish;
 *  - descriptions (one translated, one not), galleries with a logo, and
 *    reviews with a business reply — on a few places only, so a place with
 *    none of them is the common case it is.
 */
import type {
  CapabilityKey,
  Category,
  CategoryIcon,
  Place,
  PlaceCapability,
  PlaceHoursException,
  PlaceMedia,
  PlaceReview,
} from '@goway.to/sdk';

const DAY_MS = 86_400_000;
/** Fixed at module load so a session's relative timestamps stay consistent. */
const NOW = Date.now();

const daysAgo = (days: number): string => new Date(NOW - days * DAY_MS).toISOString();
/** A calendar date `days` from today, `YYYY-MM-DD`. */
const dateIn = (days: number): string => new Date(NOW + days * DAY_MS).toISOString().slice(0, 10);

function category(key: string, icon: CategoryIcon, en: string, es: string): Category {
  const separator = key.lastIndexOf('.');
  return {
    key,
    parent: separator < 0 ? null : key.slice(0, separator),
    icon,
    status: 'active',
    // `GET /categories` resolves this per `locale`; `mockTransport` does too.
    label: en,
    labels: { en, es },
  };
}

/**
 * The slice of GoWay's category taxonomy the fixtures need — what
 * `GET /categories` answers in fixture mode.
 *
 * NOT a copy of the taxonomy: that lives in GoWay's database and changes
 * without an app release. It is the shortcut roots, every key a fixture place
 * carries, and those keys' parents, labelled as the server labels them, in the
 * server's order (depth-first, siblings by position).
 */
export const FIXTURE_CATEGORIES: readonly Category[] = [
  category('food', 'restaurant', 'Food & drink', 'Comida y bebida'),
  category('food.restaurant', 'restaurant', 'Restaurant', 'Restaurante'),
  category('food.cafe', 'cafe', 'Café', 'Cafetería'),
  category('food.bar', 'bar', 'Bar', 'Bar'),
  category('food.bakery', 'bakery', 'Bakery', 'Panadería'),
  category('shop', 'shop', 'Shops', 'Tiendas'),
  category('shop.marketplace', 'grocery', 'Market', 'Mercado'),
  category('shop.books', 'book', 'Bookshop', 'Librería'),
  category('shop.clothes', 'clothing', 'Clothes', 'Ropa'),
  category('lodging', 'hotel', 'Stay', 'Alojamiento'),
  category('lodging.hotel', 'hotel', 'Hotel', 'Hotel'),
  category('leisure', 'park', 'Leisure', 'Ocio'),
  category('leisure.park', 'park', 'Park', 'Parque'),
  category('culture', 'museum', 'Culture & sights', 'Cultura y turismo'),
  category('culture.museum', 'museum', 'Museum', 'Museo'),
  category('transport', 'subway', 'Transport', 'Transporte'),
  category('transport.rail_station', 'train', 'Train station', 'Estación de tren'),
  category('transport.bicycle_rental', 'bike', 'Bike hire', 'Alquiler de bicicletas'),
  category('health', 'health', 'Health', 'Salud'),
  category('health.hospital', 'hospital', 'Hospital', 'Hospital'),
  category('health.pharmacy', 'pharmacy', 'Pharmacy', 'Farmacia'),
  category('education', 'school', 'Education', 'Educación'),
  category('education.school', 'school', 'School', 'Escuela'),
  category('civic', 'civic', 'Public services', 'Servicios públicos'),
  category('finance', 'bank', 'Money', 'Dinero'),
  category('finance.bank', 'bank', 'Bank', 'Banco'),
  category('office', 'office', 'Offices', 'Oficinas'),
  category('office.coworking', 'office', 'Coworking', 'Coworking'),
];

interface CapabilitySeed {
  key: CapabilityKey;
  value?: PlaceCapability['value'];
  verification: PlaceCapability['verification'];
  daysAgo: number;
}

function capability(seed: CapabilitySeed): PlaceCapability {
  const lastDot = seed.key.lastIndexOf('.');
  return {
    namespace: seed.key.slice(0, lastDot),
    capability: seed.key.slice(lastDot + 1),
    key: seed.key,
    value: seed.value ?? true,
    verification: seed.verification,
    observedAt: daysAgo(seed.daysAgo),
  };
}

interface PlaceSeed {
  id: string;
  /** The DEFAULT name — Catalan here, because that is what the sign says. */
  name: string;
  /**
   * `{ language: name }` for the other languages this place is known by.
   *
   * Only on the handful of places that really do have a widely-used exonym.
   * Translating every fixture would be inventing facts, which is the same
   * defect as a fabricated route — and it would also hide the case that
   * matters, where GoWay has NO name in the reader's language and has to fall
   * back to the default.
   */
  names?: Record<string, string>;
  latitude: number;
  longitude: number;
  categories: string[];
  status?: Place['status'];
  verification?: Place['verification']['state'];
  street?: string;
  houseNumber?: string;
  locality?: string;
  phone?: string;
  website?: string;
  /** `[day, opens, closes]` triples; the timezone is Barcelona's throughout. */
  hours?: Array<[0 | 1 | 2 | 3 | 4 | 5 | 6, string, string]>;
  capabilities?: CapabilitySeed[];
  /** `[fromToday, days, closed-or-hours, note]` — dated exceptions to the week. */
  exceptions?: Array<{ in: number; days?: number; hours?: [string, string]; note?: string; verification: PlaceHoursException['verification'] }>;
  osmId?: string;
  /** The default-language description, and GoWay's translations of it. */
  description?: string;
  descriptions?: Record<string, string>;
  /** The Oxy file of the place's logo — one of its `logo` gallery items. */
  logoFileId?: string;
}

function place(seed: PlaceSeed): Place {
  const built: Place = {
    id: seed.id,
    name: seed.name,
    location: { latitude: seed.latitude, longitude: seed.longitude },
    categories: seed.categories,
    status: seed.status ?? 'active',
    verification: {
      state: seed.verification ?? 'unverified',
      ...(seed.verification && seed.verification !== 'unverified'
        ? { verifiedAt: daysAgo(40) }
        : {}),
    },
    sources: seed.osmId
      ? [{ source: 'openstreetmap', sourceId: seed.osmId, observedAt: daysAgo(12) }]
      : [{ source: 'goway', sourceId: seed.id, observedAt: daysAgo(3) }],
    capabilities: (seed.capabilities ?? []).map(capability),
    // GoWay derives the zone from the position; every fixture is in Barcelona.
    timezone: 'Europe/Madrid',
    createdAt: daysAgo(420),
    updatedAt: daysAgo(6),
  };

  if (seed.names) {
    built.names = Object.entries(seed.names).map(([language, name]) => ({
      language,
      name,
      source: 'openstreetmap' as const,
    }));
  }

  if (seed.street || seed.locality) {
    built.address = {
      ...(seed.houseNumber ? { houseNumber: seed.houseNumber } : {}),
      ...(seed.street ? { street: seed.street } : {}),
      ...(seed.locality ? { locality: seed.locality } : {}),
      city: 'Barcelona',
      region: 'Catalonia',
      countryCode: 'ES',
      country: 'Spain',
    };
  }
  if (seed.phone || seed.website) {
    built.contact = {
      ...(seed.phone ? { phone: seed.phone } : {}),
      ...(seed.website ? { website: seed.website } : {}),
    };
  }
  if (seed.hours) {
    built.openingHours = {
      intervals: seed.hours.map(([day, opens, closes]) => ({ day, opens, closes })),
    };
  }
  if (seed.description) built.description = seed.description;
  if (seed.description || seed.descriptions) {
    built.descriptions = Object.entries(seed.descriptions ?? {}).map(([language, description]) => ({
      language,
      description,
      source: 'goway',
    }));
  }
  if (seed.logoFileId) built.logoFileId = seed.logoFileId;
  if (seed.exceptions) {
    built.hoursExceptions = seed.exceptions.map((exception, index) => ({
      id: `${seed.id}_exception_${index}`,
      placeId: seed.id,
      startsOn: dateIn(exception.in),
      endsOn: dateIn(exception.in + (exception.days ?? 1) - 1),
      closed: exception.hours === undefined,
      intervals: exception.hours ? [{ opens: exception.hours[0], closes: exception.hours[1] }] : [],
      ...(exception.note ? { note: exception.note } : {}),
      source: 'goway',
      verification: exception.verification,
      observedAt: daysAgo(2),
    }));
  }
  return built;
}

/** Monday–Friday, then Saturday, at the same times. */
const weekdays = (opens: string, closes: string): Array<[0 | 1 | 2 | 3 | 4 | 5 | 6, string, string]> =>
  ([1, 2, 3, 4, 5] as const).map((day) => [day, opens, closes] as [1 | 2 | 3 | 4 | 5, string, string]);

export const FIXTURE_PLACES: readonly Place[] = [
  place({
    id: 'gw_mercat_boqueria',
    name: 'Mercat de la Boqueria',
    names: { es: 'Mercado de La Boquería', en: 'La Boqueria Market' },
    latitude: 41.3817,
    longitude: 2.1716,
    categories: ['shop.marketplace'],
    verification: 'oxy_verified',
    street: 'La Rambla',
    houseNumber: '91',
    locality: 'El Raval',
    phone: '+34934132303',
    website: 'https://www.boqueria.barcelona',
    hours: [...weekdays('08:00', '20:30'), [6, '08:00', '20:30']],
    osmId: 'way/25336101',
    description: "El mercat més antic de la ciutat: parades de fruita, peix, embotits i taulells on menjar a peu dret.",
    descriptions: {
      es: 'El mercado más antiguo de la ciudad: puestos de fruta, pescado, embutidos y barras donde comer de pie.',
      en: "The city's oldest market: fruit, fish and charcuterie stalls, and counters to eat at standing up.",
    },
    logoFileId: 'fixture-file-boqueria-logo',
    exceptions: [{ in: 3, note: 'Public holiday', verification: 'business_asserted' }],
    capabilities: [
      { key: 'payments.faircoin.accepted', verification: 'oxy_verified', daysAgo: 9 },
      { key: 'commerce.mercaria.store', verification: 'business_asserted', daysAgo: 55 },
      { key: 'accessibility.wheelchair', value: 'limited', verification: 'community_reported', daysAgo: 30 },
      { key: 'payments.cash', verification: 'external_source', daysAgo: 12 },
      { key: 'payments.cards', verification: 'external_source', daysAgo: 12 },
    ],
  }),
  place({
    id: 'gw_parc_ciutadella',
    name: 'Parc de la Ciutadella',
    names: { es: 'Parque de la Ciudadela', en: 'Ciutadella Park' },
    latitude: 41.3881,
    longitude: 2.1871,
    categories: ['leisure.park'],
    verification: 'community_reviewed',
    street: 'Passeig de Picasso',
    locality: 'Sant Pere',
    osmId: 'way/4229243',
  }),
  place({
    id: 'gw_museu_picasso',
    name: 'Museu Picasso',
    names: { es: 'Museo Picasso', en: 'Picasso Museum', fr: 'Musée Picasso' },
    latitude: 41.3851,
    longitude: 2.1806,
    categories: ['culture.museum'],
    verification: 'oxy_verified',
    street: "Carrer de Montcada",
    houseNumber: '15-23',
    locality: 'El Born',
    phone: '+34932563000',
    website: 'museupicasso.bcn.cat',
    hours: [[2, '10:00', '19:00'], [3, '10:00', '19:00'], [4, '10:00', '19:00'], [5, '10:00', '19:00'], [6, '10:00', '20:00'], [0, '10:00', '20:00']],
    osmId: 'way/34633854',
    description: "Més de 4.000 obres de Picasso en cinc palaus medievals del carrer de Montcada.",
    capabilities: [
      { key: 'accessibility.wheelchair', value: 'yes', verification: 'external_source', daysAgo: 12 },
      { key: 'accessibility.toilets_wheelchair', verification: 'external_source', daysAgo: 12 },
      { key: 'accessibility.hearing_loop', verification: 'business_asserted', daysAgo: 70 },
    ],
    exceptions: [
      { in: 0, hours: ['10:00', '15:00'], note: 'Reduced hours', verification: 'business_asserted' },
      { in: 20, days: 2, verification: 'business_asserted', note: 'Installing an exhibition' },
    ],
  }),
  place({
    id: 'gw_hospital_clinic',
    name: 'Hospital Clínic',
    names: { es: 'Hospital Clínico', en: 'Hospital Clinic' },
    latitude: 41.3893,
    longitude: 2.1516,
    categories: ['health.hospital'],
    verification: 'oxy_verified',
    street: "Carrer de Villarroel",
    houseNumber: '170',
    locality: "L'Eixample",
    phone: '+34932275400',
    osmId: 'way/23090271',
  }),
  place({
    id: 'gw_metro_liceu',
    name: 'Liceu',
    latitude: 41.3803,
    longitude: 2.1735,
    categories: ['transport.rail_station'],
    locality: 'Ciutat Vella',
    osmId: 'node/1725079123',
  }),
  place({
    id: 'gw_metro_jaume_i',
    name: 'Jaume I',
    latitude: 41.3836,
    longitude: 2.1780,
    categories: ['transport.rail_station'],
    locality: 'Ciutat Vella',
    osmId: 'node/1725079221',
  }),
  place({
    id: 'gw_bicing_born',
    name: 'Bicing — Passeig del Born',
    latitude: 41.3846,
    longitude: 2.1824,
    categories: ['transport.bicycle_rental'],
    locality: 'El Born',
    capabilities: [{ key: 'mobility.moovo.pickup', verification: 'external_source', daysAgo: 21 }],
  }),
  place({
    id: 'gw_cafe_el_magnifico',
    name: 'Cafès El Magnífico',
    latitude: 41.3843,
    longitude: 2.1811,
    categories: ['food.cafe'],
    verification: 'owner_verified',
    street: "Carrer de l'Argenteria",
    houseNumber: '64',
    locality: 'El Born',
    phone: '+34933193975',
    website: 'https://cafeselmagnifico.com',
    hours: [...weekdays('09:00', '20:00'), [6, '10:00', '20:00']],
    capabilities: [
      { key: 'payments.faircoin.accepted', verification: 'business_asserted', daysAgo: 4 },
      { key: 'social.mention.location', verification: 'oxy_verified', daysAgo: 2 },
      { key: 'payments.contactless', verification: 'business_asserted', daysAgo: 4 },
      { key: 'amenities.wifi', verification: 'business_asserted', daysAgo: 4 },
      { key: 'amenities.takeaway', verification: 'business_asserted', daysAgo: 4 },
      { key: 'food.diet', value: ['vegan', 'gluten_free'], verification: 'community_reported', daysAgo: 40 },
      { key: 'social.instagram', value: 'https://www.instagram.com/cafeselmagnifico', verification: 'business_asserted', daysAgo: 4 },
    ],
  }),
  place({
    id: 'gw_bar_marsella',
    name: 'Bar Marsella',
    latitude: 41.3790,
    longitude: 2.1697,
    categories: ['food.bar'],
    street: 'Carrer de Sant Pau',
    houseNumber: '65',
    locality: 'El Raval',
    hours: [[4, '22:00', '02:30'], [5, '22:00', '02:30'], [6, '22:00', '02:30']],
    osmId: 'node/301188112',
    capabilities: [
      // Deliberately ancient: this is the claim the freshness rule must demote.
      { key: 'payments.faircoin.accepted', verification: 'community_reported', daysAgo: 790 },
    ],
  }),
  place({
    id: 'gw_forn_baluard',
    name: 'Baluard Barceloneta',
    latitude: 41.3789,
    longitude: 2.1893,
    categories: ['food.bakery'],
    street: 'Carrer del Baluard',
    houseNumber: '38',
    locality: 'La Barceloneta',
    hours: [...weekdays('08:00', '21:00'), [6, '08:00', '21:00']],
    capabilities: [{ key: 'commerce.mercaria.store', verification: 'community_reported', daysAgo: 130 }],
  }),
  place({
    id: 'gw_llibreria_calders',
    name: 'Llibreria Calders',
    latitude: 41.3795,
    longitude: 2.1620,
    categories: ['shop.books'],
    street: 'Passatge de Pere Calders',
    houseNumber: '9',
    locality: 'Sant Antoni',
    website: 'www.instagram.com/llibreriacalders',
    hours: [...weekdays('10:00', '21:00')],
    capabilities: [
      { key: 'social.instagram', value: 'https://www.instagram.com/llibreriacalders', verification: 'external_source', daysAgo: 12 },
    ],
  }),
  place({
    id: 'gw_coworking_betahaus',
    name: 'Betahaus Barcelona',
    latitude: 41.3862,
    longitude: 2.1639,
    categories: ['office.coworking'],
    verification: 'owner_verified',
    street: "Carrer de Vilafranca",
    houseNumber: '7',
    locality: 'Gràcia',
    website: 'https://betahaus.bcn',
    hours: weekdays('08:30', '20:00'),
    capabilities: [
      { key: 'payments.faircoin.accepted', verification: 'oxy_verified', daysAgo: 16 },
      { key: 'housing.homiio.listings', value: 4, verification: 'business_asserted', daysAgo: 30 },
    ],
  }),
  place({
    id: 'gw_farmacia_gracia',
    name: 'Farmàcia Gran de Gràcia',
    latitude: 41.4023,
    longitude: 2.1552,
    categories: ['health.pharmacy'],
    street: 'Gran de Gràcia',
    houseNumber: '130',
    locality: 'Gràcia',
    phone: '+34932178965',
    hours: [...weekdays('09:00', '21:00'), [6, '09:00', '14:00']],
  }),
  place({
    id: 'gw_restaurant_can_sole',
    name: 'Can Solé',
    latitude: 41.3771,
    longitude: 2.1875,
    categories: ['food.restaurant'],
    verification: 'community_reviewed',
    street: 'Carrer de Sant Carles',
    houseNumber: '4',
    locality: 'La Barceloneta',
    phone: '+34932215012',
    hours: [[2, '13:00', '16:00'], [3, '13:00', '16:00'], [4, '13:00', '16:00'], [5, '13:00', '23:00'], [6, '13:00', '23:00']],
    capabilities: [
      { key: 'food.cuisine', value: ['catalan', 'seafood'], verification: 'external_source', daysAgo: 12 },
      { key: 'price.level', value: 3, verification: 'community_reported', daysAgo: 90 },
      { key: 'amenities.outdoor_seating', verification: 'external_source', daysAgo: 12 },
      { key: 'amenities.reservations', verification: 'business_asserted', daysAgo: 20 },
      // The business's own `no` outranks the community's `yes`: no badge.
      { key: 'accessibility.wheelchair', value: 'yes', verification: 'community_reported', daysAgo: 100 },
      { key: 'accessibility.wheelchair', value: 'no', verification: 'business_asserted', daysAgo: 20 },
    ],
  }),
  place({
    id: 'gw_hotel_neri',
    name: 'Hotel Neri',
    latitude: 41.3833,
    longitude: 2.1755,
    categories: ['lodging.hotel'],
    street: 'Carrer de Sant Sever',
    houseNumber: '5',
    locality: 'Barri Gòtic',
    website: 'https://hotelneri.com',
    capabilities: [{ key: 'housing.homiio.listings', value: 12, verification: 'external_source', daysAgo: 45 }],
  }),
  place({
    id: 'gw_banc_sabadell_gotic',
    name: 'Banc Sabadell — Gòtic',
    latitude: 41.3821,
    longitude: 2.1770,
    categories: ['finance.bank'],
    street: 'Carrer de Ferran',
    houseNumber: '28',
    locality: 'Barri Gòtic',
    hours: weekdays('08:15', '14:30'),
  }),
  place({
    id: 'gw_plaza_del_sol',
    name: 'Plaça del Sol',
    latitude: 41.4013,
    longitude: 2.1565,
    // Deliberately bare: no address, no contact, no hours, no capabilities.
    // The "place with incomplete metadata" state, as data.
    categories: ['civic'],
    osmId: 'way/94812255',
  }),
  place({
    id: 'gw_fuente_canaletes',
    name: 'Font de Canaletes',
    latitude: 41.3862,
    longitude: 2.1699,
    categories: [],
    osmId: 'node/2266447114',
  }),
  place({
    id: 'gw_mercat_santa_caterina',
    name: 'Mercat de Santa Caterina',
    names: { es: 'Mercado de Santa Caterina' },
    latitude: 41.3870,
    longitude: 2.1769,
    categories: ['shop.marketplace'],
    verification: 'community_reviewed',
    street: "Avinguda de Francesc Cambó",
    houseNumber: '16',
    locality: 'Sant Pere',
    hours: [...weekdays('07:30', '20:00'), [6, '07:30', '15:00']],
    capabilities: [{ key: 'payments.faircoin.accepted', verification: 'community_reported', daysAgo: 62 }],
  }),
  place({
    id: 'gw_cafe_nomad',
    name: 'Nømad Coffee Lab',
    latitude: 41.3879,
    longitude: 2.1723,
    categories: ['food.cafe'],
    street: 'Passatge Sert',
    houseNumber: '12',
    locality: 'Sant Pere',
    hours: weekdays('09:00', '17:00'),
    capabilities: [{ key: 'payments.faircoin.accepted', verification: 'business_asserted', daysAgo: 11 }],
  }),
  place({
    id: 'gw_parc_joan_miro',
    name: 'Parc de Joan Miró',
    latitude: 41.3759,
    longitude: 2.1487,
    categories: ['leisure.park'],
    locality: "L'Eixample",
    osmId: 'way/25984122',
  }),
  place({
    id: 'gw_botiga_tancada',
    name: 'La Botiga del Raval',
    latitude: 41.3801,
    longitude: 2.1669,
    categories: ['shop.clothes'],
    status: 'closed',
    street: 'Carrer del Carme',
    houseNumber: '41',
    locality: 'El Raval',
  }),
  place({
    id: 'gw_escola_massana',
    name: 'Escola Massana',
    latitude: 41.3808,
    longitude: 2.1691,
    categories: ['education.school'],
    street: "Carrer de l'Hospital",
    houseNumber: '56',
    locality: 'El Raval',
    website: 'https://escolamassana.cat',
  }),
  place({
    id: 'gw_moovo_sants',
    name: 'Moovo — Sants Estació',
    latitude: 41.3791,
    longitude: 2.1400,
    categories: ['transport.bicycle_rental'],
    locality: 'Sants',
    capabilities: [{ key: 'mobility.moovo.pickup', verification: 'oxy_verified', daysAgo: 1 }],
  }),
];

interface MediaSeed {
  fileId: string;
  kind: PlaceMedia['kind'];
  caption?: string;
  verification?: PlaceMedia['verification'];
  attribution?: string;
  license?: string;
}

function gallery(placeId: string, seeds: readonly MediaSeed[]): PlaceMedia[] {
  return seeds.map((seed, position) => ({
    id: `${placeId}_media_${position}`,
    placeId,
    fileId: seed.fileId,
    kind: seed.kind,
    verification: seed.verification ?? 'community_reported',
    position,
    ...(seed.caption ? { caption: seed.caption } : {}),
    ...(seed.attribution ? { attribution: seed.attribution } : {}),
    ...(seed.license ? { license: seed.license } : {}),
    width: 1600,
    height: 1200,
    createdAt: daysAgo(30 - position),
  }));
}

/**
 * Each place's VISIBLE gallery, in order. The file ids are fixture ids, so
 * against Oxy's CDN they render nothing — which is exactly the case the
 * gallery must survive: an image that does not load is not drawn.
 */
export const FIXTURE_MEDIA: ReadonlyMap<string, readonly PlaceMedia[]> = new Map([
  [
    'gw_mercat_boqueria',
    gallery('gw_mercat_boqueria', [
      { fileId: 'fixture-file-boqueria-logo', kind: 'logo', verification: 'business_asserted' },
      { fileId: 'fixture-file-boqueria-entrance', kind: 'exterior', caption: 'The entrance on La Rambla' },
      { fileId: 'fixture-file-boqueria-stall', kind: 'interior', caption: 'Fruit stalls in the morning' },
      {
        fileId: 'fixture-file-boqueria-commons',
        kind: 'photo',
        verification: 'external_source',
        attribution: 'Wikimedia Commons contributor',
        license: 'CC BY-SA 4.0',
      },
    ]),
  ],
  [
    'gw_museu_picasso',
    gallery('gw_museu_picasso', [{ fileId: 'fixture-file-picasso-courtyard', kind: 'exterior', caption: 'The courtyard' }]),
  ],
]);

interface ReviewSeed {
  author: string;
  rating: number;
  title?: string;
  body?: string;
  locale?: string;
  daysAgo: number;
  reply?: string;
}

function reviews(placeId: string, seeds: readonly ReviewSeed[]): PlaceReview[] {
  return seeds.map((seed, index) => ({
    id: `${placeId}_review_${index}`,
    placeId,
    rating: seed.rating,
    ...(seed.title ? { title: seed.title } : {}),
    ...(seed.body ? { body: seed.body } : {}),
    ...(seed.locale ? { locale: seed.locale } : {}),
    authorOxyUserId: seed.author,
    createdAt: daysAgo(seed.daysAgo),
    ...(seed.reply ? { reply: { body: seed.reply, repliedAt: daysAgo(seed.daysAgo - 1) } } : {}),
  }));
}

/**
 * Each place's PUBLISHED reviews. The authors are fixture ids, so Oxy resolves
 * no profile for them — the anonymous-author state is the one a fixture shows.
 * `Place.rating` is derived from these by the fixture transport, as the API
 * derives it, rather than stated beside them where it could disagree.
 */
export const FIXTURE_REVIEWS: ReadonlyMap<string, readonly PlaceReview[]> = new Map([
  [
    'gw_mercat_boqueria',
    reviews('gw_mercat_boqueria', [
      { author: 'fixture-user-1', rating: 5, title: 'Unmissable', body: 'Go early, before the crowds. The juice stalls are worth it.', locale: 'en', daysAgo: 12, reply: 'Thank you! We open at 8.' },
      { author: 'fixture-user-2', rating: 3, body: 'Massa turístic al migdia, però el peix és excel·lent.', locale: 'ca', daysAgo: 40 },
      { author: 'fixture-user-3', rating: 4, daysAgo: 90 },
    ]),
  ],
  [
    'gw_museu_picasso',
    reviews('gw_museu_picasso', [
      { author: 'fixture-user-4', rating: 5, title: 'Las Meninas', body: 'La serie de Las Meninas justifica la visita.', locale: 'es', daysAgo: 5 },
    ]),
  ],
]);

/** Every fixture place keyed by its GoWay Place ID. */
export const FIXTURE_PLACES_BY_ID: ReadonlyMap<string, Place> = new Map(
  FIXTURE_PLACES.map((entry) => [entry.id, entry]),
);

/**
 * GoWay Place IDs GoWay once published and has since withdrawn.
 *
 * A withdrawn place is not a `Place` at all — `removed` is never a published
 * status — so these are ids, not records: `places.get` of one answers `gone`
 * (410), which is how a stale deep link reaches the "no longer on GoWay" state
 * rather than "we couldn't find it".
 */
export const FIXTURE_WITHDRAWN_PLACE_IDS: ReadonlySet<string> = new Set(['gw_forn_desaparegut']);
