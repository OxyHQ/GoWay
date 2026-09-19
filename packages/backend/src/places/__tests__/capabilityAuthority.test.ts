/**
 * The tier decision, on its own.
 *
 * Every HTTP test of the write path exercises this function through a socket
 * and a database; these assertions are here because the property they pin is
 * about the SHAPE of the decision rather than about any one request — that the
 * strong tiers are unreachable by construction, not merely unreached by the
 * requests somebody thought to try.
 *
 * Two of the checks below are compile-time and have no runtime assertion at
 * all. `tsconfig.tools.json` type-checks this directory, so a `@ts-expect-error`
 * that stops being an error fails `bun run typecheck` — which is the only way
 * to test a guarantee the type system makes, since the type is erased before
 * any test could run.
 */

import { describe, expect, it } from 'bun:test';
import { CAPABILITY_VERIFICATIONS, PLACE_CLAIM_ROLES } from '@goway/shared-types';
import type { PlaceAuthorization } from '../../db/places/placesRepository';
import { isApiError } from '../../http/apiError';
import {
  ASSERTABLE_VERIFICATIONS,
  VERIFICATION_ORIGIN,
  assertWritableVerification,
  assertableVerification,
  withdrawableVerification,
  type AssertableVerification,
} from '../capabilityAuthority';

function authorization(overrides: Partial<PlaceAuthorization> = {}): PlaceAuthorization {
  return { exists: true, claimed: false, callerRoles: [], ...overrides };
}

describe('assertableVerification', () => {
  it('gives a caller with no approved claim the weakest tier', () => {
    expect(assertableVerification(authorization())).toBe('community_reported');
  });

  it('gives a caller with no approved claim the weakest tier even on a CLAIMED place', () => {
    // Somebody else's approved claim does not raise this caller. The place is
    // claimed and `callerRoles` is empty, which is the shape a passer-by
    // reporting a FairCoin sticker in a claimed shop arrives in.
    expect(assertableVerification(authorization({ claimed: true }))).toBe('community_reported');
  });

  it('gives every approved claim role the business tier', () => {
    // Iterated over the PUBLISHED tuple rather than a list repeated here: a
    // role added to the contract is tested the moment it exists.
    for (const role of PLACE_CLAIM_ROLES) {
      expect(assertableVerification(authorization({ claimed: true, callerRoles: [role] }))).toBe(
        'business_asserted',
      );
    }
  });

  it('never returns a tier the caller could not have earned', () => {
    // The set the function can return is the `actor`-origin set, and nothing
    // else. `oxy_verified` and `external_source` are not in it.
    expect([...ASSERTABLE_VERIFICATIONS].sort()).toEqual(['business_asserted', 'community_reported']);
    expect(ASSERTABLE_VERIFICATIONS).not.toContain('oxy_verified' as AssertableVerification);
  });
});

describe('withdrawableVerification', () => {
  it('lets an approved claimant withdraw their own tier and nothing else', () => {
    expect(withdrawableVerification(authorization({ claimed: true, callerRoles: ['owner'] }))).toBe(
      'business_asserted',
    );
  });

  it('lets a community reporter withdraw nothing', () => {
    // `places_capabilities` records no author, so the community tier is one
    // shared row. Deleting it would erase a report the caller did not write,
    // with nothing recording that they did. The retraction path is an
    // assertion of `false`, not a deletion.
    expect(withdrawableVerification(authorization())).toBeNull();
  });
});

describe('the origin classification', () => {
  it('classifies every published verification tier', () => {
    // A total `Record<CapabilityVerification, …>` is a COMPILE-time guarantee;
    // this is the runtime half, which also catches a tier that was added to
    // the tuple in a shared-types version this package resolved at runtime but
    // did not type-check against.
    for (const verification of CAPABILITY_VERIFICATIONS) {
      expect(VERIFICATION_ORIGIN[verification]).toBeDefined();
    }
    expect(Object.keys(VERIFICATION_ORIGIN).sort()).toEqual([...CAPABILITY_VERIFICATIONS].sort());
  });

  it('keeps oxy_verified a moderation act and external_source an evidence one', () => {
    expect(VERIFICATION_ORIGIN.oxy_verified).toBe('moderation');
    expect(VERIFICATION_ORIGIN.external_source).toBe('evidence');
  });
});

describe('assertWritableVerification', () => {
  it('passes the tiers a write may produce', () => {
    expect(assertWritableVerification('community_reported')).toBe('community_reported');
    expect(assertWritableVerification('business_asserted')).toBe('business_asserted');
    expect(assertWritableVerification('external_source')).toBe('external_source');
  });

  it('refuses oxy_verified as a DEFECT rather than as a client failure', () => {
    // Reaching here with it is not something a request can do, so it is a 500
    // and not a 4xx: answering 403 would describe a bug in GoWay as the
    // caller's fault, and an integrator would retry forever against it.
    try {
      assertWritableVerification('oxy_verified');
      throw new Error('expected a refusal');
    } catch (error) {
      expect(isApiError(error)).toBe(true);
      expect(isApiError(error) && error.code).toBe('internal_error');
    }
  });
});

describe('the type system, checked by bun run typecheck', () => {
  it('excludes the moderation tier from every actor-derived value', () => {
    // No runtime assertion is possible here — the type is erased. These lines
    // fail `tsc -p tsconfig.tools.json` if the exclusion is ever weakened,
    // which is what makes it structural rather than a convention.

    // @ts-expect-error `oxy_verified` is moderation-origin and is not assertable.
    const escalated: AssertableVerification = 'oxy_verified';
    // @ts-expect-error `external_source` rests on evidence, not on who is asking.
    const sourced: AssertableVerification = 'external_source';
    const allowed: AssertableVerification = 'business_asserted';

    expect([escalated, sourced, allowed]).toHaveLength(3);
  });
});
