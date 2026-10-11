/**
 * When GoWay asks Mercaria about a place, and how a shelf's stock reads.
 *
 * The availability words are the information — the badge's colour only
 * repeats them — so they are pinned here, with the count that appears only
 * where a merchant discloses it and the confirmation age that says how much
 * the word is worth.
 */
import { describe, expect, test } from 'bun:test';
import type { PlaceCapability } from '@goway.to/sdk';

import { formatMessage, type MessageValues } from '@/lib/i18n';
import { PRODUCTS_EN, PRODUCTS_ES } from '@/lib/messages/products';
import {
  formatMercariaPrice,
  MERCARIA_STORE_CAPABILITY,
  placeOffersMercariaStore,
  presentStock,
  spokenProduct,
  stockConfirmedAge,
  type Translate,
} from '@/lib/mercaria/presentation';
import { MERCARIA_FIXTURE_STOCK } from '@/lib/mercaria/fixtures';

/** What `useTranslation().t` does with one table: a missing key reads as itself, so a test sees it. */
const translator =
  (messages: Record<string, string>): Translate =>
  (key: string, values?: MessageValues) =>
    formatMessage(messages[key] ?? key, values);
const t = translator(PRODUCTS_EN);
const tEs = translator(PRODUCTS_ES);

const NOW = Date.parse('2026-10-05T12:00:00.000Z');
const minutesBefore = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();

function capability(
  key: string,
  value: PlaceCapability['value'],
  verification: PlaceCapability['verification'],
): PlaceCapability {
  const lastDot = key.lastIndexOf('.');
  return {
    namespace: key.slice(0, lastDot),
    capability: key.slice(lastDot + 1),
    key,
    value,
    verification,
    observedAt: minutesBefore(60 * 24 * 3),
  };
}

describe('the capability decides whether to ask, never what is shown', () => {
  test('a place naming a Mercaria location is asked about', () => {
    expect(
      placeOffersMercariaStore({
        capabilities: [capability(MERCARIA_STORE_CAPABILITY, 'loc_1', 'business_asserted')],
      }),
    ).toBe(true);
  });

  test('a community report is still asked about: which tier counts is Mercaria’s rule', () => {
    expect(
      placeOffersMercariaStore({
        capabilities: [capability(MERCARIA_STORE_CAPABILITY, 'loc_1', 'community_reported')],
      }),
    ).toBe(true);
  });

  test('a place with no store link sends no request', () => {
    expect(placeOffersMercariaStore({ capabilities: [] })).toBe(false);
    expect(
      placeOffersMercariaStore({
        capabilities: [capability('payments.faircoin.accepted', true, 'oxy_verified')],
      }),
    ).toBe(false);
  });

  test('an emptied store link does not hold', () => {
    expect(
      placeOffersMercariaStore({
        capabilities: [capability(MERCARIA_STORE_CAPABILITY, '', 'business_asserted')],
      }),
    ).toBe(false);
  });
});

describe('availability reads as words', () => {
  test('each availability has its own label and tone', () => {
    const confirmed = minutesBefore(5);
    expect(
      presentStock({ availability: 'in_stock', stockConfirmedAt: confirmed }, t, NOW),
    ).toMatchObject({ label: 'In stock', tone: 'success' });
    expect(
      presentStock({ availability: 'low_stock', stockConfirmedAt: confirmed }, t, NOW),
    ).toMatchObject({ label: 'Low stock', tone: 'warning' });
    expect(
      presentStock({ availability: 'out_of_stock', stockConfirmedAt: confirmed }, t, NOW),
    ).toMatchObject({ label: 'Out of stock', tone: 'default' });
  });

  test('the count shows only where the merchant discloses it', () => {
    expect(
      presentStock(
        { availability: 'low_stock', exactQuantity: 3, stockConfirmedAt: minutesBefore(5) },
        t,
        NOW,
      ).quantity,
    ).toBe('3 left');
    expect(
      presentStock({ availability: 'in_stock', stockConfirmedAt: minutesBefore(5) }, t, NOW)
        .quantity,
    ).toBeNull();
  });

  test('an out-of-stock item never shows a count, whatever arrived with it', () => {
    expect(
      presentStock(
        { availability: 'out_of_stock', exactQuantity: 0, stockConfirmedAt: minutesBefore(5) },
        t,
        NOW,
      ).quantity,
    ).toBeNull();
  });

  test('the confirmation age is fine-grained, because a shelf moves in hours', () => {
    expect(stockConfirmedAge(minutesBefore(0), t, NOW)).toBe('Stock confirmed just now');
    expect(stockConfirmedAge(minutesBefore(1), t, NOW)).toBe('Stock confirmed 1 minute ago');
    expect(stockConfirmedAge(minutesBefore(35), t, NOW)).toBe('Stock confirmed 35 minutes ago');
    expect(stockConfirmedAge(minutesBefore(60), t, NOW)).toBe('Stock confirmed 1 hour ago');
    expect(stockConfirmedAge(minutesBefore(60 * 5), t, NOW)).toBe('Stock confirmed 5 hours ago');
    expect(stockConfirmedAge(minutesBefore(60 * 24 * 2), t, NOW)).toBe(
      'Stock confirmed 2 days ago',
    );
  });

  test('Spanish reads Spanish, with its own singular and plural', () => {
    expect(stockConfirmedAge(minutesBefore(1), tEs, NOW)).toBe('Stock confirmado hace 1 minuto');
    expect(stockConfirmedAge(minutesBefore(60 * 24 * 2), tEs, NOW)).toBe(
      'Stock confirmado hace 2 días',
    );
    expect(
      presentStock(
        { availability: 'low_stock', exactQuantity: 1, stockConfirmedAt: minutesBefore(5) },
        tEs,
        NOW,
      ),
    ).toMatchObject({
      label: 'Pocas unidades',
      quantity: 'Queda 1',
    });
    expect(
      presentStock(
        { availability: 'in_stock', exactQuantity: 4, stockConfirmedAt: minutesBefore(5) },
        tEs,
        NOW,
      ).quantity,
    ).toBe('Quedan 4');
  });

  test('a confirmation stamped in the future (clock skew) reads as just now', () => {
    expect(stockConfirmedAge(minutesBefore(-3), t, NOW)).toBe('Stock confirmed just now');
  });
});

describe('prices are the listing’s own currency, in its own precision', () => {
  test('cents, for a two-decimal currency', () => {
    expect(formatMercariaPrice({ amount: 650, currency: 'EUR' }, 'en')).toBe('€6.50');
  });

  test('no division, for a currency with no minor unit', () => {
    expect(formatMercariaPrice({ amount: 1200, currency: 'JPY' }, 'en')).toBe('¥1,200');
  });

  test('eight decimals for FAIR, which Intl cannot name', () => {
    expect(formatMercariaPrice({ amount: 125_000_000, currency: 'FAIR' }, 'en')).toBe('⊜ 1.25');
    expect(formatMercariaPrice({ amount: 1, currency: 'FAIR' }, 'en')).toBe('⊜ 0.00000001');
  });
});

test('a tile is one spoken sentence: title, price, availability, count, age', () => {
  const [cherries] = MERCARIA_FIXTURE_STOCK.get('loc_boqueria_fruites_soler') ?? [];
  const spoken = spokenProduct({ ...cherries, stockConfirmedAt: minutesBefore(35) }, t, NOW, 'en');
  expect(spoken).toBe(
    'Cireres del Jerte, 500 g, €6.50, In stock, 24 left, Stock confirmed 35 minutes ago',
  );
});
