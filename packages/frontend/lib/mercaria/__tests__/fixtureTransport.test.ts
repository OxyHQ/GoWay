/**
 * Mercaria's answers, and what each one puts on the place sheet.
 *
 * The fixture transport sits under the REAL `@mercaria.co/sdk` client, so
 * every fixture here is parsed by Mercaria's own contract schemas; a fixture
 * that drifts fails this file rather than a screen. The other half is the
 * mapping that matters most: `gone` hides a store for good, and "Mercaria
 * could not answer" (usually: it could not ask GoWay) offers a retry instead
 * of pretending the store is gone.
 */
import { describe, expect, test } from 'bun:test';
import {
  createMercariaClient,
  MercariaAbortError,
  MercariaApiError,
  MercariaGoneError,
  MercariaNetworkError,
  MercariaNotFoundError,
  MercariaRateLimitError,
  MercariaResponseError,
  MercariaTimeoutError,
  MercariaUnavailableError,
  type MercariaClient,
} from '@mercaria.co/sdk';

import type { FixtureFaultMode } from '@/lib/goway/mockTransport';
import { classifyMercariaError, mercariaReadState, shouldRetryMercaria } from '@/lib/mercaria/errors';
import { createMercariaFixtureFetch } from '@/lib/mercaria/mockTransport';

function fixtureClient(fault?: FixtureFaultMode): MercariaClient {
  return createMercariaClient({ apiBaseUrl: 'https://api.mercaria.co', fetch: createMercariaFixtureFetch(fault) });
}

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to fail');
}

describe('the fixture layer answers what Mercaria answers', () => {
  test('a shared place lists every shop front trading from it, each linked on mercaria.co', async () => {
    const { items, nextCursor } = await fixtureClient().locations.list({ goWayPlaceId: 'gw_mercat_boqueria' });
    expect(items.map((location) => location.store.name)).toEqual(['Fruites Soler', 'Xarcuteria Joan']);
    expect(nextCursor).toBeNull();
    const client = fixtureClient();
    for (const location of items) {
      expect(location.goWayPlaceId).toBe('gw_mercat_boqueria');
      expect(location.url).toBe(client.links.location(location, location.store));
    }
  });

  test('a place Mercaria does not trade from is an empty page, never an error', async () => {
    // Forn Baluard names a location only at the community tier.
    expect((await fixtureClient().locations.list({ goWayPlaceId: 'gw_forn_baluard' })).items).toEqual([]);
  });

  test('`inStock` keeps what is on this shelf now', async () => {
    const client = fixtureClient();
    const everything = await client.locations.products('loc_boqueria_fruites_soler');
    const onShelf = await client.locations.products('loc_boqueria_fruites_soler', { inStock: true });
    expect(everything.items.some((item) => item.availability === 'out_of_stock')).toBe(true);
    expect(onShelf.items.length).toBeGreaterThan(0);
    expect(onShelf.items.every((item) => item.availability !== 'out_of_stock')).toBe(true);
  });

  test('a count is present only where the merchant discloses it', async () => {
    const client = fixtureClient();
    const disclosed = await client.locations.products('loc_boqueria_fruites_soler', { inStock: true });
    const undisclosed = await client.locations.products('loc_boqueria_xarcuteria_joan', { inStock: true });
    expect(disclosed.items.every((item) => typeof item.exactQuantity === 'number')).toBe(true);
    expect(undisclosed.items.every((item) => item.exactQuantity === undefined)).toBe(true);
  });

  test('a short page hands back a cursor that reaches the rest', async () => {
    const client = fixtureClient();
    const first = await client.locations.products('loc_boqueria_fruites_soler', { inStock: true, limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    const second = await client.locations.products('loc_boqueria_fruites_soler', {
      inStock: true,
      limit: 1,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.items[0].product.ref.id).not.toBe(first.items[0].product.ref.id);
  });

  test('a location that is not public is gone', async () => {
    expect(await failureOf(fixtureClient().locations.products('loc_withdrawn'))).toBeInstanceOf(MercariaGoneError);
  });

  test('the unavailable fault is a 503, the network fault a network error', async () => {
    expect(await failureOf(fixtureClient('unavailable').locations.list({ goWayPlaceId: 'gw_mercat_boqueria' }))).toBeInstanceOf(
      MercariaUnavailableError,
    );
    expect(await failureOf(fixtureClient('network').locations.list({ goWayPlaceId: 'gw_mercat_boqueria' }))).toBeInstanceOf(
      MercariaNetworkError,
    );
  });
});

describe('gone and unavailable mean different things', () => {
  test('gone and not found stop, and are never retried', () => {
    expect(classifyMercariaError(new MercariaGoneError('gone', { status: 410 }))).toEqual({ kind: 'gone', retryable: false });
    expect(classifyMercariaError(new MercariaNotFoundError('missing', { status: 404 }))).toEqual({ kind: 'notFound', retryable: false });
    expect(shouldRetryMercaria(0, new MercariaGoneError('gone', { status: 410 }))).toBe(false);
  });

  test('an outage, offline, a timeout and a rate limit are all "try again later"', () => {
    for (const error of [
      new MercariaUnavailableError('down', { status: 503 }),
      new MercariaNetworkError('offline'),
      new MercariaTimeoutError('slow'),
      new MercariaRateLimitError('busy', { status: 429 }),
    ]) {
      expect(classifyMercariaError(error)).toEqual({ kind: 'unavailable', retryable: true });
    }
    expect(shouldRetryMercaria(0, new MercariaUnavailableError('down', { status: 503 }))).toBe(true);
    expect(shouldRetryMercaria(2, new MercariaUnavailableError('down', { status: 503 }))).toBe(false);
  });

  test('a 404 with no Mercaria error body proves nothing, and is not "gone"', () => {
    expect(classifyMercariaError(new MercariaApiError('proxy', { status: 404 })).kind).toBe('unknown');
  });

  test('a cancelled read is nothing at all', () => {
    expect(classifyMercariaError(new MercariaAbortError('cancelled')).kind).toBe('aborted');
  });
});

describe('what a read puts on screen', () => {
  const settled = (error: Error) => mercariaReadState({ status: 'error', error, empty: false });

  test('gone, not found and an unknown failure hide the section', () => {
    expect(settled(new MercariaGoneError('gone', { status: 410 }))).toBe('hidden');
    expect(settled(new MercariaNotFoundError('missing', { status: 404 }))).toBe('hidden');
    expect(settled(new MercariaResponseError('malformed'))).toBe('hidden');
  });

  test('unavailable offers a retry rather than hiding for good', () => {
    expect(settled(new MercariaUnavailableError('down', { status: 503 }))).toBe('retry');
    expect(settled(new MercariaNetworkError('offline'))).toBe('retry');
  });

  test('an empty answer hides; a pending one loads; a confirmed one renders', () => {
    expect(mercariaReadState({ status: 'success', error: null, empty: true })).toBe('hidden');
    expect(mercariaReadState({ status: 'pending', error: null, empty: true })).toBe('loading');
    expect(mercariaReadState({ status: 'success', error: null, empty: false })).toBe('ready');
  });
});
