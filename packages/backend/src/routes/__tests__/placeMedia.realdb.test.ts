/**
 * A place's gallery, end to end: the real media, places and moderation
 * routers, the real `@oxy.so/core` client asking a fake Oxy at the HTTP
 * boundary (`fakeOxy`) about files and organizations, and a real PostGIS.
 *
 *  - adding a file: signed in, the caller's own, public, an image, active —
 *    or refused with nothing recorded and nothing linked; Oxy down is `503`;
 *  - who may add a logo, withdraw an item, order the gallery;
 *  - the logo and cover pointers, and their release when an item leaves;
 *  - moderation's hide and restore, and reports about one item;
 *  - every write's revision in its own transaction, and no file id in any.
 *
 * This suite does not skip. See `db/__tests__/testDatabase.ts`.
 */

import '../../__tests__/testEnv';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type {
  ModerationPlaceMedia,
  ModerationPlaceMediaPage,
  Place,
  PlaceMedia,
  PlaceMediaPage,
  PlaceReport,
  PlaceRevisionPage,
} from '@goway/contracts';
import { createClaim, createPlace, type PlaceActor } from '../../db/places/placesRepository';
import {
  SUITE_SETUP_TIMEOUT_MS,
  createSuiteDatabase,
  destroySuiteDatabase,
  type SuiteDatabase,
} from '../../db/__tests__/testDatabase';
import { createRequireOperator } from '../../middleware/operator';
import { createAccountRoleResolver } from '../../oxy/accountRoles';
import { createOxyPlaceFileStore } from '../../oxy/placeFiles';
import { membershipKey, startFakeOxy, type FakeOxy, type FakeOxyFile } from '../../__tests__/fakeOxy';
import { fakeOptionalAuth, fakeRequireAuth, serve, session, type ErrorBody, type TestApi } from '../../__tests__/httpHarness';
import { apiAuthor, NO_RATE_LIMIT } from '../../__tests__/placesFixtures';
import { createModerationRouter } from '../moderation';
import { createPlaceMediaRouter } from '../placeMedia';
import { createPlacesRouter } from '../places';

const CONTRIBUTOR: PlaceActor = { author: apiAuthor('person-contributor'), assertedVerification: 'community_reported' };
const GRACIA = { latitude: 41.3979, longitude: 2.1598 };
const OPERATOR = session('person-mod');

let suite: SuiteDatabase | null = null;
let oxy: FakeOxy;
let api: TestApi;

/** Claimed, approved, by the organization `org-cafe`. */
let cafe: Place;
/** Nobody's. */
let open: Place;

/** Put a file in the fake Oxy, as `owner` uploaded it. */
function upload(fileId: string, owner: string, file: Partial<FakeOxyFile> = {}): string {
  oxy.files.set(fileId, {
    ownerUserId: owner,
    status: 'active',
    mime: 'image/jpeg',
    visibility: 'public',
    metadata: { width: 1600, height: 1200 },
    ...file,
  });
  return fileId;
}

function linksOf(fileId: string): string[] {
  return (oxy.links.get(fileId) ?? []).map((link) => `${link.app}/${link.entityType}/${link.entityId}`);
}

async function mediaCount(placeId: string): Promise<number> {
  const [row] = await suite!.client<{ count: string }[]>`SELECT count(*) FROM place_media WHERE place_id = ${placeId}`;
  return Number(row!.count);
}

