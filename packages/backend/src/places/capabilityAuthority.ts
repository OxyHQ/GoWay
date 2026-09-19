/**
 * Who may assert what about a place — the one place that decision is made.
 *
 * A capability assertion carries a VERIFICATION tier, and the tier is the whole
 * of what a consumer trusts: `@goway.to/sdk` publishes it, the GoWay app
 * renders `oxy_verified` differently from `community_reported`, and a FairCoin
 * wallet decides on the strength of it whether to send a user to a shop. So the
 * tier must be a function of WHO IS ASKING and of the evidence attached, and
 * never of anything in a request body.
 *
 * ## Why this is a module rather than a line in the route
 *
 * Issue #8's acceptance criterion is that "anonymous/community assertions
 * cannot masquerade as verified acceptance". A validation rule that strips
 * `verification` from a body satisfies that today and stops satisfying it the
 * first time somebody adds a field to a schema — which is a one-line change
 * that looks harmless in review. What survives a refactor is a shape where the
 * strong tiers have no path from the HTTP layer AT ALL:
 *
 *   1. {@link VERIFICATION_ORIGIN} classifies every published tier by where its
 *      value comes from, as a TOTAL `Record<CapabilityVerification, …>`. A tier
 *      added to `@goway/shared-types` fails this package to compile until
 *      somebody decides which kind it is, exactly as `API_ERROR_STATUS` does
 *      for error codes.
 *   2. {@link assertableVerification} derives the tier from a
 *      {@link PlaceAuthorization} — approved claims read from the database —
 *      and returns a type that CANNOT hold `oxy_verified`. Every write path
 *      types its actor with that union, so reaching the strong tier is a type
 *      error rather than a policy violation.
 *   3. {@link assertWritableVerification} is the last gate before the INSERT,
 *      and it refuses a moderation-origin tier at runtime whatever produced it.
 *      Belt and braces on purpose: (2) is erased at compile time, so it cannot
 *      defend against a value that arrives through a `Record<string, unknown>`
 *      or a future `as` cast.
 *
 * `oxy_verified` therefore has no API path in or out. Issue #4 established that
 * deliberately and `placeCapabilities.realdb.test.ts` proves it stays true,
 * including for a caller who sends the field directly.
 */

import {
  CAPABILITY_VERIFICATIONS,
  type CapabilityVerification,
  type PlaceClaimRole,
} from '@goway/shared-types';
import { ApiError } from '../http/apiError';
import type { PlaceAuthorization } from '../db/places/placesRepository';

/**
 * Where a verification tier's value comes from.
 *
 *  - `actor`      — derived from the caller's own standing on the place. These
 *                   are the only tiers an HTTP write can produce directly.
 *  - `evidence`   — derived from something attached to the assertion that
 *                   outlives the request. `external_source` names a row in
 *                   `places_sources`, which the table's CHECK requires and
 *                   which a reviewer can go and check against that source.
 *  - `moderation` — a statement GoWay makes, through a reviewed act that is not
 *                   this API. No request may produce one.
 */
export type VerificationOrigin = 'actor' | 'evidence' | 'moderation';

/**
 * Every published tier, classified.
 *
 * TOTAL over `CapabilityVerification` on purpose. `CAPABILITY_VERIFICATIONS`
 * lives in `@goway/shared-types` and is shared by the SDK, the frontend's
 * evidence ranking and this table's CHECK constraint; widening it is a
 * deliberate act, and this record makes the second half of that act —
 * "and who is allowed to write it" — impossible to forget.
 */
export const VERIFICATION_ORIGIN = {
  community_reported: 'actor',
  external_source: 'evidence',
  business_asserted: 'actor',
  oxy_verified: 'moderation',
} as const satisfies Record<CapabilityVerification, VerificationOrigin>;

/**
 * A tier an API caller's own standing may earn them.
 *
 * DERIVED from {@link VERIFICATION_ORIGIN} rather than written out a second
 * time, so the union and the classification cannot drift: reclassifying
 * `business_asserted` as `moderation` narrows this type in the same edit, and
 * every write path typed with it stops compiling until it is reconciled. The
 * `as const satisfies` above is what makes that possible — `satisfies` enforces
 * totality over the published tier tuple while `as const` keeps the literal
 * values this mapped type reads.
 */
