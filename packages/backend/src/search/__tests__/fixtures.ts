/**
 * Doubles for the search suite.
 *
 * Nothing in `src/search/__tests__` touches the network or a database. A test
 * that reached a community Photon instance would be a test that fails when
 * somebody else's server is busy, and one that reached PostGIS would be a test
 * that does not run on a laptop — which is the same as not having it.
 */

import type { Place, PlaceWithDistance } from '@goway/shared-types';
import type { SourceRefInput } from '../../db/places/placesRepository';
import type { PlacesGateway } from '../placesGateway';
import { sourceRefKey } from '../placesGateway';
import type { FetchLike } from '../provider';

export interface FetchRecorder {
  fetch: FetchLike;
  /** Every URL requested, in order. */
  urls: string[];
  /** Every `init` passed, in order. */
  inits: (RequestInit | undefined)[];
}

/** A `fetch` double that answers each call from `handler`. */
export function recordingFetch(handler: (url: string, call: number) => Response | Promise<Response>): FetchRecorder {
  const urls: string[] = [];
  const inits: (RequestInit | undefined)[] = [];
  const fetch: FetchLike = async (input, init) => {
    urls.push(input);
    inits.push(init);
    return handler(input, urls.length - 1);
  };
  return { fetch, urls, inits };
}

export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

/** The query parameters of a recorded URL. */
export function paramsOf(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

let placeCounter = 0;

/** A `Place` with every required field, overridable part by part. */
export function buildPlace(overrides: Partial<Place> = {}): Place {
  placeCounter += 1;
  const id = overrides.id ?? `place-${String(placeCounter)}`;
  return {
    id,
    name: `Place ${id}`,
    location: { latitude: 41.4036, longitude: 2.1744 },
    categories: ['cafe'],
    status: 'active',
    verification: { state: 'unverified' },
    sources: [],
    capabilities: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export interface FakeGatewayOptions {
  /** `<source>:<sourceId>` → place id. */
  bindings?: Record<string, string>;
  /** Places reachable by id, and the rows the spatial queries return. */
  places?: readonly Place[];
  nearby?: readonly PlaceWithDistance[];
  inBounds?: readonly Place[];
  /** When set, every method rejects with it — the "database is down" case. */
  failure?: Error;
}

export interface FakeGateway extends PlacesGateway {
  /** How many reference-resolution round trips the merge made. */
  readonly refLookups: SourceRefInput[][];
}

export function fakeGateway(options: FakeGatewayOptions = {}): FakeGateway {
  const bindings = options.bindings ?? {};
  const byId = new Map((options.places ?? []).map((place) => [place.id, place]));
  const refLookups: SourceRefInput[][] = [];

  const reject = <T>(): Promise<T> => Promise.reject(options.failure);

  return {
    refLookups,
    findPlaceIdsBySourceRefs(refs) {
      if (options.failure) return reject();
      refLookups.push([...refs]);
      const resolved = new Map<string, string>();
      for (const ref of refs) {
        const placeId = bindings[sourceRefKey(ref)];
        if (placeId !== undefined) resolved.set(sourceRefKey(ref), placeId);
      }
      return Promise.resolve(resolved);
    },
    findPlacesByIds(ids) {
      if (options.failure) return reject();
      const found = new Map<string, Place>();
      for (const id of ids) {
        const place = byId.get(id);
        if (place) found.set(id, place);
      }
      return Promise.resolve(found);
    },
    findPlacesNearby() {
      if (options.failure) return reject();
      return Promise.resolve([...(options.nearby ?? [])]);
    },
    findPlacesInBounds() {
      if (options.failure) return reject();
      return Promise.resolve([...(options.inBounds ?? [])]);
    },
  };
}
