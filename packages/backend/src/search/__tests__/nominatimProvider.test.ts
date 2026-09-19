/**
 * The Nominatim adapter.
 *
 * Two of these cases are policy rather than parsing: the adapter must refuse to
 * be an interactive provider, and it must identify GoWay on every request. Both
 * are conditions of using the public instance at all.
 */

import { describe, expect, it } from 'bun:test';
import type { NominatimConfig } from '../../config/search';
import { createNominatimProvider } from '../nominatimProvider';
import { jsonResponse, paramsOf, recordingFetch } from './fixtures';

const CONFIG: NominatimConfig = {
  baseUrl: 'https://nominatim.example',
  userAgent: 'GoWay/0.1 (+https://goway.to)',
  email: 'ops@goway.to',
};

/** `GET /search?q=berlin&format=jsonv2&addressdetails=1`, trimmed to one hit. */
const BERLIN = [
  {
    place_id: 297983214,
    licence: 'Data © OpenStreetMap contributors, ODbL 1.0.',
    osm_type: 'relation',
    osm_id: 62422,
    // STRINGS, not numbers.
    lat: '52.5170365',
    lon: '13.3888599',
    category: 'boundary',
    type: 'administrative',
    place_rank: 12,
    importance: 0.8055,
    addresstype: 'city',
    name: 'Berlin',
    display_name: 'Berlin, Deutschland',
    // [south, north, west, east] — LATITUDES first, as strings.
    boundingbox: ['52.3382448', '52.6755087', '13.0882097', '13.7611609'],
    address: { city: 'Berlin', state: 'Berlin', country: 'Deutschland', country_code: 'de' },
  },
];

function provider(handler: (url: string) => Response) {
  const recorder = recordingFetch(handler);
  return {
    recorder,
    nominatim: createNominatimProvider({ config: CONFIG, fetch: recorder.fetch, timeoutMs: 1_000, attempts: 1 }),
  };
}

