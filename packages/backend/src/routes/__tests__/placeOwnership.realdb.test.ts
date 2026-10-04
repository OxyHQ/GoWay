/**
 * A business is an Oxy organization: who may act for its claim.
 *
 * Every authorization path, through the real Places router, the real role
 * resolver and the real `@oxy.so/core` client, against a fake Oxy at the HTTP
 * boundary (`fakeOxy`) and a real PostGIS:
 *
 *  - a personal account that holds the claim itself;
 *  - a session that SWITCHED into the organization (its subject is the org);
 *  - a member Oxy reports as owner, admin or editor — allowed;
 *  - a member Oxy reports as viewer, billing or developer — refused;
 *  - Oxy unavailable — `503`, and nothing written.
 */

import '../../__tests__/testEnv';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { Place, PlaceClaim, PlaceClaimPage } from '@goway/contracts';
import { createClaim, createPlace, type PlaceActor } from '../../db/places/placesRepository';
import {
  SUITE_SETUP_TIMEOUT_MS,
  createSuiteDatabase,
  destroySuiteDatabase,
  type SuiteDatabase,
} from '../../db/__tests__/testDatabase';
import { createAccountRoleResolver } from '../../oxy/accountRoles';
import { membershipKey, startFakeOxy, type FakeOxy } from '../../__tests__/fakeOxy';
import { fakeOptionalAuth, fakeRequireAuth, serve, session, type ErrorBody, type TestApi } from '../../__tests__/httpHarness';
import { apiAuthor, NO_RATE_LIMIT } from '../../__tests__/placesFixtures';
import { createPlacesRouter } from '../places';

const CONTRIBUTOR: PlaceActor = { author: apiAuthor('person-contributor'), assertedVerification: 'community_reported' };
const GRACIA = { latitude: 41.3979, longitude: 2.1598 };
const FAIRCOIN = 'payments.faircoin.accepted';

/** Every role Oxy has, and whether it may act for the organization's claim. */
const ACTING = { owner: true, admin: true, editor: true, developer: false, billing: false, viewer: false } as const;

let suite: SuiteDatabase | null = null;
let oxy: FakeOxy;
let api: TestApi;

/** Claimed, approved, by the organization `org-cafe`. */
let cafe: Place;
/** Claimed, approved, by the personal account `person-solo`. */
let solo: Place;
/** Nobody's. */
let vacant: Place;

/** The revisions a place holds, oldest first, straight from the table. */
async function revisionsOf(placeId: string) {
  return suite!.client<{ action: string; oxy_account_id: string; operated_by_oxy_user_id: string | null }[]>`
    SELECT action, oxy_account_id, operated_by_oxy_user_id FROM place_revisions
    WHERE place_id = ${placeId} ORDER BY created_at, id
  `;
}

async function nameOf(placeId: string): Promise<string> {
  const [row] = await suite!.client<{ name: string }[]>`SELECT name FROM places WHERE id = ${placeId}`;
  return row!.name;
}

beforeAll(async () => {
  suite = await createSuiteDatabase();
  oxy = await startFakeOxy();
  for (const account of ['org-cafe', 'person-solo']) oxy.accounts.add(account);
  for (const role of Object.keys(ACTING) as (keyof typeof ACTING)[]) {
    oxy.memberships.set(membershipKey(`person-${role}`, 'org-cafe'), role);
  }

  // TTL 0: every request asks Oxy, so the outage cases below measure the
  // outage rather than an answer cached by an earlier case.
  const accountRoles = createAccountRoleResolver({ oxyApiUrl: oxy.url, ttlMs: 0 });
  api = await serve(
    createPlacesRouter({ optionalAuth: fakeOptionalAuth, requireAuth: fakeRequireAuth, accountRoles, reportRateLimit: NO_RATE_LIMIT }),
  );

  cafe = await createPlace(suite.db, { name: 'Cafè de la Plaça', location: GRACIA }, CONTRIBUTOR);
  solo = await createPlace(suite.db, { name: 'Taller Solo', location: GRACIA }, CONTRIBUTOR);
  vacant = await createPlace(suite.db, { name: 'Local Buit', location: GRACIA }, CONTRIBUTOR);
  await createClaim(suite.db, { placeId: cafe.id, oxyAccountId: 'org-cafe', role: 'owner', state: 'approved' });
  await createClaim(suite.db, { placeId: solo.id, oxyAccountId: 'person-solo', role: 'owner', state: 'approved' });
}, SUITE_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await api.close();
  await oxy.close();
  await destroySuiteDatabase(suite);
  suite = null;
});

