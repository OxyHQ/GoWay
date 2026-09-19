/**
 * The Photon adapter, against real-shaped payloads.
 *
 * The cases that matter are the ones a reviewer cannot see by reading the
 * mapping: the `extent` axis order, the kilometre reverse radius, and the fact
 * that a viewport must NOT become a `bbox`. Each of those produces a plausible
 * wrong answer rather than an error, which is precisely why they are tested.
 */

import { describe, expect, it } from 'bun:test';
import { createPhotonProvider } from '../photonProvider';
import type { PhotonConfig } from '../../config/search';
import { jsonResponse, paramsOf, recordingFetch } from './fixtures';

const CONFIG: PhotonConfig = { baseUrl: 'https://photon.example', languages: ['de', 'en', 'fr', 'it'] };

/** `GET /api?q=berlin` against photon.komoot.io, trimmed to one feature. */
const BERLIN = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [13.3888599, 52.5170365] },
      properties: {
        osm_id: 240109189,
        osm_type: 'N',
        osm_key: 'place',
        osm_value: 'city',
        // [minLon, maxLat, maxLon, minLat] — west, NORTH, east, SOUTH.
        extent: [13.0882097, 52.6755087, 13.7611609, 52.3382448],
        country: 'Germany',
        countrycode: 'DE',
        state: 'Berlin',
        city: 'Berlin',
        name: 'Berlin',
        type: 'city',
      },
    },
  ],
};

/** A named café that carries a house number — Photon calls it `type: "house"`. */
const CAFE = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [2.1744, 41.4036] },
      properties: {
        osm_id: 1234567,
        osm_type: 'W',
        osm_key: 'amenity',
        osm_value: 'cafe',
        name: 'Cafè Sagrada',
        housenumber: '401',
        street: 'Carrer de Mallorca',
        district: 'La Sagrada Família',
        city: 'Barcelona',
        state: 'Catalonia',
        postcode: '08013',
        countrycode: 'es',
        country: 'Spain',
        type: 'house',
      },
    },
  ],
};

function provider(handler: (url: string) => Response) {
  const recorder = recordingFetch(handler);
  return {
    recorder,
    photon: createPhotonProvider({ config: CONFIG, fetch: recorder.fetch, timeoutMs: 1_000, attempts: 1 }),
  };
}

