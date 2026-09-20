/**
 * GoWay's CORS policy: two lanes, and the strict one is the default.
 *
 * ## Why there is a second lane at all
 *
 * `createOxyCors` from `@oxy.so/core/server` is a deny-by-default allowlist.
 * It never reflects an arbitrary origin and never pairs a wildcard with
 * credentials, because both patterns leaked credentials in production — the
 * Allo wildcard-fallback class its header documents. Nothing here relaxes it,
 * forks it, vendors it or passes it a wildcard. It remains the policy for every
 * request this module does not positively recognise.
 *
 * But GoWay ships a PUBLIC map API, and the allowlist makes that impossible to
 * consume. Measured against production:
 *
 *     curl -H 'Origin: https://homiio.com' \
 *       'https://api.goway.to/api/v1/places/nearby?latitude=41.38&longitude=2.17'
 *     → 200, and no Access-Control-Allow-Origin at all
 *
 * The body is there; a browser throws it away. So a third-party site cannot
 * render a GoWay map, and the only workarounds are for every consumer to proxy
 * GoWay server-side or for GoWay to collect every consumer's hostname into
 * `CORS_APP_ORIGINS` — an allowlist of the whole web, maintained by hand.
 *
 * ## The two properties that license a wildcard HERE and nowhere else
 *
 * A wildcard is dangerous when it is attached to a response a browser will
 * fetch with the user's ambient credentials. Two facts about this API's read
 * surface mean that cannot happen, and BOTH are load-bearing:
 *
 *  1. **The data is public and unauthenticated.** `AGENTS.md`: "The map opens
 *     without an account. Browsing, search and routing must work signed out."
 *     Every route in {@link PUBLIC_READ_ROUTES} is mounted behind
 *     `optionalAuth`, answers a signed-out visitor completely, and returns the
 *     same places, geocodes and routes to everyone. There is nothing in these
 *     responses that a cross-origin reader was not already entitled to fetch
 *     server-side, which is what `*` means: this is not a secret.
 *
 *  2. **There is no ambient credential to steal or to ride.** GoWay
 *     authenticates with `Authorization: Bearer <token>` and nothing else —
 *     `middleware/auth.ts` wires `@oxy.so/core/server`, whose `oxy.auth()`
 *     reads `req.headers.authorization` and no cookie; this repository parses
 *     no credential of its own. A Bearer header is attached deliberately by the
 *     calling code, which must already hold the token; a cookie is attached by
 *     the browser to any request an attacker's page can cause. So a
 *     cross-origin fetch of these routes carries no caller identity by
 *     accident, there is no session to confuse with the caller's, and there is
 *     no CSRF surface — the requests are reads, and they are unauthenticated
 *     reads.
 *
 * Those two together are exactly the conditions the spec encodes when it
 * forbids `Access-Control-Allow-Origin: *` alongside
 * `Access-Control-Allow-Credentials: true`, and browsers enforce it. This
 * module therefore emits `*` and NEVER emits the credentials header on the
 * public lane. The combination the shared helper exists to prevent is
 * unrepresentable here: the wildcard lane has no credentials header, and the
 * credentialed lane is `createOxyCors`, untouched. A public tile and geocoding
 * service answering `*` is the ordinary shape of this —
 * `tiles.openfreemap.org` answers `access-control-allow-origin: *` for the same
 * reason.
 *
 * If either property ever stops holding — a cookie-borne session anywhere on
 * this API, or a public route that starts varying its body by caller identity —
 * this lane must be deleted, not adjusted.
 *
 * ## "No app-local CORS", and what this is instead
 *
 * `AGENTS.md` says backend CORS is `@oxy.so/core/server` and nothing else. The
 * rule is about POLICY, not about middleware count: what it forbids is a second
 * allowlist — an app-local list of origins, an app-local matcher, an app-local
 * "reflect the origin" fallback — because that is the thing that drifted from
 * the shared one and leaked. There is no second allowlist here. Every decision
 * about WHICH origins may read a credentialed response is still made by
 * `createOxyCors`, from `CORS_APP_ORIGINS` and its built-in Oxy family, and
 * this file does not inspect, normalize, compare or store an origin anywhere.
 * What it decides is a different question the shared helper does not answer and
 * should not: which of GoWay's own routes carry no credential at all. Answering
 * that in a router-shaped table beside the routers is where it belongs.
 *
 * ## Why a table, matched on method and path, and why it fails closed
 *
 * The lane has to be chosen BEFORE the body parser (a rejected cross-origin
 * preflight must not get a body parsed for it — see `app.ts`), and therefore
 * before Express resolves a route. On a preflight there is nothing else to go
 * on in any case: an `OPTIONS` request resolves to no route, carries no
 * `Authorization` header and has no body. Method plus path is the entire
 * information available at the only point in the stack where the decision can
 * be made, so the table below is what the decision is made from.
 *
 * It is an explicit inventory rather than a prefix rule or a "GET is public"
 * convention, and the difference is the failure mode. An unrecognised
 * method/path pair falls through to `createOxyCors` — a route added tomorrow is
 * private until somebody writes it down here, and writing it down is a diff a
 * reviewer sees. A prefix rule would have made `GET /places/:id/claims`
 * (`requireAuth`, one account's claim history) public by accident, because it
 * lives under `/places`.
 *
 * The one entry with a wildcard segment, `GET /places/:id`, is the one that
 * could admit a route that does not exist yet: a future `GET /places/mine`
 * behind `requireAuth` would match it. `__tests__/cors.test.ts` walks the real
 * routers and fails if anything this table admits is mounted behind
 * `requireAuth`, so that mistake is caught by the suite rather than by a
 * reader.
 *
 * ## Caching, and why the public lane answers `*` even with no `Origin`
 *
 * A `*` response is identical for every caller, so it needs no `Vary: Origin` —
 * and it must not have one, or a shared cache keys one useless entry per
 * origin. The trap is emitting `*` only when an `Origin` header is present:
 * that response DOES vary by request header, and a CDN that cached the
 * Origin-less variant would then serve a browser a body with no ACAO at all.
 * So the public lane sets `*` unconditionally. A request with no `Origin` —
 * curl, a server-side fetch, a native app, which are not subject to CORS — is
 * unaffected by a response header it never reads, and the response a CDN holds
 * is correct for everyone.
 *
 * `createOxyCors` sets `Vary: Origin` itself on the credentialed lane, where
 * the answer genuinely does depend on the origin. That stays as it is.
 */

