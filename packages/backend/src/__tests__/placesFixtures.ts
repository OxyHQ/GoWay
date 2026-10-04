/**
 * Fixtures every Places suite shares: who writes, and the Oxy membership answer
 * when no test is about organizations.
 */

import type { RequestHandler } from 'express';
import type { RevisionAuthor } from '../db/places/revisions';
import type { AccountRoleResolver } from '../oxy/accountRoles';
import type { PlaceFileStore } from '../oxy/placeFiles';

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

/**
 * Oxy files, as a suite that never adds to a gallery sees them: nothing may be
 * attached. A suite about galleries runs the real store against `fakeOxy`.
 */
export const NO_FILES: PlaceFileStore = {
  async attach() {
    throw new Error('This suite does not attach Oxy files.');
  },
  async detach() {
    return undefined;
  },
};
