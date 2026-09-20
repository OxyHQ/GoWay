/**
 * The two CORS lanes, over a real socket.
 *
 * What is under test is a SECURITY BOUNDARY, so the assertions are about
 * headers rather than status codes, and about headers being ABSENT as much as
 * present: the thing a browser does with a credentialed cross-origin response
 * that carries no `Access-Control-Allow-Origin` is throw it away, and a suite
 * that only checked statuses would pass while the boundary was gone.
 *
 * Three apps, each for something the others cannot show:
 *
 *   - `app`, the real `createApp()`. It proves the lane is chosen for the paths
 *     the API actually serves, at the prefix it actually mounts them on, and it
 *     is where every credentialed-lane case runs. Its public routes reach
 *     handlers that want a database this suite deliberately does not have, so
 *     those cases assert the lane and not the status — the lane is chosen by a
 *     middleware that runs long before any handler, which is exactly why it can
 *     be measured without one.
 *
 *   - `publicSurface`, which mirrors `app.ts`'s middleware order — helmet, then
 *     `createGoWayCors`, then the body parser — in front of trivial handlers
 *     registered FROM `PUBLIC_READ_ROUTES` itself. That is what a real 200
 *     looks like on every public route, and registering from the table means
 *     the fixture cannot drift from the policy it is measuring.
 *
 *   - the routers, built directly with sentinel guards, for the structural
 *     case: nothing the table admits may be mounted behind `requireAuth`.
 *
 * `./testEnv` FIRST — `src/config` parses at module load, so the environment
 * has to exist before anything downstream of it is evaluated. It sets
 * `CORS_APP_ORIGINS=http://localhost:8081`, which is the allowlisted origin
 * these tests use.
 */

import '../../__tests__/testEnv';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import express, { Router, type Express, type RequestHandler } from 'express';
import helmet from 'helmet';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../app';
import { createCaptureRouter } from '../../routes/capture';
import { createRoutesRouter } from '../../routes/directions';
import { createPlacesRouter } from '../../routes/places';
import { createSearchRouter } from '../../routes/search';
import { createGoWayCors, isPublicReadRequest, PUBLIC_READ_ROUTES } from '../cors';

/** The prefix `app.ts` mounts the API on, restated so a drift is a failure. */
const BASE = '/api/v1';

/** An origin in no allowlist. The site that found this bug, in fact. */
const FOREIGN = 'https://homiio.com';

/** `testEnv`'s `CORS_APP_ORIGINS` entry — the credentialed lane's allowlist. */
const ALLOWLISTED = 'http://localhost:8081';

