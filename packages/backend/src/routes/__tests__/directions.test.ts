/**
 * `POST /routes`, over a real socket, with a fake engine and no database.
 *
 * The router is mounted here rather than through `createApp()` on purpose: what
 * is under test is this router's own contract — the request shape
 * `@goway.to/sdk` sends, the status and code each failure gets, and the place
 * resolution that happens before the engine is asked anything. Both of its
 * collaborators are injected, so none of it needs Oxy or Postgres.
 *
 * The mount below mirrors `app.ts`: the same `/api/v1` prefix the SDK builds
 * every URL on, and the same terminal handlers, because the error envelope is
 * the half of the contract a consumer branches on.
 */

import '../../__tests__/testEnv';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import express, { Router, type RequestHandler } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { GeoCoordinate, Route, TravelMode } from '@goway/shared-types';
import { errorHandler, notFoundHandler } from '../../http/errorHandler';
import type { RoutingProvider, RoutingRequest } from '../../routing';
import { createRoutesRouter, type PlaceLocationResolver } from '../directions';

/** Every route the fake engine returns, so an assertion has something to read. */
function sampleRoute(mode: TravelMode): Route {
  return {
    id: 'route-1',
    mode,
    distanceMeters: 635,
    durationSeconds: 90,
    geometry: {
      type: 'LineString',
      coordinates: [
        [2.17, 41.387],
        [2.1764, 41.3902],
      ],
    },
    legs: [
      {
        distanceMeters: 635,
        durationSeconds: 90,
        maneuvers: [
          {
            type: 'depart',
            instruction: 'Head north.',
            distanceMeters: 635,
            durationSeconds: 90,
            coordinate: { latitude: 41.387, longitude: 2.17 },
            geometryIndex: 0,
          },
        ],
      },
    ],
  };
}

/** The engine's last question, so a test can assert what it was asked. */
let lastRequest: RoutingRequest | null = null;
/** What the engine answers next. `[]` is "no route", which is a normal answer. */
let nextRoutes: Route[] = [];
/** Modes the fake deployment offers. */
let supportedModes: TravelMode[] = ['drive', 'walk', 'bike'];
/** Whether this deployment has an engine at all. */
let engineConfigured = true;
/** Places the fake repository knows. */
const PLACES = new Map<string, GeoCoordinate>([
  ['place-market', { latitude: 41.3819, longitude: 2.1716 }],
]);

const fakeProvider: RoutingProvider = {
  name: 'fake',
  get supportedModes() {
    return supportedModes;
  },
  route: (request) => {
    lastRequest = request;
    return Promise.resolve(nextRoutes);
  },
};

const resolvePlaceLocation: PlaceLocationResolver = (placeId) =>
  Promise.resolve(PLACES.get(placeId) ?? null);

/** Stands in for Oxy's optional auth: resolves nothing and continues. */
const passThroughAuth: RequestHandler = (_request, _response, next) => {
  next();
};

