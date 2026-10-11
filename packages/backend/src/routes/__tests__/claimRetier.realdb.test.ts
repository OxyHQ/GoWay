/**
 * What a business said while its claim was pending becomes its own when the
 * claim is approved — and nothing else does.
 *
 * Over a real socket and a real PostGIS, through the public Places router and
 * the moderation router, as a business dashboard and an operator would. The
 * rule (`decideClaim` → `retierClaimantStatements`) re-tiers a community row
 * to `business_asserted` only when its LATEST statement was made after the
 * claim was filed, by the claimant account or by the person who filed it; each
 * re-tier is a revision attributed to whoever made the statement.
 *
 * This suite does not skip. See `db/__tests__/testDatabase.ts`.
 */

import '../../__tests__/testEnv';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { AccountRole } from '@oxy.so/core';
import {
  strongestCapability,
  type ModerationPlaceRevisionPage,
  type Place,
  type PlaceClaim,
  type PlaceHoursException,
  type PlaceRevisionPage,
} from '@goway/contracts';
import { createClaim, createPlace, type PlaceActor } from '../../db/places/placesRepository';
import {
  SUITE_SETUP_TIMEOUT_MS,
  createSuiteDatabase,
  destroySuiteDatabase,
  type SuiteDatabase,
} from '../../db/__tests__/testDatabase';
import { createRequireOperator } from '../../middleware/operator';
import type { AccountRoleResolver } from '../../oxy/accountRoles';
import {
  fakeOptionalAuth,
  fakeRequireAuth,
  serve,
  session,
  type ErrorBody,
  type TestApi,
} from '../../__tests__/httpHarness';
import { apiAuthor, NO_RATE_LIMIT } from '../../__tests__/placesFixtures';
import { createModerationRouter } from '../moderation';
import { createPlacesRouter } from '../places';

const CONTRIBUTOR: PlaceActor = {
  author: apiAuthor('person-contributor'),
  assertedVerification: 'community_reported',
};
const POBLENOU = { latitude: 41.4036, longitude: 2.1975 };
const OPERATOR = session('person-mod');

const STORE = 'commerce.mercaria.store';

/** Oxy's answer, fixed: who holds which role in which organization. */
const ROLES: Readonly<Record<string, Readonly<Record<string, AccountRole>>>> = {
  'org-botiga': { 'person-owner': 'owner', 'person-editor': 'editor' },
};

const ACCOUNT_ROLES: AccountRoleResolver = {
  async roleIn(caller, oxyAccountId) {
    const person = caller.operatedByOxyUserId ?? caller.oxyAccountId;
    return ROLES[oxyAccountId]?.[person] ?? null;
  },
};

let suite: SuiteDatabase | null = null;
let api: TestApi;

beforeAll(async () => {
  suite = await createSuiteDatabase();
  api = await serve(
    createPlacesRouter({
      optionalAuth: fakeOptionalAuth,
      requireAuth: fakeRequireAuth,
      accountRoles: ACCOUNT_ROLES,
      reportRateLimit: NO_RATE_LIMIT,
    }),
    createModerationRouter({
      requireAuth: fakeRequireAuth,
      requireOperator: createRequireOperator(['person-mod']),
    }),
  );
}, SUITE_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await api.close();
  await destroySuiteDatabase(suite);
  suite = null;
});

async function assert(
  placeId: string,
  key: string,
  value: unknown,
  headers: Record<string, string>,
): Promise<void> {
  const { status } = await api.call<Place>(
    'PUT',
    `/places/${placeId}/capabilities/${key}`,
    headers,
    { value },
  );
  expect(status).toBe(200);
}

/** Every stored tier of every key, as `key@tier=value`, sorted. */
async function tiers(placeId: string): Promise<string[]> {
  const { body } = await api.call<Place>('GET', `/places/${placeId}`);
  return body.capabilities
    .map((row) => `${row.key}@${row.verification}=${JSON.stringify(row.value)}`)
    .sort();
}

async function decide(claimId: string, state: 'approved' | 'rejected'): Promise<number> {
  return (
    await api.call<PlaceClaim>('POST', `/moderation/claims/${claimId}/decision`, OPERATOR, {
      state,
    })
  ).status;
}

async function fileClaim(placeId: string): Promise<PlaceClaim> {
  // Filed by the organization's owner, as themselves, in its name — what
  // Mercaria's dashboard does.
  const { status, body } = await api.call<PlaceClaim>(
    'POST',
    `/places/${placeId}/claims`,
    session('person-owner'),
    {
      role: 'owner',
      oxyAccountId: 'org-botiga',
    },
  );
  expect(status).toBe(201);
  return body;
}

