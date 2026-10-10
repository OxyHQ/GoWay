/**
 * How Mercaria's answer about a place is decided on and put into words.
 *
 * Pure, so the rules that matter — when GoWay asks at all, and how a shelf's
 * stock reads — are tested without a renderer.
 */
import { placeHasCapability, type Place } from '@goway.to/sdk';
import type {
  MercariaLocationAvailability,
  MercariaLocationProduct,
  MercariaMoney,
} from '@mercaria.co/sdk';

import { deviceLocale, type MessageValues } from '@/lib/i18n';

/**
 * The app's message lookup — `useTranslation().t` in a component. Taken as an
 * argument so these stay pure: the words are `lib/messages/products.ts`'s, in
 * the reader's language, and the rules are tested here without a renderer.
 */
export type Translate = (key: string, values?: MessageValues) => string;

/**
 * The `.one` or `.other` form of a counted message. Enough for every locale
 * the app's message tables carry (`en`, `es`); a language with more plural
 * forms adds them here first.
 */
export function pluralKey(base: string, count: number): string {
  return `${base}.${count === 1 ? 'one' : 'other'}`;
}

/** The capability a place asserts when a Mercaria location trades from it. Its value is the location id. */
export const MERCARIA_STORE_CAPABILITY = 'commerce.mercaria.store';

/**
 * Whether to ask Mercaria about this place at all.
 *
 * The capability is a HINT, and only a hint: anybody signed in can report it,
 * so it never decides what is shown. Mercaria's answer does — it lists a
 * location only while the place names it back at the business's tier or
 * GoWay's, and re-checks that against GoWay on every read. Which tier counts is
 * Mercaria's rule, so it is not restated here; a place with only a community
 * report costs one request that answers an empty page. What the hint buys is
 * that the many places with no store link never send one.
 */
export function placeOffersMercariaStore(place: Pick<Place, 'capabilities'>): boolean {
  return placeHasCapability(place, MERCARIA_STORE_CAPABILITY);
}

/** The message for each availability. Never only a colour: the badge carries these words. */
export const AVAILABILITY_MESSAGES: Readonly<Record<MercariaLocationAvailability, string>> = {
  in_stock: 'products.availability.in_stock',
  low_stock: 'products.availability.low_stock',
  out_of_stock: 'products.availability.out_of_stock',
};

/** How loudly each availability is badged — redundant emphasis over the words above. */
export const AVAILABILITY_TONES: Readonly<
  Record<MercariaLocationAvailability, 'success' | 'warning' | 'default'>
> = {
  in_stock: 'success',
  low_stock: 'warning',
  out_of_stock: 'default',
};

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * "Stock confirmed 20 minutes ago".
 *
 * Finer than a review's age, because a shelf moves in hours: a count is only
 * worth something inside the shop's own confirmation interval, and "today"
 * would hide the difference between this morning and a minute ago.
 */
export function stockConfirmedAge(
  confirmedAt: string,
  t: Translate,
  now: number = Date.now(),
): string {
  const elapsed = Math.max(0, now - Date.parse(confirmedAt));
  if (elapsed < MINUTE_MS) return t('products.confirmed.now');
  const [unit, count] =
    elapsed < HOUR_MS
      ? (['minutes', Math.floor(elapsed / MINUTE_MS)] as const)
      : elapsed < DAY_MS
        ? (['hours', Math.floor(elapsed / HOUR_MS)] as const)
        : (['days', Math.floor(elapsed / DAY_MS)] as const);
  return t(pluralKey(`products.confirmed.${unit}`, count), { count });
}

export interface StockPresentation {
  /** "In stock" / "Low stock" / "Out of stock". */
  label: string;
  tone: (typeof AVAILABILITY_TONES)[MercariaLocationAvailability];
  /** "3 left", only where the merchant discloses the count. */
  quantity: string | null;
  /** "Stock confirmed 20 minutes ago". */
  confirmed: string;
}

/**
 * One product's stock at one location, in words.
 *
 * `exactQuantity` is present only where the merchant chose to disclose it and
 * the count is fresh, so its absence is the normal case and says nothing. A
 * stale count already reads `out_of_stock` with no number — Mercaria decides
 * that, and this never second-guesses it.
 */
export function presentStock(
  item: Pick<MercariaLocationProduct, 'availability' | 'exactQuantity' | 'stockConfirmedAt'>,
  t: Translate,
  now: number = Date.now(),
): StockPresentation {
  const disclosed =
    item.exactQuantity !== undefined && item.availability !== 'out_of_stock'
      ? item.exactQuantity
      : null;
  return {
    label: t(AVAILABILITY_MESSAGES[item.availability]),
    tone: AVAILABILITY_TONES[item.availability],
    quantity:
      disclosed === null
        ? null
        : t(pluralKey('products.quantity', disclosed), { count: disclosed }),
    confirmed: stockConfirmedAge(item.stockConfirmedAt, t, now),
  };
}

/** FAIR is not an ISO-4217 code, so `Intl` cannot format it; Mercaria gives it eight decimals and `⊜`. */
const FAIR_DECIMALS = 8;
const FAIR_SYMBOL = '⊜';

/**
 * A Mercaria price — integer minor units in the listing's NATIVE currency — as
 * text. Nothing is converted: Mercaria serves no other currency, and inventing
 * one here would be a price nobody can pay.
 */
export function formatMercariaPrice(money: MercariaMoney, locale: string = deviceLocale()): string {
  if (money.currency === 'FAIR') {
    const units = money.amount / 10 ** FAIR_DECIMALS;
    return `${FAIR_SYMBOL} ${new Intl.NumberFormat(locale, { maximumFractionDigits: FAIR_DECIMALS }).format(units)}`;
  }
  const format = new Intl.NumberFormat(locale, { style: 'currency', currency: money.currency });
  const decimals = format.resolvedOptions().maximumFractionDigits ?? 2;
  return format.format(money.amount / 10 ** decimals);
}

/** One product tile, as one spoken sentence. */
export function spokenProduct(
  item: MercariaLocationProduct,
  t: Translate,
  now: number = Date.now(),
  locale: string = deviceLocale(),
): string {
  const stock = presentStock(item, t, now);
  return [
    item.product.title,
    formatMercariaPrice(item.product.price, locale),
    stock.label,
    stock.quantity,
    stock.confirmed,
  ]
    .filter(Boolean)
    .join(', ');
}
