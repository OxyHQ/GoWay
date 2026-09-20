/**
 * The capture API over a real socket and a real PostGIS database — Phase A's
 * exit condition, as a test.
 *
 * The epic's condition is: a contributor can upload a real geotagged photo or
 * video, the backend knows exactly WHERE it is, WHY it is stored and WHEN it
 * will expire, and no raw media is permanent by accident. Everything below is
 * an assertion about one of those four clauses, made over HTTP against the
 * shapes an `@goway.to/sdk` consumer actually receives.
 *
 * ## The object store is a fake, and the bytes are never sent anywhere
 *
 * That is not a shortcut, it is the design under test: the API issues an upload
 * target and never touches media. The fake records what was asked of it, so the
 * suite can assert the things a real S3 would silently accept — that the key
 * came from the server, that a target is issued once and not for already-stored
 * bytes, and that finalize asks the STORE whether the object arrived rather
 * than believing the client.
 *
 * ## The auth middlewares are injected, and the real ones are not exercised
 *
 * `createOxyAuthMiddleware` verifies a token against the Oxy identity service
 * over HTTP; standing one up is not what this suite is about. `createApp()`
 * passes the real ones and `app.test.ts` covers the composition. What these
 * fakes reproduce is the only contract the router depends on: `requireAuth`
 * fails closed with `unauthorized`, and both publish `req.userId`.
 *
 * This suite does not skip. See `db/__tests__/testDatabase.ts`.
 */

import '../../__tests__/testEnv';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import express, { type RequestHandler } from 'express';
import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type {
  ApiErrorBody,
  CaptureAsset,
  CaptureSession,
  CaptureUploadPolicy,
  CaptureUploadTicket,
} from '@goway/shared-types';
import { summarizeCaptureStorage } from '../../db/capture/captureRepository';
import { getDb } from '../../db/postgres';
import { SUITE_SETUP_TIMEOUT_MS, createSuiteDatabase, destroySuiteDatabase, type SuiteDatabase } from '../../db/__tests__/testDatabase';
import { ApiError } from '../../http/apiError';
import { errorHandler, notFoundHandler } from '../../http/errorHandler';
import type { CaptureObjectStore, UploadTargetRequest } from '../../storage/objectStore';
import { createCaptureRouter, currentUploadPolicy } from '../capture';

/** Barcelona, Plaça de Catalunya. */
const CATALUNYA = { latitude: 41.387, longitude: 2.17 };

/** A distinct, well-formed SHA-256 digest per seed — the shape the API demands. */
const hash = (seed: string): string => createHash('sha256').update(seed).digest('hex');

/**
 * A store that records rather than stores.
 *
 * `stored` is what a successful PUT would have produced; the suite puts entries
 * in by hand to stand in for the client's direct upload, which is exactly the
 * step the API is not involved in.
 */
class FakeObjectStore implements CaptureObjectStore {
  readonly targets: UploadTargetRequest[] = [];
  readonly stored = new Map<string, number>();
  readonly deleted: string[] = [];

  async createUploadTarget(request: UploadTargetRequest) {
    this.targets.push(request);
    return {
      url: `https://fake.invalid/${request.key}?signature=x`,
      headers: { 'Content-Type': request.contentType, 'Content-Length': String(request.byteSize) },
      expiresAt: new Date(Date.now() + request.ttlSeconds * 1000),
    };
  }

  async statObject(key: string) {
    const byteSize = this.stored.get(key);
    return byteSize === undefined ? null : { byteSize };
  }

  async createReadUrl(key: string) {
    return `https://fake.invalid/${key}?read=1`;
  }

  async deleteObject(key: string) {
    this.deleted.push(key);
    this.stored.delete(key);
  }
}

let suite: SuiteDatabase | null = null;
let server: Server;
let origin: string;
let store: FakeObjectStore;
let policy: CaptureUploadPolicy;

const optionalAuth: RequestHandler = (request, _response, next) => {
  const user = request.header('x-test-user');
  if (user) request.userId = user;
  next();
};

const requireAuth: RequestHandler = (request, _response, next) => {
  const user = request.header('x-test-user');
  if (!user) {
    next(new ApiError('unauthorized', 'This request requires an Oxy session.'));
    return;
  }
  request.userId = user;
  next();
};

