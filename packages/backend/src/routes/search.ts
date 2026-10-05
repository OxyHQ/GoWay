/**
 * The GoWay Search and Geocoding HTTP surface.
 *
 * ## Paths and parameters are the SDK's, because the SDK is published contract
 *
 * `GET /search`, `GET /geocode`, `GET /geocode/reverse` and
 * `GET /geocode/structured` are operations in `@goway/contracts`' registry, and
 * each request is parsed with the registry's own schema for it — the one the
 * SDK validates with before sending.
 *
 * A 2xx body IS the contract value: `SearchResults`, unwrapped — a page,
 * `{ items, nextCursor }`, plus which providers answered.
 *
 * ## Pages are OFFSETS into one ranking, to a fixed depth
 *
 * A blended list has no keyset, so a cursor carries how many results earlier
 * pages served, bound to the query and its filters, and the list ends at
 * `SEARCH_MAX_DEPTH`. `limit` above this deployment's `SEARCH_MAX_LIMIT` is
 * refused as `validation_failed` rather than silently clamped: a caller who
 * asked for 40 and got 25 would conclude there were 25.
 *
 * ## `/search` and `/geocode` are not the same endpoint
 *
 * `/search` is the search box: interactive providers only. `/geocode` is an
 * explicit, user-initiated forward lookup, so every configured provider may
 * answer it — including Nominatim, whose usage policy permits the second and
 * forbids the first. The distinction is enforced in the service by the
 * provider's own `allowsInteractiveSearch`, not by a configuration flag.
 *
 * ## Every route here is public
 *
 * "The map opens without an account. Browsing, search and routing must work
 * signed out." So the routes sit behind `optionalAuth`, which resolves a
 * session when one is present and continues regardless. The only thing the
 * session buys is claim visibility on an enriched place — the same rule the
 * Places endpoints apply, via the same repository argument.
 *
 * ## Nothing here persists or logs a coordinate
 *
 * A `near` bias and a reverse lookup carry the user's precise location. It is
 * read from the query, used to build one upstream request, and dropped. No
 * table, no log field, no cache key (see `search/cache.ts`), and
 * `Cache-Control: no-store` so it is not parked in a shared proxy either.
 */

import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import {
  reverseGeocodeQuerySchema,
  SEARCH_MAX_DEPTH,
  searchParametersSchema,
  structuredGeocodeQuerySchema,
  type SearchResults,
} from '@goway/contracts';
import { searchConfig, type SearchConfig } from '../config/search';
import { createPlacesGateway } from '../search/dbPlacesGateway';
import type { PlacesGateway } from '../search/placesGateway';
import { createProviders } from '../search/providers';
import {
  createSearchService,
  type ResolvedSearchQuery,
  type SearchService,
  type SearchWindow,
} from '../search/searchService';
import { ApiError } from '../http/apiError';
import { cursorBinding, decodeCursor, encodeCursor, type CursorBinding, type CursorKind } from '../http/cursor';
import { parseQuery } from '../http/validation';
import { createLogger } from '../utils/logger';

/** A search page resumes after this many results. */
const offsetSchema = z.number().int().min(1).max(SEARCH_MAX_DEPTH - 1);

/** Forward a rejected handler to the error middleware. */
function route(handler: (request: Request, response: Response) => Promise<void>): RequestHandler {
  return (request, response, next: NextFunction) => {
    handler(request, response).catch(next);
  };
}

/** The Oxy session on the request, or null. Never read from the body or the query. */
function callerId(request: Request): string | null {
  return typeof request.userId === 'string' && request.userId.length > 0 ? request.userId : null;
}

/**
 * A signal that aborts when the client hangs up.
 *
 * This is what makes an autocomplete box cheap: a user typing the next
 * character closes the previous connection, and the in-flight upstream request
 * is cancelled instead of running to completion against a community geocoder's
 * fair-use allowance for an answer nobody will read.
 */
function callerSignal(request: Request, response: Response): AbortSignal {
  const controller = new AbortController();
  request.once('close', () => {
    if (!response.writableEnded) controller.abort();
  });
  return controller.signal;
}

export interface SearchRouterDependencies {
  /** Resolves a session when one is present and continues regardless. */
  optionalAuth: RequestHandler;
  /**
   * The search implementation. Injected in tests; production builds the one
   * below from `searchConfig` at router construction, which opens no sockets.
   */
  service?: SearchService;
  /** Builds the Places gateway for one request. Injected in tests. */
  createGateway?: (request: Request) => PlacesGateway;
  config?: SearchConfig;
}

function defaultService(config: SearchConfig): SearchService {
  return createSearchService({
    providers: createProviders({ config }),
    config,
    logger: createLogger('search'),
  });
}

/**
 * Build the Search router.
 *
 * Mount it on the `/api/v1` router in `app.ts`:
 *
 * ```ts
 * v1.use(createSearchRouter({ optionalAuth }));
 * ```
 */
