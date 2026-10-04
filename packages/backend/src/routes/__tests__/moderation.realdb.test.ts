/**
 * Moderation: the operator gate, claim decisions, Oxy verification, duplicate
 * merges and the report queue — over a real socket and a real PostGIS, beside
 * the public Places router so a decision's effect is read back the way a
 * client reads it.
 */

import '../../__tests__/testEnv';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  API_OPERATIONS,
  type DuplicateCandidate,
  type DuplicateCandidatePage,
  type ModerationPlaceReport,
  type ModerationPlaceReportPage,
  type ModerationPlaceRevisionPage,
  type Place,
  type PlaceClaim,
  type PlaceClaimPage,
  type PlaceReport,
  type PlaceRevisionPage,
} from '@goway/contracts';
import { applyPlaceNames, createClaim, createPlace, recordDuplicateCandidate, type PlaceActor } from '../../db/places/placesRepository';
import {
  SUITE_SETUP_TIMEOUT_MS,
  createSuiteDatabase,
  destroySuiteDatabase,
  type SuiteDatabase,
} from '../../db/__tests__/testDatabase';
import { createRequireOperator } from '../../middleware/operator';
import { fakeOptionalAuth, fakeRequireAuth, serve, session, type ErrorBody, type TestApi } from '../../__tests__/httpHarness';
import { apiAuthor, NO_MEMBERSHIPS, NO_RATE_LIMIT } from '../../__tests__/placesFixtures';
import { createModerationRouter } from '../moderation';
import { createPlacesRouter } from '../places';

const CONTRIBUTOR: PlaceActor = { author: apiAuthor('person-contributor'), assertedVerification: 'community_reported' };
const GRACIA = { latitude: 41.3979, longitude: 2.1598 };
const FAIRCOIN = 'payments.faircoin.accepted';

/** The one operator on the allow-list. */
const OPERATOR = session('person-mod');

let suite: SuiteDatabase | null = null;
let api: TestApi;

async function place(name: string): Promise<Place> {
  return createPlace(suite!.db, { name, location: GRACIA }, CONTRIBUTOR);
}

async function moderationHistory(placeId: string): Promise<ModerationPlaceRevisionPage> {
  const { status, body } = await api.call<ModerationPlaceRevisionPage>('GET', `/moderation/places/${placeId}/revisions`, OPERATOR);
  expect(status).toBe(200);
  return body;
}

async function publicActions(placeId: string): Promise<string[]> {
  const { body } = await api.call<PlaceRevisionPage>('GET', `/places/${placeId}/revisions`);
  return body.items.map((revision) => revision.action);
}

beforeAll(async () => {
  suite = await createSuiteDatabase();
  api = await serve(
    createPlacesRouter({ optionalAuth: fakeOptionalAuth, requireAuth: fakeRequireAuth, accountRoles: NO_MEMBERSHIPS, reportRateLimit: NO_RATE_LIMIT }),
    createModerationRouter({ requireAuth: fakeRequireAuth, requireOperator: createRequireOperator(['person-mod']) }),
  );
}, SUITE_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await api.close();
  await destroySuiteDatabase(suite);
  suite = null;
});

describe('the operator gate', () => {
  const moderation = API_OPERATIONS.filter((operation) => operation.path.startsWith('/moderation'));

  it('covers every moderation operation the registry publishes', () => {
    expect(moderation.length).toBe(10);
  });

  for (const operation of moderation) {
    const path = operation.path.replace(/\{([A-Za-z]+)\}/g, (_match, name: string) =>
      name === 'key' ? FAIRCOIN : 'some-id',
    );
    const method = operation.method.toUpperCase();
    const body = operation.method === 'get' || operation.method === 'delete' ? undefined : {};

    it(`refuses ${method} ${operation.path} signed out (401) and to anybody off the list (403)`, async () => {
      expect((await api.call<ErrorBody>(method, path, {}, body)).status).toBe(401);
      const stranger = await api.call<ErrorBody>(method, path, session('person-stranger'), body);
      expect(stranger.status).toBe(403);
      expect(stranger.body.error.code).toBe('forbidden');
    });
  }

  it('matches the PERSON: an operator switched into an organization is still one, and the organization never is', async () => {
    expect((await api.call('GET', '/moderation/claims', session('org-anything', 'person-mod'))).status).toBe(200);
    expect((await api.call('GET', '/moderation/claims', session('person-mod', 'person-intruder'))).status).toBe(403);
  });
});

