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
import type { RequestHandler } from 'express';
import { isLiveShapeRequest } from './liveShapeRequest';
import type { OxyActorChain } from '../oxy/caller';
import { config } from '../config';
import { createAccountRoleResolver, type AccountRoleResolver } from '../oxy/accountRoles';
import { getDb } from '../db/postgres';
import {
  createFileReferenceWorker,
  createOxyFileReferences,
  type FileReferenceWorker,
} from '../oxy/fileReferences';
import { createOxyPlaceFileStore, type PlaceFileStore } from '../oxy/placeFiles';
import { createLogger } from '../utils/logger';
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
export const accountRoles: AccountRoleResolver = createAccountRoleResolver({
  oxyApiUrl: config.oxyApiUrl,
});

/**
 * GoWay's own Oxy file references (`oxy/fileReferences`): made and removed with
 * GoWay's service token — in a deployment the ECS task role's attested
 * workload identity (Oxy ADR 0026), whose binding must name the GoWay
 * application and carry `files:references:write`. Where the process cannot
 * mint a token, adding to a gallery answers `503` and queued changes wait.
 */
const goWayFileReferences = createOxyFileReferences({ baseURL: config.oxyApiUrl });

/** Checks the Oxy files place galleries show, and references them — see `oxy/placeFiles`. */
export const placeFiles: PlaceFileStore = createOxyPlaceFileStore({
  oxyApiUrl: config.oxyApiUrl,
  references: goWayFileReferences,
});

/** Delivers and reconciles GoWay's queued reference changes. Its loop is started by `server.ts`. */
export const fileReferences: FileReferenceWorker = createFileReferenceWorker({
  getDb,
  references: goWayFileReferences,
  logger: createLogger('oxy-references'),
});

/** The moderation gate for this process's operator allow-list. Mounted after `requireAuth`. */
export const requireOperator: RequestHandler = createRequireOperator(
  config.moderationOperatorOxyUserIds,
);

/**
 * `createOxyRateLimit` with GoWay's wording.
 *
 * `~/Oxy/docs/api-conventions.md` puts the rate limiter's 429 inside the same
 * `{ error: { code, message, details } }` as every other failure, with
 * `details.retryAfterSeconds` beside the `Retry-After` header — so an SDK maps
 * it to a typed error instead of failing to parse "Too many requests". Since
 * `@oxy.so/core` 4.11 the limiter answers exactly that itself; GoWay supplies
 * only the message. `app.test.ts` holds the body to the contract.
 */
export function createGoWayRateLimit(
  options: Omit<OxyRateLimitOptions, 'message'> = {},
): RequestHandler {
  return createOxyRateLimit(oxyClient, {
    ...options,
    message: 'Too many requests. Retry after the indicated delay.',
  });
}

/**
 * Per-caller rate limiting, keyed by the resolved Oxy session.
 *
 * Mounted on the API router rather than on the app, so the health probe stays
 * unlimited: a throttled probe reports a service down that is merely popular.
 */
export const apiRateLimit: RequestHandler = createGoWayRateLimit({
  exempt: (request) => isLiveShapeRequest(request),
});

/**
 * The limit for an operator's published route shapes, INSTEAD of
 * `apiRateLimit`: a map of New York draws vehicles on a few hundred lines, each
 * fetched once (and cached by the browser for an hour). Static, small,
 * read-only data, so the bucket is wider than the API's — not unlimited.
 */
export const liveShapeRateLimit: RequestHandler = createGoWayRateLimit({
  authenticatedMax: 3000,
  anonymousMax: 3000,
  windowMs: 15 * 60_000,
});

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

/**
 * A limit for organization-list writes, on top of `apiRateLimit`.
 *
 * Every write asks Oxy's account graph who may act for the organization, so an
 * unbounded writer makes GoWay an amplifier against Oxy. Sixty in fifteen
 * minutes is an editor rebuilding a whole day's programme, twice.
 */
export const organizationListWriteRateLimit: RequestHandler = createGoWayRateLimit({
  authenticatedMax: 60,
  anonymousMax: 60,
  windowMs: 15 * 60_000,
});