let server: Server;
let origin: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  const v1: Router = Router();
  v1.use(
    createRoutesRouter({
      optionalAuth: passThroughAuth,
      // `null` models a deployment with no engine configured, which is a
      // legitimate state rather than a misconfiguration.
      get provider() {
        return engineConfigured ? fakeProvider : null;
      },
      resolvePlaceLocation,
    }),
  );
  app.use('/api/v1', v1);
  app.use(notFoundHandler);
  app.use(errorHandler);

  // Port 0: the OS picks a free one. A fixed port makes the suite fail when
  // anything else on the machine happens to hold it.
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${String(port)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

interface Answer {
  status: number;
  body: { routes?: Route[]; error?: { code: string; message: string; details?: unknown } };
  headers: Headers;
}

async function directions(body: unknown): Promise<Answer> {
  lastRequest = null;
  const response = await fetch(`${origin}/api/v1/routes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return {
    status: response.status,
    body: (await response.json()) as Answer['body'],
    headers: response.headers,
  };
}

const COORDINATES = {
  origin: { coordinate: { latitude: 41.387, longitude: 2.17 } },
  destination: { coordinate: { latitude: 41.3902, longitude: 2.1764 } },
};

describe('POST /routes', () => {
  it('answers the SDK’s RouteResponse and nothing else', async () => {
    nextRoutes = [sampleRoute('drive')];
    engineConfigured = true;
    supportedModes = ['drive', 'walk', 'bike'];

    const answer = await directions({ ...COORDINATES, mode: 'drive' });
    expect(answer.status).toBe(200);
    // The body IS the contract value. No envelope, no pagination, no metadata.
    expect(Object.keys(answer.body)).toEqual(['routes']);
    expect(answer.body.routes).toHaveLength(1);
    expect(answer.body.routes?.[0].geometry.coordinates[0]).toEqual([2.17, 41.387]);
  });

  it('tells every cache in between not to keep the route', async () => {
    // A route is a user's precise movement. A shared cache holding one is a
    // location history nobody decided to keep.
    nextRoutes = [sampleRoute('drive')];
    const answer = await directions({ ...COORDINATES, mode: 'drive' });
    expect(answer.headers.get('cache-control')).toBe('no-store');
  });

  it('answers NO ROUTE as a 200 with an empty list', async () => {
    // Not an error: `RouteResponse.routes` may be empty, and a consumer must
    // render that as "there is no way to get there", not as a failure of GoWay.
    nextRoutes = [];
    const answer = await directions({ ...COORDINATES, mode: 'walk' });
    expect(answer.status).toBe(200);
    expect(answer.body.routes).toEqual([]);
  });

  it('passes origin, waypoints and destination to the engine in travel order', async () => {
    nextRoutes = [sampleRoute('drive')];
    await directions({
      ...COORDINATES,
      waypoints: [{ coordinate: { latitude: 41.3889, longitude: 2.1738 }, name: 'A stop' }],
      mode: 'drive',
      alternatives: true,
      locale: 'ca-ES',
    });

    const request = lastRequest as RoutingRequest | null;
    expect(request?.locations.map((point) => point.coordinate.latitude)).toEqual([
      41.387, 41.3889, 41.3902,
    ]);
    expect(request?.alternatives).toBe(true);
    expect(request?.locale).toBe('ca-ES');
  });
});

describe('place resolution', () => {
  it('resolves a placeId to the point GoWay says a router should aim at', async () => {
    nextRoutes = [sampleRoute('walk')];
    const answer = await directions({
      origin: COORDINATES.origin,
      destination: { placeId: 'place-market', name: 'La Boqueria' },
      mode: 'walk',
    });

    expect(answer.status).toBe(200);
    const request = lastRequest as RoutingRequest | null;
    expect(request?.locations[1].coordinate).toEqual({ latitude: 41.3819, longitude: 2.1716 });
    expect(request?.locations[1].name).toBe('La Boqueria');
  });

  it('answers not_found for an unknown placeId', async () => {
    const answer = await directions({
      origin: COORDINATES.origin,
      destination: { placeId: 'place-gone' },
      mode: 'walk',
    });
    expect(answer.status).toBe(404);
    expect(answer.body.error?.code).toBe('not_found');
    expect(lastRequest).toBeNull();
  });

  it('lets the place win when a caller sends BOTH, and still 404s an unknown one', async () => {
    // Falling back to the caller's coordinate would route to a point they
    // guessed while reporting success — and which point is routable is exactly
    // the knowledge a place id is sent to borrow.
    nextRoutes = [sampleRoute('walk')];
    const resolved = await directions({
      origin: COORDINATES.origin,
      destination: { placeId: 'place-market', coordinate: { latitude: 0, longitude: 0 } },
      mode: 'walk',
    });
    expect(resolved.status).toBe(200);
    expect((lastRequest as RoutingRequest | null)?.locations[1].coordinate).toEqual({
      latitude: 41.3819,
      longitude: 2.1716,
    });

    const unknown = await directions({
      origin: COORDINATES.origin,
      destination: { placeId: 'place-gone', coordinate: { latitude: 41.3, longitude: 2.1 } },
      mode: 'walk',
    });
    expect(unknown.status).toBe(404);
  });
});

describe('mode validation', () => {
  it('answers unsupported_mode for a mode outside the contract', async () => {
    // `transit` is a well-formed question GoWay cannot answer yet. Reporting it
    // as `validation_failed` would tell an integrator their request was
    // malformed; `unsupported_mode` is something a client can hide a button on.
    const answer = await directions({ ...COORDINATES, mode: 'transit' });
    expect(answer.status).toBe(422);
    expect(answer.body.error?.code).toBe('unsupported_mode');
    expect(answer.body.error?.details).toMatchObject({ mode: 'transit' });
    expect(lastRequest).toBeNull();
  });

  it('answers unsupported_mode for a mode this deployment switched off', async () => {
    supportedModes = ['drive', 'walk'];
    const answer = await directions({ ...COORDINATES, mode: 'bike' });
    expect(answer.status).toBe(422);
    expect(answer.body.error?.code).toBe('unsupported_mode');
    supportedModes = ['drive', 'walk', 'bike'];
  });

  it('answers bad_request when mode is missing altogether', async () => {
    const answer = await directions({ ...COORDINATES });
    expect(answer.status).toBe(400);
    expect(answer.body.error?.code).toBe('bad_request');
  });
});

describe('request validation', () => {
  it('refuses a location carrying neither a coordinate nor a placeId', async () => {
    const answer = await directions({
      origin: { name: 'somewhere' },
      destination: COORDINATES.destination,
      mode: 'drive',
    });
    expect(answer.status).toBe(422);
    expect(answer.body.error?.code).toBe('validation_failed');
  });

  it('refuses a latitude that is not on Earth', async () => {
    const answer = await directions({
      origin: { coordinate: { latitude: 120, longitude: 2.17 } },
      destination: COORDINATES.destination,
      mode: 'drive',
    });
    expect(answer.status).toBe(422);
    expect(answer.body.error?.code).toBe('validation_failed');
  });

  it('never echoes the offending coordinate back', async () => {
    // A validation failure on a coordinate must not be the thing that writes
    // the coordinate down — `details` is what an integrator logs verbatim.
    const answer = await directions({
      origin: { coordinate: { latitude: 120, longitude: 2.171717 } },
      destination: COORDINATES.destination,
      mode: 'drive',
    });
    expect(JSON.stringify(answer.body)).not.toContain('2.171717');
    expect(JSON.stringify(answer.body)).not.toContain('120');
  });

  it('treats a coordinate sent as a string as a malformed request', async () => {
    const answer = await directions({
      origin: { coordinate: { latitude: '41.387', longitude: '2.17' } },
      destination: COORDINATES.destination,
      mode: 'drive',
    });
    expect(answer.status).toBe(400);
    expect(answer.body.error?.code).toBe('bad_request');
  });

  it('refuses more waypoints than the engine profiles accept', async () => {
    const answer = await directions({
      ...COORDINATES,
      mode: 'drive',
      waypoints: Array.from({ length: 9 }, (_unused, index) => ({
        coordinate: { latitude: 41.38 + index / 1000, longitude: 2.17 },
      })),
    });
    expect(answer.status).toBe(422);
    expect(answer.body.error?.code).toBe('validation_failed');
  });

  it('refuses a locale that is not a language tag', async () => {
    const answer = await directions({ ...COORDINATES, mode: 'drive', locale: 'not a tag' });
    expect(answer.status).toBe(422);
    expect(answer.body.error?.code).toBe('validation_failed');
  });

  it('ignores a field this backend has not learned yet', async () => {
    // A newer SDK must not 400 against an older backend.
    nextRoutes = [sampleRoute('drive')];
    const answer = await directions({ ...COORDINATES, mode: 'drive', avoidTolls: true });
    expect(answer.status).toBe(200);
  });
});

describe('a deployment with no routing engine', () => {
  it('answers service_unavailable, not provider_unavailable', async () => {
    // `provider_unavailable` would tell a caller the map data source is down
    // and invite a retry that cannot succeed until an operator acts.
    engineConfigured = false;
    const answer = await directions({ ...COORDINATES, mode: 'drive' });
    expect(answer.status).toBe(503);
    expect(answer.body.error?.code).toBe('service_unavailable');
    engineConfigured = true;
  });
});
