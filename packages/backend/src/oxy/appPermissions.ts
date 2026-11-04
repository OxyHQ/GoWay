/**
 * GoWay's application roles: who operates GoWay is decided in Oxy.
 *
 * GoWay declares its permission keys on its Oxy application and the owning
 * account's administrators grant them to people (`~/Oxy/docs/application-roles.md`);
 * GoWay keeps no allow-list of Oxy user ids. `@oxy.so/core` reads what the
 * PERSON behind a request holds, with the request's own verified bearer —
 * somebody who switched into an organization is answered for themselves, and
 * a service token never holds a key.
 *
 * Refusals reach `http/errorHandler`, which answers them in GoWay's envelope:
 * no key is `403 forbidden`, no session `401`, and Oxy unable to say `503` —
 * never cached, never a "no". Reads reuse an answer for 30 s; every other
 * method asks Oxy afresh, so a revocation stops the next write.
 */

import type { OxyServer } from '@oxy.so/core/server';
import { OxyAppPermissionError } from '@oxy.so/core/server';
import type { Request, RequestHandler } from 'express';

/** Approve claims, verify capabilities, merge duplicates, resolve reports, edit the taxonomy. */
export const MODERATION_PERMISSION = 'moderation.operate';

/**
 * Contribute Street 3D captures while contribution is a closed pilot: the
 * pipeline's privacy and operational controls are verified end to end in
 * production before anybody else's imagery enters it. Opening contribution to
 * every account is deleting this gate, not granting the key to everybody.
 */
export const CAPTURE_PILOT_PERMISSION = 'capture.pilot';

const READ_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

/** Whether `request` asks Oxy afresh: anything that is not a read. */
function freshFor(request: Request): boolean {
  return !READ_METHODS.has(request.method);
}

/**
 * The moderation gate, mounted after `requireAuth`. The operator Oxy resolved
 * is left on `req.oxyAppPermissions.operatorId`, which is who a moderation
 * decision is attributed to.
 */
export function createRequireOperator(oxy: Pick<OxyServer, 'middleware'>): RequestHandler {
  const options = { deny: 403, respond: false } as const;
  const read = oxy.middleware.requireAppPermission(MODERATION_PERMISSION, options);
  const write = oxy.middleware.requireAppPermission(MODERATION_PERMISSION, {
    ...options,
    fresh: true,
  });
  return (request, response, next) => (freshFor(request) ? write : read)(request, response, next);
}

/**
 * Whether the person behind `request` may contribute, during the closed pilot.
 * `false` for a signed-out request or a person without the key; Oxy unable to
 * say rejects, and the error handler answers `503`.
 */
export type ContributionGate = (request: Request) => Promise<boolean>;

export function createContributionGate(
  oxy: Pick<OxyServer, 'appPermissionsFor'>,
): ContributionGate {
  return async (request) => {
    try {
      const held = await oxy.appPermissionsFor(request, { fresh: freshFor(request) });
      return held.has(CAPTURE_PILOT_PERMISSION);
    } catch (error) {
      if (
        error instanceof OxyAppPermissionError &&
        (error.code === 'APP_PERMISSION_DENIED' || error.code === 'APP_PERMISSION_SESSION_REQUIRED')
      ) {
        return false;
      }
      throw error;
    }
  };
}