interface Fetched<T> {
  status: number;
  body: T;
  headers: Headers;
}

async function call<T>(path: string, init: RequestInit = {}): Promise<Fetched<T>> {
  const response = await fetch(`${origin}/api/v1${path}`, init);
  return { status: response.status, body: (await response.json()) as T, headers: response.headers };
}

function asUser(user: string, init: RequestInit = {}): RequestInit {
  return { ...init, headers: { ...(init.headers as Record<string, string>), 'x-test-user': user } };
}

function json(user: string, body: unknown): RequestInit {
  return asUser(user, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** A photo contribution body, at Plaça de Catalunya, with a device-recorded position. */
function photoBody(seed: string, overrides: Record<string, unknown> = {}) {
  return {
    mediaKind: 'photo',
    source: 'camera',
    contentHash: hash(seed),
    byteSize: 2_048_000,
    contentType: 'image/jpeg',
    capturedAt: '2026-09-20T09:12:00.000Z',
    location: [
      {
        origin: 'device_capture',
        coordinate: CATALUNYA,
        accuracyMeters: 8,
        observedAt: '2026-09-20T09:12:00.000Z',
      },
    ],
    camera: { widthPixels: 4032, heightPixels: 3024, exifOrientation: 6, focalLengthMm: 6.8 },
    ...overrides,
  };
}

async function openSession(user: string): Promise<CaptureSession> {
  const created = await call<CaptureSession>(
    '/captures/sessions',
    json(user, { source: 'camera', consentVersion: policy.consentVersion }),
  );
  expect(created.status).toBe(201);
  return created.body;
}

beforeAll(async () => {
  suite = await createSuiteDatabase();
  store = new FakeObjectStore();
  policy = currentUploadPolicy();

  const app = express();
  app.use(express.json());
  const api = express.Router();
  api.use(createCaptureRouter({ optionalAuth, requireAuth, objectStore: store }));
  app.use('/api/v1', api);
  app.use(notFoundHandler);
  app.use(errorHandler);

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, SUITE_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await destroySuiteDatabase(suite);
  suite = null;
});

describe('before anybody contributes', () => {
  it('publishes what may be contributed and for how long, WITHOUT an account', async () => {
    // A visitor reading about contributing is entitled to know what GoWay would
    // keep and for how long. Telling somebody the retention policy only after
    // they sign in is an odd way to obtain informed consent.
    const { status, body } = await call<CaptureUploadPolicy>('/captures/policy');
    expect(status).toBe(200);
    expect(body.contentHashAlgorithm).toBe('sha256');
    expect(body.photo.contentTypes).toContain('image/jpeg');
    expect(body.retentionDays.raw_photo).toBeGreaterThan(0);
    // Raw video goes substantially earlier than photos — the cost posture of
    // #10, published so a contributor can see it before submitting.
    expect(body.retentionDays.raw_video).toBeLessThan(body.retentionDays.raw_photo);
    expect(body.consentVersion.length).toBeGreaterThan(0);
  });

  it('refuses an anonymous contribution', async () => {
    // Contribution requires an account so consent, deletion, abuse controls and
    // attribution are possible at all. An anonymous contribution is one nobody
    // can withdraw and nobody can be accountable for.
    const { status, body } = await call<ApiErrorBody>('/captures/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'camera', consentVersion: policy.consentVersion }),
    });
    expect(status).toBe(401);
    expect(body.error.code).toBe('unauthorized');
  });

  it('refuses a session that accepted superseded consent text', async () => {
    const { status, body } = await call<ApiErrorBody>(
      '/captures/sessions',
      json('user-a', { source: 'camera', consentVersion: 'something-older' }),
    );
    expect(status).toBe(409);
    expect(body.error.code).toBe('conflict');
  });
});

describe('the exit condition: upload a geotagged photo', () => {
  let session: CaptureSession;
  let ticket: CaptureUploadTicket;

  it('registers the contribution and issues a scoped, expiring upload target', async () => {
    session = await openSession('user-a');
    const registered = await call<CaptureUploadTicket>(
      `/captures/sessions/${session.id}/assets`,
      json('user-a', photoBody('a')),
    );
    expect(registered.status).toBe(201);
    ticket = registered.body;

    expect(ticket.upload).toBeDefined();
    expect(ticket.upload?.method).toBe('PUT');
    expect(ticket.upload?.byteSize).toBe(2_048_000);
    expect(new Date(ticket.upload?.expiresAt ?? 0).getTime()).toBeGreaterThan(Date.now());

    // The key is the SERVER's, under the one prefix the object store's own
    // lifecycle backstop is configured on. Nothing in the request body could
    // influence it, and it is not published in the asset.
    const [target] = store.targets;
    expect(target?.key).toMatch(/^captures\/\d{4}\/\d{2}\/[0-9a-f-]+$/);
    expect(JSON.stringify(ticket.asset)).not.toContain('captures/');
  });

  it('knows exactly WHERE it is, and where that came from', async () => {
    expect(ticket.asset.anchor.coordinate).toEqual(CATALUNYA);
    // Not just a coordinate: the provenance travels with it, so #13 and #11 can
    // weigh the position rather than believe it.
    expect(ticket.asset.anchor.origin).toBe('device_capture');
    expect(ticket.asset.anchor.witness).toBe('client');
    expect(ticket.asset.anchor.accuracyMeters).toBe(8);
    // And every claim is kept beside the resolved one.
    expect(ticket.asset.locationEvidence).toHaveLength(1);
    expect(ticket.asset.locationEvidence[0]?.witness).toBe('client');
  });

  it('knows exactly WHY it is stored and WHEN it will expire', async () => {
    const { lifecycle } = ticket.asset.media;
    expect(lifecycle.retentionClass).toBe('raw_photo');
    // A raw photo is on disk because nobody has looked at its pixels yet. The
    // reason is what a sweeper re-checks; the expiry is only the ceiling.
    expect(lifecycle.retentionReason).toBe('awaiting_privacy_processing');
    expect(lifecycle.extensionCount).toBe(0);

    const daysUntilExpiry =
      (Date.parse(lifecycle.expiresAt) - Date.now()) / (24 * 60 * 60 * 1000);
    expect(daysUntilExpiry).toBeGreaterThan(policy.retentionDays.raw_photo - 1);
    expect(daysUntilExpiry).toBeLessThan(policy.retentionDays.raw_photo + 1);
  });

  it('is not a reconstruction input until the privacy gate has run', async () => {
    // Phase A's other half: the contribution is safely ingested AND it cannot
    // be trained on. `reconstructionEligible` is a generated column; the API
    // reads it rather than re-deriving the rule.
    expect(ticket.asset.privacy.state).toBe('pending');
    expect(ticket.asset.privacy.pipelineVersion).toBeUndefined();
    expect(ticket.asset.reconstructionEligible).toBe(false);
  });

  it('refuses to finalize bytes the object store does not have', async () => {
    // The orphan case. GoWay asks the STORE, because a finalize is a claim that
    // an upload succeeded and an upload that did not would otherwise produce an
    // asset GoWay believes in.
    const { status, body } = await call<ApiErrorBody>(
      `/captures/assets/${ticket.asset.id}/finalize`,
      json('user-a', {}),
    );
    expect(status).toBe(409);
    expect(body.error.code).toBe('conflict');
  });

  it('refuses to finalize an object of the wrong size', async () => {
    const key = store.targets[0]?.key as string;
    store.stored.set(key, 17);
    const { status, body } = await call<ApiErrorBody>(
      `/captures/assets/${ticket.asset.id}/finalize`,
      json('user-a', {}),
    );
    expect(status).toBe(409);
    expect(body.error.details?.storedByteSize).toBe(17);
  });

  it('finalizes once the bytes are really there, and does so idempotently', async () => {
    const key = store.targets[0]?.key as string;
    store.stored.set(key, 2_048_000);

    const first = await call<CaptureAsset>(`/captures/assets/${ticket.asset.id}/finalize`, json('user-a', {}));
    expect(first.status).toBe(200);
    expect(first.body.state).toBe('uploaded');
    expect(first.body.media.byteSize).toBe(2_048_000);

    // A contributor on a flaky connection retries. A second finalize must not
    // produce a second asset, a second object, or a 409 for succeeding twice.
    const again = await call<CaptureAsset>(`/captures/assets/${ticket.asset.id}/finalize`, json('user-a', {}));
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);
    expect(again.body.state).toBe('uploaded');
  });

  it('shows the contributor their own contribution, and nobody else theirs', async () => {
    const mine = await call<CaptureAsset>(`/captures/assets/${ticket.asset.id}`, asUser('user-a'));
    expect(mine.status).toBe(200);

    // A stranger gets 404 rather than 403: an enumerable "exists but is not
    // yours" tells them which ids are real.
    const theirs = await call<ApiErrorBody>(`/captures/assets/${ticket.asset.id}`, asUser('user-b'));
    expect(theirs.status).toBe(404);
  });

  it('never publishes the object key or the contributor id', async () => {
    // Raw imagery is never a public path (#13), and a scene manifest must not
    // carry an Oxy id. Asserted on the serialized body, because that is what a
    // consumer sees — a field the mapper forgot to omit would show up here.
    const { body } = await call<CaptureAsset>(`/captures/assets/${ticket.asset.id}`, asUser('user-a'));
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('user-a');
    expect(serialized).not.toContain('captures/2026');
  });
});