async function storedRevisions(placeId: string) {
  return suite!.client<{ action: string; changes: unknown }[]>`
    SELECT action, changes FROM place_revisions WHERE place_id = ${placeId} ORDER BY created_at, id
  `;
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

async function add(placeId: string, who: Record<string, string>, body: unknown) {
  return api.call<PlaceMedia & ErrorBody>('POST', `/places/${placeId}/media`, who, body);
}

async function gallery(placeId: string, query = ''): Promise<PlaceMedia[]> {
  const { status, body } = await api.call<PlaceMediaPage>('GET', `/places/${placeId}/media${query}`);
  expect(status).toBe(200);
  return body.items;
}

beforeAll(async () => {
  suite = await createSuiteDatabase();
  oxy = await startFakeOxy();
  oxy.accounts.add('org-cafe');
  oxy.memberships.set(membershipKey('person-editor', 'org-cafe'), 'editor');
  oxy.memberships.set(membershipKey('person-viewer', 'org-cafe'), 'viewer');

  const accountRoles = createAccountRoleResolver({ oxyApiUrl: oxy.url, ttlMs: 0 });
  const placeFiles = createOxyPlaceFileStore({ oxyApiUrl: oxy.url });
  api = await serve(
    createPlacesRouter({ optionalAuth: fakeOptionalAuth, requireAuth: fakeRequireAuth, accountRoles, reportRateLimit: NO_RATE_LIMIT }),
    createPlaceMediaRouter({
      optionalAuth: fakeOptionalAuth,
      requireAuth: fakeRequireAuth,
      accountRoles,
      placeFiles,
      reportRateLimit: NO_RATE_LIMIT,
      contributionRateLimit: NO_RATE_LIMIT,
    }),
    createModerationRouter({ requireAuth: fakeRequireAuth, requireOperator: createRequireOperator(['person-mod']) }),
  );

  cafe = await createPlace(suite.db, { name: 'Cafè de la Plaça', location: GRACIA }, CONTRIBUTOR);
  open = await createPlace(suite.db, { name: 'Plaça del Sol', location: GRACIA }, CONTRIBUTOR);
  await createClaim(suite.db, { placeId: cafe.id, oxyAccountId: 'org-cafe', role: 'owner', state: 'approved' });
}, SUITE_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await api.close();
  await oxy.close();
  await destroySuiteDatabase(suite);
  suite = null;
});

beforeEach(() => {
  oxy.mode = 'ok';
  oxy.fileRequests.length = 0;
});

describe('adding an Oxy file to a gallery', () => {
  it('records a public image the caller owns, links it to the place, and publishes it', async () => {
    const fileId = upload('file-ana-1', 'person-ana');
    const { status, body } = await add(open.id, session('person-ana'), { fileId, kind: 'photo', caption: 'La plaça al matí' });

    expect(status).toBe(201);
    expect(body).toMatchObject({
      placeId: open.id,
      fileId,
      kind: 'photo',
      verification: 'community_reported',
      position: 0,
      caption: 'La plaça al matí',
      width: 1600,
      height: 1200,
    });
    // Asked on the caller's own session, and linked so Oxy keeps the file.
    expect(oxy.fileRequests.every((request) => request.person === 'person-ana')).toBe(true);
    expect(linksOf(fileId)).toEqual([`goway/place/${open.id}`]);
    expect(oxy.files.get(fileId)?.visibility).toBe('public');
    expect((await gallery(open.id)).map((item) => item.fileId)).toEqual([fileId]);
  });

  it('records media_added publicly, and never the file id', async () => {
    const { body } = await api.call<PlaceRevisionPage>('GET', `/places/${open.id}/revisions`);
    const [latest] = body.items;
    expect(latest?.action).toBe('media_added');
    expect(latest?.changes[0]?.field).toMatch(/^media\./);
    expect(JSON.stringify(body)).not.toContain('file-ana-1');
  });

  it('refuses a signed-out caller', async () => {
    expect((await add(open.id, {}, { fileId: 'file-ana-1', kind: 'photo' })).status).toBe(401);
  });

  it("refuses somebody else's file, and links nothing", async () => {
    const fileId = upload('file-ana-2', 'person-ana');
    const { status, body } = await add(open.id, session('person-bob'), { fileId, kind: 'photo' });
    expect(status).toBe(403);
    expect(body.error.details).toMatchObject({ field: 'fileId', issue: 'not_owner' });
    expect(linksOf(fileId)).toEqual([]);
  });

  it('refuses a private file without making it public', async () => {
    const fileId = upload('file-ana-private', 'person-ana', { visibility: 'private' });
    const { status, body } = await add(open.id, session('person-ana'), { fileId, kind: 'photo' });
    expect(status).toBe(422);
    expect(body.error.details?.issue).toBe('not_public');
    expect(oxy.files.get(fileId)?.visibility).toBe('private');
    expect(linksOf(fileId)).toEqual([]);
  });

  it('refuses a file in the trash, a file that is not an image, and an id Oxy does not know', async () => {
    upload('file-ana-trash', 'person-ana', { status: 'trash' });
    upload('file-ana-pdf', 'person-ana', { mime: 'application/pdf' });
    const before = await mediaCount(open.id);
    for (const [fileId, issue] of [
      ['file-ana-trash', 'not_active'],
      ['file-ana-pdf', 'not_an_image'],
      ['file-nobody', 'not_found'],
    ] as const) {
      const { status, body } = await add(open.id, session('person-ana'), { fileId, kind: 'photo' });
      expect(`${fileId}: ${String(status)} ${String(body.error.details?.issue)}`).toBe(`${fileId}: 422 ${issue}`);
    }
    expect(await mediaCount(open.id)).toBe(before);
  });

  it('fails closed with 503 when Oxy cannot answer, and records nothing', async () => {
    const fileId = upload('file-ana-3', 'person-ana');
    oxy.mode = 'down';
    const before = await mediaCount(open.id);
    const { status, body } = await add(open.id, session('person-ana'), { fileId, kind: 'photo' });
    expect(status).toBe(503);
    expect(body.error.code).toBe('service_unavailable');
    expect(await mediaCount(open.id)).toBe(before);
  });

  it('answers a file already in the gallery with 409 naming the item, and keeps its link', async () => {
    const [existing] = await gallery(open.id);
    const { status, body } = await add(open.id, session('person-ana'), { fileId: 'file-ana-1', kind: 'photo' });
    expect(status).toBe(409);
    expect(body.error.details).toEqual({ mediaId: existing!.id });
    expect(linksOf('file-ana-1')).toEqual([`goway/place/${open.id}`]);
  });

  it('accepts a file uploaded by the organization a session switched into', async () => {
    const fileId = upload('file-org-1', 'org-cafe');
    const { status, body } = await add(cafe.id, session('org-cafe', 'person-editor'), { fileId, kind: 'interior' });
    expect(status).toBe(201);
    expect(body.verification).toBe('business_asserted');
  });
});

