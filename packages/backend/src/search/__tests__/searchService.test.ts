/**
 * The search service: blending, enrichment, duplicate grouping and degradation.
 *
 * Every provider here is a stub object implementing `SearchProvider` — the
 * point of the interface is that this layer cannot tell Photon from anything
 * else, so testing it through an HTTP double would be testing the adapters
 * twice and the blending once.
 */

import { describe, expect, it } from 'bun:test';
import type { PlaceCapability, PlaceWithDistance, SearchResultKind } from '@goway/shared-types';
import { isApiError } from '../../http/apiError';
import { BoundedCache } from '../cache';
import type { ProviderCandidate, SearchProvider } from '../provider';
import { createSearchService, placeMatchesText, type SearchService } from '../searchService';
import { UpstreamError } from '../upstream';
import { buildPlace, fakeGateway } from './fixtures';

const CONFIG = { cacheMaxEntries: 50, cacheTtlSeconds: 60, placesRadiusMeters: 5_000 };

interface StubOptions {
  allowsInteractiveSearch?: boolean;
  forward?: ProviderCandidate[] | Error;
  reverse?: ProviderCandidate[] | Error;
  structured?: ProviderCandidate[] | Error | 'unsupported';
  onForward?: () => void;
}

function stub(id: 'photon' | 'nominatim', options: StubOptions = {}): SearchProvider {
  const answer = (value: ProviderCandidate[] | Error | undefined): Promise<ProviderCandidate[]> =>
    value instanceof Error ? Promise.reject(value) : Promise.resolve(value ?? []);

  const provider: SearchProvider = {
    id,
    allowsInteractiveSearch: options.allowsInteractiveSearch ?? true,
    forward: () => {
      options.onForward?.();
      return answer(options.forward);
    },
    reverse: () => answer(options.reverse),
  };
  const structured = options.structured;
  if (structured === 'unsupported') return provider;
  return { ...provider, structured: () => answer(structured) };
}

interface CandidateOptions {
  source: 'photon' | 'nominatim';
  name: string;
  latitude: number;
  longitude: number;
  osmId?: string;
  kind?: SearchResultKind;
}

function candidate(options: CandidateOptions): ProviderCandidate {
  const sourceId = options.osmId;
  const result = {
    id: `${options.source}:${sourceId ?? options.name}`,
    displayName: options.name,
    kind: options.kind ?? ('poi' as SearchResultKind),
    coordinate: { latitude: options.latitude, longitude: options.longitude },
    source: options.source,
    ...(sourceId !== undefined ? { sourceId } : {}),
  };
  return sourceId === undefined
    ? { result }
    : { result, osmRef: { source: 'openstreetmap' as const, sourceId } };
}

const FAIRCOIN: PlaceCapability = {
  namespace: 'payments.faircoin',
  capability: 'accepted',
  key: 'payments.faircoin.accepted',
  value: true,
  verification: 'oxy_verified',
  observedAt: '2026-06-01T00:00:00.000Z',
};

function service(providers: SearchProvider[], overrides: Partial<typeof CONFIG> = {}): SearchService {
  return createSearchService({ providers, config: { ...CONFIG, ...overrides } });
}

const QUERY = { query: 'cafe', limit: 10 };