export function createSearchRouter(dependencies: SearchRouterDependencies): Router {
  const config = dependencies.config ?? searchConfig;
  const service = dependencies.service ?? defaultService(config);
  const gatewayFor =
    dependencies.createGateway ??
    ((request: Request) => createPlacesGateway({ viewerOxyAccountId: callerId(request) }));
  const router: Router = Router();

  /**
   * The window a request asks for: the deployment's default size when it names
   * none, and the offset its cursor carries.
   */
  const windowOf = (
    request: { limit?: number | undefined; cursor?: string | undefined },
    binding: CursorBinding,
  ): { limit: number; offset: number } => {
    if (request.limit !== undefined && request.limit > config.maxLimit) {
      throw new ApiError('validation_failed', `limit may not exceed ${config.maxLimit} on this deployment.`, {
        field: 'limit',
        issue: 'too_big',
        maximum: config.maxLimit,
      });
    }
    const offset = decodeCursor(request.cursor, binding, offsetSchema) ?? 0;
    // Never past the depth: the last page is cut short rather than the cursor
    // that would reach beyond it ever being minted.
    return { offset, limit: Math.min(request.limit ?? config.defaultLimit, SEARCH_MAX_DEPTH - offset) };
  };

  /**
   * A search response.
   *
   * `no-store` rather than a short `max-age`: the query text is the user's, and
   * on a `near` search the URL contains their coordinate. Neither belongs in a
   * shared cache, and a `private` directive is advice a proxy is free to
   * misread.
   */
  const send = (
    response: Response,
    window: SearchWindow,
    binding: CursorBinding,
    served: { offset: number; limit: number },
  ): void => {
    const end = served.offset + window.results.length;
    const body: SearchResults = {
      items: window.results,
      nextCursor: window.hasMore && end > served.offset && end < SEARCH_MAX_DEPTH ? encodeCursor(binding, end) : null,
      providers: window.providers,
      ...(window.degradedProviders ? { degradedProviders: window.degradedProviders } : {}),
    };
    response.setHeader('Cache-Control', 'no-store');
    response.json(body);
  };

  /** The parsed query as the service takes it. Used by `/search` and `/geocode`. */
  const resolveSearchQuery = (
    kind: CursorKind,
    input: z.output<typeof searchParametersSchema>,
  ): { query: ResolvedSearchQuery; binding: CursorBinding } => {
    const { cursor, limit, ...filters } = input;
    const binding = cursorBinding(kind, filters);
    const resolved: ResolvedSearchQuery = { query: input.q, ...windowOf({ limit, cursor }, binding) };
    if (input.latitude !== undefined && input.longitude !== undefined) {
      resolved.near = { latitude: input.latitude, longitude: input.longitude };
    }
    if (
      input.west !== undefined &&
      input.south !== undefined &&
      input.east !== undefined &&
      input.north !== undefined
    ) {
      resolved.viewport = { west: input.west, south: input.south, east: input.east, north: input.north };
    }
    if (input.capabilities) resolved.capabilities = input.capabilities;
    if (input.categories) resolved.categories = input.categories;
    if (input.locale !== undefined) resolved.locale = input.locale;
    return { query: resolved, binding };
  };

  /**
   * `GET /search?q=…` — the blended search box.
   *
   * Free-text, optionally biased to a coordinate (`latitude`/`longitude`) or to
   * the viewport (`west`/`south`/`east`/`north`), optionally filtered by
   * `categories` and by GoWay `capabilities`. The biases RE-RANK; the filters
   * filter.
   */
  router.get(
    '/search',
    dependencies.optionalAuth,
    route(async (request, response) => {
      const { query, binding } = resolveSearchQuery('search', parseQuery(searchParametersSchema, request.query));
      const window = await service.search(query, {
        gateway: gatewayFor(request),
        signal: callerSignal(request, response),
      });
      send(response, window, binding, query);
    }),
  );

  /**
   * `GET /geocode/reverse?latitude=&longitude=` — what is at this coordinate.
   *
   * Registered before `/geocode` for readability; Express matches these three
   * as distinct literal paths, so neither can swallow another.
   */
  router.get(
    '/geocode/reverse',
    dependencies.optionalAuth,
    route(async (request, response) => {
      const { cursor, limit, ...input } = parseQuery(reverseGeocodeQuerySchema, request.query);
      const binding = cursorBinding('reverse-geocode', input);
      const served = windowOf({ limit, cursor }, binding);
      const window = await service.reverse(
        {
          coordinate: { latitude: input.latitude, longitude: input.longitude },
          ...served,
          ...(input.radiusMeters !== undefined ? { radiusMeters: input.radiusMeters } : {}),
          ...(input.locale !== undefined ? { locale: input.locale } : {}),
        },
        { gateway: gatewayFor(request), signal: callerSignal(request, response) },
      );
      send(response, window, binding, served);
    }),
  );

  /** `GET /geocode/structured?street=&city=…` — an address lookup by parts. */
  router.get(
    '/geocode/structured',
    dependencies.optionalAuth,
    route(async (request, response) => {
      const { cursor, limit, ...input } = parseQuery(structuredGeocodeQuerySchema, request.query);
      const binding = cursorBinding('structured-geocode', input);
      const served = windowOf({ limit, cursor }, binding);
      const window = await service.structured(
        {
          ...served,
          ...(input.street !== undefined ? { street: input.street } : {}),
          ...(input.houseNumber !== undefined ? { houseNumber: input.houseNumber } : {}),
          ...(input.city !== undefined ? { city: input.city } : {}),
          ...(input.region !== undefined ? { region: input.region } : {}),
          ...(input.postalCode !== undefined ? { postalCode: input.postalCode } : {}),
          ...(input.countryCode !== undefined ? { countryCode: input.countryCode } : {}),
          ...(input.locale !== undefined ? { locale: input.locale } : {}),
        },
        { gateway: gatewayFor(request), signal: callerSignal(request, response) },
      );
      send(response, window, binding, served);
    }),
  );

  /**
   * `GET /geocode?q=…` — an explicit forward geocode.
   *
   * Same parameters as `/search`. The difference is the provider set: this is a
   * deliberate lookup rather than a keystroke, so a provider whose terms forbid
   * autocomplete may still answer it.
   */
  router.get(
    '/geocode',
    dependencies.optionalAuth,
    route(async (request, response) => {
      const { query, binding } = resolveSearchQuery('geocode', parseQuery(searchParametersSchema, request.query));
      const window = await service.forward(query, {
        gateway: gatewayFor(request),
        signal: callerSignal(request, response),
      });
      send(response, window, binding, query);
    }),
  );

  return router;
}
