/** Atomic weekday edits through the real router, PostgreSQL and Oxy role resolver. */
import '../../__tests__/testEnv';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { OpeningHours, Place } from '@goway/contracts';
import { createClaim, createPlace, type PlaceActor } from '../../db/places/placesRepository';
import { listPlaceRevisions } from '../../db/places/revisions';
import { createSuiteDatabase, destroySuiteDatabase, SUITE_SETUP_TIMEOUT_MS, type SuiteDatabase } from '../../db/__tests__/testDatabase';
import { createAccountRoleResolver } from '../../oxy/accountRoles';
import { membershipKey, startFakeOxy, type FakeOxy } from '../../__tests__/fakeOxy';
import { fakeOptionalAuth, fakeRequireAuth, serve, session, type ErrorBody, type TestApi } from '../../__tests__/httpHarness';
import { apiAuthor, NO_RATE_LIMIT } from '../../__tests__/placesFixtures';
import { createPlacesRouter } from '../places';

const ACTOR: PlaceActor = { author: apiAuthor('contributor'), assertedVerification: 'community_reported' };
const ORIGINAL: OpeningHours = { intervals: [
  { day: 1, opens: '20:00', closes: '02:00' },
  { day: 3, opens: '00:00', closes: '00:00' },
] };
let suite: SuiteDatabase | null = null;
let api: TestApi;
let oxy: FakeOxy;
beforeAll(async () => {
  suite = await createSuiteDatabase();
  oxy = await startFakeOxy();
  oxy.accounts.add('hours-business');
  for (const role of ['owner', 'admin', 'editor', 'viewer', 'developer', 'billing'] as const) {
    oxy.memberships.set(membershipKey(`person-${role}`, 'hours-business'), role);
  }
  api = await serve(createPlacesRouter({ optionalAuth: fakeOptionalAuth, requireAuth: fakeRequireAuth,
    accountRoles: createAccountRoleResolver({ oxyApiUrl: oxy.url, ttlMs: 0 }), reportRateLimit: NO_RATE_LIMIT }));
}, SUITE_SETUP_TIMEOUT_MS);
afterAll(async () => {
  await api?.close();
  await oxy?.close();
  await destroySuiteDatabase(suite);
});
beforeEach(() => { oxy.mode = 'ok'; });
async function place(hours: OpeningHours | undefined = ORIGINAL) {
  return createPlace(suite!.db, { name: 'Atomic hours', location: { latitude: 41.39, longitude: 2.16 }, openingHours: hours }, ACTOR);
}
const day = (day: number, opens = '09:00', closes = '17:00') => ({ day, intervals: [{ opens, closes }] });
const patch = (id: string, body: unknown, person = 'contributor') => api.call<Place & ErrorBody>('PATCH', `/places/${id}`, session(person), body);
const read = async (id: string) => (await api.call<Place>('GET', `/places/${id}`)).body;
const revisions = (id: string) => listPlaceRevisions(suite!.db, id, 'moderation', { limit: 20 });