beforeEach(() => {
  oxy.mode = 'ok';
  oxy.requests.length = 0;
});

describe('a personal account that holds the claim', () => {
  it('edits its place without asking Oxy anything', async () => {
    const { status } = await api.call<Place>('PATCH', `/places/${solo.id}`, session('person-solo'), { name: 'Taller Solo i Fills' });
    expect(status).toBe(200);
    expect(oxy.requests).toHaveLength(0);
  });

  it('is the only one: a stranger is refused after Oxy says they are no member', async () => {
    const { status, body } = await api.call<ErrorBody>('PATCH', `/places/${solo.id}`, session('person-stranger'), { name: 'Hijacked' });
    expect(status).toBe(403);
    expect(body.error.code).toBe('forbidden');
    expect(oxy.requests.map((request) => request.accountId)).toEqual(['person-solo']);
    expect(await nameOf(solo.id)).toBe('Taller Solo i Fills');
  });
});

describe('a session that switched into the organization', () => {
  it('acts for the claim as the organization, and the revision names the person', async () => {
    const { status } = await api.call<Place>('PATCH', `/places/${cafe.id}`, session('org-cafe', 'person-viewer'), {
      contact: { phone: '+34 900 000 001' },
    });
    // The token's subject IS the organization: Oxy minted that session only
    // because the person may act as it, so GoWay does not ask again — even for
    // a person whose own membership role would not have been enough.
    expect(status).toBe(200);
    expect(oxy.requests).toHaveLength(0);

    const [latest] = (await revisionsOf(cafe.id)).slice(-1);
    expect(latest).toEqual({ action: 'place_updated', oxy_account_id: 'org-cafe', operated_by_oxy_user_id: 'person-viewer' });
  });
});

describe('a member of the organization, acting as themselves', () => {
  for (const [role, acts] of Object.entries(ACTING)) {
    it(`${acts ? 'lets' : 'refuses'} an Oxy ${role} edit the claimed place`, async () => {
      const { status, body } = await api.call<Place | ErrorBody>('PATCH', `/places/${cafe.id}`, session(`person-${role}`), {
        name: `Cafè de la Plaça (${role})`,
      });
      expect(status).toBe(acts ? 200 : 403);
      if (!acts) expect((body as ErrorBody).error.code).toBe('forbidden');
      // Asked with the member's OWN bearer, about the claiming account.
      expect(oxy.requests).toHaveLength(1);
      expect(oxy.requests[0]?.accountId).toBe('org-cafe');
    });
  }

  it('gives an acting member the business tier, and a viewer only the community tier', async () => {
    const editor = await api.call<Place>('PUT', `/places/${cafe.id}/capabilities/${FAIRCOIN}`, session('person-editor'), { value: true });
    expect(editor.status).toBe(200);
    expect(editor.body.capabilities.some((capability) => capability.verification === 'business_asserted')).toBe(true);

    const viewer = await api.call<Place>('PUT', `/places/${cafe.id}/capabilities/${FAIRCOIN}`, session('person-viewer'), { value: false });
    expect(viewer.status).toBe(200);
    const tiers = viewer.body.capabilities.map((capability) => capability.verification).sort();
    expect(tiers).toEqual(['business_asserted', 'community_reported']);
  });

  it('lets an acting member withdraw the business assertion, and not a viewer', async () => {
    const viewer = await api.call<ErrorBody>('DELETE', `/places/${cafe.id}/capabilities/${FAIRCOIN}`, session('person-viewer'));
    expect(viewer.status).toBe(403);
    const editor = await api.call('DELETE', `/places/${cafe.id}/capabilities/${FAIRCOIN}`, session('person-editor'));
    expect(editor.status).toBe(204);
  });

  it('shows the claims to an acting member, and refuses a viewer', async () => {
    const editor = await api.call<PlaceClaimPage>('GET', `/places/${cafe.id}/claims`, session('person-editor'));
    expect(editor.status).toBe(200);
    expect(editor.body.items.map((claim) => claim.oxyAccountId)).toEqual(['org-cafe']);
    const viewer = await api.call<ErrorBody>('GET', `/places/${cafe.id}/claims`, session('person-viewer'));
    expect(viewer.status).toBe(403);
  });

  it("lists the organization's claims for an acting member, and refuses a viewer", async () => {
    const editor = await api.call<PlaceClaimPage>('GET', '/claims?oxyAccountId=org-cafe', session('person-editor'));
    expect(editor.status).toBe(200);
    expect(editor.body.items.every((claim) => claim.oxyAccountId === 'org-cafe')).toBe(true);
    expect(editor.body.items.map((claim) => claim.placeId)).toContain(cafe.id);
    const viewer = await api.call<ErrorBody>('GET', '/claims?oxyAccountId=org-cafe', session('person-viewer'));
    expect(viewer.status).toBe(403);
  });
});

