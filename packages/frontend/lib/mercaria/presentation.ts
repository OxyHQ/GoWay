/**
 * How Mercaria's answer about a place is decided on and put into words.
 *
 * Pure, so the rules that matter — when GoWay asks at all, and how a shelf's
 * stock reads — are tested without a renderer.
 */
import { placeHasCapability, type Place } from '@goway.to/sdk';
import type { MercariaLocationAvailability, MercariaLocationProduct, MercariaMoney } from '@mercaria.co/sdk';

import { deviceLocale } from '@/lib/i18n';

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

/** The word for each availability. Never only a colour: the badge carries this text. */
export const AVAILABILITY_LABELS: Readonly<Record<MercariaLocationAvailability, string>> = {
  in_stock: 'In stock',
  low_stock: 'Low stock',
  out_of_stock: 'Out of stock',
};

/** How loudly each availability is badged — redundant emphasis over the words above. */
export const AVAILABILITY_TONES: Readonly<Record<MercariaLocationAvailability, 'success' | 'warning' | 'default'>> = {
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
export function stockConfirmedAge(confirmedAt: string, now: number = Date.now()): string {
  const elapsed = Math.max(0, now - Date.parse(confirmedAt));
  if (elapsed < MINUTE_MS) return 'Stock confirmed just now';
  if (elapsed < HOUR_MS) {
    const minutes = Math.floor(elapsed / MINUTE_MS);
    return `Stock confirmed ${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  }
  if (elapsed < DAY_MS) {
    const hours = Math.floor(elapsed / HOUR_MS);
    return `Stock confirmed ${hours} hour${hours === 1 ? '' : 's'} ago`;
  }
  const days = Math.floor(elapsed / DAY_MS);
  return `Stock confirmed ${days} day${days === 1 ? '' : 's'} ago`;
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
export function presentStock(item: Pick<MercariaLocationProduct, 'availability' | 'exactQuantity' | 'stockConfirmedAt'>, now: number = Date.now()): StockPresentation {
  return {
    label: AVAILABILITY_LABELS[item.availability],
    tone: AVAILABILITY_TONES[item.availability],
    quantity: item.exactQuantity !== undefined && item.availability !== 'out_of_stock' ? `${item.exactQuantity} left` : null,
    confirmed: stockConfirmedAge(item.stockConfirmedAt, now),
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
export function spokenProduct(item: MercariaLocationProduct, now: number = Date.now(), locale: string = deviceLocale()): string {
  const stock = presentStock(item, now);
  return [item.product.title, formatMercariaPrice(item.product.price, locale), stock.label, stock.quantity, stock.confirmed]
    .filter(Boolean)
    .join(', ');
}
