/**
 * Builds the HTTP application.
 *
 * `createApp()` opens no connections, starts no timers and registers no
 * process-level handlers — `server.ts` owns all of that — so a test can exercise
 * the application without a runtime around it, and so the order of "connect,
 * then listen" stays visible in exactly one place.
 *
 * Middleware order below is load-bearing:
 *   helmet → CORS → body parser → health → API router → notFound → errorHandler
 * CORS before the body parser so a rejected cross-origin preflight never gets a
 * body parsed for it, and the two terminal handlers LAST because Express matches
 * in registration order — a `notFoundHandler` mounted before a router would
 * answer 404 for every route that router defines.
 */

import express, { type Express, Router } from 'express';
import helmet from 'helmet';
import { createOxyCors } from '@oxy.so/core/server';
import { config } from './config';
import { errorHandler, notFoundHandler } from './http/errorHandler';
import { apiRateLimit, optionalAuth, requireAuth } from './middleware/auth';
import { healthRouter } from './routes/health';
import { createPlacesRouter } from './routes/places';

/** The largest request body any GoWay route accepts. */
const JSON_BODY_LIMIT = '1mb';

export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  // One proxy hop: the shared ALB terminates TLS and sets X-Forwarded-*. A
  // permissive value would let a client forge its own client address, which is
  // the value the rate limiter keys on for unauthenticated callers.
  app.set('trust proxy', 1);

  app.use(helmet());

  /**
   * Deny-by-default CORS from `@oxy.so/core/server`, never a hand-rolled
   * allowlist: the shared helper echoes the exact matched origin, refuses to
   * reflect an arbitrary one, and never pairs a wildcard with credentials.
   *
   * `goway.to` and the HTTPS `oxy.so` apex family are allowed by the helper
   * already. `corsAppOrigins` is for the Expo dev server and for any future
   * console on a hostname outside those families — configuration, never a
   * hardcoded development endpoint in product code.
   */
  app.use(createOxyCors({ appOrigins: [...config.corsAppOrigins] }));

  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  app.use(healthRouter);

  /**
   * The GoWay API.
   *
   * Rate limiting is mounted HERE rather than on the app so every API route —
   * including the authenticated ones — is throttled while the probes above stay
   * unlimited.
   *
   * Routers mount onto `v1` as they are built. Places is here (issue #4);
   * search and routing follow. Two caller classes share this router and neither
   * may satisfy the other's routes: a signed-out visitor reaches browse, search
   * and routing through `optionalAuth`, and only identity-bound routes (saves,
   * lists, edits, contributions) sit behind `requireAuth`. Each router declares
   * which of the two it wants per route, rather than the version router picking
   * one for everything underneath it.
   *
   * ## `/api/v1`, and the version segment is not decoration
   *
   * `@goway.to/sdk` ships `GOWAY_API_BASE_PATH = '/api/v1'` and builds every
   * URL on it. The SDK is published contract: a backend that answered `/api`
   * alone would 404 every call from every consumer, and it would do so only in
   * an environment where the real SDK is talking to the real API — which is
   * exactly where a contract test that fakes `fetch` cannot see it.
   */
  const api: Router = Router();
  api.use(apiRateLimit);

  const v1: Router = Router();
  v1.use(createPlacesRouter({ optionalAuth, requireAuth }));
  api.use('/v1', v1);

  app.use('/api', api);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
