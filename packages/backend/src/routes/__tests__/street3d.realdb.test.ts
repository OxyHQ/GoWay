/**
 * The public Street 3D API over a real socket and a real PostGIS database.
 *
 * Asserted: it is off unless switched on; coverage is coarse and capped; only a
 * served version is ever returned, and returned without internal keys; reports
 * need a session and are idempotent per reporter and version.
 *
 * This suite does not skip. See `db/__tests__/testDatabase.ts`.
 */

import '../../__tests__/testEnv';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import express, { type RequestHandler } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq, sql } from 'drizzle-orm';
import type { StreetCoverage, StreetSceneManifest, StreetSceneReport } from '@goway/shared-types';
import { parseStreet3dConfig } from '../../config/street3d';
import {
  street3dCoverageAreas,
  street3dJobs,
  street3dSceneReports,
  street3dSceneVersions,
  street3dScenes,
} from '../../db/schema';
import { createSuiteDatabase, destroySuiteDatabase, SUITE_SETUP_TIMEOUT_MS, type SuiteDatabase } from '../../db/__tests__/testDatabase';
import { ApiError } from '../../http/apiError';
import { errorHandler, notFoundHandler } from '../../http/errorHandler';
import { createStreet3dRouter } from '../street3d';

let suite: SuiteDatabase | null = null;
const servers: Server[] = [];
let on: string;
let off: string;

const requireAuth: RequestHandler = (request, _response, next) => {
  const user = request.header('x-test-user');
  if (!user) {
    next(new ApiError('unauthorized', 'This request requires an Oxy session.'));
    return;
  }
  request.userId = user;
  next();
};
const passThrough: RequestHandler = (_request, _response, next) => next();

async function listen(viewingEnabled: boolean): Promise<string> {
  const app = express();
  app.use(express.json());
  const config = parseStreet3dConfig({ STREET3D_VIEWING_ENABLED: viewingEnabled ? 'true' : 'false' });
  app.use('/api/v1', createStreet3dRouter({ requireAuth, reportRateLimit: passThrough, config }));
  app.use(notFoundHandler);
  app.use(errorHandler);
  const server = await new Promise<Server>((resolve) => {
    const started = app.listen(0, '127.0.0.1', () => resolve(started));
  });
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
}

const ASSET_KEY = 'scenes/s/v1/' + 'c'.repeat(64) + '.spz';

/** A scene with one version, in the given state, served or not. */
async function scene(state: 'published' | 'failed_quality' | 'disabled' = 'published'): Promise<string> {
  const db = suite!.db;
  const [created] = await db
    .insert(street3dScenes)
    .values({ anchorLatitude: 48.8684, anchorLongitude: 2.302, radiusMeters: 90, state: 'candidate', lastAllocatedVersion: 1 })
    .returning({ id: street3dScenes.id });
  const sceneId = created!.id;
  const [job] = await db
    .insert(street3dJobs)
    .values({
      kind: 'scene_reconstruct', sceneId, sceneVersion: 1, profile: 'draft', state: 'completed', maxAttempts: 4,
      finishedAt: new Date(), inputManifestKey: 'jobs/x/input.json', inputManifestSha256: 'a'.repeat(64), outputPrefix: 'jobs/x/',
    })
    .returning({ id: street3dJobs.id });
  const [version] = await db
    .insert(street3dSceneVersions)
    .values({
      sceneId, version: 1, jobId: job!.id, state, profile: 'draft',
      boundsWest: 2.3008, boundsSouth: 48.8678, boundsEast: 2.3032, boundsNorth: 48.869,
      footprint: { type: 'Polygon', coordinates: [[[2.3008, 48.8678], [2.3032, 48.8678], [2.3032, 48.869], [2.3008, 48.8678]]] },
      worldTransform: { anchor: { latitude: 48.8684, longitude: 2.302, altitudeMeters: 0 }, frame: 'enu', enuFromScene: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
      initialView: { position: [0, 0, 1.6], target: [0, 10, 1.6] },
      assets: [
        { role: 'splat', format: 'spz', url: `https://cdn.example.test/${ASSET_KEY}`, key: ASSET_KEY, byteSize: 10, sha256: 'c'.repeat(64), gaussians: 5 },
        { role: 'poster', format: 'jpeg', url: 'https://cdn.example.test/poster.jpg', key: 'scenes/s/v1/p.jpg', byteSize: 3, sha256: 'd'.repeat(64) },
      ],
      quality: { profile: 'draft', registrationRatio: 1, alignmentResidualMeters: 1.4, heldOutPsnr: 21, placement: 'precise' },
      metrics: { gpuSeconds: 1 },
      provenance: { pipelineVersion: 'p/1', components: {} },
      observedFrom: new Date('2026-09-01T00:00:00Z'), observedTo: new Date('2026-09-02T00:00:00Z'),
      privacyPipelineVersions: ['goway-privacy/1'], attributions: ['Imagery © Example, CC BY-SA 4.0'],
      resultSha256: 'b'.repeat(64),
      ...(state === 'published' ? { publishedAt: new Date() } : {}),
      ...(state === 'disabled' ? { disabledAt: new Date(), disabledReason: 'test' } : {}),
    })
    .returning({ id: street3dSceneVersions.id });
  if (state === 'published') {
    await db.update(street3dScenes).set({ currentVersionId: version!.id, state: 'published' }).where(eq(street3dScenes.id, sceneId));
  }
  return sceneId;
}

beforeAll(async () => {
  suite = await createSuiteDatabase();
  on = await listen(true);
  off = await listen(false);
}, SUITE_SETUP_TIMEOUT_MS);
afterAll(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await destroySuiteDatabase(suite);
});
beforeEach(async () => {
  await suite!.db.execute(sql`truncate table ${street3dCoverageAreas}, ${street3dSceneReports}, ${street3dSceneVersions}, ${street3dJobs}, ${street3dScenes} cascade`);
});

