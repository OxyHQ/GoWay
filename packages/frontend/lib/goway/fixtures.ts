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
 *  - categories spread across the three zoom tiers in `categories.ts`, so
 *    zoom-dependent visibility and clustering have something to do;
 *  - one `closed` place, because a lifecycle state other than `active` must
 *    render as itself rather than vanish.
 */
import type { Place, PlaceCapability, PlaceStatus } from '@goway.to/sdk';

const DAY_MS = 86_400_000;
/** Fixed at module load so a session's relative timestamps stay consistent. */
const NOW = Date.now();

const daysAgo = (days: number): string => new Date(NOW - days * DAY_MS).toISOString();

interface CapabilitySeed {
  key: string;
  value?: boolean | string | number;
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
  name: string;
  latitude: number;
  longitude: number;
  categories: string[];
  status?: PlaceStatus;
  verification?: Place['verification']['state'];
  street?: string;
  houseNumber?: string;
  locality?: string;
  phone?: string;
  website?: string;
  /** `[day, opens, closes]` triples; the timezone is Barcelona's throughout. */
  hours?: Array<[0 | 1 | 2 | 3 | 4 | 5 | 6, string, string]>;
  capabilities?: CapabilitySeed[];
  osmId?: string;
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
    createdAt: daysAgo(420),
    updatedAt: daysAgo(6),
  };

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
      timezone: 'Europe/Madrid',
    };
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
    latitude: 41.3817,
    longitude: 2.1716,
    categories: ['grocery', 'shop'],
    verification: 'oxy_verified',
    street: 'La Rambla',
    houseNumber: '91',
    locality: 'El Raval',
    phone: '+34934132303',
    website: 'https://www.boqueria.barcelona',
    hours: [...weekdays('08:00', '20:30'), [6, '08:00', '20:30']],
    osmId: 'way/25336101',
    capabilities: [
      { key: 'payments.faircoin.accepted', verification: 'oxy_verified', daysAgo: 9 },
      { key: 'commerce.mercaria.store', verification: 'business_asserted', daysAgo: 55 },
    ],
  }),
  place({
    id: 'gw_parc_ciutadella',
    name: 'Parc de la Ciutadella',
    latitude: 41.3881,
    longitude: 2.1871,
    categories: ['park'],
    verification: 'community_reviewed',
    street: 'Passeig de Picasso',
    locality: 'Sant Pere',
    osmId: 'way/4229243',
  }),
  place({
    id: 'gw_museu_picasso',
    name: 'Museu Picasso',
    latitude: 41.3851,
    longitude: 2.1806,
    categories: ['museum'],
    verification: 'oxy_verified',
    street: "Carrer de Montcada",
    houseNumber: '15-23',
    locality: 'El Born',
    phone: '+34932563000',
    website: 'museupicasso.bcn.cat',
    hours: [[2, '10:00', '19:00'], [3, '10:00', '19:00'], [4, '10:00', '19:00'], [5, '10:00', '19:00'], [6, '10:00', '20:00'], [0, '10:00', '20:00']],
    osmId: 'way/34633854',
  }),
  place({
    id: 'gw_hospital_clinic',
    name: 'Hospital Clínic',
    latitude: 41.3893,
    longitude: 2.1516,
    categories: ['hospital'],
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
    categories: ['transit_station'],
    locality: 'Ciutat Vella',
    osmId: 'node/1725079123',
  }),
  place({
    id: 'gw_metro_jaume_i',
    name: 'Jaume I',
    latitude: 41.3836,
    longitude: 2.1780,
    categories: ['transit_station'],
    locality: 'Ciutat Vella',
    osmId: 'node/1725079221',
  }),
  place({
    id: 'gw_bicing_born',
    name: 'Bicing — Passeig del Born',
    latitude: 41.3846,
    longitude: 2.1824,
    categories: ['bicycle_rental'],
    locality: 'El Born',
    capabilities: [{ key: 'mobility.moovo.pickup', verification: 'external_source', daysAgo: 21 }],
  }),
  place({
    id: 'gw_cafe_el_magnifico',
    name: 'Cafès El Magnífico',
    latitude: 41.3843,
    longitude: 2.1811,
    categories: ['cafe'],
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
    ],
  }),
  place({
    id: 'gw_bar_marsella',
    name: 'Bar Marsella',
    latitude: 41.3790,
    longitude: 2.1697,
    categories: ['bar'],
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
    categories: ['bakery'],
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
    categories: ['bookshop', 'shop'],
    street: 'Passatge de Pere Calders',
    houseNumber: '9',
    locality: 'Sant Antoni',
    website: 'www.instagram.com/llibreriacalders',
    hours: [...weekdays('10:00', '21:00')],
  }),
  place({
    id: 'gw_coworking_betahaus',
    name: 'Betahaus Barcelona',
    latitude: 41.3862,
    longitude: 2.1639,
    categories: ['coworking'],
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
    categories: ['pharmacy'],
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
    categories: ['restaurant'],
    verification: 'community_reviewed',
    street: 'Carrer de Sant Carles',
    houseNumber: '4',
    locality: 'La Barceloneta',
    phone: '+34932215012',
    hours: [[2, '13:00', '16:00'], [3, '13:00', '16:00'], [4, '13:00', '16:00'], [5, '13:00', '23:00'], [6, '13:00', '23:00']],
  }),
  place({
    id: 'gw_hotel_neri',
    name: 'Hotel Neri',
    latitude: 41.3833,
    longitude: 2.1755,
    categories: ['hotel'],
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
    categories: ['bank'],
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
    latitude: 41.3870,
    longitude: 2.1769,
    categories: ['grocery', 'shop'],
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
    categories: ['cafe'],
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
    categories: ['park'],
    locality: "L'Eixample",
    osmId: 'way/25984122',
  }),
  place({
    id: 'gw_botiga_tancada',
    name: 'La Botiga del Raval',
    latitude: 41.3801,
    longitude: 2.1669,
    categories: ['shop'],
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
    categories: ['civic'],
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
    categories: ['transit_station', 'bicycle_rental'],
    locality: 'Sants',
    capabilities: [{ key: 'mobility.moovo.pickup', verification: 'oxy_verified', daysAgo: 1 }],
  }),
];

/** Every fixture place keyed by its GoWay Place ID. */
export const FIXTURE_PLACES_BY_ID: ReadonlyMap<string, Place> = new Map(
  FIXTURE_PLACES.map((entry) => [entry.id, entry]),
);
