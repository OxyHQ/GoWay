/**
 * The GoWay Search and Geocoding HTTP surface.
 *
 * ## Paths and parameters are the SDK's, because the SDK is published contract
 *
 * `@goway.to/sdk` calls `GET /search`, `GET /geocode`, `GET /geocode/reverse`
 * and `GET /geocode/structured` below `GOWAY_API_BASE_PATH = '/api/v1'`. Those
 * spellings are what this router answers, and `searchSchemas.ts` reads exactly
 * the parameters the SDK sends. An SDK that cannot reach its own API is a
 * silent integration break that only shows up where the real SDK talks to the
 * real API — which is exactly where a contract test that fakes `fetch` cannot
 * see it.
 *
 * A 2xx body IS the contract value: `SearchResults`, unwrapped, which is what
 * `parseSearchResults` in the SDK reads.
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
import type { SearchResults } from '@goway/shared-types';
import { searchConfig, type SearchConfig } from '../config/search';
import { createPlacesGateway } from '../search/dbPlacesGateway';
import type { PlacesGateway } from '../search/placesGateway';
import { createProviders } from '../search/providers';
import {
  createSearchService,
  type ResolvedSearchQuery,
  type SearchService,
} from '../search/searchService';
import { parseQuery } from '../http/validation';
import { createLogger } from '../utils/logger';
import {
  reverseQuerySchema,
  searchQuerySchema,
  structuredQuerySchema,
  withSearchQueryAliases,
  type SearchQueryInput,
} from './searchSchemas';

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

  /** The configured default, clamped to the configured maximum. */
  const resolveLimit = (requested: number | undefined): number =>
    Math.min(requested ?? config.defaultLimit, config.maxLimit);

  /**
   * A search response.
   *
   * `no-store` rather than a short `max-age`: the query text is the user's, and
   * on a `near` search the URL contains their coordinate. Neither belongs in a
   * shared cache, and a `private` directive is advice a proxy is free to
   * misread.
   */
  const send = (response: Response, results: SearchResults): void => {
    response.setHeader('Cache-Control', 'no-store');
    response.json(results);
  };

  /** The parsed query as the service takes it. Used by `/search` and `/geocode`. */
  const resolveSearchQuery = (input: SearchQueryInput): ResolvedSearchQuery => {
    const resolved: ResolvedSearchQuery = { query: input.q, limit: resolveLimit(input.limit) };
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
    return resolved;
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
      const input = parseQuery(searchQuerySchema, withSearchQueryAliases({ ...request.query }));
      const results = await service.search(resolveSearchQuery(input), {
        gateway: gatewayFor(request),
        signal: callerSignal(request, response),
      });
      send(response, results);
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
      const input = parseQuery(reverseQuerySchema, withSearchQueryAliases({ ...request.query }));
      const results = await service.reverse(
        {
          coordinate: { latitude: input.latitude, longitude: input.longitude },
          limit: resolveLimit(input.limit),
          ...(input.radiusMeters !== undefined ? { radiusMeters: input.radiusMeters } : {}),
          ...(input.locale !== undefined ? { locale: input.locale } : {}),
        },
        { gateway: gatewayFor(request), signal: callerSignal(request, response) },
      );
      send(response, results);
    }),
  );

  /** `GET /geocode/structured?street=&city=…` — an address lookup by parts. */
  router.get(
    '/geocode/structured',
    dependencies.optionalAuth,
    route(async (request, response) => {
      const input = parseQuery(structuredQuerySchema, { ...request.query });
      const results = await service.structured(
        {
          limit: resolveLimit(input.limit),
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
      send(response, results);
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
      const input = parseQuery(searchQuerySchema, withSearchQueryAliases({ ...request.query }));
      const results = await service.forward(resolveSearchQuery(input), {
        gateway: gatewayFor(request),
        signal: callerSignal(request, response),
      });
      send(response, results);
    }),
  );

  return router;
}
