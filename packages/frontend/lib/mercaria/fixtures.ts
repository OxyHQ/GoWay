/**
 * The Mercaria stand-in dataset, typed as Mercaria's real public contract.
 *
 * Like `lib/goway/fixtures.ts`: these are `@mercaria.co/sdk` values, served by
 * `mockTransport.ts` THROUGH the SDK's own parser, so a fixture that drifts
 * from the contract fails in development rather than on goway.to.
 *
 * Chosen for the states "Products at this store" has to render, not to look
 * full:
 *
 *  - the Boqueria is a market, so it carries TWO shop fronts — a stall that
 *    discloses exact stock and one that does not. Mercaria's place list holds
 *    at most one location today (a place names one location back); it is a
 *    page so a shared place changes nothing for a client, and this is the
 *    fixture that keeps that true;
 *  - every availability: in stock, low stock, and out of stock (which
 *    `inStock` filters out, as Mercaria does);
 *  - a price in FAIR, whose eight decimals a money formatter must not round
 *    to cents, and one in EUR;
 *  - Forn Baluard names a location only at the COMMUNITY tier, so it has none
 *    here: Mercaria lists a location only while its place names it back at the
 *    business's tier or GoWay's.
 *
 * No image or logo URL is invented: a fixture host would be a broken image,
 * and the tiles' no-image state is the one worth seeing locally.
 */
import { createMercariaClient, locationRef, productRef, storeRef } from '@mercaria.co/sdk';
import type {
  MercariaLocation,
  MercariaLocationAvailability,
  MercariaLocationProduct,
  MercariaLocationStore,
  MercariaMoney,
} from '@mercaria.co/sdk';

const MINUTE_MS = 60_000;
/** Fixed at module load so a session's relative timestamps stay consistent. */
const NOW = Date.now();
const minutesAgo = (minutes: number): string => new Date(NOW - minutes * MINUTE_MS).toISOString();

/** Mercaria's own link helpers, so a fixture URL is the string the server would send. */
const { links } = createMercariaClient();

function store(id: string, handle: string, name: string): MercariaLocationStore {
  return { ref: storeRef(id), handle, name, logoUrl: null };
}

function location(
  id: string,
  goWayPlaceId: string,
  owner: MercariaLocationStore,
  pickup: boolean,
): MercariaLocation {
  return {
    ref: locationRef(id),
    goWayPlaceId,
    store: owner,
    pickup: pickup
      ? {
          identityRequirement: 'collection_code',
          paymentRequirement: 'prepaid',
          instructions: 'Ask at the counter.',
        }
      : null,
    discoverable: pickup,
    url: links.location(locationRef(id), owner),
  };
}

interface StockSeed {
  id: string;
  title: string;
  price: MercariaMoney;
  availability: MercariaLocationAvailability;
  exactQuantity?: number;
  confirmedMinutesAgo: number;
}

function stocked(owner: MercariaLocationStore, seed: StockSeed): MercariaLocationProduct {
  const ref = productRef(seed.id);
  return {
    product: {
      ref,
      title: seed.title,
      primaryImage: null,
      price: seed.price,
      compareAtPrice: null,
      priceRange: null,
      availability: seed.availability === 'out_of_stock' ? 'out_of_stock' : 'in_stock',
      condition: { key: 'new', group: 'new' },
      seller: {
        kind: 'store',
        store: owner.ref,
        handle: owner.handle,
        name: owner.name,
        logoUrl: owner.logoUrl,
      },
      url: links.product(ref),
    },
    availability: seed.availability,
    ...(seed.exactQuantity !== undefined ? { exactQuantity: seed.exactQuantity } : {}),
    stockConfirmedAt: minutesAgo(seed.confirmedMinutesAgo),
  };
}

const eur = (cents: number): MercariaMoney => ({ amount: cents, currency: 'EUR' });
const fair = (units: number): MercariaMoney => ({
  amount: Math.round(units * 1e8),
  currency: 'FAIR',
});

const FRUITES_SOLER = store('store_fruites_soler', 'fruites-soler', 'Fruites Soler');
const XARCUTERIA_JOAN = store('store_xarcuteria_joan', 'xarcuteria-joan', 'Xarcuteria Joan');

/** Mercaria's public locations, keyed by the GoWay place each trades from. */
export const MERCARIA_FIXTURE_LOCATIONS: ReadonlyMap<string, readonly MercariaLocation[]> = new Map(
  [
    [
      'gw_mercat_boqueria',
      [
        location('loc_boqueria_fruites_soler', 'gw_mercat_boqueria', FRUITES_SOLER, true),
        location('loc_boqueria_xarcuteria_joan', 'gw_mercat_boqueria', XARCUTERIA_JOAN, false),
      ],
    ],
  ],
);

/** What is on each location's shelf, in the store's own order. */
export const MERCARIA_FIXTURE_STOCK: ReadonlyMap<string, readonly MercariaLocationProduct[]> =
  new Map([
    [
      'loc_boqueria_fruites_soler',
      [
        stocked(FRUITES_SOLER, {
          id: 'prod_cireres',
          title: 'Cireres del Jerte, 500 g',
          price: eur(650),
          availability: 'in_stock',
          exactQuantity: 24,
          confirmedMinutesAgo: 35,
        }),
        stocked(FRUITES_SOLER, {
          id: 'prod_figues',
          title: 'Figues de coll de dama, safata',
          price: fair(1.25),
          availability: 'low_stock',
          exactQuantity: 3,
          confirmedMinutesAgo: 35,
        }),
        stocked(FRUITES_SOLER, {
          id: 'prod_maduixes',
          title: 'Maduixes del Maresme',
          price: eur(420),
          availability: 'out_of_stock',
          confirmedMinutesAgo: 60 * 26,
        }),
        stocked(FRUITES_SOLER, {
          id: 'prod_suc_taronja',
          title: 'Suc de taronja natural, 1 l',
          price: eur(390),
          availability: 'in_stock',
          exactQuantity: 12,
          confirmedMinutesAgo: 4,
        }),
      ],
    ],
    [
      'loc_boqueria_xarcuteria_joan',
      [
        stocked(XARCUTERIA_JOAN, {
          id: 'prod_fuet',
          title: 'Fuet de Vic',
          price: eur(595),
          availability: 'in_stock',
          confirmedMinutesAgo: 60 * 3,
        }),
        stocked(XARCUTERIA_JOAN, {
          id: 'prod_pernil',
          title: 'Pernil ibèric, 100 g tallat',
          price: eur(1190),
          availability: 'low_stock',
          confirmedMinutesAgo: 60 * 3,
        }),
      ],
    ],
  ]);
