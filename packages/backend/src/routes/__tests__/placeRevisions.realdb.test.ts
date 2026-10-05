/**
 * Place revisions: one per write, in the write's own transaction, and a public
 * history that says what and when, never who.
 *
 * The atomicity cases do not take the code's word for "same transaction": they
 * make the REVISION insert fail — a constraint added for the duration of one
 * test refuses that action — and assert the place itself did not change. A
 * revision recorded outside the write's transaction would leave the write
 * committed and this suite red.
 */

import '../../__tests__/testEnv';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Place, PlaceRevision, PlaceRevisionPage } from '@goway/contracts';
import { createClaim, createPlace, type PlaceActor } from '../../db/places/placesRepository';
import {
  SUITE_SETUP_TIMEOUT_MS,
  createSuiteDatabase,
  destroySuiteDatabase,
  type SuiteDatabase,
} from '../../db/__tests__/testDatabase';
import { fakeOptionalAuth, fakeRequireAuth, serve, session, type ErrorBody, type TestApi } from '../../__tests__/httpHarness';
import { apiAuthor, NO_MEMBERSHIPS, NO_RATE_LIMIT } from '../../__tests__/placesFixtures';
import { createPlacesRouter } from '../places';

const CONTRIBUTOR: PlaceActor = { author: apiAuthor('person-contributor'), assertedVerification: 'community_reported' };
const GRACIA = { latitude: 41.3979, longitude: 2.1598 };
const FAIRCOIN = 'payments.faircoin.accepted';

let suite: SuiteDatabase | null = null;
let api: TestApi;

async function history(placeId: string, query = ''): Promise<PlaceRevisionPage> {
  const { status, body } = await api.call<PlaceRevisionPage>('GET', `/places/${placeId}/revisions${query}`);
  expect(status).toBe(200);
  return body;
}

async function newest(placeId: string): Promise<PlaceRevision> {
  const page = await history(placeId, '?limit=1');
  return page.items[0]!;
}

async function storedRevisionCount(placeId: string): Promise<number> {
  const [row] = await suite!.client<{ count: string }[]>`SELECT count(*) FROM place_revisions WHERE place_id = ${placeId}`;
  return Number(row!.count);
}

/** Make the database refuse to record one revision action, for the length of `run`. */
async function refusingRevisions(action: string, run: () => Promise<void>): Promise<void> {
  await suite!.client.unsafe(
    `ALTER TABLE place_revisions ADD CONSTRAINT test_refuse_action CHECK (action <> '${action}') NOT VALID`,
  );
  try {
    await run();
  } finally {
    await suite!.client`ALTER TABLE place_revisions DROP CONSTRAINT test_refuse_action`;
  }
}

beforeAll(async () => {
  suite = await createSuiteDatabase();
  api = await serve(
    createPlacesRouter({
      optionalAuth: fakeOptionalAuth,
      requireAuth: fakeRequireAuth,
      accountRoles: NO_MEMBERSHIPS,
      reportRateLimit: NO_RATE_LIMIT,
    }),
  );
}, SUITE_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await api.close();
  await destroySuiteDatabase(suite);
  suite = null;
});

