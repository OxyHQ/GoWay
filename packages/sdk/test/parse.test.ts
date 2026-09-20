import { describe, expect, it } from 'vitest';
import { createGoWayClient, GoWayResponseError, placeDisplayName, type GoWayError } from '../src/index';
import { fakeFetch, rejection } from './helpers';
import { PLACE, PLACE_WITH_DISTANCE, ROUTE_RESPONSE, SEARCH_RESULTS } from './fixtures';

async function parsePlaceBody(body: unknown): Promise<GoWayError> {
  const { fetch } = fakeFetch(200, body);
  return rejection(createGoWayClient({ fetch }).places.get('gw_place_01H8'));
}

function without(source: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...source };
  delete copy[key];
  return copy;
}

describe('place parsing', () => {
  it('keeps exactly the contract keys and drops whatever else the server sent', async () => {
    const leaky = {
      ...PLACE,
      internalRowId: 42,
      geom: 'SRID=4326;POINT(2.1686 41.3874)',
      moderatorNote: 'do not show',
      claims: undefined,
    };
    const { fetch } = fakeFetch(200, leaky);
    const place = await createGoWayClient({ fetch }).places.get('gw_place_01H8');
    expect(Object.keys(place).sort()).toEqual([
      'address',
      'capabilities',
      'categories',
      'createdAt',
      'id',
      'location',
      'name',
      'sources',
      'status',
      'updatedAt',
      'verification',
    ]);
    expect(place).not.toHaveProperty('geom');
    expect(place).not.toHaveProperty('moderatorNote');
    // An absent `claims` is NOT an empty claim list: the caller simply may not
    // see them.
    expect(place).not.toHaveProperty('claims');
  });

  for (const field of ['id', 'location', 'status', 'verification', 'sources', 'capabilities', 'updatedAt']) {
    it(`rejects a place missing ${field}`, async () => {
      const error = await parsePlaceBody(without(PLACE, field));
      expect(error).toBeInstanceOf(GoWayResponseError);
      expect(error.message).toContain(`response.${field}`);
    });
  }

  it('rejects a coordinate that is not on Earth, including a transposed pair', async () => {
    const error = await parsePlaceBody({ ...PLACE, location: { latitude: 181, longitude: 2.1686 } });
    expect(error).toBeInstanceOf(GoWayResponseError);
    expect(error.message).toContain('latitude in [-90, 90]');
  });

  it('rejects a value outside a closed set rather than passing it through', async () => {
    const status = await parsePlaceBody({ ...PLACE, status: 'demolished' });
    expect(status).toBeInstanceOf(GoWayResponseError);
    expect(status.message).toContain('response.status');

    const verification = await parsePlaceBody({ ...PLACE, verification: { state: 'trust_me' } });
    expect(verification).toBeInstanceOf(GoWayResponseError);
  });

  it('refuses a capability with no provenance, and one whose key disagrees', async () => {
    const noProvenance = await parsePlaceBody({
      ...PLACE,
      capabilities: [
        { namespace: 'payments.faircoin', capability: 'accepted', key: 'payments.faircoin.accepted', value: true },
      ],
    });
    expect(noProvenance).toBeInstanceOf(GoWayResponseError);
    expect(noProvenance.message).toContain('verification');

    const wrongKey = await parsePlaceBody({
      ...PLACE,
      capabilities: [
        {
          namespace: 'payments.faircoin',
          capability: 'accepted',
          key: 'payments.faircoin.maybe',
          value: true,
          verification: 'community_reported',
          observedAt: '2026-02-01T09:30:00.000Z',
        },
      ],
    });
    expect(wrongKey).toBeInstanceOf(GoWayResponseError);
    expect(wrongKey.message).toContain('capabilities[0].key');
  });

  it('accepts an unknown source and an unknown capability namespace — both open sets', async () => {
    const { fetch } = fakeFetch(200, {
      ...PLACE,
      sources: [{ source: 'some_new_registry', sourceId: 'x/1' }],
      capabilities: [
        {
          namespace: 'energy.someone',
          capability: 'charging',
          key: 'energy.someone.charging',
          value: '22kW',
          verification: 'external_source',
          observedAt: '2026-02-01T09:30:00.000Z',
        },
      ],
    });
    const place = await createGoWayClient({ fetch }).places.get('p');
    expect(place.sources[0]?.source).toBe('some_new_registry');
    expect(place.capabilities[0]?.value).toBe('22kW');
  });

  it('fails a whole nearby page when one item is malformed', async () => {
    const { fetch } = fakeFetch(200, [PLACE_WITH_DISTANCE, { ...PLACE_WITH_DISTANCE, distanceMeters: -1 }]);
    const error = await rejection(
      createGoWayClient({ fetch }).places.nearby({ latitude: 0, longitude: 0, radiusMeters: 10 }),
    );
    expect(error).toBeInstanceOf(GoWayResponseError);
    expect(error.message).toContain('response[1].distanceMeters');
  });
});