import { createOxyCors } from '@oxy.so/core/server';
import type { Request, RequestHandler, Response } from 'express';

/**
 * The prefix every route in the table below hangs off.
 *
 * `app.ts` mounts `app.use('/api', api)` and `api.use('/v1', v1)`, and
 * `@goway.to/sdk` ships `GOWAY_API_BASE_PATH = '/api/v1'` and builds every URL
 * on it. Spelled here rather than imported because the backend does not depend
 * on the SDK; `__tests__/cors.test.ts` drives the real `createApp()` through a
 * socket, so a divergence between this constant and the mount is a failing
 * test and not a silently private API.
 */
const API_BASE_PATH = '/api/v1';

/** A method the public table may admit. `HEAD` is folded into `GET` below. */
type PublicMethod = 'GET' | 'POST';

interface PublicRoute {
  readonly method: PublicMethod;
  /** Path below {@link API_BASE_PATH}. `:name` matches exactly one segment. */
  readonly path: string;
  /** Why this route is public. Not decoration: it is the entry's justification. */
  readonly because: string;
}

/**
 * Every route that answers any origin. Nothing else does.
 *
 * `GET /places/:id` subsumes `/places/nearby` and `/places/bounds` as a matter
 * of regular expressions, and they are listed anyway: this table is read as the
 * inventory of GoWay's public surface, and an entry missing from it reads as a
 * route somebody decided to keep private.
 *
 * Deliberately ABSENT, and each for a reason:
 *   - `POST|PATCH /places`, `PUT|DELETE /places/:id/capabilities/:key`,
 *     `POST /places/:id/claims` — writes, behind `requireAuth`.
 *   - `GET /places/:id/claims`, `GET /claims` — one account's claim history,
 *     behind `requireAuth`. A read, but not a public one.
 *   - every `/captures/*` route — contributions are identity-bound, and even
 *     `GET /captures/policy` (`optionalAuth`) stays on the strict lane: it is
 *     the contribution surface, which no third-party page has a reason to call
 *     and which is where upload intents are minted.
 *   - `GET /health`, `GET /ready` — operational probes, not an API.
 */