describe('who may add what to a claimed place', () => {
  it("lets a customer add a photo, at the community's tier", async () => {
    const fileId = upload('file-stranger-1', 'person-stranger');
    const { status, body } = await add(cafe.id, session('person-stranger'), { fileId, kind: 'photo' });
    expect(status).toBe(201);
    expect(body.verification).toBe('community_reported');
  });

  it("refuses a customer's logo, and a viewer's, but takes an editor's at the business tier", async () => {
    upload('file-stranger-logo', 'person-stranger');
    expect((await add(cafe.id, session('person-stranger'), { fileId: 'file-stranger-logo', kind: 'logo' })).status).toBe(403);
    upload('file-viewer-logo', 'person-viewer');
    expect((await add(cafe.id, session('person-viewer'), { fileId: 'file-viewer-logo', kind: 'logo' })).status).toBe(403);

    upload('file-editor-logo', 'person-editor');
    const { status, body } = await add(cafe.id, session('person-editor'), { fileId: 'file-editor-logo', kind: 'logo' });
    expect(status).toBe(201);
    expect(body.verification).toBe('business_asserted');
  });
});

describe('the logo and the cover', () => {
  it('points at a visible logo item of the place, published by its file', async () => {
    const { status, body } = await api.call<Place>('PATCH', `/places/${cafe.id}`, session('person-editor'), {
      logoFileId: 'file-editor-logo',
    });
    expect(status).toBe(200);
    expect(body.logoFileId).toBe('file-editor-logo');

    // The revision names the gallery item, never the file.
    const [latest] = (await storedRevisions(cafe.id)).slice(-1);
    expect(latest?.action).toBe('place_updated');
    expect(JSON.stringify(latest?.changes)).not.toContain('file-editor-logo');
    expect(JSON.stringify(latest?.changes)).toContain('"field":"logo"');
  });

  it('refuses a file that is not a logo item of this place', async () => {
    const { status, body } = await api.call<ErrorBody>('PATCH', `/places/${cafe.id}`, session('person-editor'), {
      coverFileId: 'file-stranger-1',
    });
    expect(status).toBe(422);
    expect(body.error.details).toMatchObject({ field: 'coverFileId', issue: 'not_in_gallery' });
  });

  it('is cleared with null', async () => {
    upload('file-editor-cover', 'person-editor');
    await add(cafe.id, session('person-editor'), { fileId: 'file-editor-cover', kind: 'cover' });
    const set = await api.call<Place>('PATCH', `/places/${cafe.id}`, session('person-editor'), { coverFileId: 'file-editor-cover' });
    expect(set.body.coverFileId).toBe('file-editor-cover');
    const cleared = await api.call<Place>('PATCH', `/places/${cafe.id}`, session('person-editor'), { coverFileId: null });
    expect(cleared.body.coverFileId).toBeUndefined();
  });
});