describe('deduplication', () => {
  it('registers a second contribution of identical bytes WITHOUT a second upload', async () => {
    // The same photo, from a different contributor. One object, two
    // contributions — decided before a single byte moves, which is the whole
    // reason the client hashes first.
    const targetsBefore = store.targets.length;
    const session = await openSession('user-b');
    const { status, body } = await call<CaptureUploadTicket>(
      `/captures/sessions/${session.id}/assets`,
      json('user-b', photoBody('a')),
    );
    expect(status).toBe(201);
    expect(body.upload).toBeUndefined();
    expect(store.targets.length).toBe(targetsBefore);
    // Nothing left for the contributor to do: the bytes are already here.
    expect(body.asset.state).toBe('uploaded');
    expect(body.asset.media.deduplicated).toBe(true);
  });

  it('cancels a pending deletion when the same bytes are contributed again', async () => {
    // `deleting` is the window between a sweeper recording its intent and
    // calling the store. #10 requires it to re-check that nothing still needs
    // the object, and a contribution arriving right then is exactly such a
    // reference — handing this contributor an asset whose bytes are about to
    // disappear would be worse than either deleting or keeping.
    await suite!.client`
      UPDATE capture_media_objects SET storage_state = 'deleting' WHERE content_hash = ${hash('a')}
    `;
    const session = await openSession('user-e');
    const { body } = await call<CaptureUploadTicket>(
      `/captures/sessions/${session.id}/assets`,
      json('user-e', photoBody('a')),
    );
    expect(body.asset.state).toBe('uploaded');
    const [row] = await suite!.client<{ storage_state: string }[]>`
      SELECT storage_state FROM capture_media_objects WHERE content_hash = ${hash('a')}
    `;
    expect(row?.storage_state).toBe('stored');
  });

  it('gives the second contributor their own full retention window', async () => {
    // A photo contributed on day 89 of somebody else's window must not die
    // tomorrow — the contributor was told a policy, and it has to apply to them.
    const session = await openSession('user-c');
    const { body } = await call<CaptureUploadTicket>(
      `/captures/sessions/${session.id}/assets`,
      json('user-c', photoBody('a')),
    );
    const days = (Date.parse(body.asset.media.lifecycle.expiresAt) - Date.now()) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThan(policy.retentionDays.raw_photo - 1);
    // And it is NOT counted as a rescue extension: that budget exists for
    // GoWay keeping something past policy, not for a contributor getting theirs.
    expect(body.asset.media.lifecycle.extensionCount).toBe(0);
  });
});

