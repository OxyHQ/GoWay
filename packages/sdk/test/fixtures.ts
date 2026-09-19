/**
 * Valid wire bodies, exactly as the GoWay API is contracted to send them.
 *
 * Written as `unknown` literals rather than typed values on purpose: these
 * stand in for an untrusted response, and a test that builds them through the
 * contract types could not express a malformed one.
 */

export const PLACE: Record<string, unknown> = {
  id: 'gw_place_01H8',
  name: 'Cafè de la Plaça',
  location: { latitude: 41.3874, longitude: 2.1686 },
  categories: ['food.cafe'],
  status: 'active',
  verification: { state: 'owner_verified', verifiedAt: '2026-01-04T10:00:00.000Z' },
  sources: [{ source: 'openstreetmap', sourceId: 'node/12345', observedAt: '2026-01-01T00:00:00.000Z' }],
  capabilities: [
    {
      namespace: 'payments.faircoin',
      capability: 'accepted',
      key: 'payments.faircoin.accepted',
      value: true,
      verification: 'oxy_verified',
      observedAt: '2026-02-01T09:30:00.000Z',
    },
  ],
  address: { street: 'Carrer de Sants', city: 'Barcelona', countryCode: 'ES' },
  createdAt: '2025-12-01T00:00:00.000Z',
  updatedAt: '2026-02-01T09:30:00.000Z',
};

export const PLACE_WITH_DISTANCE: Record<string, unknown> = { ...PLACE, distanceMeters: 412.5 };

export const SEARCH_RESULTS: Record<string, unknown> = {
  results: [
    {
      id: 'photon:node/12345',
      displayName: 'Cafè de la Plaça, Barcelona',
      kind: 'poi',
      coordinate: { latitude: 41.3874, longitude: 2.1686 },
      source: 'photon',
      sourceId: 'node/12345',
      placeId: 'gw_place_01H8',
      relevance: 0.91,
    },
  ],
  providers: ['goway', 'photon'],
};

export const ROUTE_RESPONSE: Record<string, unknown> = {
  routes: [
    {
      id: 'route_1',
      mode: 'walk',
      distanceMeters: 820,
      durationSeconds: 610,
      geometry: {
        type: 'LineString',
        coordinates: [
          [2.1686, 41.3874],
          [2.1701, 41.3881],
        ],
      },
      legs: [
        {
          distanceMeters: 820,
          durationSeconds: 610,
          maneuvers: [
            {
              type: 'depart',
              instruction: 'Head north on Carrer de Sants',
              distanceMeters: 820,
              durationSeconds: 610,
              coordinate: { latitude: 41.3874, longitude: 2.1686 },
              geometryIndex: 0,
            },
          ],
        },
      ],
    },
  ],
};

/** The API's error envelope. */
export function errorBody(code: string, message = 'nope', details?: Record<string, unknown>): Record<string, unknown> {
  return { error: details === undefined ? { code, message } : { code, message, details } };
}
