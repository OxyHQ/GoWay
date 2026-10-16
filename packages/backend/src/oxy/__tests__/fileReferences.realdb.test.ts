/**
 * GoWay's Oxy file references after the add, end to end: the outbox in a real
 * PostGIS, the real worker, and the real `@oxy.so/core` `OxyServer` minting
 * GoWay's service token against a fake Oxy (`fakeOxy`).
 *
 *  - a merge moves each moved item's reference to the survivor — queued in the
 *    merge's transaction, add before remove, retried with backoff, and one
 *    file's moves delivered in the order they were made;
 *  - a change that keeps failing is dead-lettered, logged, and requeued by an
 *    operator;
 *  - the nightly reconciliation: a dry run reports and changes nothing, a real
 *    run adds the missing, removes the stale and re-points items an older merge
 *    left naming the absorbed place; one run at a time, one a day.
 *
 * This suite does not skip. See `db/__tests__/testDatabase.ts`.
 */

import '../../__tests__/testEnv';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { Place } from '@goway/contracts';
import { OXY_FILE_REFERENCES_POLICY } from '../../config/oxyFileReferences';
import {
  enqueueFileReferenceChanges,
  fileReferenceOutboxStatus,
  listDeadFileReferenceChanges,
  retryDeadFileReferenceChanges,
} from '../../db/oxyFiles/referenceChanges';
import { recentReconciliations } from '../../db/oxyFiles/reconciliations';
import { addPlaceMedia } from '../../db/places/mediaRepository';
import { resolveDuplicateCandidate } from '../../db/places/moderationRepository';
import { createPlace, recordDuplicateCandidate } from '../../db/places/placesRepository';
import {
  createSuiteDatabase,
  destroySuiteDatabase,
  requireSuite,
  SUITE_SETUP_TIMEOUT_MS,
  type SuiteDatabase,
} from '../../db/__tests__/testDatabase';
import { defined } from '../../__tests__/defined';
import {
  FAKE_SERVICE_APPLICATION_ID,
  FAKE_SERVICE_AUTH,
  startFakeOxy,
  type FakeOxy,
} from '../../__tests__/fakeOxy';
import { apiAuthor } from '../../__tests__/placesFixtures';
import {
  createFileReferenceWorker,
  createOxyFileReferences,
  type FileReferenceWorker,
} from '../fileReferences';

const GRACIA = { latitude: 41.3979, longitude: 2.1598 };
const APP = FAKE_SERVICE_APPLICATION_ID;
/** Two attempts, so a dead letter takes two drains. */
const POLICY = { ...OXY_FILE_REFERENCES_POLICY, maxAttempts: 2 };
/** Far enough ahead of real time for any backoff the policy can choose. */
const PAST_ANY_BACKOFF_MS = 7 * 24 * 60 * 60 * 1000;

let suite: SuiteDatabase | null = null;
let oxy: FakeOxy;
let worker: FileReferenceWorker;
let skewMs = 0;
const errors: string[] = [];

function db() {
  return requireSuite(suite).db;
}

async function place(name: string): Promise<Place> {
  return createPlace(
    db(),
    { name, location: GRACIA },
    { author: apiAuthor('person-c'), assertedVerification: 'community_reported' },
  );
}

/** A public file in a place's gallery, referenced by GoWay at Oxy as `attach` leaves it. */
async function galleryItem(placeId: string, fileId: string): Promise<void> {
  oxy.files.set(fileId, {
    ownerUserId: 'person-c',
    status: 'active',
    mime: 'image/jpeg',
    visibility: 'public',
  });
  defined(
    await addPlaceMedia(
      db(),
      placeId,
      { fileId, kind: 'photo' },
      { author: apiAuthor('person-c'), assertedVerification: 'community_reported' },
    ),
  );
  referenceAt(fileId, placeId);
}

function referenceAt(fileId: string, entityId: string): void {
  const links = oxy.links.get(fileId) ?? [];
  links.push({ app: APP, entityType: 'place', entityId, createdBy: null, sequence: 0 });
  oxy.links.set(fileId, links);
}

function linksOf(fileId: string): string[] {
  return (oxy.links.get(fileId) ?? []).map(
    (link) => `${link.app}/${link.entityType}/${link.entityId}`,
  );
}

async function queuedFor(fileId: string) {
  return [
    ...(await requireSuite(suite).client<
      { action: string; from_entity_id: string | null; entity_id: string; state: string }[]
    >`
      SELECT action, from_entity_id, entity_id, state FROM oxy_file_reference_changes
      WHERE oxy_file_id = ${fileId} ORDER BY id
    `),
  ];
}

