/**
 * Who may act for a claimed business — the one place that decision is made.
 *
 * A claim names an Oxy account, usually an ORGANIZATION. A caller acts for it
 * when either:
 *
 *  (a) the session IS that account — a person's own account, or a session that
 *      switched into the organization (`oxy.accounts.actAs`), whose token's
 *      subject is then the organization; or
 *  (b) the person holds the account permission the action needs, as Oxy
 *      reports with the caller's own bearer (`oxy/accountAccess`):
 *
 *       - `account:act_as` to ACT for its claims — edit the claimed place,
 *         assert and withdraw at the business's tier, read the claims;
 *       - `account:update` to FILE a new claim in its name, which is a
 *         statement about who the business is.
 *
 *      Oxy's role baselines give the first to owners, administrators and
 *      editors and the second to owners and administrators; a per-member grant
 *      or revoke in Oxy moves either, and GoWay follows it.
 *
 * (a) needs no network. (b) asks Oxy, and a failure to ask is a
 * `503 service_unavailable` — never a guess in either direction.
 */

import type { PlaceClaimRole } from '@goway/contracts';
import {
  ACCOUNT_PERMISSIONS,
  type AccountAccessResolver,
  type OxyCaller,
} from '../oxy/accountAccess';
import type { ApprovedClaim } from '../db/places/placesRepository';
import { CLAIM_ROLE_SPEAKS_FOR_BUSINESS } from './capabilityAuthority';

/** Whether the caller is `oxyAccountId`, or holds `permission` in it. */
async function holds(
  caller: OxyCaller,
  oxyAccountId: string,
  permission: string,
  accounts: AccountAccessResolver,
): Promise<boolean> {
  if (caller.oxyAccountId === oxyAccountId) return true;
  return (await accounts.accessIn(caller, oxyAccountId))?.has(permission) ?? false;
}

/** Whether the caller may act for `oxyAccountId`'s claims. */
export function mayActFor(
  caller: OxyCaller,
  oxyAccountId: string,
  accounts: AccountAccessResolver,
): Promise<boolean> {
  return holds(caller, oxyAccountId, ACCOUNT_PERMISSIONS.actAs, accounts);
}

/** Whether the caller may file a claim in `oxyAccountId`'s name. */
export function mayFileFor(
  caller: OxyCaller,
  oxyAccountId: string,
  accounts: AccountAccessResolver,
): Promise<boolean> {
  return holds(caller, oxyAccountId, ACCOUNT_PERMISSIONS.update, accounts);
}

/** Whether the caller may act for ANY of these accounts. Asks Oxy only for accounts the session is not. */
export async function mayActForAny(
  caller: OxyCaller,
  oxyAccountIds: readonly string[],
  accounts: AccountAccessResolver,
): Promise<boolean> {
  const unique = [...new Set(oxyAccountIds)];
  if (unique.includes(caller.oxyAccountId)) return true;
  for (const account of unique) {
    if (await mayActFor(caller, account, accounts)) return true;
  }
  return false;
}

/** What a caller is to a place: whether anybody holds it, and which approved roles the caller acts in. */
export interface PlaceStanding {
  /** Whether ANY account holds an approved claim — a claimed business is not community-editable. */
  readonly claimed: boolean;
  /** The approved claim roles this caller acts in. Empty for everyone else. */
  readonly callerRoles: readonly PlaceClaimRole[];
}

/**
 * The caller's standing on a place, from its APPROVED claims.
 *
 * An unclaimed place costs no Oxy call. A session that itself holds a claim
 * whose role speaks for the business needs none either: nothing Oxy could add
 * would change a decision made from these roles, and a business must not lose
 * its own place to an Oxy outage over a question that was already answered.
 * Every other claim account is asked about, and an Oxy failure is a 503.
 */
export async function standingOn(
  claims: readonly ApprovedClaim[],
  caller: OxyCaller,
  accounts: AccountAccessResolver,
): Promise<PlaceStanding> {
  if (claims.length === 0) return { claimed: false, callerRoles: [] };

  const direct = claims
    .filter((claim) => claim.oxyAccountId === caller.oxyAccountId)
    .map((claim) => claim.role);
  if (direct.some((role) => CLAIM_ROLE_SPEAKS_FOR_BUSINESS[role]))
    return { claimed: true, callerRoles: direct };

  const callerRoles = [...direct];
  for (const account of [...new Set(claims.map((claim) => claim.oxyAccountId))]) {
    if (account === caller.oxyAccountId) continue;
    if (await mayActFor(caller, account, accounts)) {
      callerRoles.push(
        ...claims.filter((claim) => claim.oxyAccountId === account).map((claim) => claim.role),
      );
    }
  }
  return { claimed: true, callerRoles };
}

/**
 * Whether the caller is AFFILIATED with any of these accounts: is one — the
 * session, or the person behind it — or has ANY access to one, as Oxy reports
 * it.
 *
 * Deliberately wider than {@link mayActFor}. Acting for a business is a
 * question of authority, so a `viewer` does not; having an interest in it is a
 * question of conflict, so a `viewer` does — an employee reviewing their
 * employer's shop is the case this exists for. An Oxy failure is a 503, as
 * everywhere else: "we could not tell" is not "no".
 */
export async function affiliatedWithAny(
  caller: OxyCaller,
  oxyAccountIds: readonly string[],
  access: AccountAccessResolver,
): Promise<boolean> {
  const accounts = [...new Set(oxyAccountIds)];
  const self = new Set(
    [caller.oxyAccountId, caller.operatedByOxyUserId].filter((id): id is string => id !== null),
  );
  if (accounts.some((account) => self.has(account))) return true;
  for (const account of accounts) {
    if ((await access.accessIn(caller, account)) !== null) return true;
  }
  return false;
}