export const PUBLIC_READ_ROUTES: readonly PublicRoute[] = [
  {
    method: 'GET',
    path: '/places',
    because: 'the viewport/bbox collection read — a map embed with no account',
  },
  { method: 'GET', path: '/places/nearby', because: 'proximity search, signed out' },
  { method: 'GET', path: '/places/bounds', because: 'viewport search, signed out' },
  {
    method: 'GET',
    path: '/places/:id',
    because: 'one public place; a deep link anybody already holds must resolve',
  },
  { method: 'GET', path: '/search', because: 'the search box, signed out' },
  { method: 'GET', path: '/geocode', because: 'forward geocoding, signed out' },
  { method: 'GET', path: '/geocode/reverse', because: 'reverse geocoding, signed out' },
  { method: 'GET', path: '/geocode/structured', because: 'address lookup by parts, signed out' },
  {
    method: 'POST',
    path: '/routes',
    /**
     * A READ in every sense but the verb. `POST` because a directions request
     * is an origin, a destination and up to a hundred waypoints, which does not
     * fit in a query string — not because anything is created. The handler
     * writes no row, mints no id, keeps no history and sets `Cache-Control:
     * no-store`; it requires no account, and `AGENTS.md` names routing
     * alongside browsing and search as what must work signed out. Excluding it
     * for its verb would leave a third-party map able to show places and unable
     * to draw a line between two of them.
     *
     * A JSON body makes it a non-simple request, so the browser preflights it.
     * That preflight is answered on this lane, or the route is unreachable
     * cross-origin no matter what the actual response says.
     */
    because: 'directions: a read whose arguments do not fit in a query string',
  },
];

/**
 * Request headers a browser may send to the public lane.
 *
 * `Content-Type`, and only `Content-Type`: that is what makes `POST /routes`
 * preflight (`application/json` is outside the CORS-safelisted values) and it
 * is the whole of what these routes need. Everything a public GET sends —
 * `Accept`, `Accept-Language` — is safelisted and never preflighted.
 *
 * `Authorization` is deliberately NOT admitted, and the reasoning is the
 * inverse of the usual one. It would be safe in the credential-leak sense: a
 * Bearer token is not ambient, so no page can cause a browser to attach one it
 * does not already hold, and a `*` response carries nothing back. It is left
 * out because of what it would change about the lane rather than what it would
 * expose. These responses vary by caller when a session is present — a place
 * read behind `optionalAuth` shows claim detail to the account that claimed it
 * — and this lane's whole cacheability argument is that its responses are
 * identical for every caller and therefore need no `Vary`. Admitting a
 * browser-borne `Authorization` here would put a caller-specific body behind a
 * `*` with no `Vary`, which is precisely how a shared cache serves one reader's
 * view to another.
 *
 * Nothing is lost that has a safe route already: a third-party site that needs
 * an AUTHENTICATED read has its origin added to `CORS_APP_ORIGINS` and gets the
 * strict lane — exact echoed origin, credentials, `Vary: Origin` — or it calls
 * from its own server, where CORS does not apply. Both of those are decisions
 * somebody makes; this lane is the one nobody has to.
 *
 * That argument only holds if an authenticated request never REACHES this
 * lane, and originally nothing enforced it: the lane was chosen from the
 * method and the path alone, before anything looked at `Authorization`. GoWay's
 * own app is cross-origin to its own API (`goway.to` → `api.goway.to`) and
 * `@goway.to/sdk` attaches the token to every request it makes, public route or
 * not — so a signed-in first-party read preflighted for `authorization`, was
 * answered `Content-Type`, and the browser blocked it. The sentence above
 * described the strict lane as the answer for an authenticated read while
 * nothing routed one there.
 *
 * {@link carriesAuthorization} is what makes it true. An authenticated request
 * goes to the strict lane whatever its path, so this constant stays exactly as
 * narrow as its reasoning requires and the lane's responses stay identical for
 * every caller.
 */