describe('approving a claim', () => {
  let shop: Place;
  let claim: PlaceClaim;
  let closure: PlaceHoursException;
  let strangersClosure: PlaceHoursException;
  let observedBefore: string | undefined;

  beforeAll(async () => {
    shop = await createPlace(
      suite!.db,
      { name: 'Botiga del Poblenou', location: POBLENOU },
      CONTRIBUTOR,
    );

    // Before the claim existed, even as the organization: a community report.
    await assert(shop.id, 'amenities.toilets', true, session('org-botiga', 'person-owner'));

    claim = await fileClaim(shop.id);

    // While it is pending — each lands at the community tier.
    await assert(shop.id, STORE, 'loc-1', session('person-owner')); // the filer, as themselves
    await assert(
      shop.id,
      'accessibility.step_free_entrance',
      true,
      session('org-botiga', 'person-editor'),
    ); // as the org
    await assert(shop.id, 'amenities.wifi', true, session('person-editor')); // a member, as themselves
    await assert(shop.id, 'payments.cash', true, session('person-stranger'));
    await assert(shop.id, 'payments.cards', true, session('person-owner'));
    await assert(shop.id, 'payments.cards', false, session('person-stranger')); // overwritten since

    closure = (
      await api.call<PlaceHoursException>(
        'POST',
        `/places/${shop.id}/hours-exceptions`,
        session('person-owner'),
        {
          startsOn: '2031-12-25',
          closed: true,
        },
      )
    ).body;
    strangersClosure = (
      await api.call<PlaceHoursException>(
        'POST',
        `/places/${shop.id}/hours-exceptions`,
        session('person-stranger'),
        {
          startsOn: '2031-12-31',
          closed: true,
        },
      )
    ).body;

    const before = await api.call<Place>('GET', `/places/${shop.id}`);
    observedBefore = strongestCapability(before.body, STORE)?.observedAt;
    expect(await tiers(shop.id)).toEqual([
      'accessibility.step_free_entrance@community_reported=true',
      'amenities.toilets@community_reported=true',
      'amenities.wifi@community_reported=true',
      'commerce.mercaria.store@community_reported="loc-1"',
      'payments.cards@community_reported=false',
      'payments.cash@community_reported=true',
    ]);

    expect(await decide(claim.id, 'approved')).toBe(200);
  });

  it("makes the claimant's own pending statements the business's, and leaves everyone else's", async () => {
    expect(await tiers(shop.id)).toEqual([
      'accessibility.step_free_entrance@business_asserted=true',
      // Said before the claim was filed: a report like any other.
      'amenities.toilets@community_reported=true',
      // A member who is not the filer, speaking as themselves: GoWay cannot
      // ask Oxy about their role with an operator's session.
      'amenities.wifi@community_reported=true',
      'commerce.mercaria.store@business_asserted="loc-1"',
      // The filer said `true`, a stranger said `false` since: the row is the stranger's.
      'payments.cards@community_reported=false',
      'payments.cash@community_reported=true',
    ]);
  });

  it('keeps when the statement was observed: nobody observed it again', async () => {
    const { body } = await api.call<Place>('GET', `/places/${shop.id}`);
    const link = strongestCapability(body, STORE);
    expect(link?.verification).toBe('business_asserted');
    expect(link?.observedAt).toBe(observedBefore);
  });

  it("re-tiers the filer's closure and not the stranger's", async () => {
    const { body } = await api.call<Place>('GET', `/places/${shop.id}`);
    const tierOf = (id: string) =>
      body.hoursExceptions?.find((exception) => exception.id === id)?.verification;
    expect(tierOf(closure.id)).toBe('business_asserted');
    expect(tierOf(strangersClosure.id)).toBe('community_reported');
  });

  it('records each re-tier as a revision of whoever made the statement, through the moderation door', async () => {
    const { body } = await api.call<ModerationPlaceRevisionPage>(
      'GET',
      `/moderation/places/${shop.id}/revisions?limit=100`,
      OPERATOR,
    );
    const retiers = body.items
      .filter((revision) => revision.action.endsWith('_retiered'))
      .map((revision) => ({
        action: revision.action,
        source: revision.source,
        account: revision.oxyAccountId,
        person: revision.operatedByOxyUserId,
        field: revision.changes[0]?.field,
        from: (revision.changes[0]?.before as { verification?: string } | undefined)?.verification,
        to: (revision.changes[0]?.after as { verification?: string } | undefined)?.verification,
      }))
      .sort((left, right) => (left.field ?? '').localeCompare(right.field ?? ''));
    const retier = {
      source: 'moderation',
      from: 'community_reported',
      to: 'business_asserted',
    } as const;
    expect(retiers).toEqual([
      {
        ...retier,
        action: 'capability_retiered',
        account: 'org-botiga',
        person: 'person-editor',
        field: 'capabilities.accessibility.step_free_entrance',
      },
      {
        ...retier,
        action: 'capability_retiered',
        account: 'person-owner',
        person: 'person-owner',
        field: `capabilities.${STORE}`,
      },
      {
        ...retier,
        action: 'hours_exception_retiered',
        account: 'person-owner',
        person: 'person-owner',
        field: `hoursExceptions.${closure.id}`,
      },
    ]);
    // Decided first, re-tiered after, in one transaction.
    const actions = body.items.map((revision) => revision.action);
    expect(actions.indexOf('claim_approved')).toBeGreaterThan(
      actions.indexOf('capability_retiered'),
    );
  });

  it('publishes the re-tier in the public history, never who', async () => {
    const { body } = await api.call<PlaceRevisionPage>(
      'GET',
      `/places/${shop.id}/revisions?limit=100`,
    );
    const retiered = body.items.filter((revision) => revision.action === 'capability_retiered');
    expect(retiered).toHaveLength(2);
    expect(JSON.stringify(body)).not.toContain('person-');
    expect(JSON.stringify(body)).not.toContain('org-botiga');
  });

  it('lets the business withdraw what is now its own, as it may any statement at its tier', async () => {
    const { status } = await api.call(
      'DELETE',
      `/places/${shop.id}/capabilities/accessibility.step_free_entrance`,
      session('person-owner'),
    );
    expect(status).toBe(204);
  });
});

