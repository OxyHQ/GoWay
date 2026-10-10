/**
 * A `MercariaFetch` that answers the two Mercaria public routes GoWay reads
 * from local fixtures.
 *
 * The same shape as `lib/goway/mockTransport.ts`, for the same reason: it sits
 * UNDER the real `@mercaria.co/sdk` client, at the one `fetch` seam
 * `createMercariaClient({ fetch })` exposes, so every request is still built,
 * timed out, parsed and error-classified by Mercaria's own SDK. A fixture that
 * does not satisfy Mercaria's contract is a `MercariaResponseError` in
 * development. Going live is the removal of that one option (`client.ts`).
 *
 * It answers what Mercaria answers and nothing it does not:
 *
 *  - `GET /public/v1/locations?goWayPlaceId=` — a page, EMPTY for a place
 *    nobody trades from, never a 404;
 *  - `GET /public/v1/locations/:id/products` — a page, with `inStock=true`
 *    keeping what is on THIS shelf now (`in_stock` or `low_stock`); `gone` for
 *    a location that is not public.
 *
 * `EXPO_PUBLIC_GOWAY_FIXTURE_FAULTS=mercaria[:network]` fails both, so the
 * section's quiet retry can be seen without unplugging anything.
 */
import { MERCARIA_PUBLIC_API_BASE_PATH } from '@mercaria.co/sdk';
import type {
  MercariaFetch,
  MercariaFetchResponse,
  MercariaLocation,
  MercariaLocationProduct,
  MercariaPage,
  MercariaPublicErrorCode,
} from '@mercaria.co/sdk';

import { fixtureLatency, type FixtureFaultMode } from '@/lib/goway/mockTransport';

import { MERCARIA_FIXTURE_LOCATIONS, MERCARIA_FIXTURE_STOCK } from './fixtures';

function respond(status: number, body: unknown): MercariaFetchResponse {
  const text = JSON.stringify(body);
  return { status, headers: { get: () => null }, text: async () => text };
}

/** Mercaria's error envelope, `{ error: { code, message } }`, at the status Mercaria gives the code. */
function fail(
  status: number,
  code: MercariaPublicErrorCode,
  message: string,
): MercariaFetchResponse {
  return respond(status, { error: { code, message } });
}

/** The cursors this transport mints: an offset into the list, `o<n>`. */
const FIXTURE_CURSOR = /^o(\d+)$/;

/** Mercaria's default page size, `MERCARIA_PUBLIC_PAGE_LIMIT_DEFAULT`. */
const DEFAULT_LIMIT = 20;

function page<T>(entries: readonly T[], params: Map<string, string>): MercariaPage<T> {
  const offset = Number(FIXTURE_CURSOR.exec(params.get('cursor') ?? '')?.[1] ?? 0);
  const end = offset + Number(params.get('limit') ?? DEFAULT_LIMIT);
  return { items: entries.slice(offset, end), nextCursor: end < entries.length ? `o${end}` : null };
}

/** The path below `/public/v1` and the query, hand-parsed (`URL` is incomplete in React Native). */
function splitUrl(url: string): { path: string; params: Map<string, string> } {
  const [beforeQuery, query = ''] = url.split('?');
  const marker = beforeQuery.indexOf(MERCARIA_PUBLIC_API_BASE_PATH);
  const path =
    marker >= 0 ? beforeQuery.slice(marker + MERCARIA_PUBLIC_API_BASE_PATH.length) : beforeQuery;
  const params = new Map<string, string>();
  for (const pair of query.split('&')) {
    if (!pair) continue;
    const [key, value = ''] = pair.split('=');
    params.set(decodeURIComponent(key), decodeURIComponent(value));
  }
  return { path, params };
}

function locationsAt(params: Map<string, string>): MercariaPage<MercariaLocation> {
  return page(MERCARIA_FIXTURE_LOCATIONS.get(params.get('goWayPlaceId') ?? '') ?? [], params);
}

function shelf(
  stock: readonly MercariaLocationProduct[],
  params: Map<string, string>,
): MercariaPage<MercariaLocationProduct> {
  const onShelf =
    params.get('inStock') === 'true'
      ? stock.filter((item) => item.availability !== 'out_of_stock')
      : stock;
  return page(onShelf, params);
}

/**
 * Build the fixture-backed `fetch`. `fault` fails every request the way
 * `EXPO_PUBLIC_GOWAY_FIXTURE_FAULTS` asks.
 */
export function createMercariaFixtureFetch(fault?: FixtureFaultMode): MercariaFetch {
  return async function mercariaFixtureFetch(url, init) {
    await fixtureLatency(init.signal);

    // Thrown, so the SDK reads it as `MercariaNetworkError` — what "offline" is.
    if (fault === 'network') throw new TypeError('Network request failed');
    if (fault)
      return fail(503, 'service_unavailable', 'Mercaria could not ask GoWay about this place');

    const { path, params } = splitUrl(url);
    const cursor = params.get('cursor');
    if (cursor !== undefined && !FIXTURE_CURSOR.test(cursor)) {
      return fail(400, 'bad_request', 'That cursor was not issued by this list.');
    }

    if (path === '/locations') return respond(200, locationsAt(params));

    const productsRoute = /^\/locations\/([^/]+)\/products$/.exec(path);
    if (productsRoute) {
      const stock = MERCARIA_FIXTURE_STOCK.get(decodeURIComponent(productsRoute[1]));
      if (!stock) return fail(410, 'gone', 'This location is no longer available');
      return respond(200, shelf(stock, params));
    }

    return fail(404, 'unknown_route', `The fixture layer does not serve ${path}`);
  };
}