describe('video is treated as a derivation source, not an archive', () => {
  it('gives a video a shorter window and an early deletion eligibility', async () => {
    const session = await openSession('user-a');
    const { status, body } = await call<CaptureUploadTicket>(
      `/captures/sessions/${session.id}/assets`,
      json(
        'user-a',
        photoBody('9', {
          mediaKind: 'video',
          contentType: 'video/mp4',
          byteSize: 80_000_000,
          camera: { widthPixels: 1920, heightPixels: 1080, durationSeconds: 42, frameRate: 30 },
        }),
      ),
    );
    expect(status).toBe(201);

    const { lifecycle } = body.asset.media;
    expect(lifecycle.retentionClass).toBe('raw_video');
    // It says out loud that it exists to produce something smaller.
    expect(lifecycle.retentionReason).toBe('derivation_source');
    expect(Date.parse(lifecycle.expiresAt)).toBeLessThan(
      Date.now() + policy.retentionDays.raw_photo * 24 * 60 * 60 * 1000,
    );
    // Eligible for deletion well before it expires: keyframes replace it, and
    // that early deletion is most of #10's saving.
    expect(lifecycle.deletionEligibleAt).toBeDefined();
    expect(Date.parse(lifecycle.deletionEligibleAt as string)).toBeLessThan(Date.parse(lifecycle.expiresAt));
  });
});