describe('every write records one revision', () => {
  let place: Place;

  it('records a creation with every field the place was created with', async () => {
    const created = await api.call<Place>('POST', '/places', session('org-cafe', 'person-ana'), {
      name: 'Cafè Revisat',
      location: GRACIA,
      names: [{ language: 'es', name: 'Café Revisado' }],
      address: { city: 'Barcelona' },
      sources: [{ source: 'openstreetmap', sourceId: 'node/900' }],
      capabilities: [{ namespace: 'payments.faircoin', capability: 'accepted', value: true }],
    });
    expect(created.status).toBe(201);
    place = created.body;

    const page = await history(place.id);
    expect(page.items).toHaveLength(1);
    const [revision] = page.items;
    expect(revision?.action).toBe('place_created');
    expect(revision?.source).toBe('api');
    const fields = revision!.changes.map((change) => change.field);
    expect(fields).toEqual(
      expect.arrayContaining(['name', 'location', 'address.city', 'status', 'names.es', `capabilities.${FAIRCOIN}`, 'sources']),
    );
    // A creation has no before.
    expect(revision!.changes.every((change) => change.before === undefined)).toBe(true);
    expect(revision!.changes.find((change) => change.field === 'names.es')?.after).toEqual({ name: 'Café Revisado', source: 'goway' });
  });

  it('records an update as exactly the fields that changed, before and after', async () => {
    const { status } = await api.call<Place>('PATCH', `/places/${place.id}`, session('person-ana'), {
      name: 'Cafè Revisat Nou',
      address: { city: 'Barcelona', postalCode: '08012' },
    });
    expect(status).toBe(200);

    const revision = await newest(place.id);
    expect(revision.action).toBe('place_updated');
    // `address.city` was restated with the same value, so it is not a change.
    expect(revision.changes).toEqual([
      { field: 'name', before: 'Cafè Revisat', after: 'Cafè Revisat Nou' },
      { field: 'address.postalCode', after: '08012' },
    ]);
  });

  it('records a write that restated everything as a revision with no changes', async () => {
    await api.call<Place>('PATCH', `/places/${place.id}`, session('person-ana'), { name: 'Cafè Revisat Nou' });
    const revision = await newest(place.id);
    expect(revision.action).toBe('place_updated');
    expect(revision.changes).toEqual([]);
  });

  it('records a capability assertion at its tier, with what it replaced', async () => {
    await api.call<Place>('PUT', `/places/${place.id}/capabilities/${FAIRCOIN}`, session('person-ana'), { value: false });
    const revision = await newest(place.id);
    expect(revision.action).toBe('capability_asserted');
    const [change] = revision.changes;
    expect(change?.field).toBe(`capabilities.${FAIRCOIN}`);
    expect(change?.before).toMatchObject({ value: true, verification: 'community_reported' });
    expect(change?.after).toMatchObject({ value: false, verification: 'community_reported' });
  });

  it('records a withdrawal with what was withdrawn', async () => {
    await createClaim(suite!.db, { placeId: place.id, oxyAccountId: 'org-cafe', role: 'owner', state: 'approved' });
    await api.call<Place>('PUT', `/places/${place.id}/capabilities/${FAIRCOIN}`, session('org-cafe'), { value: true });
    const withdrawn = await api.call('DELETE', `/places/${place.id}/capabilities/${FAIRCOIN}`, session('org-cafe'));
    expect(withdrawn.status).toBe(204);

    const revision = await newest(place.id);
    expect(revision.action).toBe('capability_withdrawn');
    expect(revision.changes).toEqual([
      { field: `capabilities.${FAIRCOIN}`, before: expect.objectContaining({ value: true, verification: 'business_asserted' }) },
    ]);
  });

  it('records nothing for a refused write', async () => {
    const before = await storedRevisionCount(place.id);
    const refused = await api.call<ErrorBody>('PATCH', `/places/${place.id}`, session('person-stranger'), { name: 'Nope' });
    expect(refused.status).toBe(403);
    expect(await storedRevisionCount(place.id)).toBe(before);
  });
});

describe('the revision is in the write transaction', () => {
  it('rolls an update back when its revision cannot be recorded', async () => {
    const place = await createPlace(suite!.db, { name: 'Atòmic', location: GRACIA }, CONTRIBUTOR);
    const before = await storedRevisionCount(place.id);
    await refusingRevisions('place_updated', async () => {
      const { status } = await api.call<ErrorBody>('PATCH', `/places/${place.id}`, session('person-ana'), { name: 'Half-written' });
      expect(status).toBe(500);
    });
    const [row] = await suite!.client<{ name: string }[]>`SELECT name FROM places WHERE id = ${place.id}`;
    expect(row?.name).toBe('Atòmic');
    expect(await storedRevisionCount(place.id)).toBe(before);
  });

  it('rolls a capability assertion back when its revision cannot be recorded', async () => {
    const place = await createPlace(suite!.db, { name: 'Atòmic Dos', location: GRACIA }, CONTRIBUTOR);
    await refusingRevisions('capability_asserted', async () => {
      const { status } = await api.call<ErrorBody>('PUT', `/places/${place.id}/capabilities/${FAIRCOIN}`, session('person-ana'), {
        value: true,
      });
      expect(status).toBe(500);
    });
    const rows = await suite!.client`SELECT 1 FROM places_capabilities WHERE place_id = ${place.id}`;
    expect(rows).toHaveLength(0);
  });

  it('rolls a creation back when its revision cannot be recorded', async () => {
    await refusingRevisions('place_created', async () => {
      const { status } = await api.call<ErrorBody>('POST', '/places', session('person-ana'), { name: 'Mai Creat', location: GRACIA });
      expect(status).toBe(500);
    });
    const rows = await suite!.client`SELECT 1 FROM places WHERE name = 'Mai Creat'`;
    expect(rows).toHaveLength(0);
  });

  it('rolls a claim request back when its revision cannot be recorded', async () => {
    const place = await createPlace(suite!.db, { name: 'Atòmic Tres', location: GRACIA }, CONTRIBUTOR);
    await refusingRevisions('claim_requested', async () => {
      const { status } = await api.call<ErrorBody>('POST', `/places/${place.id}/claims`, session('person-ana'), { role: 'owner' });
      expect(status).toBe(500);
    });
    const rows = await suite!.client`SELECT 1 FROM places_claims WHERE place_id = ${place.id}`;
    expect(rows).toHaveLength(0);
  });
});