describe('ordering the gallery', () => {
  it('is the business alone', async () => {
    const items = await gallery(cafe.id);
    const reversed = items.map((item) => item.id).reverse();
    const stranger = await api.call<ErrorBody>('PUT', `/places/${cafe.id}/media/order`, session('person-stranger'), { mediaIds: reversed });
    expect(stranger.status).toBe(403);

    expect((await api.call('PUT', `/places/${cafe.id}/media/order`, session('person-editor'), { mediaIds: reversed })).status).toBe(204);
    expect((await gallery(cafe.id)).map((item) => item.id)).toEqual(reversed);
    expect((await storedRevisions(cafe.id)).slice(-1)[0]?.action).toBe('media_reordered');
  });

  it('refuses an id that is not a visible item of this place', async () => {
    const { status, body } = await api.call<ErrorBody>('PUT', `/places/${cafe.id}/media/order`, session('person-editor'), {
      mediaIds: ['no-such-item'],
    });
    expect(status).toBe(422);
    expect(body.error.details).toMatchObject({ field: 'mediaIds.0', issue: 'not_in_gallery' });
  });

  it('pages the public gallery in its order, by kind when asked', async () => {
    const all = await gallery(cafe.id);
    const first = await api.call<PlaceMediaPage>('GET', `/places/${cafe.id}/media?limit=1`);
    expect(first.body.items.map((item) => item.id)).toEqual([all[0]!.id]);
    const second = await api.call<PlaceMediaPage>('GET', `/places/${cafe.id}/media?limit=1&cursor=${first.body.nextCursor!}`);
    expect(second.body.items.map((item) => item.id)).toEqual([all[1]!.id]);
    expect((await gallery(cafe.id, '?kinds=logo')).map((item) => item.kind)).toEqual(['logo']);
    // A cursor minted under one filter is refused under another.
    expect((await api.call('GET', `/places/${cafe.id}/media?kinds=photo&cursor=${first.body.nextCursor!}`)).status).toBe(400);
  });
});

describe('withdrawing an item', () => {
  it('is open to its contributor, and drops the Oxy link', async () => {
    const item = (await gallery(cafe.id)).find((entry) => entry.fileId === 'file-stranger-1')!;
    expect(linksOf('file-stranger-1')).toEqual([`goway/place/${cafe.id}`]);
    const { status } = await api.call('DELETE', `/places/${cafe.id}/media/${item.id}`, session('person-stranger'));
    expect(status).toBe(204);
    expect(linksOf('file-stranger-1')).toEqual([]);
    expect((await gallery(cafe.id)).some((entry) => entry.id === item.id)).toBe(false);
    expect((await storedRevisions(cafe.id)).slice(-1)[0]?.action).toBe('media_removed');
  });

  it('is open to the business for anybody\'s item, and to nobody else', async () => {
    const fileId = upload('file-stranger-2', 'person-stranger');
    const { body: item } = await add(cafe.id, session('person-stranger'), { fileId, kind: 'photo' });
    expect((await api.call<ErrorBody>('DELETE', `/places/${cafe.id}/media/${item.id}`, session('person-other'))).status).toBe(403);
    expect((await api.call('DELETE', `/places/${cafe.id}/media/${item.id}`, session('person-editor'))).status).toBe(204);
    expect((await api.call('DELETE', `/places/${cafe.id}/media/${item.id}`, session('person-editor'))).status).toBe(404);
  });

  it('clears the logo it was, in the same revision', async () => {
    const logo = (await gallery(cafe.id)).find((entry) => entry.fileId === 'file-editor-logo')!;
    expect((await api.call('DELETE', `/places/${cafe.id}/media/${logo.id}`, session('person-editor'))).status).toBe(204);
    const { body: place } = await api.call<Place>('GET', `/places/${cafe.id}`);
    expect(place.logoFileId).toBeUndefined();
    const [latest] = (await storedRevisions(cafe.id)).slice(-1);
    expect(latest?.changes).toContainEqual({ field: 'logo', before: logo.id });
  });
});