describe('the Photon adapter', () => {
  it('normalizes a city, reading `extent` as west/north/east/south', async () => {
    const { photon } = provider(() => jsonResponse(BERLIN));
    const [candidate] = await photon.forward({ query: 'berlin', limit: 5 });

    expect(candidate?.result).toMatchObject({
      id: 'photon:node/240109189',
      displayName: 'Berlin, Germany',
      kind: 'locality',
      coordinate: { latitude: 52.5170365, longitude: 13.3888599 },
      source: 'photon',
      sourceId: 'node/240109189',
    });
    // Read positionally as [west, south, east, north] this box would have
    // south > north — legal arithmetic, wrong rectangle, no error anywhere.
    expect(candidate?.result.boundingBox).toEqual({
      west: 13.0882097,
      south: 52.3382448,
      east: 13.7611609,
      north: 52.6755087,
    });
    expect(candidate?.osmRef).toEqual({ source: 'openstreetmap', sourceId: 'node/240109189' });
  });

  it('invents nothing the payload did not carry', async () => {
    const { photon } = provider(() => jsonResponse(BERLIN));
    const [candidate] = await photon.forward({ query: 'berlin', limit: 5 });

    expect(candidate?.result.address).toEqual({
      city: 'Berlin',
      region: 'Berlin',
      countryCode: 'DE',
      country: 'Germany',
    });
    // No postcode in the payload, so none in the result: an inferred one is
    // indistinguishable downstream from a real one.
    expect(candidate?.result.address?.postalCode).toBeUndefined();
    expect(candidate?.result.address?.street).toBeUndefined();
    // Photon publishes no single-line rendering and no score.
    expect(candidate?.result.address?.formatted).toBeUndefined();
    expect(candidate?.result.relevance).toBeUndefined();
  });

  it('classifies a named amenity as a POI even though Photon types it "house"', async () => {
    const { photon } = provider(() => jsonResponse(CAFE));
    const [candidate] = await photon.forward({ query: 'cafe', limit: 5 });

    expect(candidate?.result.kind).toBe('poi');
    expect(candidate?.result.displayName).toBe(
      'Cafè Sagrada, La Sagrada Família, Barcelona, Catalonia, Spain',
    );
    expect(candidate?.result.address).toEqual({
      houseNumber: '401',
      street: 'Carrer de Mallorca',
      locality: 'La Sagrada Família',
      city: 'Barcelona',
      region: 'Catalonia',
      postalCode: '08013',
      // Lower-case in the payload; the contract says uppercase.
      countryCode: 'ES',
      country: 'Spain',
    });
    expect(candidate?.result.context).toEqual({
      city: 'Barcelona',
      region: 'Catalonia',
      country: 'Spain',
      countryCode: 'ES',
    });
    expect(candidate?.result.sourceId).toBe('way/1234567');
  });

  it('biases a viewport to its centre and never sends a bbox', async () => {
    const { photon, recorder } = provider(() => jsonResponse({ type: 'FeatureCollection', features: [] }));
    await photon.forward({
      query: 'museum',
      limit: 5,
      viewport: { west: 2.0, south: 41.3, east: 2.2, north: 41.5 },
    });

    const params = paramsOf(recorder.urls[0] ?? '');
    // `bbox` FILTERS in Photon; the contract says a viewport only re-ranks.
    expect(params.get('bbox')).toBeNull();
    expect(Number(params.get('lat'))).toBeCloseTo(41.4, 6);
    expect(Number(params.get('lon'))).toBeCloseTo(2.1, 6);
  });

  it('prefers an explicit `near` over the viewport', async () => {
    const { photon, recorder } = provider(() => jsonResponse({ type: 'FeatureCollection', features: [] }));
    await photon.forward({
      query: 'museum',
      limit: 5,
      near: { latitude: 52.5, longitude: 13.4 },
      viewport: { west: 2.0, south: 41.3, east: 2.2, north: 41.5 },
    });

    const params = paramsOf(recorder.urls[0] ?? '');
    expect(params.get('lat')).toBe('52.5');
    expect(params.get('lon')).toBe('13.4');
  });

  it('sends `lang` only for a language the instance was built with', async () => {
    const { photon, recorder } = provider(() => jsonResponse({ type: 'FeatureCollection', features: [] }));
    await photon.forward({ query: 'a', limit: 1, locale: 'fr-CA' });
    await photon.forward({ query: 'a', limit: 1, locale: 'es-ES' });

    expect(paramsOf(recorder.urls[0] ?? '').get('lang')).toBe('fr');
    // Photon answers 400 for a language it does not carry, so it is dropped.
    expect(paramsOf(recorder.urls[1] ?? '').get('lang')).toBeNull();
  });

  it('forwards only categories spelled as an explicit OSM tag', async () => {
    const { photon, recorder } = provider(() => jsonResponse({ type: 'FeatureCollection', features: [] }));
    await photon.forward({ query: 'coffee', limit: 5, categories: ['amenity:cafe', 'speciality-coffee'] });

    const tags = paramsOf(recorder.urls[0] ?? '').getAll('osm_tag');
    expect(tags).toEqual(['amenity:cafe']);
  });

  it('converts the reverse radius from metres to kilometres', async () => {
    const { photon, recorder } = provider(() => jsonResponse({ type: 'FeatureCollection', features: [] }));
    await photon.reverse({ coordinate: { latitude: 41.4, longitude: 2.17 }, limit: 3, radiusMeters: 500 });

    const params = paramsOf(recorder.urls[0] ?? '');
    // Photon's `radius` is in KILOMETRES. Passing 500 would search 500 km.
    expect(params.get('radius')).toBe('0.5');
    expect(params.get('lat')).toBe('41.4');
  });

  it('sends the structured parameters Photon names', async () => {
    const { photon, recorder } = provider(() => jsonResponse({ type: 'FeatureCollection', features: [] }));
    await photon.structured?.({
      street: 'Carrer de Mallorca',
      houseNumber: '401',
      postalCode: '08013',
      city: 'Barcelona',
      countryCode: 'ES',
      limit: 3,
    });

    const params = paramsOf(recorder.urls[0] ?? '');
    expect(recorder.urls[0]).toContain('/structured?');
    expect(params.get('housenumber')).toBe('401');
    expect(params.get('postcode')).toBe('08013');
    expect(params.get('countrycode')).toBe('ES');
  });

  it('drops one unusable feature rather than the whole response', async () => {
    const { photon } = provider(() =>
      jsonResponse({
        type: 'FeatureCollection',
        features: [
          { type: 'Feature', geometry: { type: 'Point', coordinates: [999, 999] }, properties: { name: 'Nowhere' } },
          ...BERLIN.features,
        ],
      }),
    );
    const candidates = await photon.forward({ query: 'berlin', limit: 5 });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.result.displayName).toBe('Berlin, Germany');
  });

  it('treats a 200 that is not a FeatureCollection as a provider failure', async () => {
    const { photon } = provider(() => jsonResponse({ message: 'maintenance' }));
    // Reporting this as "no matches" would hide an outage behind a blank
    // search box for as long as it lasted.
    await expect(photon.forward({ query: 'berlin', limit: 5 })).rejects.toThrow(/photon/);
  });

  it('permits interactive use', () => {
    const { photon } = provider(() => jsonResponse(BERLIN));
    expect(photon.allowsInteractiveSearch).toBe(true);
  });
});