const PUBLIC_ALLOWED_HEADERS = 'Content-Type';

/**
 * How long a browser may cache a public preflight. 24h, matching the shared
 * helper's default: the table changes at the speed of a deploy, not a request.
 */
const PUBLIC_MAX_AGE_SECONDS = 86_400;

/** Regex-escape a literal path segment. */
function escapeSegment(segment: string): string {
  return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compile a path template into an anchored matcher.
 *
 * `:name` becomes exactly one segment (`[^/]+`), never a greedy `.*` — that is
 * what keeps `/places/:id` from swallowing `/places/:id/claims`. Anchored at
 * both ends for the same reason: a prefix match is how a private sub-route
 * becomes public.
 *
 * Case-insensitive, because Express's own router is (`caseSensitive` defaults
 * to false) and the two must not disagree: a path Express routes to a public
 * handler but this table misses would be refused by the browser on a route the
 * API happily serves.
 */
function compile(path: string): RegExp {
  const pattern = path
    .split('/')
    .map((segment) => (segment.startsWith(':') ? '[^/]+' : escapeSegment(segment)))
    .join('/');
  return new RegExp(`^${escapeSegment(API_BASE_PATH)}${pattern}$`, 'i');
}

const COMPILED: readonly { readonly method: PublicMethod; readonly matcher: RegExp }[] =
  PUBLIC_READ_ROUTES.map((route) => ({ method: route.method, matcher: compile(route.path) }));

/**
 * Normalize a request path the way Express's router would before matching.
 *
 * One trailing slash is dropped, because Express's `strict` routing defaults to
 * false and serves `/api/v1/places/nearby/` from the same handler. Without this
 * the two spellings would get two different CORS policies for one response.
 */