describe('place names', () => {
  const NAMES = [
    { language: 'ca', name: 'Museu Picasso', source: 'openstreetmap' },
    { language: 'es', name: 'Museo Picasso', source: 'goway' },
  ];

  it('parses the name set and the resolved name field by field', async () => {
    const { fetch } = fakeFetch(200, {
      ...PLACE,
      names: NAMES.map((entry) => ({ ...entry, internalRowId: 7 })),
      localizedName: { ...NAMES[1], internalRowId: 8 },
    });
    const place = await createGoWayClient({ fetch }).places.get('p');
    expect(place.names).toEqual(NAMES);
    expect(place.names?.[0]).not.toHaveProperty('internalRowId');
    expect(place.localizedName).toEqual(NAMES[1]);
  });

  it('reads an absent name set as "not published here", never as empty', async () => {
    // A viewport read omits `names`. A UI that treated absent as "this place
    // has one name" would be wrong about every pin on the map.
    const { fetch } = fakeFetch(200, PLACE);
    const place = await createGoWayClient({ fetch }).places.get('p');
    expect(place).not.toHaveProperty('names');
    expect(place).not.toHaveProperty('localizedName');
  });

  it('rejects a malformed name rather than dropping it', async () => {
    const error = await parsePlaceBody({ ...PLACE, names: [{ language: 'es' }] });
    expect(error).toBeInstanceOf(GoWayResponseError);
    expect(error.message).toContain('response.names[0].name');
  });

  it('carries an unrecognised name source through', async () => {
    // The source registry is GoWay's to extend; an SDK that refused a new key
    // would break on the release that added one.
    const { fetch } = fakeFetch(200, {
      ...PLACE,
      names: [{ language: 'es', name: 'Museo Picasso', source: 'some_new_registry' }],
    });
    const place = await createGoWayClient({ fetch }).places.get('p');
    expect(place.names?.[0]?.source).toBe('some_new_registry');
  });

  it('placeDisplayName resolves, and falls back to the default name', () => {
    expect(placeDisplayName({ name: 'Museu Picasso' })).toBe('Museu Picasso');
    expect(
      placeDisplayName({ name: 'Museu Picasso', localizedName: NAMES[1]! }),
    ).toBe('Museo Picasso');
  });
});

describe('search and route parsing', () => {
  it('rejects a relevance outside 0..1 and a bad result kind', async () => {
    const { fetch } = fakeFetch(200, {
      ...SEARCH_RESULTS,
      results: [{ ...(SEARCH_RESULTS.results as Record<string, unknown>[])[0], relevance: 12 }],
    });
    const error = await rejection(createGoWayClient({ fetch }).search.query({ query: 'x' }));
    expect(error).toBeInstanceOf(GoWayResponseError);
    expect(error.message).toContain('results[0].relevance');
  });

  it('accepts an empty routes array as the normal "no route" answer', async () => {
    const { fetch } = fakeFetch(200, { routes: [] });
    const answer = await createGoWayClient({ fetch }).routes.directions({
      origin: { coordinate: { latitude: 0, longitude: 0 } },
      destination: { coordinate: { latitude: 1, longitude: 1 } },
      mode: 'drive',
    });
    expect(answer.routes).toEqual([]);
  });

  it('rejects route geometry that is not a LineString', async () => {
    const route = (ROUTE_RESPONSE.routes as Record<string, unknown>[])[0] as Record<string, unknown>;
    const { fetch } = fakeFetch(200, {
      routes: [{ ...route, geometry: { type: 'Point', coordinates: [2, 41] } }],
    });
    const error = await rejection(
      createGoWayClient({ fetch }).routes.directions({
        origin: { coordinate: { latitude: 0, longitude: 0 } },
        destination: { coordinate: { latitude: 1, longitude: 1 } },
        mode: 'walk',
      }),
    );
    expect(error).toBeInstanceOf(GoWayResponseError);
    expect(error.message).toContain('geometry.type');
  });

  it('rejects a GeoJSON position whose latitude is in the longitude slot', async () => {
    const route = (ROUTE_RESPONSE.routes as Record<string, unknown>[])[0] as Record<string, unknown>;
    const { fetch } = fakeFetch(200, {
      routes: [
        {
          ...route,
          // A transposed pair: the second position carries a LATITUDE of 95,
          // which only the ±90 bound can catch.
          geometry: { type: 'LineString', coordinates: [[2.1686, 41.3874], [41.39, 95]] },
        },
      ],
    });
    const error = await rejection(
      createGoWayClient({ fetch }).routes.directions({
        origin: { coordinate: { latitude: 0, longitude: 0 } },
        destination: { coordinate: { latitude: 1, longitude: 1 } },
        mode: 'walk',
      }),
    );
    expect(error).toBeInstanceOf(GoWayResponseError);
    expect(error.message).toContain('coordinates[1][1]');
    expect(error.message).toContain('latitude in [-90, 90]');
  });
});
