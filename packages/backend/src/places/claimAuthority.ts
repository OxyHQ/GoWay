/**
 * Who may act for a claimed business — the one place that decision is made.
 *
 * A claim names an Oxy account, usually an ORGANIZATION. A caller acts for it
 * when either:
 *
 *  (a) the session IS that account — a person's own account, or a session that
 *      switched into the organization (`oxy.accounts.actAs`), whose token's
 *      subject is then the organization; or
 *  (b) the person is a MEMBER of it, in a role {@link ACCOUNT_ROLE_AUTHORITY}
 *      says can act, as Oxy reports with the caller's own bearer
 *      (`oxy/accountRoles`).
 *
 * (a) needs no network. (b) asks Oxy, and a failure to ask is a
 * `503 service_unavailable` — never a guess in either direction.
 */

import type { AccountRole } from '@oxy.so/core';
import type { PlaceClaimRole } from '@goway/contracts';
import type { AccountRoleResolver, OxyCaller } from '../oxy/accountRoles';
import type { ApprovedClaim } from '../db/places/placesRepository';
import { CLAIM_ROLE_SPEAKS_FOR_BUSINESS } from './capabilityAuthority';

/**
 * What each Oxy account role may do with that account's claims.
 *
 *  - `acts`  — edit the claimed place, assert and withdraw at the business's
 *              tier, read the claims. Content work: `owner`, `admin` and
 *              `editor`.
 *  - `files` — file a NEW claim in the account's name, which is a statement
 *              about who the business is: `owner` and `admin` only.
 *
 * `developer`, `billing` and `viewer` do neither: none of them is a role in
 * which a person speaks for the business on a public map.
 *
 * TOTAL over Oxy's `AccountRole`, so a role Oxy adds fails this package to
 * compile on the upgrade that brings it, until somebody decides what it may do
 * here — rather than inheriting nothing, or everything, by omission.
 */
export const ACCOUNT_ROLE_AUTHORITY: Readonly<Record<AccountRole, { acts: boolean; files: boolean }>> = {
  owner: { acts: true, files: true },
  admin: { acts: true, files: true },
  editor: { acts: true, files: false },
  developer: { acts: false, files: false },
  billing: { acts: false, files: false },
  viewer: { acts: false, files: false },
};

/** Whether the caller may act for `oxyAccountId`'s claims: is it, or holds an acting role in it. */
export async function mayActFor(
  caller: OxyCaller,
  oxyAccountId: string,
  roles: AccountRoleResolver,
): Promise<boolean> {
  if (caller.oxyAccountId === oxyAccountId) return true;
  const role = await roles.roleIn(caller, oxyAccountId);
  return role !== null && ACCOUNT_ROLE_AUTHORITY[role].acts;
}

/** Whether the caller may file a claim in `oxyAccountId`'s name: is it, or owns or administers it. */
export async function mayFileFor(
  caller: OxyCaller,
  oxyAccountId: string,
  roles: AccountRoleResolver,
): Promise<boolean> {
  if (caller.oxyAccountId === oxyAccountId) return true;
  const role = await roles.roleIn(caller, oxyAccountId);
  return role !== null && ACCOUNT_ROLE_AUTHORITY[role].files;
}

/** Whether the caller may act for ANY of these accounts. Asks Oxy only for accounts the session is not. */
export async function mayActForAny(
  caller: OxyCaller,
  oxyAccountIds: readonly string[],
  roles: AccountRoleResolver,
): Promise<boolean> {
  const accounts = [...new Set(oxyAccountIds)];
  if (accounts.includes(caller.oxyAccountId)) return true;
  for (const account of accounts) {
    if (await mayActFor(caller, account, roles)) return true;
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
  roles: AccountRoleResolver,
): Promise<PlaceStanding> {
  if (claims.length === 0) return { claimed: false, callerRoles: [] };

  const direct = claims.filter((claim) => claim.oxyAccountId === caller.oxyAccountId).map((claim) => claim.role);
  if (direct.some((role) => CLAIM_ROLE_SPEAKS_FOR_BUSINESS[role])) return { claimed: true, callerRoles: direct };

  const callerRoles = [...direct];
  for (const account of [...new Set(claims.map((claim) => claim.oxyAccountId))]) {
    if (account === caller.oxyAccountId) continue;
    if (await mayActFor(caller, account, roles)) {
      callerRoles.push(...claims.filter((claim) => claim.oxyAccountId === account).map((claim) => claim.role));
    }
  }
  return { claimed: true, callerRoles };
}
