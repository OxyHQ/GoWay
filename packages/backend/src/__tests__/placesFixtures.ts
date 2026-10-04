/**
 * Fixtures every Places suite shares: who writes, and the Oxy membership answer
 * when no test is about organizations.
 */

import type { RequestHandler } from 'express';
import type { RevisionAuthor } from '../db/places/revisions';
import type { AccountRoleResolver } from '../oxy/accountRoles';

/** A write made through the public API by `oxyAccountId`, acting as itself. */
export function apiAuthor(oxyAccountId: string): RevisionAuthor {
  return { oxyAccountId, operatedByOxyUserId: oxyAccountId, source: 'api' };
}

/**
 * Oxy, as a suite that is not about organizations sees it: nobody is a member
 * of anything. Exactly the answer GoWay gave before claims could name an
 * organization, so a suite written then keeps meaning what it meant.
 */
export const NO_MEMBERSHIPS: AccountRoleResolver = {
  async roleIn() {
    return null;
  },
};

/** A rate limit that never limits, for suites that are not about one. */
export const NO_RATE_LIMIT: RequestHandler = (_request, _response, next) => {
  next();
};
