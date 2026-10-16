import '../../__tests__/testEnv';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { OrganizationList, OrganizationListEntry, Page, Place } from '@goway/contracts';
import {
  createSuiteDatabase,
  destroySuiteDatabase,
  type SuiteDatabase,
  SUITE_SETUP_TIMEOUT_MS,
} from '../../db/__tests__/testDatabase';
import { createPlace } from '../../db/places/placesRepository';
import { apiAuthor } from '../../__tests__/placesFixtures';
import { startFakeOxy, membershipKey, type FakeOxy } from '../../__tests__/fakeOxy';
import { fakeRequireAuth, serve, session, type TestApi } from '../../__tests__/httpHarness';
import { createOrganizationListsRouter } from '../organizationLists';
import { createOrganizationAuthority } from '../../oxy/organizationAuthority';
import { listEntries } from '../../db/organizationLists';
let suite: SuiteDatabase;
let oxy: FakeOxy;
let api: TestApi;
let place: Place;
const owner = session('owner');
const org = 'org-lists';
const input = () => ({
  placeId: place.id,
  activity: 'Community collection',
  information: 'Bring clean containers',
  startsAt: new Date(Date.now() - 60000).toISOString(),
  endsAt: new Date(Date.now() + 3600000).toISOString(),
});
async function create() {
  const r = await api.call<OrganizationList>('POST', '/organization-lists', owner, {
    oxyAccountId: org,
    title: 'Neighborhood activities',
  });
  expect(r.status).toBe(201);
  return r.body;
}
async function add(list: OrganizationList, data = input()) {
  const r = await api.call<OrganizationListEntry>(
    'POST',
    `/organization-lists/${list.id}/entries`,
    owner,
    data,
  );
  expect(r.status).toBe(201);
  return r.body;
}
beforeAll(async () => {
  suite = await createSuiteDatabase();
  oxy = await startFakeOxy();
  oxy.accounts.add(org);
  oxy.accounts.add('owner');
  oxy.memberships.set(membershipKey('owner', org), 'owner');
  api = await serve(
    createOrganizationListsRouter({
      requireAuth: fakeRequireAuth,
      authorize: createOrganizationAuthority(oxy.url),
    }),
  );
  place = await createPlace(
    suite.db,
    { name: 'Library', location: { latitude: 41.39, longitude: 2.16 } },
    { author: apiAuthor('contributor'), assertedVerification: 'community_reported' },
  );
}, SUITE_SETUP_TIMEOUT_MS);
afterAll(async () => {
  await api?.close();
  await oxy?.close();
  await destroySuiteDatabase(suite);
});