describe('degradation', () => {
  it('answers with a short list and names the degraded provider', async () => {
    const failing = stub('photon', { forward: new UpstreamError('photon', 'timeout') });
    const working = stub('nominatim', {
      forward: [candidate({ source: 'nominatim', name: 'Cafè Sagrada', latitude: 41.4, longitude: 2.17 })],
    });

    const results = await service([failing, working]).forward(QUERY, { gateway: fakeGateway() });

    // A degraded provider is a shorter list, not a failed request: the
    // difference between "some sources are unavailable" and "nothing is there"
    // is one a consumer has to be able to tell.
    expect(results.results).toHaveLength(1);
    expect(results.providers).toEqual(['nominatim']);
    expect(results.degradedProviders).toEqual(['photon']);
  });

  it('fails only when nothing at all answered', async () => {
    const service_ = service([stub('photon', { forward: new UpstreamError('photon', 'timeout') })]);
    const error = await service_.forward(QUERY, { gateway: fakeGateway() }).catch((raised: unknown) => raised);

    expect(isApiError(error)).toBe(true);
    expect(isApiError(error) ? error.code : null).toBe('provider_unavailable');
  });

  it('reports a rate limit in preference to a generic outage', async () => {
    const limited = new UpstreamError('nominatim', 'rate_limited', { status: 429, retryAfterSeconds: 11 });
    const service_ = service([
      stub('photon', { forward: new UpstreamError('photon', 'network') }),
      stub('nominatim', { forward: limited }),
    ]);
    const error = await service_.forward(QUERY, { gateway: fakeGateway() }).catch((raised: unknown) => raised);

    // Only one of the two failures carries an actionable retry delay.
    expect(isApiError(error) ? error.code : null).toBe('rate_limited');
    expect(isApiError(error) ? error.details?.retryAfterSeconds : null).toBe(11);
  });

  it('treats GoWay Places as one more provider when the database is down', async () => {
    const provider = stub('photon', {
      forward: [candidate({ source: 'photon', name: 'Cafè', latitude: 41.4, longitude: 2.17, osmId: 'node/1' })],
    });
    const results = await service([provider]).search(
      { ...QUERY, near: { latitude: 41.4, longitude: 2.17 } },
      { gateway: fakeGateway({ failure: new Error('connection refused') }) },
    );

    // Search still works off the geocoder rather than taking the map's search
    // box down with the database.
    expect(results.results).toHaveLength(1);
    expect(results.degradedProviders).toContain('goway');
    expect(results.providers).not.toContain('goway');
  });
});

describe('GoWay Places enrichment', () => {
  it('reconciles an external candidate and keeps its provenance', async () => {
    const place = buildPlace({
      id: 'p1',
      name: 'Cafè Sagrada',
      sources: [{ source: 'openstreetmap', sourceId: 'node/1', observedAt: '2026-05-01T00:00:00.000Z' }],
      capabilities: [FAIRCOIN],
    });
    const provider = stub('photon', {
      forward: [candidate({ source: 'photon', name: 'Cafè Sagrada', latitude: 41.4, longitude: 2.17, osmId: 'node/1' })],
    });

    const results = await service([provider]).forward(QUERY, {
      gateway: fakeGateway({ bindings: { 'openstreetmap:node/1': 'p1' }, places: [place] }),
    });

    const [result] = results.results;
    expect(result?.placeId).toBe('p1');
    expect(result?.source).toBe('goway');
    // Provenance is not dropped: the OSM element the candidate came from is
    // published on the embedded place, which is the only way it got here.
    expect(result?.place?.sources).toEqual([
      { source: 'openstreetmap', sourceId: 'node/1', observedAt: '2026-05-01T00:00:00.000Z' },
    ]);
    // And the enrichment that made reconciling worth doing.
    expect(result?.place?.capabilities[0]?.key).toBe('payments.faircoin.accepted');
  });

  it('shows one café, not two, when GoWay Places and a geocoder both know it', async () => {
    const place = buildPlace({ id: 'p1', name: 'Cafè Sagrada' });
    const nearby: PlaceWithDistance[] = [{ ...place, distanceMeters: 12 }];
    const provider = stub('photon', {
      forward: [candidate({ source: 'photon', name: 'Cafè Sagrada', latitude: 41.4036, longitude: 2.1744, osmId: 'node/1' })],
    });

    const results = await service([provider]).search(
      { ...QUERY, near: { latitude: 41.4036, longitude: 2.1744 } },
      { gateway: fakeGateway({ bindings: { 'openstreetmap:node/1': 'p1' }, places: [place], nearby }) },
    );

    expect(results.results).toHaveLength(1);
    expect(results.results[0]?.placeId).toBe('p1');
    expect(results.providers).toEqual(['photon', 'goway']);
  });

  it('groups the same OSM element reported by two geocoders', async () => {
    const results = await service([
      stub('photon', {
        forward: [candidate({ source: 'photon', name: 'Berlin', latitude: 52.5, longitude: 13.4, osmId: 'node/240109189' })],
      }),
      stub('nominatim', {
        forward: [candidate({ source: 'nominatim', name: 'Berlin, Deutschland', latitude: 52.5, longitude: 13.4, osmId: 'node/240109189' })],
      }),
    ]).forward({ query: 'berlin', limit: 10 }, { gateway: fakeGateway() });

    expect(results.results).toHaveLength(1);
    // With no GoWay place to represent the group, the candidate keeps its own
    // provenance verbatim rather than being relabelled.
    expect(results.results[0]?.source).toBe('photon');
    expect(results.providers).toEqual(['photon', 'nominatim']);
  });

  it('never groups two records on their names alone', async () => {
    const provider = stub('photon', {
      forward: [
        candidate({ source: 'photon', name: 'Farmacia', latitude: 41.4036, longitude: 2.1744, osmId: 'node/1' }),
        // The same name, fifty metres away — in Spain that is two pharmacies,
        // and merging them would collapse two real businesses into one record.
        candidate({ source: 'photon', name: 'Farmacia', latitude: 41.4041, longitude: 2.1744, osmId: 'node/2' }),
      ],
    });

    const results = await service([provider]).forward({ query: 'farmacia', limit: 10 }, { gateway: fakeGateway() });
    expect(results.results).toHaveLength(2);
  });

  it('keeps a capability filter honest: an unreconciled candidate cannot satisfy one', async () => {
    const withCapability = buildPlace({ id: 'p1', capabilities: [FAIRCOIN] });
    const provider = stub('photon', {
      forward: [
        candidate({ source: 'photon', name: 'Accepts FairCoin', latitude: 41.4, longitude: 2.17, osmId: 'node/1' }),
        candidate({ source: 'photon', name: 'Unknown to GoWay', latitude: 41.41, longitude: 2.17, osmId: 'node/2' }),
      ],
    });

    const results = await service([provider]).forward(
      { ...QUERY, capabilities: ['payments.faircoin.accepted'] },
      { gateway: fakeGateway({ bindings: { 'openstreetmap:node/1': 'p1' }, places: [withCapability] }) },
    );

    expect(results.results).toHaveLength(1);
    expect(results.results[0]?.placeId).toBe('p1');
  });

  it('resolves every source reference in one round trip', async () => {
    const provider = stub('photon', {
      forward: [
        candidate({ source: 'photon', name: 'A', latitude: 41.4, longitude: 2.17, osmId: 'node/1' }),
        candidate({ source: 'photon', name: 'B', latitude: 41.5, longitude: 2.17, osmId: 'node/2' }),
      ],
    });
    const gateway = fakeGateway();
    await service([provider]).forward(QUERY, { gateway });

    expect(gateway.refLookups).toHaveLength(1);
    expect(gateway.refLookups[0]).toHaveLength(2);
  });
});

