/**
 * Oxy authentication, wired once.
 *
 * `@oxy.so/core/server` is the ONLY thing in this repository that verifies an
 * Oxy session. There is no app-local bearer parsing, no JWT verification and no
 * second CORS policy: Oxy owns identity, its middleware knows how to revalidate
 * a token against the identity service, and a hand-rolled verifier is a
 * signature check that silently stops matching the day Oxy rotates a key.
 *
 * ## Two middlewares, because GoWay's map opens without an account
 *
 * `requireAuth` is for identity-bound routes — saves, lists, edits, Street 3D
 * contributions. `optionalAuth` is for everything a signed-out visitor must
 * still get: browsing, search and routing. Browsing behind `requireAuth` would
 * break the product's first rule, and a personal list behind `optionalAuth`
 * would leak one user's saves to another.
 *
 * A handler reads the caller with `getOxyUserId(req)` (may be null under
 * `optionalAuth`) or `getRequiredOxyUserId(req)` (behind `requireAuth`). It
 * never reads a user id from the body or a query parameter — a client-supplied
 * id is an authorization bypass with extra steps.
 */

import {
  createOptionalOxyAuth,
  createOxyAuthMiddleware,
  createOxyRateLimit,
  OxyServer,
  type OxyRateLimitOptions,
  type OxyRequestUser,
} from '@oxy.so/core/server';
import type { Request, RequestHandler } from 'express';
import type { OxyActorChain } from '../oxy/caller';
import { config } from '../config';
import { ApiError, type ApiErrorBody } from '../http/apiError';
import { createAccountRoleResolver, type AccountRoleResolver } from '../oxy/accountRoles';
import { createOxyPlaceFileStore, type PlaceFileStore } from '../oxy/placeFiles';
import { createRequireOperator } from './operator';

/**
 * Express's `Request` gains the fields `@oxy.so/core/server` populates.
 *
 * Declared here, once, so a handler elsewhere reads `req.userId` with a type
 * rather than casting — and so nothing else in the tree is tempted to declare a
 * SECOND augmentation with a different shape, which TypeScript merges silently
 * and which then disagrees with what the middleware actually sets.
 */
declare global {
  // biome-ignore lint/style/noNamespace: Express declares its global augmentation point as `namespace Express`
  namespace Express {
    interface Request {
      userId?: string;
      accessToken?: string;
      user?: OxyRequestUser | null;
      /** Who acted, and as whom. Read it with `oxyCallerOf`, never directly. */
      oxyActor?: OxyActorChain | null;
    }
  }
}

/** The Oxy client this process authenticates against. */
export const oxyClient = new OxyServer({ baseURL: config.oxyApiUrl });

/** Fail-closed: the request is refused unless it carries a valid Oxy session. */
export const requireAuth: RequestHandler = createOxyAuthMiddleware(oxyClient);

/**
 * Resolves a session when one is present and continues regardless.
 *
 * A handler behind this must treat "no user" as a normal case, not an error —
 * that is the whole point of a map that opens without an account.
 */
export const optionalAuth: RequestHandler = createOptionalOxyAuth(oxyClient);

/** Answers "what is this caller's role in that Oxy account?" — see `oxy/accountRoles`. */
export const accountRoles: AccountRoleResolver = createAccountRoleResolver({ oxyApiUrl: config.oxyApiUrl });

/** Checks, links and unlinks the Oxy files place galleries reference — see `oxy/placeFiles`. */
export const placeFiles: PlaceFileStore = createOxyPlaceFileStore({ oxyApiUrl: config.oxyApiUrl });

/** The moderation gate for this process's operator allow-list. Mounted after `requireAuth`. */
export const requireOperator: RequestHandler = createRequireOperator(config.moderationOperatorOxyUserIds);

/**
 * The 429 body: GoWay's error envelope, never the limiter's plain text.
 *
 * `~/Oxy/docs/api-conventions.md` puts the rate limiter's 429 inside the same
 * `{ error: { code, message, details } }` as every other failure, with
 * `details.retryAfterSeconds` beside the `Retry-After` header — so an SDK maps
 * it to a typed error instead of failing to parse "Too many requests".
 *
 * `createOxyRateLimit` has no handler option and types `message` as a string,
 * but it hands `message` to `express-rate-limit` untouched, and that library's
 * documented `message` also takes a FUNCTION of the request, called per
 * rejection — the only way to put the per-caller reset time in the body. The
 * cast below is that type gap and nothing else; `app.test.ts` holds the JSON
 * body to the contract, so a core release that stopped forwarding it fails
 * there rather than in production.
 */
function rateLimitedBody(request: Request & { rateLimit?: { resetTime?: Date } }): ApiErrorBody {
  const resetTime = request.rateLimit?.resetTime;
  const retryAfterSeconds = resetTime ? Math.max(1, Math.ceil((resetTime.getTime() - Date.now()) / 1000)) : 1;
  return new ApiError('rate_limited', 'Too many requests. Retry after the indicated delay.', {
    retryAfterSeconds,
  }).toResponseBody();
}

/** `createOxyRateLimit`, answering its 429 in the contract's error envelope. */
export function createGoWayRateLimit(options: Omit<OxyRateLimitOptions, 'message'> = {}): RequestHandler {
  return createOxyRateLimit(oxyClient, { ...options, message: rateLimitedBody as unknown as string });
}

/**
 * Per-caller rate limiting, keyed by the resolved Oxy session.
 *
 * Mounted on the API router rather than on the app, so the health probe stays
 * unlimited: a throttled probe reports a service down that is merely popular.
 */
export const apiRateLimit: RequestHandler = createGoWayRateLimit();

/**
 * A limit for contributions — reviews, replies and gallery writes — on top of
 * `apiRateLimit`.
 *
 * Each is a public statement somebody else reads; sixty in fifteen minutes is
 * a busy afternoon of honest reviewing and nowhere near a flood.
 */
export const contributionRateLimit: RequestHandler = createGoWayRateLimit({
  authenticatedMax: 60,
  anonymousMax: 60,
  windowMs: 15 * 60_000,
});

/**
 * A tighter limit for reports — of a Street 3D scene or of a place — on top of
 * `apiRateLimit`.
 *
 * A report is a moderation request a human reads; thirty in fifteen minutes is
 * far beyond any honest use and far below what would bury a moderator.
 */
export const reportRateLimit: RequestHandler = createGoWayRateLimit({
  authenticatedMax: 30,
  anonymousMax: 30,
  windowMs: 15 * 60_000,
});