/** A path template's `:params` filled in, so it can actually be requested. */
function concretePath(template: string): string {
  return template
    .split('/')
    .map((segment) => (segment.startsWith(':') ? 'sample-value' : segment))
    .join('/');
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const servers: Server[] = [];

/** Listen on an OS-chosen port and return the origin to fetch. */
async function listen(application: Express): Promise<string> {
  const server = application.listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${String(port)}`;
}

/**
 * `app.ts`'s middleware order in front of stub handlers at the real public
 * paths.
 *
 * The order is the load-bearing part and it is copied deliberately: CORS ahead
 * of the body parser, because a preflight must be answered before anything
 * reads a body for it.
 */
function buildPublicSurface(): Express {
  const application = express();
  application.disable('x-powered-by');
  application.use(helmet());
  application.use(createGoWayCors({ appOrigins: [ALLOWLISTED] }));
  application.use(express.json({ limit: '1mb' }));

  const v1: Router = Router();
  for (const route of PUBLIC_READ_ROUTES) {
    const handler: RequestHandler = (_request, response) => {
      response.json({ ok: true });
    };
    if (route.method === 'GET') v1.get(route.path, handler);
    else v1.post(route.path, handler);
  }
  application.use(BASE, v1);
  return application;
}

let appOrigin: string;
let publicSurfaceOrigin: string;

beforeAll(async () => {
  appOrigin = await listen(createApp());
  publicSurfaceOrigin = await listen(buildPublicSurface());
});

afterAll(async () => {
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

// ---------------------------------------------------------------------------
// The public lane
// ---------------------------------------------------------------------------

describe('a public read from a foreign origin', () => {
  it('answers 200 with a wildcard and no credentials header, on every route in the table', async () => {
    // The measured blocker, route by route: before this lane existed, every one
    // of these answered with no `Access-Control-Allow-Origin` at all and a
    // browser discarded the body.
    for (const route of PUBLIC_READ_ROUTES) {
      const url = `${publicSurfaceOrigin}${BASE}${concretePath(route.path)}`;
      const response = await fetch(url, {
        method: route.method,
        headers:
          route.method === 'POST'
            ? { origin: FOREIGN, 'content-type': 'application/json' }
            : { origin: FOREIGN },
        ...(route.method === 'POST' ? { body: '{}' } : {}),
      });

      expect(`${route.method} ${route.path}: ${String(response.status)}`).toBe(
        `${route.method} ${route.path}: 200`,
      );
      expect(response.headers.get('access-control-allow-origin')).toBe('*');
      // The pairing the spec forbids and browsers enforce. Its absence is the
      // whole licence for the wildcard above.
      expect(response.headers.get('access-control-allow-credentials')).toBeNull();
    }
  });

  it('answers the wildcard on the REAL app, at the real mount prefix', async () => {
    // Status is not asserted: these handlers want a database this suite does
    // not have. The lane is chosen by a middleware that runs before the router,
    // which is why it is measurable anyway — and why the prefix in
    // `middleware/cors.ts` matching `app.ts`'s mount is what this case is for.
    const response = await fetch(
      `${appOrigin}${BASE}/places/nearby?latitude=41.38&longitude=2.17`,
      { headers: { origin: FOREIGN } },
    );
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('access-control-allow-credentials')).toBeNull();
    expect(response.headers.get('vary')).toBeNull();
  });

  it('does not set Vary: Origin, because the answer is the same for every origin', async () => {
    // A `*` response that also said `Vary: Origin` would make a shared cache
    // keep one identical copy per origin it ever saw.
    const response = await fetch(`${publicSurfaceOrigin}${BASE}/search`, {
      headers: { origin: FOREIGN },
    });
    expect(response.headers.get('vary')).toBeNull();
  });

  it('answers the same wildcard when the request carries no Origin at all', async () => {
    // curl, a server-side fetch and a native app send no `Origin` and are not
    // subject to CORS, so the header changes nothing for them. It is emitted
    // anyway so that the response a CDN caches is correct for a browser too —
    // an Origin-CONDITIONAL wildcard is a response that varies by request
    // header while claiming not to.
    const response = await fetch(`${publicSurfaceOrigin}${BASE}/search`);
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(await response.json()).toEqual({ ok: true });
  });

  it('answers an allowlisted origin with the wildcard too, not an echo', async () => {
    // The first-party app gets the public lane on a public route like anybody
    // else. It needs no credentials there, and one cached copy serves everyone.
    const response = await fetch(`${publicSurfaceOrigin}${BASE}/search`, {
      headers: { origin: ALLOWLISTED },
    });
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('access-control-allow-credentials')).toBeNull();
  });
});

describe('the public preflight', () => {
  it('answers OPTIONS for POST /routes from a foreign origin', async () => {
    // `POST /routes` is a read whose arguments do not fit in a query string.
    // Its JSON body makes it non-simple, so a browser asks permission first —
    // and if this preflight is not answered, the route is unreachable
    // cross-origin however the real response is headed.
    const response = await fetch(`${appOrigin}${BASE}/routes`, {
      method: 'OPTIONS',
      headers: {
        origin: FOREIGN,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('access-control-allow-methods')).toBe('POST, OPTIONS');
    expect(response.headers.get('access-control-allow-headers')).toBe('Content-Type');
    expect(response.headers.get('access-control-max-age')).toBe('86400');
    expect(response.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('does not admit Authorization on the public lane', async () => {
    // Not because a Bearer token could be stolen — it cannot be sent ambiently
    // — but because an authenticated read has a caller-specific body, and this
    // lane's cacheability rests on its bodies being identical for everyone.
    // A third-party site that needs an authenticated read gets its origin added
    // to CORS_APP_ORIGINS and the strict lane with it.
    //
    // This originally asserted that the request stayed HERE and was answered
    // `Content-Type` — which is what the comment above says must not happen,
    // and what broke every signed-in first-party read. The request is now
    // routed off this lane by `carriesAuthorization`, so what a foreign origin
    // gets is the strict lane's refusal: no CORS headers at all.
    const response = await fetch(`${appOrigin}${BASE}/places/sample-value`, {
      method: 'OPTIONS',
      headers: {
        origin: FOREIGN,
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization',
      },
    });
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(response.headers.get('access-control-allow-headers')).toBeNull();
  });

  it('refuses a preflight that asks about a method the table does not admit', async () => {
    // `DELETE /places/:id/capabilities/:key` exists and is behind requireAuth.
    // Asking about DELETE on a path whose GET is public must not borrow the
    // GET's answer.
    const response = await fetch(`${appOrigin}${BASE}/places/sample-value`, {
      method: 'OPTIONS',
      headers: { origin: FOREIGN, 'access-control-request-method': 'DELETE' },
    });
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(response.headers.get('access-control-allow-methods')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The credentialed lane, unchanged
// ---------------------------------------------------------------------------

describe('a credentialed route', () => {
  it('gives a NON-allowlisted origin no Access-Control-Allow-Origin at all', async () => {
    // The case that matters. `POST /places` is behind `requireAuth`; a browser
    // on homiio.com must not be able to read this response whatever it
    // contains, and the way it is stopped is the absence of this header — not
    // the 401, which a different deployment could turn into a 200.
    const response = await fetch(`${appOrigin}${BASE}/places`, {
      method: 'POST',
      headers: { origin: FOREIGN, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Anything' }),
    });

    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(response.headers.get('access-control-allow-credentials')).toBeNull();
    // And it was genuinely served rather than failing to connect, so the
    // absence above is a policy decision and not a dead socket.
    expect(response.status).toBe(401);
  });

  it('gives a non-allowlisted origin nothing on a credentialed READ either', async () => {
    // `GET /places/:id/claims` is one account's claim history. It is a GET, it
    // lives under `/places`, and it is exactly what a prefix rule or a
    // "GETs are public" convention would have leaked.
    const response = await fetch(`${appOrigin}${BASE}/places/sample-value/claims`, {
      headers: { origin: FOREIGN },
    });
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('gives a non-allowlisted origin nothing on its preflight', async () => {
    const response = await fetch(`${appOrigin}${BASE}/places`, {
      method: 'OPTIONS',
      headers: {
        origin: FOREIGN,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,authorization',
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(response.headers.get('access-control-allow-methods')).toBeNull();
  });

  it('echoes an allowlisted origin exactly, with credentials and Vary: Origin', async () => {
    const response = await fetch(`${appOrigin}${BASE}/places`, {
      method: 'POST',
      headers: { origin: ALLOWLISTED, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Anything' }),
    });

    expect(response.headers.get('access-control-allow-origin')).toBe(ALLOWLISTED);
    expect(response.headers.get('access-control-allow-credentials')).toBe('true');
    // The exact echo is what makes a credentialed response safe, and it is only
    // safe if a cache keys on the origin that produced it.
    expect(response.headers.get('vary')).toBe('Origin');
    expect(response.status).toBe(401);
  });

  it('answers an allowlisted preflight with the shared helper, untouched', async () => {
    const response = await fetch(`${appOrigin}${BASE}/places`, {
      method: 'OPTIONS',
      headers: {
        origin: ALLOWLISTED,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,authorization',
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe(ALLOWLISTED);
    expect(response.headers.get('access-control-allow-credentials')).toBe('true');
    expect(response.headers.get('access-control-allow-headers')).toBe('content-type,authorization');
  });
});

describe('an unrecognised request', () => {
  it('falls to the strict lane rather than the wildcard', async () => {
    // Fail-closed, stated as a test: a path in no table gets the allowlist.
    const response = await fetch(`${appOrigin}${BASE}/no/such/route`, {
      headers: { origin: FOREIGN },
    });
    expect(response.status).toBe(404);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('falls to the strict lane for a method the table does not admit', async () => {
    // `/search` is public for GET. A POST to it is not in the table, so it is
    // not public — even though the path is.
    const response = await fetch(`${appOrigin}${BASE}/search`, {
      method: 'POST',
      headers: { origin: FOREIGN, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('keeps the health probes off the public lane', async () => {
    const response = await fetch(`${appOrigin}/health`, { headers: { origin: FOREIGN } });
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// `isPublicReadRequest`, at the boundaries
// ---------------------------------------------------------------------------

describe('isPublicReadRequest', () => {
  it('admits the table and nothing adjacent to it', () => {
    expect(isPublicReadRequest('GET', `${BASE}/places/abc`)).toBe(true);
    expect(isPublicReadRequest('GET', `${BASE}/places/abc/claims`)).toBe(false);
    expect(isPublicReadRequest('GET', `${BASE}/claims`)).toBe(false);
    expect(isPublicReadRequest('GET', `${BASE}/captures/policy`)).toBe(false);
    expect(isPublicReadRequest('POST', `${BASE}/places`)).toBe(false);
    expect(isPublicReadRequest('DELETE', `${BASE}/places/abc/capabilities/a.b`)).toBe(false);
  });

  it('refuses a path outside the API prefix that would otherwise match', () => {
    // Anchored at the front as well as the back: `/anything/api/v1/search` and
    // a bare `/search` are not this API.
    expect(isPublicReadRequest('GET', '/search')).toBe(false);
    expect(isPublicReadRequest('GET', `/proxy${BASE}/search`)).toBe(false);
    expect(isPublicReadRequest('GET', `${BASE}/search/extra`)).toBe(false);
  });

  it('answers HEAD as GET, since Express serves it from the same handler', () => {
    expect(isPublicReadRequest('HEAD', `${BASE}/places/nearby`)).toBe(true);
    expect(isPublicReadRequest('HEAD', `${BASE}/places`)).toBe(true);
    expect(isPublicReadRequest('HEAD', `${BASE}/claims`)).toBe(false);
  });

  it('agrees with Express about a trailing slash and about case', () => {
    // Express's router is non-strict and case-insensitive by default, so it
    // serves both of these from the public handler. A matcher that disagreed
    // would refuse a browser a route the API answers.
    expect(isPublicReadRequest('GET', `${BASE}/places/nearby/`)).toBe(true);
    expect(isPublicReadRequest('GET', `${BASE}/Places/Nearby`)).toBe(true);
    // ...and disagreeing in the other direction is not made safe by agreeing
    // here: a sub-path is still not the route.
    expect(isPublicReadRequest('GET', `${BASE}/places/nearby/extra`)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The structural guarantee
// ---------------------------------------------------------------------------

/** One route as Express records it, flattened out of a router's layer stack. */
interface RegisteredRoute {
  readonly method: string;
  readonly path: string;
  readonly guards: readonly RequestHandler[];
}

/** Express 5's layer shape, as much of it as this file reads. */
interface RouterLayer {
  readonly route?: {
    readonly path: string | string[];
    readonly methods: Record<string, boolean>;
    readonly stack: readonly { readonly handle: RequestHandler }[];
  };
}

function registeredRoutes(router: Router): RegisteredRoute[] {
  const stack = (router as unknown as { stack: readonly RouterLayer[] }).stack;
  const routes: RegisteredRoute[] = [];
  for (const layer of stack) {
    const route = layer.route;
    if (!route) continue;
    const paths = Array.isArray(route.path) ? route.path : [route.path];
    const guards = route.stack.map((entry) => entry.handle);
    for (const path of paths) {
      for (const [method, enabled] of Object.entries(route.methods)) {
        if (enabled) routes.push({ method: method.toUpperCase(), path, guards });
      }
    }
  }
  return routes;
}

describe('the public table, checked against the routers it claims to describe', () => {
  /**
   * Sentinels rather than the real middlewares: what is being asked of each
   * route is WHICH guard it was mounted with, and identity answers that without
   * an Oxy client, a database or a network.
   */
  const optionalAuth: RequestHandler = (_request, _response, next) => {
    next();
  };
  const requireAuth: RequestHandler = (_request, _response, next) => {
    next();
  };

  const everyRoute: RegisteredRoute[] = [
    ...registeredRoutes(createPlacesRouter({ optionalAuth, requireAuth })),
    ...registeredRoutes(createRoutesRouter({ optionalAuth, provider: null })),
    ...registeredRoutes(createSearchRouter({ optionalAuth })),
    ...registeredRoutes(createCaptureRouter({ optionalAuth, requireAuth, objectStore: null })),
  ];

  it('found the real routers, so the cases below are measuring something', () => {
    // A refactor that changed Express's layer shape would otherwise turn this
    // whole section into a vacuous pass over an empty list.
    expect(everyRoute.length).toBeGreaterThan(15);
    expect(everyRoute.some((route) => route.method === 'GET' && route.path === '/places/:id')).toBe(
      true,
    );
  });

  it('admits nothing that is mounted behind requireAuth', () => {
    // THE invariant. `GET /places/:id` has a wildcard segment, so a future
    // `GET /places/mine` behind requireAuth would match it and become readable
    // by any origin. This is what says so before a deploy does.
    const leaked = everyRoute.filter(
      (route) =>
        isPublicReadRequest(route.method, `${BASE}${route.path}`) &&
        route.guards.includes(requireAuth),
    );
    expect(leaked.map((route) => `${route.method} ${route.path}`)).toEqual([]);
  });

  it('admits exactly the routes written down as public, and no others', () => {
    // The table is an inventory, and this is what keeps it one: a route added
    // to a router that the table happens to match shows up here as a diff
    // somebody has to explain, rather than as a live wildcard.
    const admitted = everyRoute
      .filter((route) => isPublicReadRequest(route.method, `${BASE}${route.path}`))
      .map((route) => `${route.method} ${route.path}`)
      .sort();

    expect(admitted).toEqual([
      'GET /geocode',
      'GET /geocode/reverse',
      'GET /geocode/structured',
      'GET /places',
      'GET /places/:id',
      'GET /places/bounds',
      'GET /places/nearby',
      'GET /search',
      'POST /routes',
    ]);
  });

  it('leaves every capture route and every write on the strict lane', () => {
    const refused = everyRoute
      .filter((route) => !isPublicReadRequest(route.method, `${BASE}${route.path}`))
      .map((route) => `${route.method} ${route.path}`)
      .sort();

    expect(refused).toEqual([
      'DELETE /places/:id/capabilities/:key',
      'GET /captures/assets/:id',
      'GET /captures/policy',
      'GET /captures/sessions/:id',
      'GET /captures/sessions/:id/assets',
      'GET /claims',
      'GET /places/:id/claims',
      'PATCH /places/:id',
      'POST /captures/assets/:id/finalize',
      'POST /captures/sessions',
      'POST /captures/sessions/:id/assets',
      'POST /places',
      'POST /places/:id/claims',
      'PUT /places/:id/capabilities/:key',
    ]);
  });
});

// ---------------------------------------------------------------------------
// The credential decides the lane, not the path
// ---------------------------------------------------------------------------

describe('a SIGNED-IN read of a public route', () => {
  // GoWay's own app is cross-origin to its own API (`goway.to` →
  // `api.goway.to`) and `@goway.to/sdk` attaches the Oxy token to every request
  // it makes, public route or not. Before the credential check, the lane was
  // picked from the method and the path alone: these preflights were answered
  // `Access-Control-Allow-Headers: Content-Type` and the browser refused to
  // send the real request. Every signed-in map read failed, and only in a
  // browser — server-side callers and signed-out visitors were unaffected,
  // which is why nothing caught it.

  it('preflights through the STRICT lane, which admits Authorization', async () => {
    const response = await fetch(`${publicSurfaceOrigin}${BASE}/places/nearby`, {
      method: 'OPTIONS',
      headers: {
        Origin: ALLOWLISTED,
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'authorization',
      },
    });

    // The echoed origin, never `*`: a caller-specific answer cannot be handed
    // out under a wildcard.
    expect(response.headers.get('access-control-allow-origin')).toBe(ALLOWLISTED);
    const allowed = (response.headers.get('access-control-allow-headers') ?? '').toLowerCase();
    expect(allowed).toContain('authorization');
  });

  it('answers the real request on the strict lane, not with a wildcard', async () => {
    const response = await fetch(`${publicSurfaceOrigin}${BASE}/places/nearby`, {
      headers: { Origin: ALLOWLISTED, Authorization: 'Bearer token-shaped-value' },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe(ALLOWLISTED);
    expect(response.headers.get('access-control-allow-origin')).not.toBe('*');
  });

  it('does not hand a foreign origin an authenticated answer', async () => {
    // The public lane exists for anonymous cross-origin reads. A foreign site
    // sending somebody's Bearer token is not that, and it gets the strict
    // lane's refusal rather than a `*` it could read a caller-specific body
    // through.
    const response = await fetch(`${publicSurfaceOrigin}${BASE}/places/nearby`, {
      headers: { Origin: FOREIGN, Authorization: 'Bearer token-shaped-value' },
    });

    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('the anonymous public lane, still intact', () => {
  // The positive control for the change above: moving authenticated requests
  // off this lane must not have moved anything else off it.

  it('still answers a foreign anonymous read with a wildcard', async () => {
    const response = await fetch(`${publicSurfaceOrigin}${BASE}/places/nearby`, {
      headers: { Origin: FOREIGN },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('varies its preflight on the header that now chooses the lane', async () => {
    // Two answers exist for this preflight depending on
    // `Access-Control-Request-Headers`, so it has to be in the cache key. The
    // actual responses still carry no `Vary` and still need none.
    const response = await fetch(`${publicSurfaceOrigin}${BASE}/places/nearby`, {
      method: 'OPTIONS',
      headers: { Origin: FOREIGN, 'Access-Control-Request-Method': 'GET' },
    });

    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect((response.headers.get('vary') ?? '').toLowerCase()).toContain(
      'access-control-request-headers',
    );
  });

  it('is not diverted by a header that merely contains the word', async () => {
    // A substring test would send this to the strict lane and break an
    // ordinary anonymous embed. The match is token-wise.
    const response = await fetch(`${publicSurfaceOrigin}${BASE}/places/nearby`, {
      method: 'OPTIONS',
      headers: {
        Origin: FOREIGN,
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'x-authorization-scheme',
      },
    });

    expect(response.headers.get('access-control-allow-origin')).toBe('*');
  });
});