/** Merge `absorbed` into `survivor`, as an operator resolving their duplicate candidate. */
async function merge(survivor: Place, absorbed: Place): Promise<void> {
  await recordDuplicateCandidate(db(), survivor.id, absorbed.id, 'manual_report');
  const [low, high] = [survivor.id, absorbed.id].sort();
  const [candidate] = await requireSuite(suite).client<{ id: string }[]>`
    SELECT id FROM places_duplicate_candidates
    WHERE place_id = ${defined(low)} AND candidate_place_id = ${defined(high)}
  `;
  defined(
    await resolveDuplicateCandidate(
      db(),
      defined(candidate).id,
      { decision: 'merge', survivorPlaceId: survivor.id },
      apiAuthor('person-mod'),
    ),
  );
}

/** Drain as the loop would once every backoff has passed, until nothing is left to claim. */
async function drainEverythingDue(): Promise<void> {
  skewMs = PAST_ANY_BACKOFF_MS;
  try {
    for (;;) {
      const { delivered, retrying, dead } = await worker.drain();
      if (delivered + retrying + dead === 0) return;
    }
  } finally {
    skewMs = 0;
  }
}

beforeAll(async () => {
  suite = await createSuiteDatabase();
  oxy = await startFakeOxy();
  const handle = suite.db;
  worker = createFileReferenceWorker({
    getDb: () => handle,
    references: createOxyFileReferences({
      baseURL: oxy.url,
      serviceAuth: { ...FAKE_SERVICE_AUTH },
    }),
    policy: POLICY,
    now: () => new Date(Date.now() + skewMs),
    logger: {
      info() {},
      warn() {},
      error(_fields, message) {
        errors.push(message);
      },
    },
  });
}, SUITE_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await oxy.close();
  await destroySuiteDatabase(suite);
  suite = null;
});

beforeEach(() => {
  oxy.mode = 'ok';
  oxy.referencesGranted = true;
  oxy.referencesMode = 'ok';
  oxy.fileRequests.length = 0;
  skewMs = 0;
  errors.length = 0;
});

describe('a merge moves the references of the gallery it moves', () => {
  it('queues the move in the merge, then adds the survivor’s reference before dropping the old one', async () => {
    const [absorbed, survivor] = [await place('Bar Pinotxo'), await place('Bar Pinotxo')];
    await galleryItem(absorbed.id, 'file-merge-1');

    await merge(survivor, absorbed);
    expect(await queuedFor('file-merge-1')).toEqual([
      { action: 'move', from_entity_id: absorbed.id, entity_id: survivor.id, state: 'pending' },
    ]);
    expect(linksOf('file-merge-1')).toEqual([`${APP}/place/${absorbed.id}`]);

    expect(await worker.drain()).toMatchObject({ delivered: 1 });
    expect(linksOf('file-merge-1')).toEqual([`${APP}/place/${survivor.id}`]);
    expect(oxy.fileRequests.map((entry) => entry.request)).toEqual([
      'POST /assets/service/references',
      'DELETE /assets/service/references',
    ]);
    expect(oxy.fileRequests.every((entry) => entry.person === `service:${APP}`)).toBe(true);
    expect(await queuedFor('file-merge-1')).toEqual([]);
  });

  it('retries a move Oxy could not take, and delivers one file’s moves in the order they were made', async () => {
    const [first, second, third] = [
      await place('Forn Sarret'),
      await place('Forn Sarret'),
      await place('Forn Sarret'),
    ];
    await galleryItem(first.id, 'file-merge-2');

    await merge(second, first);
    oxy.referencesMode = 'down';
    expect(await worker.drain()).toMatchObject({ delivered: 0, retrying: 1 });
    expect(linksOf('file-merge-2')).toEqual([`${APP}/place/${first.id}`]);

    // A second merge moves the item on while the first move still waits.
    await merge(third, second);
    oxy.referencesMode = 'ok';
    // Due now: only the second move — and it may not overtake the first.
    expect(await worker.drain()).toMatchObject({ delivered: 0 });

    await drainEverythingDue();
    expect(linksOf('file-merge-2')).toEqual([`${APP}/place/${third.id}`]);
    expect(await queuedFor('file-merge-2')).toEqual([]);
  });
});

describe('a change that keeps failing', () => {
  it('is dead-lettered and logged, and an operator puts it back', async () => {
    const shop = await place('Colmado Quílez');
    referenceAt('file-dead-1', shop.id);
    const [id] = await enqueueFileReferenceChanges(db(), [
      { action: 'remove', fileId: 'file-dead-1', entityType: 'place', entityId: shop.id },
    ]);

    oxy.referencesMode = 'down';
    expect(await worker.deliver([defined(id)])).toMatchObject({ retrying: 1 });
    skewMs = PAST_ANY_BACKOFF_MS;
    expect(await worker.drain()).toMatchObject({ dead: 1 });
    skewMs = 0;
    expect(errors.some((message) => message.includes('dead-lettered'))).toBe(true);

    const dead = await listDeadFileReferenceChanges(db(), 100);
    expect(dead.map((change) => change.id)).toContain(defined(id));
    expect(dead.find((change) => change.id === id)).toMatchObject({
      attempts: 2,
      lastFailure: 'http_503',
    });
    expect((await fileReferenceOutboxStatus(db(), new Date())).dead).toBeGreaterThanOrEqual(1);
    // A dead change is never retried on its own...
    oxy.referencesMode = 'ok';
    await drainEverythingDue();
    expect(linksOf('file-dead-1')).toEqual([`${APP}/place/${shop.id}`]);

    // ...until an operator requeues it.
    expect(await retryDeadFileReferenceChanges(db(), new Date(), [defined(id)])).toBe(1);
    await worker.drain();
    expect(linksOf('file-dead-1')).toEqual([]);
    expect(await queuedFor('file-dead-1')).toEqual([]);
  });
});

