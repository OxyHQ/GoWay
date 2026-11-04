/**
 * The one question GoWay asks Oxy's account graph: "what may this caller do in
 * that account?"
 *
 * A place is claimed by an Oxy account — usually an organization — and Oxy, not
 * GoWay, decides who may act for it. GoWay keeps no member list
 * (`~/Oxy/docs/api-conventions.md` § Cross-app references); it asks, through
 * `OxyServer#accountAccessFor`, which reads `GET /accounts/:id` with the
 * request's OWN verified bearer on a disposable user client. Oxy resolves the
 * PERSON behind the session — somebody who switched into an organization still
 * gets their own access back — with inheritance, per-member grants and revokes
 * applied. GoWay gates on the effective `permissions`, never on a role name.
 *
 * ## Outcomes, translated once
 *
 *  - `ACCESS_DENIED` (Oxy's 403 or 404) is an ANSWER: no access, `null`;
 *  - `ACCESS_SESSION_REQUIRED` and `ACCESS_UNAVAILABLE` are rethrown as they
 *    are, and `http/errorHandler` answers them `401` and `503`: a write that
 *    cannot be authorized is not authorized, and "we could not tell" is never
 *    "no".
 *
 * ## Cached by the SDK, positive answers only
 *
 * `accountAccessFor` reuses an answer for 30 s per (account, session, person)
 * and never remembers a refusal or an outage. A write asks Oxy afresh: every
 * method but `GET`/`HEAD` passes `fresh`, so a removed member loses a write at
 * once and a read within the TTL.
 *
 * ## Organization authority
 *
 * {@link createOrganizationAuthority} demands an ORGANIZATION in which the
 * person may act (`account:act_as`). Organization-list writes call it twice:
 * once before taking any database connection, so a refused caller or an Oxy
 * outage never holds a pooled connection or the list's lock, and again after
 * the lock, so no queued write acts on an answer older than its turn.
 */

import {
  OxyAccessError,
  type OxyAccountAccess,
  type OxyCallerRequest,
  type OxyServer,
} from '@oxy.so/core/server';
import { ApiError } from '../http/apiError';

/** Who is asking, as the auth middleware resolved them. */
export interface OxyCaller {
  /** The session's EFFECTIVE account — `req.userId`; an organization after a switch. */
  readonly oxyAccountId: string;
  /** The person behind the session, from Oxy's actor chain; `null` when Oxy did not report one. */
  readonly operatedByOxyUserId: string | null;
  /** The request whose verified session Oxy is asked with. Its bearer is never stored. */
  readonly request: OxyCallerRequest & { readonly method: string };
}

/** Account permissions GoWay gates on (Oxy's `AccountPermission` vocabulary). */
export const ACCOUNT_PERMISSIONS = {
  /** Act as the account: speak for it on the map — edit its places, assert and withdraw. */
  actAs: 'account:act_as',
  /** Change who the account is: file a claim in its name. */
  update: 'account:update',
} as const;

/** What the caller may do in an account, or `null` when Oxy says they may do nothing there. */
export interface AccountAccessResolver {
  accessIn(caller: OxyCaller, oxyAccountId: string): Promise<OxyAccountAccess | null>;
}

const READ_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

export function createAccountAccessResolver(
  oxy: Pick<OxyServer, 'accountAccessFor'>,
): AccountAccessResolver {
  return {
    async accessIn(caller, oxyAccountId) {
      try {
        return await oxy.accountAccessFor(caller.request, oxyAccountId, {
          fresh: !READ_METHODS.has(caller.request.method),
        });
      } catch (error) {
        if (error instanceof OxyAccessError && error.code === 'ACCESS_DENIED') return null;
        throw error;
      }
    },
  };
}

/**
 * Resolves when the caller may act for the ORGANIZATION `oxyAccountId`, asked
 * live; throws `forbidden` otherwise, and fails closed like
 * {@link AccountAccessResolver}.
 */
export type OrganizationAuthority = (caller: OxyCaller, oxyAccountId: string) => Promise<void>;

export function createOrganizationAuthority(
  accounts: AccountAccessResolver,
): OrganizationAuthority {
  return async (caller, oxyAccountId) => {
    const access = await accounts.accessIn(caller, oxyAccountId);
    if (access?.kind !== 'organization' || !access.has(ACCOUNT_PERMISSIONS.actAs)) {
      throw new ApiError(
        'forbidden',
        'Only somebody who may act for the organization can edit its content.',
      );
    }
  };
}