describe('what a contribution is refused for', () => {
  let session: CaptureSession;

  beforeAll(async () => {
    session = await openSession('user-a');
  });

  it('refuses media with no geographic anchor at all', async () => {
    const body = photoBody('b') as Record<string, unknown>;
    delete body.location;
    const { status } = await call<ApiErrorBody>(`/captures/sessions/${session.id}/assets`, json('user-a', body));
    // No `location` at all is a malformed body; the anchor refusal below is for
    // a well-formed one whose values GoWay cannot use.
    expect(status).toBe(400);
  });

  it('refuses a format GoWay cannot read, distinctly from a file that is too big', async () => {
    const wrongType = await call<ApiErrorBody>(
      `/captures/sessions/${session.id}/assets`,
      json('user-a', photoBody('c', { contentType: 'image/gif' })),
    );
    expect(wrongType.status).toBe(422);
    expect(wrongType.body.error.code).toBe('validation_failed');

    const tooBig = await call<ApiErrorBody>(
      `/captures/sessions/${session.id}/assets`,
      json('user-a', photoBody('d', { byteSize: policy.photo.maxByteSize + 1 })),
    );
    // A different code, because it is different advice: "send a smaller file"
    // rather than "GoWay cannot read this at all".
    expect(tooBig.status).toBe(413);
    expect(tooBig.body.error.code).toBe('payload_too_large');
  });

  it('refuses a client claiming GoWay measured the position itself', async () => {
    // There is no field for it. A body that could claim `goway_ingest` would be
    // a client laundering its own coordinate into a measurement GoWay never made.
    const { body } = await call<CaptureUploadTicket>(
      `/captures/sessions/${session.id}/assets`,
      json(
        'user-a',
        photoBody('e', {
          location: [{ origin: 'device_capture', witness: 'goway_ingest', coordinate: CATALUNYA }],
        }),
      ),
    );
    expect(body.asset.anchor.witness).toBe('client');
  });

  it('normalizes EXIF GPS rather than making each client get it right', async () => {
    const { status, body } = await call<CaptureUploadTicket>(
      `/captures/sessions/${session.id}/assets`,
      json(
        'user-a',
        photoBody('f', {
          location: [
            {
              origin: 'media_metadata',
              exifGps: {
                latitude: { degrees: 41, minutes: 23, seconds: 6.36, ref: 'N' },
                longitude: { degrees: 2, minutes: 10, seconds: 24.24, ref: 'E' },
              },
            },
          ],
        }),
      ),
    );
    expect(status).toBe(201);
    expect(body.asset.anchor.coordinate.latitude).toBeCloseTo(41.3851, 4);
    expect(body.asset.anchor.coordinate.longitude).toBeCloseTo(2.1734, 4);
  });

  it('refuses EXIF whose magnitudes have been swapped', async () => {
    const { status } = await call<ApiErrorBody>(
      `/captures/sessions/${session.id}/assets`,
      json(
        'user-a',
        photoBody('g', {
          location: [
            {
              origin: 'media_metadata',
              exifGps: {
                latitude: { degrees: 2, minutes: 10, ref: 'E' },
                longitude: { degrees: 41, minutes: 23, ref: 'N' },
              },
            },
          ],
        }),
      ),
    );
    expect(status).toBe(422);
  });

  it('refuses to attach a contribution to somebody else’s session', async () => {
    const { status } = await call<ApiErrorBody>(
      `/captures/sessions/${session.id}/assets`,
      json('user-b', photoBody('h')),
    );
    expect(status).toBe(404);
  });
});