describe('the Nominatim adapter', () => {
  it('refuses to be an interactive provider', () => {
    const { nominatim } = provider(() => jsonResponse([]));
    // The OSMF usage policy forbids autocomplete against the public instance.
    // This is a constant, not a setting: no environment variable turns it on.
    expect(nominatim.allowsInteractiveSearch).toBe(false);
  });

  it('identifies GoWay on every request, as the usage policy requires', async () => {
    const { nominatim, recorder } = provider(() => jsonResponse([]));
    await nominatim.forward({ query: 'berlin', limit: 5 });

    const headers = recorder.inits[0]?.headers as Record<string, string>;
    expect(headers['User-Agent']).toBe('GoWay/0.1 (+https://goway.to)');
    expect(paramsOf(recorder.urls[0] ?? '').get('email')).toBe('ops@goway.to');
    expect(paramsOf(recorder.urls[0] ?? '').get('format')).toBe('jsonv2');
  });

  it('normalizes a city, reading `boundingbox` as south/north/west/east', async () => {
    const { nominatim } = provider(() => jsonResponse(BERLIN));
    const [candidate] = await nominatim.forward({ query: 'berlin', limit: 5 });

    expect(candidate?.result).toMatchObject({
      id: 'nominatim:relation/62422',
      displayName: 'Berlin, Deutschland',
      kind: 'locality',
      source: 'nominatim',
      sourceId: 'relation/62422',
      relevance: 0.8055,
    });
    // The strings become numbers, and the axes stay where they belong.
    expect(candidate?.result.coordinate).toEqual({ latitude: 52.5170365, longitude: 13.3888599 });
    expect(candidate?.result.boundingBox).toEqual({
      west: 13.0882097,
      south: 52.3382448,
      east: 13.7611609,
      north: 52.6755087,
    });
    // Nominatim DOES publish a single-line rendering, so this one is a source
    // fact rather than a label GoWay composed.
    expect(candidate?.result.address?.formatted).toBe('Berlin, Deutschland');
    expect(candidate?.result.address?.countryCode).toBe('DE');
    expect(candidate?.result.address?.postalCode).toBeUndefined();
  });

  it('never keys identity on `place_id`, which Nominatim documents as unstable', async () => {
    const { nominatim } = provider(() => jsonResponse(BERLIN));
    const [candidate] = await nominatim.forward({ query: 'berlin', limit: 5 });
    expect(candidate?.result.id).not.toContain('297983214');
    expect(candidate?.osmRef).toEqual({ source: 'openstreetmap', sourceId: 'relation/62422' });
  });

  it('reads a reverse answer, which is ONE object rather than an array', async () => {
    const { nominatim } = provider(() =>
      jsonResponse({
        osm_type: 'way',
        osm_id: 90394420,
        lat: '52.54877',
        lon: '13.35771',
        category: 'highway',
        type: 'residential',
        display_name: 'Lynarstraße, Gesundbrunnen, Berlin, Deutschland',
        address: { road: 'Lynarstraße', suburb: 'Gesundbrunnen', city: 'Berlin', country_code: 'de' },
      }),
    );
    const candidates = await nominatim.reverse({ coordinate: { latitude: 52.5, longitude: 13.3 }, limit: 1 });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.result.kind).toBe('street');
    expect(candidates[0]?.result.address?.street).toBe('Lynarstraße');
    expect(candidates[0]?.result.address?.locality).toBe('Gesundbrunnen');
  });

  it('reads a reverse miss as an empty result rather than a failure', async () => {
    const { nominatim } = provider(() => jsonResponse({ error: 'Unable to geocode' }));
    // There is genuinely nothing at that point; that is not an outage.
    await expect(
      nominatim.reverse({ coordinate: { latitude: 0, longitude: 0 }, limit: 1 }),
    ).resolves.toEqual([]);
  });

  it('joins house number and street for the structured lookup Nominatim documents', async () => {
    const { nominatim, recorder } = provider(() => jsonResponse([]));
    await nominatim.structured?.({
      street: 'Carrer de Mallorca',
      houseNumber: '401',
      city: 'Barcelona',
      countryCode: 'ES',
      limit: 3,
    });

    const params = paramsOf(recorder.urls[0] ?? '');
    // Nominatim's `street` parameter is "housenumber and streetname".
    expect(params.get('street')).toBe('401 Carrer de Mallorca');
    expect(params.get('countrycodes')).toBe('es');
    // Mixing `q` with the structured parameters is refused by Nominatim.
    expect(params.get('q')).toBeNull();
  });

  it('sends a viewport as an unbounded viewbox, which re-ranks rather than filters', async () => {
    const { nominatim, recorder } = provider(() => jsonResponse([]));
    await nominatim.forward({
      query: 'museum',
      limit: 5,
      viewport: { west: 2.0, south: 41.3, east: 2.2, north: 41.5 },
    });

    const params = paramsOf(recorder.urls[0] ?? '');
    expect(params.get('viewbox')).toBe('2,41.5,2.2,41.3');
    // `bounded=1` is what would turn the bias into a filter.
    expect(params.get('bounded')).toBeNull();
  });

  it('classifies a shop as a POI and a house as an address', async () => {
    const { nominatim } = provider(() =>
      jsonResponse([
        {
          osm_type: 'node',
          osm_id: 1,
          lat: '41.4',
          lon: '2.1',
          category: 'shop',
          type: 'bakery',
          display_name: 'Forn, Barcelona',
        },
        {
          osm_type: 'way',
          osm_id: 2,
          lat: '41.5',
          lon: '2.2',
          category: 'place',
          type: 'house',
          display_name: '401, Carrer de Mallorca, Barcelona',
          address: { house_number: '401', road: 'Carrer de Mallorca' },
        },
      ]),
    );
    const candidates = await nominatim.forward({ query: 'forn', limit: 5 });
    expect(candidates.map((candidate) => candidate.result.kind)).toEqual(['poi', 'address']);
  });
});