describe('weekday replacement under the place row lock', () => {
  it('preserves opening-day overnight/24h intervals and explicitly closes only the named day', async () => {
    const p = await place();
    const changed = await patch(p.id, { openingHoursDays: [day(2)] });
    expect(changed.status).toBe(200);
    expect(changed.body.openingHours?.intervals).toEqual([...ORIGINAL.intervals, { day: 2, opens: '09:00', closes: '17:00' }]);
    const closed = await patch(p.id, { openingHoursDays: [{ day: 2, intervals: [] }] });
    expect(closed.body.openingHours).toEqual(ORIGINAL);
    expect((await revisions(p.id)).filter(({ item }) => item.action === 'place_updated')).toHaveLength(2);
  });

  it('retains concurrent edits to distinct weekdays, with linked before/after revisions', async () => {
    const p = await place();
    const result = await Promise.all([1, 2].map((d) => patch(p.id, { openingHoursDays: [day(d, '10:00', '18:00')] })));
    expect(result.map(({ status }) => status)).toEqual([200, 200]);
    expect((await read(p.id)).openingHours?.intervals).toEqual(expect.arrayContaining([
      { day: 1, opens: '10:00', closes: '18:00' }, { day: 2, opens: '10:00', closes: '18:00' }, ORIGINAL.intervals[1],
    ]));
    const edits = (await revisions(p.id)).filter(({ item }) => item.action === 'place_updated');
    expect(edits).toHaveLength(2);
    expect(edits[0]!.item.changes[0]!.before).toEqual(edits[1]!.item.changes[0]!.after);
  });

  it('concurrent edits of the same weekday replace the whole day in lock order', async () => {
    const p = await place();
    const patches = [day(1, '08:00', '12:00'), { day: 1, intervals: [{ opens: '20:00', closes: '02:00' }, { opens: '03:00', closes: '04:00' }] }];
    const result = await Promise.all(patches.map((d) => patch(p.id, { openingHoursDays: [d] })));
    expect(result.map(({ status }) => status)).toEqual([200, 200]);
    const final = (await read(p.id)).openingHours;
    const edits = (await revisions(p.id)).filter(({ item }) => item.action === 'place_updated');
    expect(edits[0]!.item.changes[0]!.after).toEqual(final);
    expect(edits[0]!.item.changes[0]!.before).toEqual(edits[1]!.item.changes[0]!.after);
    expect(patches.map((p) => p.intervals.map((i) => ({ ...i, day: 1 })))).toContainEqual(final!.intervals.filter((i) => i.day === 1));
  });

  it('rejects partial edits to unknown raw, empty or absent schedules without altering facts or history', async () => {
    for (const hours of [{ intervals: [], raw: 'by appointment' }, { intervals: [] }, null] as const) {
      const p = await place(hours === null ? { intervals: [] } : { ...hours, intervals: [] });
      if (hours === null) await patch(p.id, { openingHours: null });
      const before = await read(p.id);
      const count = (await revisions(p.id)).length;
      const denied = await patch(p.id, { name: 'Must not persist', openingHoursDays: [day(2)] });
      expect(denied.status).toBe(409);
      expect(denied.body.error.details?.field).toBe('openingHoursDays');
      expect((await read(p.id)).openingHours).toEqual(before.openingHours);
      expect((await read(p.id)).name).toBe(before.name);
      expect(await revisions(p.id)).toHaveLength(count);
      const complete = await patch(p.id, { openingHoursDays: Array.from({ length: 7 }, (_, day) => ({ day, intervals: [] })) });
      expect(complete.status).toBe(200);
      expect(complete.body.openingHours).toEqual({ intervals: [] });
    }
  });

  it('rejects duplicate/invalid days, conflicting full replacements and excessive merged intervals atomically', async () => {
    const p = await place({ intervals: Array.from({ length: 64 }, () => ({ day: 1, opens: '09:00', closes: '10:00' })) });
    for (const body of [
      { openingHoursDays: [day(2), day(2)] }, { openingHoursDays: [] }, { openingHoursDays: [day(7)] },
      { openingHoursDays: [day(2, '24:00')] }, { openingHoursDays: [day(2)], openingHours: null },
      { openingHoursDays: [day(2)] },
    ]) {
      const response = await patch(p.id, body);
      expect(response.status).toBe(422);
    }
    expect((await read(p.id)).openingHours?.intervals).toHaveLength(64);
    expect(await revisions(p.id)).toHaveLength(1);
  });

  it('uses claimed-business authority and fails closed for absent credentials, denied roles and Oxy outages', async () => {
    const p = await place();
    await createClaim(suite!.db, { placeId: p.id, oxyAccountId: 'hours-business', role: 'owner', state: 'approved' });
    const body = { openingHoursDays: [day(2)] };
    expect((await api.call('PATCH', `/places/${p.id}`, undefined, body)).status).toBe(401);
    for (const role of ['viewer', 'developer', 'billing', 'stranger']) {
      expect((await patch(p.id, body, `person-${role}`)).status).toBe(403);
    }
    for (const mode of ['down', 'unauthorized'] as const) {
      oxy.mode = mode;
      expect((await patch(p.id, body, 'person-editor')).status).toBe(mode === 'down' ? 503 : 401);
    }
    expect((await read(p.id)).openingHours).toEqual(ORIGINAL);
    expect(await revisions(p.id)).toHaveLength(1);
    oxy.mode = 'ok';
    for (const role of ['owner', 'admin', 'editor']) expect((await patch(p.id, body, `person-${role}`)).status).toBe(200);
  });
});