const box = 'west=2.29&south=48.86&east=2.31&north=48.87';

describe('switched off', () => {
  it('answers 503 for coverage and 404 for scenes and reports', async () => {
    const sceneId = await scene();
    expect((await fetch(`${off}/street3d/coverage?${box}`)).status).toBe(503);
    expect((await fetch(`${off}/street3d/scenes/${sceneId}`)).status).toBe(404);
    const report = await fetch(`${off}/street3d/scenes/${sceneId}/reports`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-test-user': 'u-1' }, body: JSON.stringify({ reason: 'privacy' }),
    });
    expect(report.status).toBe(404);
  });
});

describe('coverage', () => {
  it('returns served scenes and coarse areas, and caps the box', async () => {
    const sceneId = await scene();
    await scene('failed_quality');
    await suite!.db.insert(street3dCoverageAreas).values({
      cell: 'u09wh2h', publicId: 'area-0123456789abcdef0123', state: 'at_risk', centerLatitude: 48.8684, centerLongitude: 2.3017,
      boundsWest: 2.3010, boundsSouth: 48.8677, boundsEast: 2.3024, boundsNorth: 48.8691, contributionCount: 7,
      atRiskUntil: new Date('2026-10-20T00:00:00Z'), sceneId,
    });
    const response = await fetch(`${on}/street3d/coverage?${box}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, max-age=60');
    const body = (await response.json()) as StreetCoverage;
    expect(body.scenes.map((entry) => entry.id)).toEqual([sceneId]);
    expect(body.scenes[0]).toMatchObject({ version: 1, placement: 'precise', posterUrl: 'https://cdn.example.test/poster.jpg' });
    expect(body.areas).toEqual([
      {
        id: 'area-0123456789abcdef0123', state: 'at_risk', center: { latitude: 48.8684, longitude: 2.3017 },
        bounds: { west: 2.301, south: 48.8677, east: 2.3024, north: 48.8691 }, contributionBand: '5-19',
        atRiskUntil: '2026-10-20T00:00:00.000Z', sceneId,
      },
    ]);
    expect(JSON.stringify(body)).not.toContain('u09wh2h');
    expect((await fetch(`${on}/street3d/coverage?west=0&south=0&east=10&north=10`)).status).toBe(422);
    expect((await fetch(`${on}/street3d/coverage?west=2&south=49&east=2.1&north=48`)).status).toBe(422);
    // The antimeridian is a wrap, not an inversion.
    expect((await fetch(`${on}/street3d/coverage?west=179.9&south=0&east=-179.9&north=0.1`)).status).toBe(200);
  });
});

describe('scene manifests', () => {
  it('serves only the current published version, without internal keys', async () => {
    const sceneId = await scene();
    const response = await fetch(`${on}/street3d/scenes/${sceneId}`);
    expect(response.status).toBe(200);
    const manifest = (await response.json()) as StreetSceneManifest;
    expect(manifest).toMatchObject({ id: sceneId, version: 1, attributions: ['Imagery © Example, CC BY-SA 4.0'] });
    expect(JSON.stringify(manifest)).not.toContain('"key"');
    expect(manifest.assets.every((asset) => !('key' in asset))).toBe(true);

    expect((await fetch(`${on}/street3d/scenes/${await scene('failed_quality')}`)).status).toBe(404);
    expect((await fetch(`${on}/street3d/scenes/${await scene('disabled')}`)).status).toBe(404);
    expect((await fetch(`${on}/street3d/scenes/does-not-exist`)).status).toBe(404);
  });
});

describe('reports', () => {
  it('needs a session, validates, and is idempotent per reporter and version', async () => {
    const sceneId = await scene();
    const post = (user: string | null, body: unknown) =>
      fetch(`${on}/street3d/scenes/${sceneId}/reports`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': user } : {}) },
        body: JSON.stringify(body),
      });
    expect((await post(null, { reason: 'privacy' })).status).toBe(401);
    expect((await post('u-1', { reason: 'spam' })).status).toBe(422);
    expect((await post('u-1', { reason: 'privacy', note: 'x'.repeat(501) })).status).toBe(422);
    const first = await post('u-1', { reason: 'privacy', note: 'a face is visible' });
    expect(first.status).toBe(201);
    const report = (await first.json()) as StreetSceneReport;
    expect(report).toMatchObject({ sceneId, version: 1, reason: 'privacy' });
    expect(JSON.stringify(report)).not.toContain('u-1');
    const again = await post('u-1', { reason: 'privacy' });
    expect(again.status).toBe(200);
    expect(((await again.json()) as StreetSceneReport).id).toBe(report.id);
    expect((await post('u-2', { reason: 'inaccurate' })).status).toBe(201);
    // No automatic disable.
    expect((await fetch(`${on}/street3d/scenes/${sceneId}`)).status).toBe(200);
  });
});