export type AssertableVerification = {
  [K in keyof typeof VERIFICATION_ORIGIN]: (typeof VERIFICATION_ORIGIN)[K] extends 'actor'
    ? K
    : never;
}[keyof typeof VERIFICATION_ORIGIN];

/** The same set at runtime, for anything that has to enumerate it. */
export const ASSERTABLE_VERIFICATIONS: readonly AssertableVerification[] =
  CAPABILITY_VERIFICATIONS.filter(
    (verification): verification is AssertableVerification =>
      VERIFICATION_ORIGIN[verification] === 'actor',
  );

/**
 * Whether an APPROVED claim in each role carries authority to speak FOR the
 * business.
 *
 * Total over `PLACE_CLAIM_ROLES`, so a role added to the contract — a
 * `delegate`, a `contributor` — cannot inherit `business_asserted` by being
 * absent from a list. It has to be classified here, in a review that can ask
 * whether that role really speaks for the business.
 *
 * All four of today's roles do. `owner`, `operator` and `manager` run the
 * location; `brand` is the chain the location trades under, and a chain saying
 * "our shops take FairCoin" is a business assertion about its own shops. What
 * separates a business assertion from a community report is not the role — it
 * is that the claim was APPROVED, which {@link PlaceAuthorization} has already
 * filtered on before this is consulted.
 */
const CLAIM_ROLE_SPEAKS_FOR_BUSINESS: Readonly<Record<PlaceClaimRole, boolean>> = {
  owner: true,
  operator: true,
  manager: true,
  brand: true,
};

/**
 * The tier this caller's UNSOURCED assertion earns on this place.
 *
 * `business_asserted` for an account holding an approved claim in an
 * authoritative role, `community_reported` for every other authenticated
 * caller. Nothing else is reachable: the return type says so, and the caller's
 * standing is read from `places_claims` rather than from the request.
 *
 * A capability that NAMES a source is `external_source` instead, decided in the
 * repository beside the source link that makes it true — evidence, not
 * standing, and the table refuses the tier without the link.
 */
export function assertableVerification(authorization: PlaceAuthorization): AssertableVerification {
  const speaksForBusiness = authorization.callerRoles.some(
    (role) => CLAIM_ROLE_SPEAKS_FOR_BUSINESS[role],
  );
  return speaksForBusiness ? 'business_asserted' : 'community_reported';
}

/**
 * The tier this caller may WITHDRAW on this place, or null if they may withdraw
 * nothing.
 *
 * Only `business_asserted`, and only for an approved claimant. The asymmetry
 * with {@link assertableVerification} is deliberate and it follows from the
 * schema: `places_capabilities` records no author, so the community tier is one
 * shared row rather than one row per reporter. Letting any signed-in account
 * DELETE it would let a stranger erase a report they did not write, with
 * nothing recording that they did — while a claimant deleting the
 * `business_asserted` row is attributable by construction, because holding the
 * approved claim is what granted the right.
 *
 * A community reporter retracts by ASSERTING instead: `PUT … {"value": false}`
 * refreshes their own tier's row to "not accepted" with a current `observedAt`.
 * That is strictly better evidence than a deletion anyway — a missing row means
 * "nobody has said", and a wallet cannot tell that from "somebody checked and
 * it stopped being true".
 */
export function withdrawableVerification(
  authorization: PlaceAuthorization,
): Extract<AssertableVerification, 'business_asserted'> | null {
  return assertableVerification(authorization) === 'business_asserted' ? 'business_asserted' : null;
}

/**
 * The last gate before a verification tier reaches an INSERT.
 *
 * Refuses a `moderation`-origin tier as an `internal_error` rather than a
 * client-visible refusal, because reaching here with one is not something a
 * request can do — it is a defect in a write path, and answering 4xx would
 * describe it as the caller's fault.
 *
 * Deliberately redundant with the type system. A type is erased at runtime, so
 * it cannot stop a value that arrives through a cast, a `Record<string,
 * unknown>` or a future importer that builds its actor dynamically. This stops
 * that write from committing.
 */
export function assertWritableVerification(
  verification: CapabilityVerification,
): CapabilityVerification {
  if (VERIFICATION_ORIGIN[verification] === 'moderation') {
    throw new ApiError(
      'internal_error',
      'A capability assertion cannot be written at a moderation-only verification tier.',
    );
  }
  return verification;
}