function normalizePath(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

/**
 * Whether `method` + `path` is in the public table.
 *
 * `path` is the full request path including {@link API_BASE_PATH}, as
 * `req.path` gives it — no query string, percent-encoding untouched. An
 * encoded path that does not match here does not match Express's router
 * either, so the two agree on a 404 rather than disagreeing on a policy.
 *
 * `HEAD` is answered as `GET`: Express serves a HEAD from the GET handler, it
 * is a CORS-simple method that a browser sends without a preflight, and it
 * returns strictly less than the GET this table already admits.
 *
 * Exported for `__tests__/cors.test.ts`, which is also what proves the table
 * admits nothing mounted behind `requireAuth`.
 */
export function isPublicReadRequest(method: string, path: string): boolean {
  const upper = method.toUpperCase();
  const lookup = upper === 'HEAD' ? 'GET' : upper;
  if (lookup !== 'GET' && lookup !== 'POST') return false;
  const normalized = normalizePath(path);
  return COMPILED.some((route) => route.method === lookup && route.matcher.test(normalized));
}

/**
 * The method a preflight is asking about, or `null` when this is not one.
 *
 * A CORS preflight always carries `Access-Control-Request-Method`; a bare
 * `OPTIONS` that does not is not a browser asking permission, and it falls to
 * the strict lane, which answers it 204 with no CORS headers exactly as before.
 */
function preflightMethod(request: Request): string | null {
  const requested = request.headers['access-control-request-method'];
  const value = Array.isArray(requested) ? requested[0] : requested;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Whether this request is, or is asking to become, an authenticated one.
 *
 * Two shapes, because a browser asks before it sends. On a preflight the token
 * is not present yet — `Access-Control-Request-Headers` names what the real
 * request intends to send, and `authorization` there is the browser asking
 * permission to attach one. On the real request the header itself is there.
 *
 * Either way the answer routes to the strict lane, which is what keeps the
 * public lane's responses identical for every caller (see
 * {@link PUBLIC_ALLOWED_HEADERS}). Matching is case-insensitive and
 * token-wise: `Access-Control-Request-Headers` is a comma-separated list the
 * browser lowercases, but an intermediary may not have, and a substring test
 * would match a header merely CONTAINING the word.
 */
function carriesAuthorization(request: Request): boolean {
  if (request.headers.authorization !== undefined) return true;
  const requested = request.headers['access-control-request-headers'];
  const value = Array.isArray(requested) ? requested.join(',') : requested;
  if (typeof value !== 'string') return false;
  return value.split(',').some((name) => name.trim().toLowerCase() === 'authorization');
}

/** Answer a preflight for a public route. */
function answerPublicPreflight(response: Response, method: string): void {
  response.setHeader('Access-Control-Allow-Origin', '*');
  // Exactly the method asked about, plus OPTIONS. Not the full standard set:
  // advertising `DELETE` on a lane that would never admit it is a lie a
  // reader has to disprove.
  response.setHeader('Access-Control-Allow-Methods', `${method}, OPTIONS`);
  response.setHeader('Access-Control-Allow-Headers', PUBLIC_ALLOWED_HEADERS);
  response.setHeader('Access-Control-Max-Age', String(PUBLIC_MAX_AGE_SECONDS));
  // No `Access-Control-Allow-Credentials`: see the module docs, that absence is
  // the policy rather than an omission.
  //
  // `Vary` IS set here, and only here. A preflight for one of these paths now
  // has two possible answers — this one, or the strict lane's, depending on
  // whether the real request intends to send `Authorization` — so the request
  // header that decides it has to be part of the cache key. The actual
  // responses still carry no `Vary` and still need none: an authenticated
  // request never reaches this lane, so what it returns is identical for every
  // caller, which is the whole cacheability argument.
  response.setHeader('Vary', 'Access-Control-Request-Headers');
  response.sendStatus(204);
}

export interface GoWayCorsOptions {
  /**
   * Origins allowed on the CREDENTIALED lane, passed straight through to
   * `createOxyCors` and normalized by it. Nothing about the public lane is
   * configurable — a table of public routes is a code decision, not a
   * deployment one, and an environment variable that could make a route public
   * is an environment variable that could make `/claims` public.
   */
  readonly appOrigins: readonly string[];
}

/**
 * The CORS middleware `app.ts` mounts, ahead of the body parser.
 *
 * Anonymous public read → `Access-Control-Allow-Origin: *`, no credentials
 * header. Everything else — anything authenticated, and every route outside
 * the public table — → `createOxyCors`, unchanged and unwrapped.
 *
 * The lane is chosen by credential FIRST and path second. A public path is
 * necessary for the wildcard lane, never sufficient.
 */
export function createGoWayCors(options: GoWayCorsOptions): RequestHandler {
  const strict = createOxyCors({ appOrigins: [...options.appOrigins] });

  return (request, response, next) => {
    // Asked first, and ahead of the path table, because it decides the LANE
    // rather than the route. A public path plus a credential is an
    // authenticated read of public data — GoWay's own signed-in app is exactly
    // that — and it belongs on the lane that can echo an origin and answer for
    // a specific caller. Sending it to the wildcard lane is what made every
    // signed-in first-party read fail its preflight.
    if (carriesAuthorization(request)) {
      strict(request, response, next);
      return;
    }

    if (request.method === 'OPTIONS') {
      const asked = preflightMethod(request);
      if (asked !== null && isPublicReadRequest(asked, request.path)) {
        // Note what is NOT consulted: the `Origin` header. A preflight for a
        // public route is answered the same way for every origin, because the
        // answer is the same for every origin.
        answerPublicPreflight(response, asked.toUpperCase());
        return;
      }
      strict(request, response, next);
      return;
    }

    if (isPublicReadRequest(request.method, request.path)) {
      response.setHeader('Access-Control-Allow-Origin', '*');
      next();
      return;
    }

    strict(request, response, next);
  };
}