describe('biasing', () => {
  it('re-ranks toward a coordinate without filtering anything out', async () => {
    const provider = stub('photon', {
      forward: [
        candidate({ source: 'photon', name: 'Far', latitude: 52.5, longitude: 13.4, osmId: 'node/1' }),
        candidate({ source: 'photon', name: 'Near', latitude: 41.4036, longitude: 2.1744, osmId: 'node/2' }),
      ],
    });

    const results = await service([provider]).forward(
      { ...QUERY, near: { latitude: 41.4036, longitude: 2.1744 } },
      { gateway: fakeGateway() },
    );

    // Both are still there — a bias re-ranks, it does not filter — but the
    // nearer one has overtaken the provider's own first result.
    expect(results.results.map((result) => result.displayName)).toEqual(['Near', 'Far']);
  });

  it('leaves the provider order alone when there is nothing to bias toward', async () => {
    const provider = stub('photon', {
      forward: [
        candidate({ source: 'photon', name: 'First', latitude: 52.5, longitude: 13.4, osmId: 'node/1' }),
        candidate({ source: 'photon', name: 'Second', latitude: 41.4, longitude: 2.17, osmId: 'node/2' }),
      ],
    });
    const results = await service([provider]).forward(QUERY, { gateway: fakeGateway() });
    expect(results.results.map((result) => result.displayName)).toEqual(['First', 'Second']);
  });
});