describe('claim decisions', () => {
  let shop: Place;
  let claim: PlaceClaim;

  beforeAll(async () => {
    shop = await place('Botiga Pendent');
    const filed = await api.call<PlaceClaim>('POST', `/places/${shop.id}/claims`, session('org-shop', 'person-shopkeeper'), { role: 'owner' });
    claim = filed.body;
  });

  it('lists pending claims, oldest first, by default', async () => {
    const { body } = await api.call<PlaceClaimPage>('GET', '/moderation/claims', OPERATOR);
    expect(body.items.map((item) => item.id)).toContain(claim.id);
    expect(body.items.every((item) => item.state === 'pending')).toBe(true);
  });

  it('approves a pending claim, and the claimant then owns the place', async () => {
    // Unclaimed until now: anybody could edit.
    expect((await api.call('PATCH', `/places/${shop.id}`, session('person-passerby'), { categories: ['shop'] })).status).toBe(200);

    const { status, body } = await api.call<PlaceClaim>('POST', `/moderation/claims/${claim.id}/decision`, OPERATOR, { state: 'approved' });
    expect(status).toBe(200);
    expect(body.state).toBe('approved');
    expect(Number.isNaN(Date.parse(body.decidedAt ?? ''))).toBe(false);

    expect((await api.call('PATCH', `/places/${shop.id}`, session('person-passerby'), { categories: ['bar'] })).status).toBe(403);
    const owner = await api.call<Place>('PUT', `/places/${shop.id}/capabilities/${FAIRCOIN}`, session('org-shop'), { value: true });
    expect(owner.body.capabilities.find((capability) => capability.key === FAIRCOIN)?.verification).toBe('business_asserted');
  });

  it('records the decision with the operator, visible to moderation and never to the public', async () => {
    const decision = (await moderationHistory(shop.id)).items.find((revision) => revision.action === 'claim_approved');
    expect(decision?.source).toBe('moderation');
    expect(decision?.oxyAccountId).toBe('person-mod');
    expect(decision?.operatedByOxyUserId).toBe('person-mod');
    expect(decision?.changes).toEqual([
      {
        field: `claims.${claim.id}`,
        before: { oxyAccountId: 'org-shop', role: 'owner', state: 'pending' },
        after: { oxyAccountId: 'org-shop', role: 'owner', state: 'approved' },
      },
    ]);
    // The filing itself names the person who filed it for the organization.
    const filed = (await moderationHistory(shop.id)).items.find((revision) => revision.action === 'claim_requested');
    expect(filed?.oxyAccountId).toBe('org-shop');
    expect(filed?.operatedByOxyUserId).toBe('person-shopkeeper');
    expect(await publicActions(shop.id)).not.toContain('claim_approved');
  });

  it('refuses a decision from the wrong state, and revokes an approved claim', async () => {
    const again = await api.call<ErrorBody>('POST', `/moderation/claims/${claim.id}/decision`, OPERATOR, { state: 'approved' });
    expect(again.status).toBe(409);
    const reject = await api.call<ErrorBody>('POST', `/moderation/claims/${claim.id}/decision`, OPERATOR, { state: 'rejected' });
    expect(reject.status).toBe(409);

    const revoked = await api.call<PlaceClaim>('POST', `/moderation/claims/${claim.id}/decision`, OPERATOR, { state: 'revoked' });
    expect(revoked.body.state).toBe('revoked');
    // Revoked: the place is community-editable again.
    expect((await api.call('PATCH', `/places/${shop.id}`, session('person-passerby'), { categories: ['shop'] })).status).toBe(200);
  });

  it('rejects a pending claim, and answers 404 and 422 for what is not a decision', async () => {
    const other = await api.call<PlaceClaim>('POST', `/places/${shop.id}/claims`, session('person-hopeful'), { role: 'manager' });
    const rejected = await api.call<PlaceClaim>('POST', `/moderation/claims/${other.body.id}/decision`, OPERATOR, { state: 'rejected' });
    expect(rejected.body.state).toBe('rejected');

    expect((await api.call('POST', '/moderation/claims/no-such-claim/decision', OPERATOR, { state: 'approved' })).status).toBe(404);
    expect((await api.call('POST', `/moderation/claims/${claim.id}/decision`, OPERATOR, { state: 'pending' })).status).toBe(422);
  });
});

