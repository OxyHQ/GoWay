/**
 * The moderation operator gate.
 *
 * Side-effect free, like `oxy/caller`, so the moderation router's tests build
 * it with their own allow-list; `middleware/auth` builds the process's one from
 * `MODERATION_OPERATOR_OXY_USER_IDS`.
 */

import type { RequestHandler } from 'express';
import { ApiError } from '../http/apiError';
import { oxyCallerOf } from '../oxy/caller';

/**
 * Refuses a request unless the PERSON behind it is a GoWay moderation operator.
 *
 * Mounted after `requireAuth`. The allow-list (`MODERATION_OPERATOR_OXY_USER_IDS`)
 * is matched against Oxy's actor — the human — so switching into an
 * organization neither grants nor removes operator rights. A session whose
 * actor Oxy did not report is matched on its own account, which is the person
 * whenever nobody switched.
 */
export function createRequireOperator(operatorOxyUserIds: readonly string[]): RequestHandler {
  const operators = new Set(operatorOxyUserIds);
  return (request, _response, next) => {
    const caller = oxyCallerOf(request);
    if (caller === null) {
      next(new ApiError('unauthorized', 'This request requires an Oxy session.'));
      return;
    }
    if (!operators.has(caller.operatedByOxyUserId ?? caller.oxyAccountId)) {
      next(new ApiError('forbidden', 'Only a GoWay moderation operator may do this.'));
      return;
    }
    next();
  };
}