describe('moderation', () => {
  let item: PlaceMedia;

  beforeAll(async () => {
    const fileId = upload('file-ana-moderated', 'person-ana');
    item = (await add(open.id, session('person-ana'), { fileId, kind: 'photo' })).body;
  });

  it('lists every state, with who added each, to an operator only', async () => {
    expect((await api.call('GET', `/moderation/places/${open.id}/media`, session('person-ana'))).status).toBe(403);
    const { status, body } = await api.call<ModerationPlaceMediaPage>('GET', `/moderation/places/${open.id}/media`, OPERATOR);
    expect(status).toBe(200);
    expect(body.items.find((entry) => entry.id === item.id)).toMatchObject({ state: 'visible', contributorOxyAccountId: 'person-ana' });
  });

  it('hides an item from the public gallery, and restores it, recording each', async () => {
    const hidden = await api.call<ModerationPlaceMedia>('PATCH', `/moderation/places/${open.id}/media/${item.id}`, OPERATOR, { state: 'hidden' });
    expect(hidden.status).toBe(200);
    expect(hidden.body.state).toBe('hidden');
    expect((await gallery(open.id)).some((entry) => entry.id === item.id)).toBe(false);
    // Hidden is moderation state: the public history does not list it.
    const history = await api.call<PlaceRevisionPage>('GET', `/places/${open.id}/revisions`);
    expect(history.body.items.some((revision) => revision.action === 'media_hidden')).toBe(false);

    expect((await api.call('PATCH', `/moderation/places/${open.id}/media/${item.id}`, OPERATOR, { state: 'hidden' })).status).toBe(409);
    const restored = await api.call<ModerationPlaceMedia>('PATCH', `/moderation/places/${open.id}/media/${item.id}`, OPERATOR, {
      state: 'visible',
    });
    expect(restored.body.state).toBe('visible');
    expect((await gallery(open.id)).some((entry) => entry.id === item.id)).toBe(true);
    expect((await storedRevisions(open.id)).slice(-2).map((revision) => revision.action)).toEqual(['media_hidden', 'media_restored']);
  });

  it('files a report about one item, once while it is open', async () => {
    const filed = await api.call<PlaceReport>('POST', `/places/${open.id}/media/${item.id}/reports`, session('person-bob'), {
      reason: 'privacy',
    });
    expect(filed.status).toBe(201);
    expect(filed.body).toMatchObject({ placeId: open.id, mediaId: item.id, reason: 'privacy' });
    const repeated = await api.call<PlaceReport>('POST', `/places/${open.id}/media/${item.id}/reports`, session('person-bob'), {
      reason: 'offensive',
    });
    expect(repeated.status).toBe(200);
    expect(repeated.body.id).toBe(filed.body.id);
    // A place-level reason is not a reason about one photo.
    expect(
      (await api.call('POST', `/places/${open.id}/media/${item.id}/reports`, session('person-bob'), { reason: 'wrong_location' })).status,
    ).toBe(422);
  });
});

describe('the revision is part of the write', () => {
  it('records no item, and leaves no Oxy link, when its revision cannot be recorded', async () => {
    const fileId = upload('file-ana-atomic', 'person-ana');
    const before = await mediaCount(open.id);
    await refusingRevisions('media_added', async () => {
      const { status } = await add(open.id, session('person-ana'), { fileId, kind: 'photo' });
      expect(status).toBe(500);
    });
    expect(await mediaCount(open.id)).toBe(before);
    expect(linksOf(fileId)).toEqual([]);
  });

  it('keeps an item, and the logo it is, when its removal cannot be recorded', async () => {
    const fileId = upload('file-editor-logo-2', 'person-editor');
    const { body: logo } = await add(cafe.id, session('person-editor'), { fileId, kind: 'logo' });
    await api.call('PATCH', `/places/${cafe.id}`, session('person-editor'), { logoFileId: fileId });
    await refusingRevisions('media_removed', async () => {
      expect((await api.call('DELETE', `/places/${cafe.id}/media/${logo.id}`, session('person-editor'))).status).toBe(500);
    });
    const { body: place } = await api.call<Place>('GET', `/places/${cafe.id}`);
    expect(place.logoFileId).toBe(fileId);
    expect((await gallery(cafe.id)).some((entry) => entry.id === logo.id)).toBe(true);
  });
});