describe('filing a claim for an organization', () => {
  it('lets an owner or admin file in the organization name, and records who filed it', async () => {
    const admin = await api.call<PlaceClaim>('POST', `/places/${vacant.id}/claims`, session('person-admin'), {
      role: 'operator',
      oxyAccountId: 'org-cafe',
    });
    expect(admin.status).toBe(201);
    expect(admin.body.oxyAccountId).toBe('org-cafe');
    expect(admin.body.state).toBe('pending');

    const owner = await api.call<PlaceClaim>('POST', `/places/${vacant.id}/claims`, session('person-owner'), {
      role: 'owner',
      oxyAccountId: 'org-cafe',
    });
    expect(owner.status).toBe(201);

    const filed = (await revisionsOf(vacant.id)).filter((revision) => revision.action === 'claim_requested');
    expect(filed).toEqual([
      { action: 'claim_requested', oxy_account_id: 'person-admin', operated_by_oxy_user_id: 'person-admin' },
      { action: 'claim_requested', oxy_account_id: 'person-owner', operated_by_oxy_user_id: 'person-owner' },
    ]);
  });

  it('refuses an editor: running a place is not deciding who the business is', async () => {
    const { status, body } = await api.call<ErrorBody>('POST', `/places/${vacant.id}/claims`, session('person-editor'), {
      role: 'manager',
      oxyAccountId: 'org-cafe',
    });
    expect(status).toBe(403);
    expect(body.error.code).toBe('forbidden');
  });
});

describe('when Oxy cannot answer', () => {
  it('fails closed with 503 and writes nothing, place or revision', async () => {
    oxy.mode = 'down';
    const before = (await revisionsOf(cafe.id)).length;
    const name = await nameOf(cafe.id);

    const { status, body } = await api.call<ErrorBody>('PATCH', `/places/${cafe.id}`, session('person-editor'), { name: 'Written blind' });
    expect(status).toBe(503);
    expect(body.error.code).toBe('service_unavailable');
    expect(await nameOf(cafe.id)).toBe(name);
    expect(await revisionsOf(cafe.id)).toHaveLength(before);
  });

  it('fails closed for a claim filed in an organization name', async () => {
    oxy.mode = 'down';
    const { status } = await api.call<ErrorBody>('POST', `/places/${vacant.id}/claims`, session('person-admin'), {
      role: 'brand',
      oxyAccountId: 'org-cafe',
    });
    expect(status).toBe(503);
  });

  it('does not stop a business that needs no answer: the claimant itself, or an unclaimed place', async () => {
    oxy.mode = 'down';
    const own = await api.call<Place>('PATCH', `/places/${cafe.id}`, session('org-cafe', 'person-owner'), { categories: ['cafe'] });
    expect(own.status).toBe(200);
    const open = await api.call<Place>('PATCH', `/places/${vacant.id}`, session('person-anyone'), { categories: ['shop'] });
    expect(open.status).toBe(200);
    expect(oxy.requests).toHaveLength(0);
  });
});