describe('contributor-facing history, and storage reporting', () => {
  it('lists a session’s contributions with their state, gate and expiry', async () => {
    // Contribution OBJECTS, scoped to one session — deliberately not a feed of
    // every capture the account ever made ordered by time, which is a travel
    // timeline and is the thing #13 forbids building.
    const session = await openSession('user-d');
    await call<CaptureUploadTicket>(`/captures/sessions/${session.id}/assets`, json('user-d', photoBody('k')));

    const listed = await call<CaptureAsset[]>(`/captures/sessions/${session.id}/assets`, asUser('user-d'));
    expect(listed.status).toBe(200);
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0]?.reconstructionEligible).toBe(false);
    expect(listed.body[0]?.media.lifecycle.expiresAt).toBeDefined();

    const reread = await call<CaptureSession>(`/captures/sessions/${session.id}`, asUser('user-d'));
    expect(reread.body.assetCount).toBe(1);

    const strangers = await call<ApiErrorBody>(`/captures/sessions/${session.id}/assets`, asUser('user-b'));
    expect(strangers.status).toBe(404);
  });

  it('reports bytes by retention class, including the bytes deduplication avoided', async () => {
    // The cost KPI #10 actually asks for. Computed from the rows rather than
    // from maintained counters, so it cannot drift away from what is stored.
    const usage = await summarizeCaptureStorage(getDb());
    const byClass = new Map(usage.map((entry) => [entry.retentionClass, entry]));

    // Every class is present, including empty ones: an omitted class reads as
    // "no data" rather than "no bytes".
    expect(usage).toHaveLength(5);
    expect(byClass.get('thumbnail')?.storedBytes).toBe(0);

    const photos = byClass.get('raw_photo');
    expect(photos?.storedBytes).toBeGreaterThan(0);
    expect(photos?.expiringWithin30dBytes).toBe(0);
    // Four contributions of one photo cost one object, so three copies' worth
    // of bytes were never paid for.
    expect(photos?.deduplicatedBytes).toBe(3 * 2_048_000);

    expect(byClass.get('raw_video')?.storedBytes).toBe(80_000_000);
    // Video expires inside thirty days by policy; this is the number that makes
    // "what is about to disappear" answerable without scanning the bucket.
    expect(byClass.get('raw_video')?.expiringWithin30dBytes).toBe(80_000_000);
  });

  it('narrows storage to a geographic bucket, which is what a per-cell budget caps', async () => {
    const barcelona = await summarizeCaptureStorage(getDb(), { scopeKeyPrefix: 'sp3e' });
    const elsewhere = await summarizeCaptureStorage(getDb(), { scopeKeyPrefix: 'u09t' });
    const bytesIn = (usage: Awaited<ReturnType<typeof summarizeCaptureStorage>>) =>
      usage.reduce((total, entry) => total + entry.storedBytes, 0);
    expect(bytesIn(barcelona)).toBeGreaterThan(0);
    expect(bytesIn(elsewhere)).toBe(0);
  });
});

describe('a deployment with no object store', () => {
  it('still serves the policy, and refuses an upload intent in a way a client can act on', async () => {
    const app = express();
    app.use(express.json());
    const api = express.Router();
    api.use(createCaptureRouter({ optionalAuth, requireAuth, objectStore: null }));
    app.use('/api/v1', api);
    app.use(notFoundHandler);
    app.use(errorHandler);
    const unconfigured = app.listen(0);
    await new Promise<void>((resolve) => unconfigured.once('listening', resolve));
    const base = `http://127.0.0.1:${(unconfigured.address() as AddressInfo).port}/api/v1`;

    try {
      const policyResponse = await fetch(`${base}/captures/policy`);
      expect(policyResponse.status).toBe(200);

      const session = await fetch(`${base}/captures/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-user': 'user-a' },
        body: JSON.stringify({ source: 'camera', consentVersion: policy.consentVersion }),
      });
      const created = (await session.json()) as CaptureSession;

      const attempt = await fetch(`${base}/captures/sessions/${created.id}/assets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-user': 'user-a' },
        body: JSON.stringify(photoBody('z')),
      });
      expect(attempt.status).toBe(503);
      expect(((await attempt.json()) as ApiErrorBody).error.code).toBe('service_unavailable');
    } finally {
      await new Promise<void>((resolve) => unconfigured.close(() => resolve()));
    }
  });
});