describe('endpoint modes', () => {
  it('keeps a provider that forbids autocomplete out of the interactive search', async () => {
    const interactive = stub('photon', {
      forward: [candidate({ source: 'photon', name: 'A', latitude: 41.4, longitude: 2.17, osmId: 'node/1' })],
    });
    const explicitOnly = stub('nominatim', {
      allowsInteractiveSearch: false,
      forward: [candidate({ source: 'nominatim', name: 'B', latitude: 41.5, longitude: 2.17, osmId: 'node/2' })],
    });
    const subject = service([interactive, explicitOnly]);

    const interactiveResults = await subject.search(QUERY, { gateway: fakeGateway() });
    const explicitResults = await subject.forward(QUERY, { gateway: fakeGateway() });

    expect(interactiveResults.providers).toEqual(['photon']);
    // The same provider may answer an explicit, user-initiated lookup.
    expect(explicitResults.providers).toEqual(['photon', 'nominatim']);
  });

  it('blends GoWay places into a reverse lookup', async () => {
    const place = buildPlace({ id: 'p1', name: 'Cafè Sagrada' });
    const provider = stub('photon', {
      reverse: [candidate({ source: 'photon', name: 'Carrer de Mallorca', latitude: 41.4036, longitude: 2.1744, osmId: 'node/9', kind: 'street' })],
    });

    const results = await service([provider]).reverse(
      { coordinate: { latitude: 41.4036, longitude: 2.1744 }, limit: 5 },
      { gateway: fakeGateway({ nearby: [{ ...place, distanceMeters: 8 }], places: [place] }) },
    );

    expect(results.providers).toEqual(['photon', 'goway']);
    expect(results.results.map((result) => result.source).sort()).toEqual(['goway', 'photon']);
  });

  it('skips a provider with no structured endpoint rather than degrading it', async () => {
    const unsupported = stub('nominatim', { structured: 'unsupported' });
    const supported = stub('photon', {
      structured: [candidate({ source: 'photon', name: '401 Carrer de Mallorca', latitude: 41.4, longitude: 2.17, osmId: 'node/1', kind: 'address' })],
    });

    const results = await service([unsupported, supported]).structured(
      { street: 'Carrer de Mallorca', houseNumber: '401', limit: 5 },
      { gateway: fakeGateway() },
    );

    // Not asked is not the same as failed: reporting it as degraded would tell
    // a client a source is down when it is merely not applicable.
    expect(results.providers).toEqual(['photon']);
    expect(results.degradedProviders).toBeUndefined();
  });
});

describe('caching', () => {
  it('serves a repeated global query from the cache', async () => {
    let calls = 0;
    const provider = stub('photon', {
      onForward: () => {
        calls += 1;
      },
      forward: [candidate({ source: 'photon', name: 'Berlin', latitude: 52.5, longitude: 13.4, osmId: 'node/1' })],
    });
    const subject = service([provider]);

    await subject.forward({ query: 'berlin', limit: 10 }, { gateway: fakeGateway() });
    await subject.forward({ query: 'berlin', limit: 10 }, { gateway: fakeGateway() });

    expect(calls).toBe(1);
  });

  it('never caches a request that carries a coordinate', async () => {
    let calls = 0;
    const provider = stub('photon', {
      onForward: () => {
        calls += 1;
      },
      forward: [],
    });
    const subject = service([provider]);
    const query = { query: 'berlin', limit: 10, near: { latitude: 52.5, longitude: 13.4 } };

    await subject.forward(query, { gateway: fakeGateway() });
    await subject.forward(query, { gateway: fakeGateway() });

    // The cache key would BE the user's precise location.
    expect(calls).toBe(2);
  });

  it('keys on the query text, so a different search is a different entry', async () => {
    let calls = 0;
    const provider = stub('photon', {
      onForward: () => {
        calls += 1;
      },
      forward: [],
    });
    const subject = createSearchService({
      providers: [provider],
      config: CONFIG,
      cache: new BoundedCache({ maxEntries: 10, ttlMs: 60_000 }),
    });

    await subject.forward({ query: 'berlin', limit: 10 }, { gateway: fakeGateway() });
    await subject.forward({ query: 'madrid', limit: 10 }, { gateway: fakeGateway() });
    expect(calls).toBe(2);
  });
});

describe('placeMatchesText', () => {
  it('folds diacritics so "cafe" finds "Café"', () => {
    expect(placeMatchesText(buildPlace({ name: 'Café Sagrada' }), 'cafe')).toBe(true);
  });

  it('matches on a category and on the street', () => {
    const place = buildPlace({ name: 'Nothing Relevant', categories: ['bakery'], address: { street: 'Gran Via' } });
    expect(placeMatchesText(place, 'bakery')).toBe(true);
    expect(placeMatchesText(place, 'gran via')).toBe(true);
    expect(placeMatchesText(place, 'pharmacy')).toBe(false);
  });
});