describe('the nightly reconciliation', () => {
  let shop: Place;
  let legacy: Place;

  beforeAll(async () => {
    // Everything earlier in the suite has been delivered.
    await drainEverythingDue();
    shop = await place('Ferreteria Gràcia');
    legacy = await place('Llibreria Gràcia');
    // In the gallery and referenced: unchanged.
    await galleryItem(shop.id, 'file-rec-kept');
    // In the gallery, never referenced (a reference lost before the outbox): added.
    await galleryItem(shop.id, 'file-rec-missing');
    oxy.links.set('file-rec-missing', []);
    // Referenced, in no gallery (a removal lost before the outbox): removed.
    oxy.files.set('file-rec-stale', {
      ownerUserId: 'person-c',
      status: 'active',
      mime: 'image/jpeg',
      visibility: 'public',
    });
    referenceAt('file-rec-stale', shop.id);
    // Moved by a merge before merges moved references: still names the old place.
    await galleryItem(legacy.id, 'file-rec-legacy');
    oxy.links.set('file-rec-legacy', []);
    referenceAt('file-rec-legacy', 'place-absorbed-long-ago');
    await requireSuite(suite).client`
      UPDATE place_media SET oxy_link_place_id = 'place-absorbed-long-ago'
      WHERE oxy_file_id = 'file-rec-legacy'
    `;
  });

  it('reports what it would change in a dry run, and changes nothing', async () => {
    const before = ['file-rec-kept', 'file-rec-missing', 'file-rec-stale', 'file-rec-legacy'].map(
      (fileId) => linksOf(fileId),
    );
    const outcome = await worker.reconcile({ dryRun: true, onlyIfDue: true });
    expect(outcome.status).toBe('committed');
    if (outcome.status !== 'committed') return;
    expect(outcome.dryRun).toBe(true);
    expect(outcome.result.added).toBeGreaterThanOrEqual(2);
    expect(outcome.result.removed).toBeGreaterThanOrEqual(2);
    expect(outcome.aligned).toBe(0);
    expect(
      ['file-rec-kept', 'file-rec-missing', 'file-rec-stale', 'file-rec-legacy'].map((fileId) =>
        linksOf(fileId),
      ),
    ).toEqual(before);
    expect(oxy.reconcileRequests.at(-1)).toEqual({
      request: 'commit',
      entityType: 'place',
      dryRun: true,
    });

    const [run] = await recentReconciliations(db(), 1);
    expect(run).toMatchObject({
      entityType: 'place',
      dryRun: true,
      sent: outcome.sent,
      added: outcome.result.added,
      removed: outcome.result.removed,
      failure: null,
    });
    expect(run?.finishedAt).not.toBeNull();
  });

  it('runs once a day: a due run started within the day is skipped', async () => {
    expect(await worker.reconcile({ dryRun: true, onlyIfDue: true })).toEqual({
      status: 'skipped',
    });
  });

  it('adds the missing, removes the stale and re-points legacy items in a real run', async () => {
    const outcome = await worker.reconcile({ dryRun: false, onlyIfDue: false });
    expect(outcome.status).toBe('committed');
    expect(linksOf('file-rec-kept')).toEqual([`${APP}/place/${shop.id}`]);
    expect(linksOf('file-rec-missing')).toEqual([`${APP}/place/${shop.id}`]);
    expect(linksOf('file-rec-stale')).toEqual([]);
    expect(linksOf('file-rec-legacy')).toEqual([`${APP}/place/${legacy.id}`]);
    const [row] = await requireSuite(suite).client<{ oxy_link_place_id: string }[]>`
      SELECT oxy_link_place_id FROM place_media WHERE oxy_file_id = 'file-rec-legacy'
    `;
    expect(row?.oxy_link_place_id).toBe(legacy.id);
  });

  it('records a run Oxy could not finish, and lets the next one start', async () => {
    oxy.referencesMode = 'down';
    expect(await worker.reconcile({ dryRun: true, onlyIfDue: false })).toEqual({
      status: 'failed',
      dryRun: true,
      failure: 'http_503',
    });
    expect((await recentReconciliations(db(), 1))[0]).toMatchObject({ failure: 'http_503' });
    expect(errors.some((message) => message.includes('reconciliation failed'))).toBe(true);

    oxy.referencesMode = 'ok';
    expect((await worker.reconcile({ dryRun: true, onlyIfDue: false })).status).toBe('committed');
  });
});
