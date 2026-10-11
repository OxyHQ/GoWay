/**
 * Builds the HTTP application.
 *
 * `createApp()` opens no connections, starts no timers and registers no
 * process-level handlers — `server.ts` owns all of that — so a test can exercise
 * the application without a runtime around it, and so the order of "connect,
 * then listen" stays visible in exactly one place.
 *
 * Middleware order below is load-bearing:
 *   activity → helmet → CORS → body parser → health → API router → unknownRoute → errorHandler
 * The Oxy ecosystem activity observer comes FIRST so every response is counted,
 * including the ones CORS, the rate limiter or the 404 handler answer.
 * CORS before the body parser so a rejected cross-origin preflight never gets a
 * body parsed for it, and the two terminal handlers LAST because Express matches
 * in registration order — an `unknownRouteHandler` mounted before a router would
 * answer 404 for every route that router defines.
 */

import express, { type Express, type RequestHandler, Router } from 'express';
import helmet from 'helmet';
import { config } from './config';
import { errorHandler, unknownRouteHandler } from './http/errorHandler';
import {
  accountRoles,
  apiRateLimit,
  contributionRateLimit,
  optionalAuth,
  placeFiles,
  reportRateLimit,
  requireAuth,
  requireOperator,
} from './middleware/auth';
import { createGoWayCors } from './middleware/cors';
import { healthRouter } from './routes/health';
import { createCaptureRouter } from './routes/capture';
import { createCategoriesRouter } from './routes/categories';
import { createModerationRouter } from './routes/moderation';
import { createOpenApiRouter } from './routes/openapi';
import { createPlaceMediaRouter } from './routes/placeMedia';
import { createPlaceReviewsRouter } from './routes/placeReviews';
import { createPlacesRouter } from './routes/places';
import { createRoutesRouter } from './routes/directions';
import { createSearchRouter } from './routes/search';
import { createStreet3dRouter } from './routes/street3d';
import { createConfiguredObjectStore } from './storage';

/** The largest request body any GoWay route accepts. */
const JSON_BODY_LIMIT = '1mb';

export interface CreateAppOptions {
  /**
   * The Oxy ecosystem traffic observer (`./platformActivity`). Passed in by
   * `server.ts` rather than imported, so an app a test builds publishes nothing.
   */
  activity?: RequestHandler;
}

export function createApp(options: CreateAppOptions = {}): Express {
  const app = express();

  app.disable('x-powered-by');
  // One proxy hop: the shared ALB terminates TLS and sets X-Forwarded-*. A
  // permissive value would let a client forge its own client address, which is
  // the value the rate limiter keys on for unauthenticated callers.
  app.set('trust proxy', 1);

  if (options.activity) app.use(options.activity);

  app.use(helmet());

  /**
   * CORS, in two lanes, decided by `middleware/cors.ts` and nowhere else.
   *
   * Deny-by-default from `@oxy.so/core/server` remains the policy for every
   * credentialed route and for anything unrecognised: the shared helper echoes
   * the exact matched origin, refuses to reflect an arbitrary one, and never
   * pairs a wildcard with credentials. It is used as-is — not forked, not
   * vendored, not handed a wildcard.
   *
   * The public read surface — the browse, search and routing endpoints the map
   * opens with, none of which need an account — answers ANY origin with
   * `Access-Control-Allow-Origin: *` and no credentials header, which is what
   * lets a third-party site embed GoWay at all. `middleware/cors.ts` carries the
   * full argument and the table of exactly which routes that is; read it before
   * changing either lane.
   *
   * The helper's built-in allowance is the HTTPS `oxy.so` apex family and
   * nothing else — `goway.to` is NOT in it, whatever an earlier reading of this
   * comment said. So `CORS_APP_ORIGINS` is what carries `https://goway.to`
   * itself, the Expo dev server, and any future console; a deployment that
   * omits the canonical origin gets no credentialed lane for its own app.
   * Configuration, never a hardcoded development endpoint in product code.
   */
  app.use(createGoWayCors({ appOrigins: config.corsAppOrigins }));

  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  app.use(healthRouter);

  /**
   * The GoWay API.
   *
   * Rate limiting is mounted HERE rather than on the app so every API route —
   * including the authenticated ones — is throttled while the probes above stay
   * unlimited.
   *
   * Routers mount onto `v1` as they are built: Places (#4), moderation,
   * routing (#6), search (#5) and Street 3D capture (#9/#10). Two caller classes share this
   * router and neither
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
  v1.use(createOpenApiRouter());
  v1.use(createCategoriesRouter());
  v1.use(createPlacesRouter({ optionalAuth, requireAuth, accountRoles, reportRateLimit }));
  /**
   * A place's gallery and reviews. Images are Oxy files the client uploaded;
   * GoWay checks and links them with Oxy (`oxy/placeFiles`) and never touches
   * the bytes.
   */
  v1.use(
    createPlaceMediaRouter({
      optionalAuth,
      requireAuth,
      accountRoles,
      placeFiles,
      reportRateLimit,
      contributionRateLimit,
    }),
  );
  v1.use(
    createPlaceReviewsRouter({ requireAuth, accountRoles, reportRateLimit, contributionRateLimit }),
  );
  /**
   * Moderation: claim decisions, Oxy verification, duplicate merges and the
   * report queue — every route behind `requireAuth` and the operator allow-list
   * (`MODERATION_OPERATOR_OXY_USER_IDS`).
   */
  v1.use(createModerationRouter({ requireAuth, requireOperator }));
  v1.use(createRoutesRouter({ optionalAuth }));
  v1.use(createSearchRouter({ optionalAuth }));
  /**
   * Street 3D capture (#9/#10).
   *
   * The object store is resolved HERE and injected, so a deployment with none
   * configured still builds the app: the upload-intent route answers
   * `service_unavailable` and everything else is unaffected. It is also what
   * lets a test drive the whole contribution flow against a fake store without
   * an AWS account — the alternative is a router that can only be tested with
   * real credentials, which in practice means it is not tested.
   */
  v1.use(
    createCaptureRouter({ optionalAuth, requireAuth, objectStore: createConfiguredObjectStore() }),
  );
  /**
   * Street 3D viewing (#14/#15): coverage and published scene manifests,
   * signed out, plus authenticated reports. Inert — 503/404 — unless
   * `STREET3D_VIEWING_ENABLED` is set. It reads only the database: no queue,
   * bucket or external worker is on the request path.
   */
  v1.use(createStreet3dRouter({ requireAuth, reportRateLimit }));
  api.use('/v1', v1);

  app.use('/api', api);

  app.use(unknownRouteHandler);
  app.use(errorHandler);

  return app;
}
