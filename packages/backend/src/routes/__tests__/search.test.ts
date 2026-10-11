/**
 * The search HTTP surface, over a real socket.
 *
 * What is asserted here is the CONTRACT an SDK consumer sees: the paths, the
 * parameter names `@goway.to/sdk` sends, the unwrapped `SearchResults` page,
 * its cursors, and the fact that a refused value is a 422 naming the field
 * rather than a 500. The service itself is a double — its behaviour is covered in
 * `src/search/__tests__`, and doubling it here is what keeps these cases free
 * of a database and a geocoder.
 *
 * `./testEnv` FIRST, and the order is load-bearing: `src/config` parses at
 * module load, so the environment has to exist before the router is evaluated.
 */

import '../../__tests__/testEnv';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import express, { type Express } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { SearchResults } from '@goway/contracts';
import { SEEDED_CATALOG } from '../../__tests__/categoryFixtures';
import { parseSearchConfig } from '../../config/search';
import { ApiError } from '../../http/apiError';
import { errorHandler, unknownRouteHandler } from '../../http/errorHandler';
import { fakeGateway } from '../../search/__tests__/fixtures';
import type {
  ResolvedReverseQuery,
  ResolvedSearchQuery,
  ResolvedStructuredQuery,
  SearchService,
  SearchWindow,
} from '../../search/searchService';
import { createSearchRouter } from '../search';

const CONFIG = parseSearchConfig({ SEARCH_DEFAULT_LIMIT: '3', SEARCH_MAX_LIMIT: '5' });

const EMPTY_WINDOW: SearchWindow = { results: [], hasMore: false, providers: ['photon'] };
const EMPTY_RESULTS: SearchResults = { items: [], nextCursor: null, providers: ['photon'] };

interface Recorded {
  search: ResolvedSearchQuery[];
  forward: ResolvedSearchQuery[];
  reverse: ResolvedReverseQuery[];
  structured: ResolvedStructuredQuery[];
}

const recorded: Recorded = { search: [], forward: [], reverse: [], structured: [] };
let nextFailure: ApiError | null = null;
let nextWindow: SearchWindow = EMPTY_WINDOW;

const service: SearchService = {
  search: (query) => {
    recorded.search.push(query);
    return nextFailure ? Promise.reject(nextFailure) : Promise.resolve(nextWindow);
  },
  forward: (query) => {
    recorded.forward.push(query);
    return Promise.resolve(EMPTY_WINDOW);
  },
  reverse: (query) => {
    recorded.reverse.push(query);
    return Promise.resolve(EMPTY_WINDOW);
  },
  structured: (query) => {
    recorded.structured.push(query);
    return Promise.resolve(EMPTY_WINDOW);
  },
};

function buildApp(): Express {
  const app = express();
  app.use(
    '/api/v1',
    createSearchRouter({
      // The real router is handed `optionalAuth`; a pass-through stands in for
      // it here so these cases need no live Oxy identity service.
      optionalAuth: (_request, _response, next) => next(),
      service,
      createGateway: () => fakeGateway(),
      config: CONFIG,
      categories: async () => SEEDED_CATALOG,
    }),
  );
  app.use(unknownRouteHandler);
  app.use(errorHandler);
  return app;
}

let server: Server;
let origin: string;

