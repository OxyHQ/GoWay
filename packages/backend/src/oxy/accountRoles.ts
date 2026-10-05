/**
 * The one question GoWay asks Oxy's account graph: "what is this caller's role
 * in that account?"
 *
 * A place is claimed by an Oxy account — usually an organization — and Oxy, not
 * GoWay, decides who may act for it. GoWay keeps no member list
 * (`~/Oxy/docs/api-conventions.md` § Cross-app references); it asks.
 *
 * ## Asked with the CALLER's bearer, on a short-lived client
 *
 * `GET /accounts/:id` answers `callerMembership` for whoever's token it is
 * given, and there is no service-token endpoint that answers membership — nor
 * could one prove the person asked. So the caller's own access token is
 * forwarded, on a client built for this one question and disposed after it:
 * `middleware/auth.ts`'s `oxyClient` is process-wide, and planting a caller's
 * token on it would leak one session into a concurrent request.
 *
 * Oxy resolves the role for the PERSON behind the session: somebody who
 * switched into an organization still gets their own membership back. That is
 * the answer GoWay wants.
 *
 * ## Outcomes, translated once
 *
 *  - a `403` or `404` from Oxy is an ANSWER: no role;
 *  - a `401` is the caller's session failing at Oxy: `unauthorized`;
 *  - anything else — a timeout, a 5xx, a network error — is Oxy being
 *    unavailable, and GoWay FAILS CLOSED with `503 service_unavailable`. A
 *    write that cannot be authorized is not authorized.
 *
 * ## Cached briefly, per person and account
 *
 * Answers (a role or no role) are cached for {@link DEFAULT_ROLE_TTL_MS}, keyed
 * on the PERSON (Oxy's actor chain) and the account — never on the session's
 * effective account, which two people who switched into the same organization
 * share while holding different roles. A session whose actor Oxy did not
 * report is not cached at all. Failures are never cached. The cost of the
 * window is that a removed member keeps their access for up to the TTL, which
 * is the same bound Oxy's own clients accept.
 */

import { OxyApiError, OxyServices, type AccountNode, type AccountRole } from '@oxy.so/core';
import { ApiError } from '../http/apiError';
import { logger } from '../utils/logger';

/** How long an answer is reused. Short: membership is revocable. */
export const DEFAULT_ROLE_TTL_MS = 30_000;

/** The most answers held at once; the oldest is dropped past it. */
const MAX_CACHED_ANSWERS = 10_000;

/**
 * How long one question to Oxy may take, in milliseconds.
 *
 * One attempt, no retry: the caller is waiting on a write, and a slow Oxy is
 * better answered with a prompt `503` the client can retry than with the
 * client library's own backoff spent inside GoWay's request.
 */
const OXY_REQUEST_TIMEOUT_MS = 5_000;

/** Who is asking, as the auth middleware resolved them. */
export interface OxyCaller {
  /** The session's EFFECTIVE account — `req.userId`; an organization after a switch. */
  readonly oxyAccountId: string;
  /** The person behind the session, from Oxy's actor chain; `null` when Oxy did not report one. */
  readonly operatedByOxyUserId: string | null;
  /** The caller's bearer, forwarded to Oxy and never stored. */
  readonly accessToken: string | null;
}

/** The caller's role in an account, or `null` when they hold none. */
export interface AccountRoleResolver {
  roleIn(caller: OxyCaller, oxyAccountId: string): Promise<AccountRole | null>;
}

export interface AccountRoleResolverOptions {
  /** The Oxy API origin. */
  readonly oxyApiUrl: string;
  readonly ttlMs?: number;
  readonly now?: () => number;
}

/** The caller's role in one account node. `self` is their own personal account: implicit ownership. */
function roleOf(node: AccountNode): AccountRole | null {
  if (node.relationship === 'self') return 'owner';
  const membership = node.callerMembership;
  return membership !== null && membership.status === 'active' ? membership.role : null;
}

/** `null` for an answer that means "no access"; throws for everything else. */
function translate(error: unknown): null {
  if (error instanceof OxyApiError && (error.status === 403 || error.status === 404)) return null;
  if (error instanceof OxyApiError && error.status === 401) {
    throw new ApiError('unauthorized', 'Your Oxy session is no longer valid. Sign in again.');
  }
  logger.warn(
    { status: error instanceof OxyApiError ? error.status : undefined },
    'Oxy account graph unavailable; refusing an organization-scoped request',
  );
  throw new ApiError(
    'service_unavailable',
    'Organization access cannot be checked right now because Oxy is unavailable. Try again shortly.',
  );
}

export function createAccountRoleResolver(options: AccountRoleResolverOptions): AccountRoleResolver {
  const ttlMs = options.ttlMs ?? DEFAULT_ROLE_TTL_MS;
  const now = options.now ?? Date.now;
  const answers = new Map<string, { role: AccountRole | null; expiresAt: number }>();

  async function ask(accessToken: string, oxyAccountId: string): Promise<AccountRole | null> {
    const client = new OxyServices({
      baseURL: options.oxyApiUrl,
      enableCache: false,
      enableRetry: false,
      requestTimeout: OXY_REQUEST_TIMEOUT_MS,
    });
    client.session.setAccessToken(accessToken);
    try {
      return roleOf(await client.accounts.get(oxyAccountId));
    } catch (error) {
      return translate(error);
    } finally {
      client.dispose();
    }
  }

  return {
    async roleIn(caller, oxyAccountId) {
      if (caller.accessToken === null) {
        // Behind `requireAuth` a session always carries its token; reaching here
        // without one means the middleware was rewired, and the answer to "may
        // this unidentified request act for an organization" is no.
        throw new ApiError('unauthorized', 'This request requires an Oxy session.');
      }
      const key = caller.operatedByOxyUserId === null ? null : `${caller.operatedByOxyUserId}\u0000${oxyAccountId}`;
      if (key !== null) {
        const cached = answers.get(key);
        if (cached && cached.expiresAt > now()) return cached.role;
        answers.delete(key);
      }

      const role = await ask(caller.accessToken, oxyAccountId);
      if (key !== null) {
        if (answers.size >= MAX_CACHED_ANSWERS) {
          const oldest = answers.keys().next();
          if (!oldest.done) answers.delete(oldest.value);
        }
        answers.set(key, { role, expiresAt: now() + ttlMs });
      }
      return role;
    },
  };
}