describe('what a decision does not re-tier', () => {
  it('re-tiers nothing on a rejection', async () => {
    const shop = await createPlace(
      suite!.db,
      { name: 'Botiga Rebutjada', location: POBLENOU },
      CONTRIBUTOR,
    );
    const claim = await fileClaim(shop.id);
    await assert(shop.id, STORE, 'loc-2', session('person-owner'));
    expect(await decide(claim.id, 'rejected')).toBe(200);
    expect(await tiers(shop.id)).toEqual(['commerce.mercaria.store@community_reported="loc-2"']);
  });

  it('never overwrites the business tier another approved claimant already holds', async () => {
    const shop = await createPlace(
      suite!.db,
      { name: 'Botiga de Cadena', location: POBLENOU },
      CONTRIBUTOR,
    );
    await createClaim(suite!.db, {
      placeId: shop.id,
      oxyAccountId: 'org-cadena',
      role: 'brand',
      state: 'approved',
    });
    await assert(shop.id, 'amenities.takeaway', true, session('org-cadena'));

    const claim = await fileClaim(shop.id);
    await assert(shop.id, 'amenities.takeaway', false, session('person-owner'));
    expect(await decide(claim.id, 'approved')).toBe(200);
    expect(await tiers(shop.id)).toEqual([
      'amenities.takeaway@business_asserted=true',
      'amenities.takeaway@community_reported=false',
    ]);
  });

  it('rolls the approval back with the re-tier when the re-tier cannot be recorded', async () => {
    const shop = await createPlace(
      suite!.db,
      { name: 'Botiga Atomica', location: POBLENOU },
      CONTRIBUTOR,
    );
    const claim = await fileClaim(shop.id);
    await assert(shop.id, STORE, 'loc-3', session('person-owner'));

    await suite!.client.unsafe(
      `ALTER TABLE place_revisions ADD CONSTRAINT test_refuse_retier CHECK (action <> 'capability_retiered') NOT VALID`,
    );
    try {
      const { status, body } = await api.call<ErrorBody>(
        'POST',
        `/moderation/claims/${claim.id}/decision`,
        OPERATOR,
        {
          state: 'approved',
        },
      );
      expect(status).toBe(500);
      expect(body.error.code).toBe('internal_error');
    } finally {
      await suite!.client`ALTER TABLE place_revisions DROP CONSTRAINT test_refuse_retier`;
    }

    // Neither half landed: the claim is still pending, the link still a report.
    const [stored] = await suite!.client<
      { state: string }[]
    >`SELECT state FROM places_claims WHERE id = ${claim.id}`;
    expect(stored?.state).toBe('pending');
    expect(await tiers(shop.id)).toEqual(['commerce.mercaria.store@community_reported="loc-3"']);
  });
});