describe('Oxy verification and the place state', () => {
  let shop: Place;

  beforeAll(async () => {
    shop = await place('Botiga Verificada');
  });

  it('asserts and withdraws the oxy_verified tier, beside the community row', async () => {
    await api.call('PUT', `/places/${shop.id}/capabilities/${FAIRCOIN}`, session('person-customer'), { value: true });
    const verified = await api.call<Place>('PUT', `/moderation/places/${shop.id}/capabilities/${FAIRCOIN}`, OPERATOR, { value: true });
    expect(verified.status).toBe(200);
    const tiers = verified.body.capabilities.filter((capability) => capability.key === FAIRCOIN).map((capability) => capability.verification);
    expect(tiers).toEqual(['oxy_verified', 'community_reported']);

    expect((await api.call('DELETE', `/moderation/places/${shop.id}/capabilities/${FAIRCOIN}`, OPERATOR)).status).toBe(204);
    expect((await api.call('DELETE', `/moderation/places/${shop.id}/capabilities/${FAIRCOIN}`, OPERATOR)).status).toBe(404);
    const actions = await publicActions(shop.id);
    expect(actions.slice(0, 2)).toEqual(['capability_withdrawn', 'capability_asserted']);
  });

  it('sets the verification state with its time, and records it', async () => {
    expect((await api.call('PATCH', `/moderation/places/${shop.id}`, OPERATOR, { verificationState: 'oxy_verified' })).status).toBe(204);
    const { body } = await api.call<Place>('GET', `/places/${shop.id}`);
    expect(body.verification.state).toBe('oxy_verified');
    expect(Number.isNaN(Date.parse(body.verification.verifiedAt ?? ''))).toBe(false);

    const [latest] = (await moderationHistory(shop.id)).items;
    expect(latest?.action).toBe('place_updated');
    expect(latest?.source).toBe('moderation');
    expect(latest?.changes[0]?.field).toBe('verification');
  });

  it('removes a place from the map and restores it', async () => {
    expect((await api.call('PATCH', `/moderation/places/${shop.id}`, OPERATOR, { status: 'removed' })).status).toBe(204);
    expect((await api.call('GET', `/places/${shop.id}`)).status).toBe(410);
    expect((await api.call('PATCH', `/moderation/places/${shop.id}`, OPERATOR, { status: 'active' })).status).toBe(204);
    expect((await api.call('GET', `/places/${shop.id}`)).status).toBe(200);
  });

  it('refuses an empty update and an unknown place', async () => {
    expect((await api.call('PATCH', `/moderation/places/${shop.id}`, OPERATOR, {})).status).toBe(422);
    expect((await api.call('PATCH', '/moderation/places/no-such-place', OPERATOR, { status: 'active' })).status).toBe(404);
  });
});