beforeAll(async () => {
  server = buildApp().listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${String(port)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function errorCodeOf(
  path: string,
): Promise<{ status: number; code: string; field?: unknown }> {
  const response = await fetch(`${origin}${path}`);
  const body = (await response.json()) as {
    error: { code: string; details?: { field?: unknown } };
  };
  return { status: response.status, code: body.error.code, field: body.error.details?.field };
}

describe('GET /api/v1/search', () => {
  it('answers the SDK’s parameters with an unwrapped SearchResults body', async () => {
    const response = await fetch(
      `${origin}/api/v1/search?q=cafe&latitude=41.4036&longitude=2.1744&capabilities=payments.faircoin.accepted&categories=food.cafe,food.bakery&locale=ca-ES`,
    );

    expect(response.status).toBe(200);
    // A 2xx body IS the contract value; GoWay wraps success in no envelope.
    expect(await response.json()).toEqual(EMPTY_RESULTS);
    // The query text and, on a `near` search, the coordinate are in this URL.
    expect(response.headers.get('cache-control')).toBe('no-store');

    const query = recorded.search.at(-1);
    expect(query).toMatchObject({
      query: 'cafe',
      near: { latitude: 41.4036, longitude: 2.1744 },
      capabilities: ['payments.faircoin.accepted'],
      categories: ['food.cafe', 'food.bakery'],
      locale: 'ca-ES',
    });
  });

  it('refuses a category filter naming a key that is not a category', async () => {
    expect(
      await errorCodeOf('/api/v1/search?q=museum&categories=food.cafe,food.space_diner'),
    ).toMatchObject({
      status: 422,
      code: 'validation_failed',
      field: 'categories.1',
    });
  });

  it('reads a viewport from the bare west/south/east/north the SDK sends', async () => {
    await fetch(`${origin}/api/v1/search?q=museum&west=2.0&south=41.3&east=2.2&north=41.5`);
    expect(recorded.search.at(-1)?.viewport).toEqual({
      west: 2,
      south: 41.3,
      east: 2.2,
      north: 41.5,
    });
  });

  it('refuses a parameter the contract does not declare, and a repeated one, as bad_request', async () => {
    // One spelling per parameter: `lat` and `bbox` were short forms once, and a
    // silently ignored `lat` answers an unbiased search to a caller who asked
    // for a biased one.
    expect(await errorCodeOf('/api/v1/search?q=museum&lat=41.4&lng=2.17')).toMatchObject({
      status: 400,
      code: 'bad_request',
    });
    expect(await errorCodeOf('/api/v1/search?q=museum&categories=a&categories=b')).toMatchObject({
      status: 400,
      code: 'bad_request',
      field: 'categories',
    });
  });

  it('applies the configured default limit and refuses one above the configured maximum', async () => {
    await fetch(`${origin}/api/v1/search?q=cafe`);
    expect(recorded.search.at(-1)).toMatchObject({ limit: 3, offset: 0 });

    // Outside the range is `validation_failed`, never a silent clamp: a caller
    // who asked for 50 and got 5 would conclude there were 5.
    expect(await errorCodeOf('/api/v1/search?q=cafe&limit=50')).toMatchObject({
      status: 422,
      code: 'validation_failed',
      field: 'limit',
    });
  });

  it('pages by a cursor bound to the query, and refuses it under another one', async () => {
    const result = (id: string): SearchWindow['results'][number] => ({
      id,
      displayName: id,
      kind: 'poi',
      coordinate: { latitude: 41.4, longitude: 2.17 },
      source: 'photon',
    });
    nextWindow = { ...EMPTY_WINDOW, results: [result('a'), result('b')], hasMore: true };
    const first = (await (
      await fetch(`${origin}/api/v1/search?q=cafe&limit=2`)
    ).json()) as SearchResults;
    nextWindow = EMPTY_WINDOW;
    expect(first.nextCursor).toEqual(expect.any(String));

    // The cursor carries how far the last page reached — the offset the
    // service is asked to resume at — and nothing a caller should parse.
    const cursor = encodeURIComponent(first.nextCursor ?? '');
    const second = await fetch(`${origin}/api/v1/search?q=cafe&limit=2&cursor=${cursor}`);
    expect(second.status).toBe(200);
    expect(((await second.json()) as SearchResults).nextCursor).toBeNull();

    // A different limit is the same list; a different question is not.
    await fetch(`${origin}/api/v1/search?q=cafe&limit=3&cursor=${cursor}`);
    expect(recorded.search.at(-1)).toMatchObject({ offset: 2, limit: 3 });
    expect(await errorCodeOf(`/api/v1/search?q=bar&cursor=${cursor}`)).toMatchObject({
      status: 400,
      code: 'bad_request',
      field: 'cursor',
    });
    expect(await errorCodeOf(`/api/v1/geocode?q=cafe&cursor=${cursor}`)).toMatchObject({
      status: 400,
    });
  });

  it('refuses a missing query as validation_failed, not a 500', async () => {
    expect(await errorCodeOf('/api/v1/search')).toMatchObject({
      status: 422,
      code: 'validation_failed',
      field: 'q',
    });
    expect(await errorCodeOf('/api/v1/search?q=%20%20')).toMatchObject({
      status: 422,
      code: 'validation_failed',
    });
  });

  it('refuses a half-specified bias rather than silently ignoring it', async () => {
    // Quietly dropping the half that arrived would produce a differently
    // ordered list than the caller asked for, with nothing to show why.
    expect(await errorCodeOf('/api/v1/search?q=cafe&latitude=41.4')).toMatchObject({
      status: 422,
      field: 'latitude',
    });
    expect(await errorCodeOf('/api/v1/search?q=cafe&west=2&south=41')).toMatchObject({
      status: 422,
      field: 'west',
    });
  });

  it('refuses a coordinate that is not on Earth and a box with south above north', async () => {
    expect(await errorCodeOf('/api/v1/search?q=cafe&latitude=120&longitude=2')).toMatchObject({
      status: 422,
    });
    expect(await errorCodeOf('/api/v1/search?q=a&west=2&south=42&east=3&north=41')).toMatchObject({
      status: 422,
      field: 'south',
    });
  });

  it('names the field and never the value in the error details', async () => {
    const response = await fetch(`${origin}/api/v1/search?q=cafe&latitude=41.98765&longitude=abc`);
    const body = await response.text();
    // A validation failure on a coordinate must not be the thing that writes a
    // user's location into somebody's log index.
    expect(body).not.toContain('41.98765');
    expect(body).toContain('longitude');
  });

  it('passes a provider failure through as its own code', async () => {
    nextFailure = new ApiError('provider_unavailable', 'The geocoding provider is unavailable.', {
      provider: 'photon',
    });
    const response = await fetch(`${origin}/api/v1/search?q=cafe`);
    nextFailure = null;

    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'provider_unavailable',
    );
  });
});

describe('GET /api/v1/geocode', () => {
  it('is a separate endpoint from /search', async () => {
    await fetch(`${origin}/api/v1/geocode?q=berlin`);
    expect(recorded.forward.at(-1)?.query).toBe('berlin');
  });

  it('reverse-geocodes from a coordinate', async () => {
    await fetch(
      `${origin}/api/v1/geocode/reverse?latitude=41.4036&longitude=2.1744&radiusMeters=120&limit=2`,
    );
    expect(recorded.reverse.at(-1)).toEqual({
      coordinate: { latitude: 41.4036, longitude: 2.1744 },
      limit: 2,
      offset: 0,
      radiusMeters: 120,
    });
  });

  it('refuses a reverse lookup with no coordinate, and an impossible radius', async () => {
    expect(await errorCodeOf('/api/v1/geocode/reverse')).toMatchObject({
      status: 422,
      field: 'latitude',
    });
    expect(
      await errorCodeOf('/api/v1/geocode/reverse?latitude=41&longitude=2&radiusMeters=0'),
    ).toMatchObject({ status: 422, field: 'radiusMeters' });
  });

  it('looks up a structured address and upper-cases the country code', async () => {
    await fetch(
      `${origin}/api/v1/geocode/structured?street=Carrer%20de%20Mallorca&houseNumber=401&city=Barcelona&countryCode=es`,
    );
    expect(recorded.structured.at(-1)).toEqual({
      street: 'Carrer de Mallorca',
      houseNumber: '401',
      city: 'Barcelona',
      countryCode: 'ES',
      limit: 3,
      offset: 0,
    });
  });

  it('refuses a structured lookup with no question in it', async () => {
    // Answering it would be a scan of the planet.
    expect(await errorCodeOf('/api/v1/geocode/structured')).toMatchObject({ status: 422 });
    expect(await errorCodeOf('/api/v1/geocode/structured?limit=3')).toMatchObject({ status: 422 });
  });
});
