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

import { OxyServices } from '@oxy.so/core';
import {
  createOptionalOxyAuth,
  createOxyAuthMiddleware,
  createOxyRateLimit,
  type OxyRequestUser,
} from '@oxy.so/core/server';
import type { RequestHandler } from 'express';
import { config } from '../config';

/**
 * Express's `Request` gains the fields `@oxy.so/core/server` populates.
 *
 * Declared here, once, so a handler elsewhere reads `req.userId` with a type
 * rather than casting — and so nothing else in the tree is tempted to declare a
 * SECOND augmentation with a different shape, which TypeScript merges silently
 * and which then disagrees with what the middleware actually sets.
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
      accessToken?: string;
      user?: OxyRequestUser | null;
    }
  }
}

/** The Oxy client this process authenticates against. */
export const oxyClient = new OxyServices({ baseURL: config.oxyApiUrl });

/** Fail-closed: the request is refused unless it carries a valid Oxy session. */
export const requireAuth: RequestHandler = createOxyAuthMiddleware(oxyClient);

/**
 * Resolves a session when one is present and continues regardless.
 *
 * A handler behind this must treat "no user" as a normal case, not an error —
 * that is the whole point of a map that opens without an account.
 */
export const optionalAuth: RequestHandler = createOptionalOxyAuth(oxyClient);

/**
 * Per-caller rate limiting, keyed by the resolved Oxy session.
 *
 * Mounted on the API router rather than on the app, so the health probe stays
 * unlimited: a throttled probe reports a service down that is merely popular.
 */
export const apiRateLimit: RequestHandler = createOxyRateLimit(oxyClient);