describe('the public history', () => {
  let place: Place;

  beforeAll(async () => {
    place = await createPlace(suite!.db, { name: 'Història', location: GRACIA }, CONTRIBUTOR);
    for (const name of ['Història I', 'Història II', 'Història III']) {
      await api.call<Place>('PATCH', `/places/${place.id}`, session('org-secret', 'person-secret'), { name });
    }
    // A claim request: a business relationship, never published.
    await api.call('POST', `/places/${place.id}/claims`, session('org-secret', 'person-secret'), { role: 'owner' });
  });

  it('answers a signed-out reader', async () => {
    const page = await history(place.id);
    expect(page.items.length).toBeGreaterThan(0);
  });

  it('never names an account or a person', async () => {
    const raw = JSON.stringify(await history(place.id));
    expect(raw).not.toContain('org-secret');
    expect(raw).not.toContain('person-secret');
    expect(raw).not.toContain('person-contributor');
    for (const item of (await history(place.id)).items) {
      expect(Object.keys(item).sort()).toEqual(['action', 'changes', 'createdAt', 'id', 'placeId', 'source']);
    }
  });

  it('leaves out the moderation-only actions, which the table does hold', async () => {
    const actions = (await history(place.id)).items.map((revision) => revision.action);
    expect(actions).not.toContain('claim_requested');
    const [held] = await suite!.client<{ count: string }[]>`
      SELECT count(*) FROM place_revisions WHERE place_id = ${place.id} AND action = 'claim_requested'
    `;
    expect(Number(held!.count)).toBe(1);
  });

  it('pages newest first and refuses its cursor on another place', async () => {
    const first = await history(place.id, '?limit=2');
    expect(first.items.map((revision) => revision.changes[0]?.after)).toEqual(['Història III', 'Història II']);
    const cursor = first.nextCursor!;
    const second = await history(place.id, `?limit=2&cursor=${cursor}`);
    expect(second.items.map((revision) => revision.action)).toEqual(['place_updated', 'place_created']);
    expect(second.nextCursor).toBeNull();

    const other = await createPlace(suite!.db, { name: 'Altre', location: GRACIA }, CONTRIBUTOR);
    const foreign = await api.call<ErrorBody>('GET', `/places/${other.id}/revisions?cursor=${cursor}`);
    expect(foreign.status).toBe(400);
  });

  it('answers 404 for no place, 410 for a removed one and 410 with mergedInto for a merged one', async () => {
    expect((await api.call<ErrorBody>('GET', '/places/no-such-place/revisions')).status).toBe(404);

    const removed = await createPlace(suite!.db, { name: 'Retirat', location: GRACIA }, CONTRIBUTOR);
    await suite!.client`UPDATE places SET status = 'removed' WHERE id = ${removed.id}`;
    const gone = await api.call<ErrorBody>('GET', `/places/${removed.id}/revisions`);
    expect(gone.status).toBe(410);
    expect(gone.body.error.details).toBeUndefined();

    const merged = await createPlace(suite!.db, { name: 'Fusionat', location: GRACIA }, CONTRIBUTOR);
    await suite!.client`UPDATE places SET status = 'merged', merged_into_place_id = ${place.id} WHERE id = ${merged.id}`;
    const pointer = await api.call<ErrorBody>('GET', `/places/${merged.id}/revisions`);
    expect(pointer.status).toBe(410);
    expect(pointer.body.error.details).toEqual({ mergedInto: place.id });
  });
});