describe('organization lists, real API and PostGIS with Oxy HTTP authority', () => {
  it('is public and stores only an existing place reference, reading timezone from its current row', async () => {
    const list = await create();
    const entry = await add(list);
    const publicList = await api.call<OrganizationList>('GET', `/organization-lists/${list.id}`);
    expect(publicList.status).toBe(200);
    const read = await api.call<Page<OrganizationListEntry>>(
      'GET',
      `/organization-lists/${list.id}/entries`,
    );
    expect(read.body.items[0]?.id).toBe(entry.id);
    expect(read.body.items[0]?.timezone).toBe('Europe/Madrid');
    expect(read.body.items[0]).not.toHaveProperty('name');
    expect(read.body.items[0]).not.toHaveProperty('address');
    await suite.client`update places set timezone = 'Europe/London' where id = ${place.id}`;
    expect(
      (await api.call<Page<OrganizationListEntry>>('GET', `/organization-lists/${list.id}/entries`))
        .body.items[0]?.timezone,
    ).toBe('Europe/London');
    const columns =
      await suite.client`select column_name from information_schema.columns where table_name = 'organization_list_entries'`;
    expect(columns.map((c) => c.column_name)).not.toContain('address');
    expect(
      (
        await api.call('POST', `/organization-lists/${list.id}/entries`, owner, {
          ...input(),
          placeId: 'missing-place',
        })
      ).status,
    ).toBe(422);
  });
  it('requires auth, an organization, and a fresh active content role including switched sessions', async () => {
    const list = await create();
    expect(
      (await api.call('POST', '/organization-lists', {}, { oxyAccountId: org, title: 'X' })).status,
    ).toBe(401);
    expect(
      (await api.call('POST', '/organization-lists', owner, { oxyAccountId: 'owner', title: 'X' }))
        .status,
    ).toBe(403);
    for (const role of ['owner', 'admin', 'editor', 'viewer', 'billing', 'developer'] as const) {
      oxy.memberships.set(membershipKey('member', org), role);
      expect(
        (
          await api.call('PUT', `/organization-lists/${list.id}`, session(org, 'member'), {
            title: role,
          })
        ).status,
      ).toBe(['owner', 'admin', 'editor'].includes(role) ? 200 : 403);
    }
    oxy.memberships.set(membershipKey('member', org), 'editor');
    expect(
      (await api.call('POST', `/organization-lists/${list.id}/entries`, session('member'), input()))
        .status,
    ).toBe(201);
    oxy.memberships.delete(membershipKey('member', org));
    expect(
      (
        await api.call(
          'POST',
          `/organization-lists/${list.id}/entries`,
          session(org, 'member'),
          input(),
        )
      ).status,
    ).toBe(403);
    oxy.mode = 'down';
    expect((await api.call('DELETE', `/organization-lists/${list.id}`, owner)).status).toBe(503);
    oxy.mode = 'ok';
    expect((await api.call('GET', `/organization-lists/${list.id}`)).status).toBe(200);
  });
  it('expires exactly at end, includes future activities, and completion removes active entries', async () => {
    const list = await create();
    const entry = await add(list);
    const future = await add(list, {
      ...input(),
      startsAt: new Date(Date.now() + 3600000).toISOString(),
      endsAt: new Date(Date.now() + 7200000).toISOString(),
    });
    const end = new Date(entry.endsAt);
    expect(
      (
        await listEntries(suite.db, list.id, 'active', undefined, 50, new Date(end.getTime() - 1))
      ).map((e) => e.id),
    ).toContain(entry.id);
    expect(
      (await listEntries(suite.db, list.id, 'active', undefined, 50, end)).map((e) => e.id),
    ).not.toContain(entry.id);
    expect(
      (await listEntries(suite.db, list.id, 'active', undefined, 50, end)).map((e) => e.id),
    ).toContain(future.id);
    const completed = await api.call<OrganizationListEntry>(
      'POST',
      `/organization-lists/${list.id}/entries/${entry.id}/complete`,
      owner,
    );
    expect(completed.body.status).toBe('completed');
    const again = await api.call<OrganizationListEntry>(
      'POST',
      `/organization-lists/${list.id}/entries/${entry.id}/complete`,
      owner,
    );
    expect(again.body.completedAt).toBe(completed.body.completedAt);
    expect(
      (
        await api.call<Page<OrganizationListEntry>>('GET', `/organization-lists/${list.id}/entries`)
      ).body.items.map((e) => e.id),
    ).toEqual([future.id]);
    expect(
      (
        await api.call<Page<OrganizationListEntry>>(
          'GET',
          `/organization-lists/${list.id}/entries?state=all`,
        )
      ).body.items,
    ).toHaveLength(2);
  });
  it('uses stable paginated order, rejects foreign/stale cursors, and fences stale reorder revisions', async () => {
    const list = await create();
    const a = await add(list);
    const b = await add(list);
    const c = await add(list);
    const first = (
      await api.call<Page<OrganizationListEntry>>(
        'GET',
        `/organization-lists/${list.id}/entries?limit=1`,
      )
    ).body;
    expect(first.items.map((e) => e.id)).toEqual([a.id]);
    expect(first.nextCursor).not.toBeNull();
    const next = (
      await api.call<Page<OrganizationListEntry>>(
        'GET',
        `/organization-lists/${list.id}/entries?limit=2&cursor=${first.nextCursor}`,
      )
    ).body;
    expect(next.items.map((e) => e.id)).toEqual([b.id, c.id]);
    expect(next.nextCursor).toBeNull();
    expect(
      (
        await api.call(
          'GET',
          `/organization-lists/${list.id}/entries?state=all&cursor=${first.nextCursor}`,
        )
      ).status,
    ).toBe(400);
    const current = (await api.call<OrganizationList>('GET', `/organization-lists/${list.id}`))
      .body;
    expect(
      (
        await api.call('PUT', `/organization-lists/${list.id}/order`, owner, {
          revision: current.revision,
          entryIds: [c.id, b.id, a.id],
        })
      ).status,
    ).toBe(200);
    expect(
      (await api.call('GET', `/organization-lists/${list.id}/entries?cursor=${first.nextCursor}`))
        .status,
    ).toBe(400);
    expect(
      (
        await api.call('PUT', `/organization-lists/${list.id}/order`, owner, {
          revision: current.revision,
          entryIds: [a.id, b.id, c.id],
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await api.call<Page<OrganizationListEntry>>('GET', `/organization-lists/${list.id}/entries`)
      ).body.items.map((e) => e.id),
    ).toEqual([c.id, b.id, a.id]);
  });
  it('edits activities and deletes only within the authorized list', async () => {
    const list = await create();
    const other = await create();
    const entry = await add(list);
    expect(
      (
        await api.call('PUT', `/organization-lists/${other.id}/entries/${entry.id}`, owner, {
          ...input(),
          activity: 'Wrong parent',
        })
      ).status,
    ).toBe(404);
    const edit = await api.call<OrganizationListEntry>(
      'PUT',
      `/organization-lists/${list.id}/entries/${entry.id}`,
      owner,
      { ...input(), activity: 'Changed activity' },
    );
    expect(edit.body.activity).toBe('Changed activity');
    expect(
      (
        await api.call(
          'DELETE',
          `/organization-lists/${list.id}/entries/${entry.id}`,
          session('stranger'),
        )
      ).status,
    ).toBe(403);
    expect(
      (await api.call('DELETE', `/organization-lists/${list.id}/entries/${entry.id}`, owner))
        .status,
    ).toBe(204);
    expect((await api.call('DELETE', `/organization-lists/${list.id}`, owner)).status).toBe(204);
    expect((await api.call('GET', `/organization-lists/${list.id}`)).status).toBe(404);
  });
  it('rechecks revoked membership after waiting for a conflicting aggregate write', async () => {
    const list = await create();
    oxy.memberships.set(membershipKey('contender', org), 'editor');
    let release!: () => void;
    let acquired!: (pid: number) => void;
    const unlocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const locked = new Promise<number>((resolve) => {
      acquired = resolve;
    });
    const holder = suite.client.begin(async (tx) => {
      await tx`select id from organization_lists where id = ${list.id} for update`;
      const [row] = await tx`select pg_backend_pid() as pid`;
      acquired(Number(row?.pid));
      await unlocked;
    });
    const pid = await locked;
    const pending = api.call('PUT', `/organization-lists/${list.id}`, session('contender'), {
      title: 'Must not happen',
    });
    try {
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const locks =
          await suite.client`select 1 from pg_locks waiter where not waiter.granted and waiter.locktype = 'transactionid' and waiter.transactionid in (select transactionid from pg_locks where pid = ${pid} and granted)`;
        if (locks.length > 0) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      // A public read never queues behind a writer's lock.
      expect((await api.call('GET', `/organization-lists/${list.id}/entries`)).status).toBe(200);
      oxy.memberships.delete(membershipKey('contender', org));
    } finally {
      release();
      await holder;
    }
    expect((await pending).status).toBe(403);
    expect(
      (await api.call<OrganizationList>('GET', `/organization-lists/${list.id}`)).body.title,
    ).toBe(list.title);
  });
  it('removes withdrawn places from the active public view without retaining their facts', async () => {
    const list = await create();
    const p = await createPlace(
      suite.db,
      { name: 'Temporary place', location: { latitude: 41.4, longitude: 2.17 } },
      { author: apiAuthor('contributor'), assertedVerification: 'community_reported' },
    );
    await add(list, { ...input(), placeId: p.id });
    await suite.client`update places set status = 'removed' where id = ${p.id}`;
    expect(
      (await api.call<Page<OrganizationListEntry>>('GET', `/organization-lists/${list.id}/entries`))
        .body.items,
    ).toEqual([]);
  });
});