describe('duplicate candidates', () => {
  async function candidateBetween(a: Place, b: Place): Promise<DuplicateCandidate> {
    await recordDuplicateCandidate(suite!.db, a.id, b.id, 'manual_report');
    const { body } = await api.call<DuplicateCandidatePage>('GET', '/moderation/duplicates?limit=100', OPERATOR);
    const pair = [a.id, b.id].sort();
    const found = body.items.find((item) => item.placeId === pair[0] && item.candidatePlaceId === pair[1]);
    if (!found) throw new Error('the candidate was not listed');
    return found;
  }

  it('keeps both places when an operator rejects the pair, and tells only moderation', async () => {
    const [a, b] = [await place('Bar Bessó'), await place('Bar Bessó')];
    const candidate = await candidateBetween(a, b);
    const { body } = await api.call<DuplicateCandidate>('POST', `/moderation/duplicates/${candidate.id}/resolution`, OPERATOR, {
      decision: 'reject',
    });
    expect(body.state).toBe('rejected');
    for (const id of [a.id, b.id]) {
      expect((await moderationHistory(id)).items[0]?.action).toBe('duplicate_rejected');
      expect(await publicActions(id)).not.toContain('duplicate_rejected');
      expect((await api.call('GET', `/places/${id}`)).status).toBe(200);
    }
    const again = await api.call<ErrorBody>('POST', `/moderation/duplicates/${candidate.id}/resolution`, OPERATOR, { decision: 'reject' });
    expect(again.status).toBe(409);
  });

  it('merges the absorbed place into the survivor, keeping provenance and redirecting its id', async () => {
    const survivor = await createPlace(
      suite!.db,
      { name: 'Forn Central', location: GRACIA, names: [{ language: 'ca', name: 'Forn Central (survivor)' }] },
      CONTRIBUTOR,
    );
    const absorbed = await createPlace(
      suite!.db,
      {
        name: 'Forn Central',
        location: GRACIA,
        names: [{ language: 'ca', name: 'Forn Central (absorbed)' }],
        sources: [{ source: 'openstreetmap', sourceId: 'node/4242' }],
        capabilities: [{ namespace: 'payments.faircoin', capability: 'accepted', value: true }],
      },
      CONTRIBUTOR,
    );
    await applyPlaceNames(suite!.db, absorbed.id, 'openstreetmap', [{ language: 'es', name: 'Horno Central' }]);
    await createClaim(suite!.db, { placeId: absorbed.id, oxyAccountId: 'org-forn', role: 'owner', state: 'approved' });
    const candidate = await candidateBetween(survivor, absorbed);

    const outside = await api.call<ErrorBody>('POST', `/moderation/duplicates/${candidate.id}/resolution`, OPERATOR, {
      decision: 'merge',
      survivorPlaceId: 'not-in-the-pair',
    });
    expect(outside.status).toBe(422);

    const merged = await api.call<DuplicateCandidate>('POST', `/moderation/duplicates/${candidate.id}/resolution`, OPERATOR, {
      decision: 'merge',
      survivorPlaceId: survivor.id,
    });
    expect(merged.status).toBe(200);
    expect(merged.body.state).toBe('confirmed');

    // The absorbed id answers with where it went.
    const gone = await api.call<ErrorBody>('GET', `/places/${absorbed.id}`);
    expect(gone.status).toBe(410);
    expect(gone.body.error.details).toEqual({ mergedInto: survivor.id });

    // Provenance moved: the OpenStreetMap node now names the survivor, so the
    // next import updates the place people read.
    const { body: read } = await api.call<Place>('GET', `/places/${survivor.id}`);
    expect(read.sources.map((source) => source.sourceId)).toContain('node/4242');
    // The survivor's own Catalan name won; the Spanish one it lacked arrived.
    expect(read.names?.find((name) => name.language === 'ca')?.name).toBe('Forn Central (survivor)');
    expect(read.names?.find((name) => name.language === 'es')?.name).toBe('Horno Central');
    expect(read.capabilities.map((capability) => capability.key)).toContain(FAIRCOIN);
    const claims = await suite!.client<{ place_id: string }[]>`SELECT place_id FROM places_claims WHERE oxy_account_id = 'org-forn'`;
    expect(claims.map((row) => row.place_id)).toEqual([survivor.id]);
    // The losing Catalan name was not destroyed: it stays with the absorbed place.
    const kept = await suite!.client<{ name: string }[]>`SELECT name FROM places_names WHERE place_id = ${absorbed.id}`;
    expect(kept.map((row) => row.name)).toEqual(['Forn Central (absorbed)']);

    // Each side's history explains itself.
    const absorbedSide = (await moderationHistory(absorbed.id)).items[0];
    expect(absorbedSide?.action).toBe('place_merged');
    expect(absorbedSide?.changes).toContainEqual({ field: 'mergedInto', after: survivor.id });
    const survivorSide = (await api.call<PlaceRevisionPage>('GET', `/places/${survivor.id}/revisions`)).body.items[0];
    expect(survivorSide?.action).toBe('place_absorbed');
    expect(survivorSide?.changes).toContainEqual({ field: 'mergedFrom', after: absorbed.id });
    expect(survivorSide?.changes).toContainEqual({ field: 'sources', after: { source: 'openstreetmap', sourceId: 'node/4242' } });

    // A later merge of the survivor re-points the old id, so a redirect is one hop.
    const successor = await place('Forn Central Nou');
    const next = await candidateBetween(successor, survivor);
    await api.call('POST', `/moderation/duplicates/${next.id}/resolution`, OPERATOR, { decision: 'merge', survivorPlaceId: successor.id });
    const hop = await api.call<ErrorBody>('GET', `/places/${absorbed.id}`);
    expect(hop.body.error.details).toEqual({ mergedInto: successor.id });

    // A pair one of whose places is already merged cannot be merged again.
    const stale = await candidateBetween(survivor, await place('Forn Altre'));
    const refused = await api.call<ErrorBody>('POST', `/moderation/duplicates/${stale.id}/resolution`, OPERATOR, {
      decision: 'merge',
      survivorPlaceId: stale.placeId,
    });
    expect(refused.status).toBe(409);
  });
});

