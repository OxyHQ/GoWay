/**
 * The caller of a request, as `@oxy.so/core/server`'s middleware resolved it.
 *
 * Free of side effects on purpose — no configuration parse, no Oxy client — so a
 * router can read its caller without importing `middleware/auth`, whose module
 * load builds the process's Oxy client. Routers stay testable with injected
 * middlewares, exactly as `routes/places.ts` explains.
 */

import { getOxyActor } from '@oxy.so/core/server';
import type { Request } from 'express';
import { ApiError } from '../http/apiError';
import type { OxyCaller } from './accountRoles';

/** Oxy's "who acted, and as whom" for a session (`getOxyActor`). */
export type OxyActorChain = NonNullable<ReturnType<typeof getOxyActor>>;

/**
 * Who is calling: the session's account, the person behind it, and the bearer
 * that can ask Oxy about them — or `null` for a signed-out request.
 *
 * `oxyAccountId` is the EFFECTIVE account, an organization when somebody
 * switched into one. `operatedByOxyUserId` is the person, from Oxy's actor
 * chain; when Oxy did not report one it is `null` and recorded as unknown,
 * never guessed from the effective account.
 */
export function oxyCallerOf(request: Request): OxyCaller | null {
  const oxyAccountId =
    typeof request.userId === 'string' && request.userId.length > 0 ? request.userId : null;
  if (oxyAccountId === null) return null;
  const actor = getOxyActor(request);
  return {
    oxyAccountId,
    operatedByOxyUserId: actor ? actor.actorAccountId : null,
    accessToken:
      typeof request.accessToken === 'string' && request.accessToken.length > 0
        ? request.accessToken
        : null,
  };
}

/** {@link oxyCallerOf} behind `requireAuth`, where a signed-out request is a rewired middleware. */
export function requiredOxyCaller(request: Request): OxyCaller {
  const caller = oxyCallerOf(request);
  if (caller === null) throw new ApiError('unauthorized', 'This request requires an Oxy session.');
  return caller;
}