describe('place reports', () => {
  let shop: Place;
  let first: PlaceReport;

  beforeAll(async () => {
    shop = await place('Botiga Reportada');
  });

  it('files one open report per person, and answers a repeat with the same report', async () => {
    const filed = await api.call<PlaceReport>('POST', `/places/${shop.id}/reports`, session('person-a'), { reason: 'spam', note: 'Sells fake tickets' });
    expect(filed.status).toBe(201);
    expect(filed.body).not.toHaveProperty('note');
    first = filed.body;

    const repeat = await api.call<PlaceReport>('POST', `/places/${shop.id}/reports`, session('org-a', 'person-a'), { reason: 'spam' });
    expect(repeat.status).toBe(200);
    expect(repeat.body.id).toBe(first.id);

    expect((await api.call('POST', `/places/${shop.id}/reports`, session('person-b'), { reason: 'wrong_location' })).status).toBe(201);
  });

  it('refuses a report signed out, about no place, or with a reason outside the set', async () => {
    expect((await api.call('POST', `/places/${shop.id}/reports`, {}, { reason: 'spam' })).status).toBe(401);
    expect((await api.call('POST', '/places/no-such-place/reports', session('person-a'), { reason: 'spam' })).status).toBe(404);
    expect((await api.call('POST', `/places/${shop.id}/reports`, session('person-c'), { reason: 'boring' })).status).toBe(422);
  });

  it('shows operators the note, never the reporter', async () => {
    const { body } = await api.call<ModerationPlaceReportPage>('GET', '/moderation/reports', OPERATOR);
    const report = body.items.find((item) => item.id === first.id);
    expect(report?.note).toBe('Sells fake tickets');
    expect(JSON.stringify(body)).not.toContain('person-a');
  });

  it('resolves a report once, and records it for moderation only', async () => {
    const resolved = await api.call<ModerationPlaceReport>('POST', `/moderation/reports/${first.id}/resolution`, OPERATOR, {
      resolution: 'dismissed',
    });
    expect(resolved.status).toBe(200);
    expect(resolved.body.resolution).toBe('dismissed');
    expect((await api.call('POST', `/moderation/reports/${first.id}/resolution`, OPERATOR, { resolution: 'actioned' })).status).toBe(409);

    const open = await api.call<ModerationPlaceReportPage>('GET', '/moderation/reports', OPERATOR);
    expect(open.body.items.map((item) => item.id)).not.toContain(first.id);
    const closed = await api.call<ModerationPlaceReportPage>('GET', '/moderation/reports?state=resolved', OPERATOR);
    expect(closed.body.items.map((item) => item.id)).toContain(first.id);

    expect((await moderationHistory(shop.id)).items[0]?.action).toBe('report_resolved');
    expect(await publicActions(shop.id)).not.toContain('report_resolved');

    // Resolved, so the same person may report the place again.
    expect((await api.call('POST', `/places/${shop.id}/reports`, session('person-a'), { reason: 'spam' })).status).toBe(201);
  });
});
