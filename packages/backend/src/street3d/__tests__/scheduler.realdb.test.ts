/**
 * The Street 3D scheduler against real PostGIS, with every AWS adapter faked.
 *
 * The external worker is a script (`FakeWorker`) that speaks only the contract:
 * it reads envelopes off the fake jobs queue, writes outputs to the fake
 * temporary bucket and posts events. Everything between — scheduling, leases,
 * idempotency, publication, moderation, coverage and cleanup — is the real code
 * against a real database, which is where the invariants live (partial unique
 * indexes, generated eligibility, CHECKs).
 *
 * This suite does not skip. See `db/__tests__/testDatabase.ts`.
 */

import '../../__tests__/testEnv';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { sweepExpiredCaptures } from '../../capture/cleanup';
import { parseStreet3dConfig } from '../../config/street3d';
import { createCaptureSession, finalizeAsset, findOwnedAsset, registerAsset, withdrawCaptureAsset } from '../../db/capture/captureRepository';
import {
  captureAssets,
  captureDerivatives,
  captureMediaObjects,
  street3dCaptureEdges,
  street3dCoverageAreas,
  street3dJobs,
  street3dSceneInputs,
  street3dSceneVersions,
  street3dScenes,
} from '../../db/schema';
import { findCoverage, findPublishedManifest } from '../../db/street3d/public';
import { loadEligibleFrames } from '../../db/street3d/scenes';
import {
  createSuiteDatabase,
  destroySuiteDatabase,
  SUITE_SETUP_TIMEOUT_MS,
  type SuiteDatabase,
} from '../../db/__tests__/testDatabase';
import { adminBlockCapture, adminDisableVersion, adminEnableVersion, adminRequeueJob, adminStatus } from '../admin';
import { tick, type TickSummary } from '../scheduler';
import {
  sceneInputManifestSchema,
  type CapturePrivacyJob,
  type SceneInputManifest,
  type SceneReconstructJob,
} from '../workerContract';
import { fakeServices, FakeWorker, type FakeServices } from './fakes';

const config = parseStreet3dConfig({
  STREET3D_MIN_ELIGIBLE_FRAMES: '4',
  STREET3D_MIN_HEADING_SECTORS: '1',
  STREET3D_REBUILD_MIN_NEW_FRAMES: '2',
  STREET3D_SUPERSEDE_MIN_NEW_FRAMES: '3',
  STREET3D_GATE_MIN_REGISTERED_FRAMES: '2',
  STREET3D_PUBLIC_ASSET_BASE_URL: 'https://cdn.example.test/street3d',
  STREET3D_EVENT_WAIT_SECONDS: '0',
});

/** Rue du Faubourg Saint-Honoré — near the contract fixture's anchor. */
const PARIS = { latitude: 48.8684, longitude: 2.302 };
const OPEN_CREDIT = 'Imagery © Example contributors, CC BY-SA 4.0';
const hash = (seed: string) => createHash('sha256').update(seed).digest('hex');

let suite: SuiteDatabase | null = null;
let services: FakeServices;
let worker: FakeWorker;

const db = () => suite!.db;

async function run(now = new Date()): Promise<TickSummary> {
  const summary = await tick({ db: db(), services, config, now: () => now });
  expect(summary.failedPhases).toEqual([]);
  return summary;
}

interface Contribution {
  assetId: string;
  objectKey: string;
  owner: string;
  sessionId: string;
  contentHash: string;
}

async function contribute(
  options: { offsetMeters?: number; heading?: number; seed?: string; attribution?: string; owner?: string } = {},
): Promise<Contribution> {
  const owner = options.owner ?? randomUUID();
  const session = await createCaptureSession(db(), owner, {
    source: 'camera',
    consentVersion: 'test',
    ...(options.attribution ? { attribution: options.attribution } : {}),
  });
  const contentHash = hash(options.seed ?? randomUUID());
  // ~1 m of latitude is 1/111 000 of a degree.
  const coordinate = { latitude: PARIS.latitude + (options.offsetMeters ?? 0) / 111_000, longitude: PARIS.longitude };
  const registered = await registerAsset(
    db(),
    { id: session.id, oxyUserId: owner },
    {
      mediaKind: 'photo',
      source: 'camera',
      contentHash,
      byteSize: 100,
      contentType: 'image/jpeg',
      evidence: [
        {
          origin: 'device_capture',
          witness: 'client',
          coordinate,
          accuracyMeters: 5,
          ...(options.heading !== undefined ? { headingDegrees: options.heading } : {}),
        },
      ],
    },
    { keyPrefix: 'captures' },
  );
  await finalizeAsset(db(), registered.asset.id, owner, { byteSize: 100 });
  return { assetId: registered.asset.id, objectKey: registered.objectKey, owner, sessionId: session.id, contentHash };
}

/** Tick, let the worker clear every privacy job, tick again to apply. */
async function clearPrivacy(framesPerAsset = 2): Promise<void> {
  await run();
  for (const { envelope } of await worker.take()) {
    if (envelope.jobType === 'capture_privacy') await worker.completePrivacy(envelope, { frames: framesPerAsset });
  }
  await run();
}

async function sceneJobs(): Promise<{ envelope: SceneReconstructJob; manifest: SceneInputManifest; attempt: number }[]> {
  return (await worker.take()).flatMap(({ envelope, attempt }) => {
    if (envelope.jobType !== 'scene_reconstruct') return [];
    const manifest = sceneInputManifestSchema.parse(services.jobStore.json(envelope.inputManifestKey));
    return [{ envelope, manifest, attempt }];
  });
}

async function jobRow(id: string) {
  const [row] = await db().select().from(street3dJobs).where(eq(street3dJobs.id, id));
  return row!;
}

/** Contribute `count` neighbouring captures and process their privacy passes. */
async function neighbourhood(count: number, framesPerAsset = 2): Promise<Contribution[]> {
  const contributions: Contribution[] = [];
  for (let index = 0; index < count; index += 1) {
    // The first is an imported open-licence capture; its credit must reach the manifest.
    contributions.push(await contribute({ offsetMeters: index * 5, ...(index === 0 ? { attribution: OPEN_CREDIT } : {}) }));
  }
  await clearPrivacy(framesPerAsset);
  return contributions;
}

/** Contribute, clear privacy, and complete the first reconstruction successfully. */
async function publishedScene(count = 2) {
  const contributions = await neighbourhood(count);
  const [job] = await sceneJobs();
  if (!job) throw new Error('no scene job');
  await worker.post(worker.completedEvent(job.envelope, 1, worker.sceneResult(job.envelope, job.manifest)));
  await run();
  return { contributions, job };
}

beforeAll(async () => {
  suite = await createSuiteDatabase();
}, SUITE_SETUP_TIMEOUT_MS);
afterAll(async () => {
  await destroySuiteDatabase(suite);
});
beforeEach(async () => {
  await db().execute(sql`truncate table
    ${street3dCoverageAreas}, ${street3dCaptureEdges}, ${street3dSceneInputs}, ${street3dSceneVersions},
    ${captureDerivatives}, ${street3dJobs}, ${street3dScenes}, ${captureAssets}, ${captureMediaObjects}
    restart identity cascade`);
  services = fakeServices();
  worker = new FakeWorker(services);
});

describe('privacy scheduling', () => {
  it('queues a privacy pass with bounded protection, and opens the gate on a passed verdict', async () => {
    const capture = await contribute();
    const summary = await run();
    expect(summary.privacy).toMatchObject({ queued: 1 });
    expect(summary.dispatch).toMatchObject({ sent: 1 });

    const [sent] = services.jobsQueue.envelopes();
    const envelope = sent!.envelope as CapturePrivacyJob;
    expect(sent!.attempt).toBe(1);
    expect(envelope).toMatchObject({ jobType: 'capture_privacy', assetId: capture.assetId, input: { key: capture.objectKey, sha256: capture.contentHash } });
    expect(envelope.outputPrefix).toBe(`derived/privacy/${capture.assetId}/${envelope.jobId}/`);

    const [object] = await db().select().from(captureMediaObjects).where(eq(captureMediaObjects.objectKey, capture.objectKey));
    expect(object?.protectedUntil).not.toBeNull();
    expect(object!.protectedUntil!.getTime()).toBeLessThanOrEqual(object!.expiresAt.getTime());
    expect((await findOwnedAsset(db(), capture.assetId, capture.owner))?.privacy.state).toBe('in_progress');

    // Nothing is queued twice while the job is open.
    expect((await run()).privacy).toMatchObject({ queued: 0 });

    await worker.take();
    await worker.completePrivacy(envelope, { frames: 3 });
    await run();
    const asset = await findOwnedAsset(db(), capture.assetId, capture.owner);
    expect(asset).toMatchObject({ state: 'waiting_for_overlap', reconstructionEligible: true, privacy: { state: 'passed', pipelineVersion: 'goway-privacy/1' } });
    const derivatives = await db().select().from(captureDerivatives).where(eq(captureDerivatives.assetId, capture.assetId));
    expect(derivatives).toHaveLength(3);
    expect(derivatives.every((row) => row.retentionClass === 'privacy_safe_proxy' && row.objectKey.startsWith('derived/'))).toBe(true);
    const [after] = await db().select().from(captureMediaObjects).where(eq(captureMediaObjects.objectKey, capture.objectKey));
    expect(after?.protectedUntil).toBeNull();
    expect(after?.retentionReason).toBe('audit_window');
    const audit = after!.deletionEligibleAt!.getTime() - Date.now();
    expect(audit).toBeGreaterThan(2.9 * 86_400_000);
    expect(audit).toBeLessThan(3.1 * 86_400_000);
  });

  it('applies a duplicated event once and deletes unparseable events', async () => {
    const capture = await contribute();
    await run();
    const [{ envelope }] = await worker.take();
    const completed = await worker.completePrivacy(envelope as CapturePrivacyJob, { frames: 2 });
    await worker.post(completed);
    await worker.post('{"not":"the contract"}');
    await worker.post('not json at all');
    const summary = await run();
    expect(summary.events).toMatchObject({ received: 4, outcomes: { applied: 1, duplicate: 1, invalid: 2 }, deferred: 0 });
    expect(services.eventsQueue.inFlight.size).toBe(0);
    expect(await db().select().from(captureDerivatives).where(eq(captureDerivatives.assetId, capture.assetId))).toHaveLength(2);
  });

  it('fails closed on a failed verdict and rejects after bounded attempts', async () => {
    const capture = await contribute();
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await run();
      const taken = await worker.take();
      expect(taken).toHaveLength(1);
      await worker.completePrivacy(taken[0]!.envelope as CapturePrivacyJob, { verdict: 'failed' });
      await run();
    }
    const asset = await findOwnedAsset(db(), capture.assetId, capture.owner);
    expect(asset).toMatchObject({ state: 'rejected', reconstructionEligible: false, privacy: { state: 'failed' } });
    expect((await run()).privacy).toMatchObject({ queued: 0 });
  });

  it('refuses a result that fails its digest, as a retried attempt', async () => {
    await contribute();
    await run();
    const [{ envelope }] = await worker.take();
    const completed = await worker.completePrivacy(envelope as CapturePrivacyJob, { frames: 1 });
    // Tamper with the stored result after the event was posted.
    if (completed.type !== 'completed') throw new Error('unexpected');
    services.jobStore.put(completed.result.key, '{"tampered":true}');
    const summary = await run();
    expect(summary.events?.outcomes).toMatchObject({ rejected: 1 });
    const job = await jobRow(envelope.jobId);
    expect(job).toMatchObject({ state: 'retry_wait', attempt: 2, failureCode: 'result_digest' });
  });
});

describe('leases', () => {
  it('requeues a job whose heartbeat went stale, same jobId with attempt + 1', async () => {
    await contribute();
    await run();
    const [{ envelope }] = await worker.take();
    await worker.heartbeat(envelope, 1, 'privacy');
    await run();
    expect(await jobRow(envelope.jobId)).toMatchObject({ state: 'privacy', workerId: 'w-test' });

    const later = new Date(Date.now() + (config.heartbeatStaleSeconds + 60) * 1000);
    const summary = await run(later);
    expect(summary.leases).toMatchObject({ stale: 1, retried: 1 });
    expect(await jobRow(envelope.jobId)).toMatchObject({ state: 'retry_wait', attempt: 2, failureCode: 'lease_expired' });

    const afterBackoff = new Date(later.getTime() + 61_000);
    expect((await run(afterBackoff)).dispatch).toMatchObject({ sent: 1 });
    const resent = services.jobsQueue.envelopes().at(-1)!;
    expect(resent.envelope.jobId).toBe(envelope.jobId);
    expect(resent.attempt).toBe(2);
  });

  it('fails a job whose envelope was dead-lettered and is not heartbeating', async () => {
    const capture = await contribute();
    await run();
    const [{ envelope }] = await worker.take();
    await services.deadLetterQueue.send(JSON.stringify(envelope));
    const summary = await run();
    expect(summary.deadLetters).toMatchObject({ received: 1, failed: 1 });
    expect(await jobRow(envelope.jobId)).toMatchObject({ state: 'failed', failureCode: 'dead_lettered' });
    // The gate failed, so the same tick's privacy phase gave it its next bounded attempt.
    const attempts = await db().select().from(street3dJobs).where(eq(street3dJobs.assetId, capture.assetId));
    expect(attempts.map((row) => row.state).sort()).toEqual(['failed', 'queued']);
  });
});

describe('scene formation and reconstruction', () => {
  it('waits for overlap alone, then queues one scene job with a contract manifest', async () => {
    const lonely = await contribute();
    await clearPrivacy(4);
    expect(await sceneJobs()).toHaveLength(0);
    expect((await findOwnedAsset(db(), lonely.assetId, lonely.owner))?.state).toBe('waiting_for_overlap');

    const neighbour = await contribute({ offsetMeters: 20, attribution: 'Imagery © Example, CC BY-SA 4.0' });
    await clearPrivacy(2);
    const jobs = await sceneJobs();
    expect(jobs).toHaveLength(1);
    const { envelope, manifest } = jobs[0]!;
    expect(manifest.frames).toHaveLength(6);
    expect(createHash('sha256').update(services.jobStore.objects.get(envelope.inputManifestKey)!).digest('hex')).toBe(envelope.inputManifestSha256);
    const text = JSON.stringify(manifest);
    for (const secret of [lonely.owner, neighbour.owner, lonely.sessionId, neighbour.sessionId, lonely.objectKey]) {
      expect(text).not.toContain(secret);
    }
    expect(new Set(manifest.frames.map((frame) => frame.sequenceGroup)).size).toBe(2);
    expect(manifest.budgets).toEqual(config.budgets.draft);
    expect(manifest.gates).toEqual(config.gates);
    expect((await findOwnedAsset(db(), neighbour.assetId, neighbour.owner))?.state).toBe('reconstruction_candidate');

    // Never enqueued twice while open.
    await run();
    expect(await sceneJobs()).toHaveLength(0);
  });

  it('marks insufficient overlap as needs_more_capture and waits for new input', async () => {
    const contributions = await neighbourhood(2);
    const [job] = await sceneJobs();
    await worker.fail(job!.envelope, 'insufficient_overlap');
    await run();
    const [scene] = await db().select().from(street3dScenes);
    expect(scene?.state).toBe('needs_more_capture');
    expect(await jobRow(job!.envelope.jobId)).toMatchObject({ state: 'failed', failureCode: 'insufficient_overlap' });
    expect((await findOwnedAsset(db(), contributions[0]!.assetId, contributions[0]!.owner))?.state).toBe('waiting_for_overlap');
    // The sanitized detail carries no path or URL.
    expect((await jobRow(job!.envelope.jobId)).failureDetail).not.toMatch(/\/tmp|https?:/);

    await run();
    expect(await sceneJobs()).toHaveLength(0);

    await contribute({ offsetMeters: 10 });
    await clearPrivacy(2);
    const [next] = await sceneJobs();
    expect(next?.envelope.sceneVersion).toBe(2);
    expect(next?.manifest.frames).toHaveLength(6);
  });

  it('publishes a validated result into the scene bucket and integrates registered captures', async () => {
    const contributions = await neighbourhood(2);
    const [job] = await sceneJobs();
    const unregistered = job!.manifest.frames.at(-1)!.frameId;
    const registered = job!.manifest.frames.slice(0, -1).map((frame) => frame.frameId);
    await worker.post(worker.completedEvent(job!.envelope, 1, worker.sceneResult(job!.envelope, job!.manifest, { registered })));
    const summary = await run();
    expect(summary.events?.outcomes).toMatchObject({ published: 1 });

    const manifest = await findPublishedManifest(db(), job!.envelope.sceneId);
    expect(manifest).toMatchObject({ id: job!.envelope.sceneId, version: 1, quality: { placement: 'precise', profile: 'draft' } });
    expect(manifest!.attributions).toEqual([OPEN_CREDIT]);
    expect(manifest!.privacyPipelineVersions).toEqual(['goway-privacy/1']);
    expect(manifest!.assets).toHaveLength(3);
    // Decimated to 1.5 m, rounded, unit-length and sorted: not the walk's order.
    expect(manifest!.navigation).toEqual({
      viewpoints: [0, 1.5, 3, 4.5, 6, 7.5, 9].map((y) => ({ position: [0, y, 1.6], forward: [0, -1, 0] })),
      fieldOfView: { horizontalDegrees: 66, verticalDegrees: 50 },
    });
    for (const asset of manifest!.assets) {
      expect(asset.url).toMatch(new RegExp(`^https://cdn\\.example\\.test/street3d/scenes/${job!.envelope.sceneId}/v1/${asset.sha256}\\.(spz|jpg)$`));
      expect(Object.keys(asset)).not.toContain('key');
    }
    expect(services.sceneStore.copies).toHaveLength(3);
    const text = JSON.stringify(manifest);
    for (const contribution of contributions) {
      expect(text).not.toContain(contribution.assetId);
      expect(text).not.toContain(contribution.owner);
    }
    expect(text).not.toContain('jobs/');

    const states = await db().select({ id: captureAssets.id, state: captureAssets.state }).from(captureAssets);
    expect(states.every((row) => row.state === 'integrated')).toBe(true);
    const inputs = await db().select().from(street3dSceneInputs);
    expect(inputs).toHaveLength(4);
    expect(inputs.find((row) => row.derivativeId === unregistered)?.registered).toBe(false);
    const edges = await db().select().from(street3dCaptureEdges);
    expect(edges).toHaveLength(1);
    expect(edges[0]!.derivativeA < edges[0]!.derivativeB).toBe(true);
    expect((await jobRow(job!.envelope.jobId)).metrics).toMatchObject({ gpuSeconds: 600 });

    // A duplicate completion changes nothing.
    services.sceneStore.copies.length = 0;
    expect((await run()).events?.received).toBe(0);
  });

  it('keeps the previous version when a newer one fails quality, and supersedes on success', async () => {
    const { job: first } = await publishedScene();
    await contribute({ offsetMeters: 10 });
    await clearPrivacy(2);
    const [second] = await sceneJobs();
    expect(second?.envelope.sceneVersion).toBe(2);
    await worker.post(worker.completedEvent(second!.envelope, 1, worker.sceneResult(second!.envelope, second!.manifest, { psnr: 9 })));
    expect((await run()).events?.outcomes).toMatchObject({ failed_quality: 1 });
    expect((await findPublishedManifest(db(), first.envelope.sceneId))?.version).toBe(1);
    const [failed] = await db().select().from(street3dSceneVersions).where(eq(street3dSceneVersions.version, 2));
    expect(failed).toMatchObject({ state: 'failed_quality' });
    expect(failed?.gateFailures).toContain('held_out_psnr');

    await contribute({ offsetMeters: 12 });
    await contribute({ offsetMeters: 14 });
    await clearPrivacy(2);
    const [third] = await sceneJobs();
    await worker.post(worker.completedEvent(third!.envelope, 1, worker.sceneResult(third!.envelope, third!.manifest)));
    await run();
    expect((await findPublishedManifest(db(), first.envelope.sceneId))?.version).toBe(3);
    const versions = await db().select({ version: street3dSceneVersions.version, state: street3dSceneVersions.state }).from(street3dSceneVersions);
    expect(versions.sort((a, b) => a.version - b.version).map((row) => row.state)).toEqual(['superseded', 'failed_quality', 'published']);
  });

  it('refuses a result that names another manifest, and one whose assets are missing', async () => {
    await neighbourhood(2);
    const [job] = await sceneJobs();
    const wrong = worker.sceneResult(job!.envelope, job!.manifest);
    wrong.inputManifestSha256 = 'f'.repeat(64);
    await worker.post(worker.completedEvent(job!.envelope, 1, wrong));
    expect((await run()).events?.outcomes).toMatchObject({ rejected: 1 });
    expect(await jobRow(job!.envelope.jobId)).toMatchObject({ state: 'retry_wait', attempt: 2, failureCode: 'result_mismatch' });

    const missing = worker.sceneResult(job!.envelope, job!.manifest, { attempt: 2 });
    services.jobStore.objects.delete(`jobs/${job!.envelope.jobId}/attempt-2/scene.spz`);
    await worker.post(worker.completedEvent(job!.envelope, 2, missing));
    expect((await run()).events?.outcomes).toMatchObject({ rejected: 1 });
    expect(await findPublishedManifest(db(), job!.envelope.sceneId)).toBeNull();
    expect(services.sceneStore.copies).toHaveLength(0);
  });

  it('supersedes a job still waiting for the worker when the input set grew a lot', async () => {
    await neighbourhood(2);
    const [first] = await sceneJobs();
    for (let index = 0; index < 2; index += 1) await contribute({ offsetMeters: 8 + index });
    await clearPrivacy(2);
    const [second] = await sceneJobs();
    expect(second?.envelope.sceneVersion).toBe(2);
    expect(await jobRow(first!.envelope.jobId)).toMatchObject({ state: 'cancelled', cancelReason: 'superseded', supersededByJobId: second!.envelope.jobId });
    await run();
    expect(services.jobStore.objects.has(`jobs/${first!.envelope.jobId}/cancel`)).toBe(true);
  });
});

describe('withdrawal and moderation', () => {
  it('cancels open jobs on withdrawal and keeps the published version until a rebuild', async () => {
    const { contributions, job } = await publishedScene(3);
    await contribute({ offsetMeters: 4 });
    await contribute({ offsetMeters: 6 });
    await clearPrivacy(2);
    const [rebuild] = await sceneJobs();
    expect(rebuild).toBeDefined();

    const withdrawn = contributions[0]!;
    await withdrawCaptureAsset(db(), withdrawn.assetId, withdrawn.owner);
    expect(await jobRow(rebuild!.envelope.jobId)).toMatchObject({ state: 'cancelled', cancelReason: 'source_withdrawn' });
    const derivatives = await db().select().from(captureDerivatives).where(eq(captureDerivatives.assetId, withdrawn.assetId));
    expect(derivatives.every((row) => row.deletionRequestedReason === 'contributor_request')).toBe(true);
    // Derived-data policy: the published version stays until the rebuild replaces it.
    expect((await findPublishedManifest(db(), job.envelope.sceneId))?.version).toBe(1);

    await run();
    expect(services.jobStore.objects.has(`jobs/${rebuild!.envelope.jobId}/cancel`)).toBe(true);
    const [next] = await sceneJobs();
    expect(next?.manifest.frames.some((frame) => frame.captureAssetId === withdrawn.assetId)).toBe(false);
  });

  it('blocks a capture permanently: disables versions, purges assets, and never re-admits its bytes', async () => {
    const { contributions, job } = await publishedScene(3);
    const blocked = contributions[1]!;
    const result = await adminBlockCapture({ db: db(), services, config }, blocked.assetId, 'faces visible in reflection');
    expect(result).toMatchObject({ blocked: true, disabledVersions: 1, purged: 1 });
    expect(await findPublishedManifest(db(), job.envelope.sceneId)).toBeNull();
    expect(services.sceneStore.objects.size).toBe(0);
    expect(services.cdn.invalidations[0]?.paths).toEqual([`/street3d/scenes/${job.envelope.sceneId}/v1/*`]);

    // Its frames can never be selected again.
    const frames = await loadEligibleFrames(db(), new Date());
    expect(frames.some((frame) => frame.assetId === blocked.assetId)).toBe(false);

    await run();
    const [rebuild] = await sceneJobs();
    if (rebuild) {
      expect(rebuild.manifest.frames.some((frame) => frame.captureAssetId === blocked.assetId)).toBe(false);
    }
    // Re-enabling a version with a blocked input is refused.
    const [disabled] = await db().select().from(street3dSceneVersions).where(eq(street3dSceneVersions.state, 'disabled'));
    expect(await adminEnableVersion({ db: db(), services, config }, disabled!.id)).toMatchObject({ enabled: false });
  });

  it('refuses identical bytes under a content-hash block at privacy scheduling', async () => {
    const original = await contribute({ seed: 'same-bytes' });
    await adminBlockCapture({ db: db(), services, config }, original.assetId, 'moderation');
    // The block marked the raw object for removal; tombstone it as cleanup would.
    await sweepExpiredCaptures(db(), { deleteObject: async () => undefined }, { now: () => new Date(Date.now() + 3600_000) });
    const again = await contribute({ seed: 'same-bytes' });
    const summary = await run();
    expect(summary.privacy).toMatchObject({ queued: 0, blocked: 1 });
    expect(await findOwnedAsset(db(), again.assetId, again.owner)).toMatchObject({ state: 'rejected', privacy: { state: 'blocked' } });
  });

  it('hides a disabled version at once, and restores it on enable from the job result', async () => {
    const { job } = await publishedScene();
    const [version] = await db().select().from(street3dSceneVersions);
    expect(await adminDisableVersion({ db: db(), services, config }, version!.id, 'operator check')).toMatchObject({ disabled: true, purged: 1 });
    expect(await findPublishedManifest(db(), job.envelope.sceneId)).toBeNull();
    expect((await findCoverage(db(), { west: 2.2, south: 48.8, east: 2.4, north: 48.9 })).scenes).toHaveLength(0);

    const enabled = await adminEnableVersion({ db: db(), services, config }, version!.id);
    expect(enabled).toMatchObject({ enabled: true, state: 'published', restoredAssets: 3 });
    expect((await findPublishedManifest(db(), job.envelope.sceneId))?.version).toBe(1);
  });

  it('requeues a failed job as a new attempt of the same job', async () => {
    await neighbourhood(2);
    const [job] = await sceneJobs();
    await worker.fail(job!.envelope, 'camera_solve_failed');
    await run();
    expect(await adminRequeueJob({ db: db(), services, config }, job!.envelope.jobId)).toEqual({ outcome: 'requeued' });
    await run();
    const resent = services.jobsQueue.envelopes().at(-1)!;
    expect(resent).toMatchObject({ attempt: 2, envelope: { jobId: job!.envelope.jobId } });
    const status = await adminStatus({ db: db(), services, config });
    expect(status.jobs.some((row) => row.kind === 'scene_reconstruct' && row.state === 'queued')).toBe(true);
    expect(JSON.stringify(status)).not.toMatch(/captures\/|derived\/|jobs\//);
  });
});

describe('coverage and rescue', () => {
  it('publishes coarse areas only, and rescues an at-risk area within bounds', async () => {
    const first = await contribute();
    await clearPrivacy(1);
    // Offsets stay inside one ~150 m coverage cell.
    const second = await contribute({ offsetMeters: 5 });
    await clearPrivacy(1);
    // Two captures, two frames: a scene candidate that cannot be reconstructed yet.
    const coverage = await findCoverage(db(), { west: 2.2, south: 48.8, east: 2.4, north: 48.9 });
    expect(coverage.areas).toHaveLength(1);
    const [area] = coverage.areas;
    expect(area).toMatchObject({ state: 'partial', contributionBand: '1-4' });
    expect(area!.id).toMatch(/^area-[0-9a-f]{20}$/);
    expect(area!.center.latitude).not.toBe(PARIS.latitude);
    expect(JSON.stringify(coverage)).not.toContain(first.assetId);

    // Make the inputs expire soon: the area becomes at risk.
    const soon = new Date(Date.now() + 5 * 86_400_000);
    await db().update(captureDerivatives).set({ expiresAt: soon });
    await run();
    const [atRisk] = (await findCoverage(db(), { west: 2.2, south: 48.8, east: 2.4, north: 48.9 })).areas;
    expect(atRisk).toMatchObject({ state: 'at_risk', atRiskUntil: soon.toISOString() });

    // A new contribution arrives: one bounded rescue.
    await contribute({ offsetMeters: 8 });
    await clearPrivacy(1);
    const rescued = await db().select().from(captureDerivatives).where(eq(captureDerivatives.assetId, second.assetId));
    expect(rescued[0]).toMatchObject({ extensionCount: 1, retentionReason: 'rescue_extension' });
    expect(rescued[0]!.expiresAt.getTime()).toBe(soon.getTime() + config.rescueExtensionDays * 86_400_000);

    // Never past the cap: three extensions at most.
    await db().update(captureDerivatives).set({ extensionCount: 3, expiresAt: soon, protectedUntil: null });
    await contribute({ offsetMeters: 10 });
    await clearPrivacy(1);
    const capped = await db().select().from(captureDerivatives).where(eq(captureDerivatives.assetId, second.assetId));
    expect(capped[0]).toMatchObject({ extensionCount: 3 });
    expect(capped[0]!.expiresAt.getTime()).toBe(soon.getTime());
  });
});

describe('cleanup', () => {
  it('retires raw photos replaced by derivatives, expired derivatives and old job artifacts', async () => {
    const capture = await contribute();
    await clearPrivacy(1);
    const later = new Date(Date.now() + 4 * 86_400_000);
    const deleted: string[] = [];
    const summary = await sweepExpiredCaptures(db(), { deleteObject: async (key) => { deleted.push(key); } }, { now: () => later }, services.jobStore);
    expect(summary).toMatchObject({ supersededMarked: 1, deleted: 1, failed: 0 });
    expect(deleted).toEqual([capture.objectKey]);
    const asset = await findOwnedAsset(db(), capture.assetId, capture.owner);
    // Retired by its derivative, NOT expired: the contribution stays eligible.
    expect(asset).toMatchObject({ state: 'waiting_for_overlap', reconstructionEligible: true });
    expect(asset?.media.lifecycle.deletionReason).toBe('superseded_by_derivative');

    // Expired derivatives go too, and the contribution then expires.
    await db().update(captureDerivatives).set({ expiresAt: new Date(Date.now() + 1000), protectedUntil: null });
    const muchLater = new Date(Date.now() + 10 * 86_400_000);
    const second = await sweepExpiredCaptures(db(), { deleteObject: async () => undefined }, { now: () => muchLater }, services.jobStore);
    expect(second).toMatchObject({ derivativesDeleted: 1, derivativesFailed: 0, jobArtifactCandidates: 1 });
    expect(second.jobArtifactObjectsDeleted).toBeGreaterThan(0);
    expect([...services.jobStore.objects.keys()].filter((key) => key.startsWith('derived/') || key.startsWith('jobs/'))).toEqual([]);
    expect((await findOwnedAsset(db(), capture.assetId, capture.owner))?.state).toBe('expired');
  });

  it('never retires a raw object while any live contribution lacks a derivative', async () => {
    const capture = await contribute({ seed: 'shared' });
    await clearPrivacy(1);
    // A second contributor of identical bytes, not yet privacy-processed.
    const owner = randomUUID();
    const session = await createCaptureSession(db(), owner, { source: 'camera', consentVersion: 'test' });
    await registerAsset(db(), { id: session.id, oxyUserId: owner }, {
      mediaKind: 'photo', source: 'camera', contentHash: capture.contentHash, byteSize: 100, contentType: 'image/jpeg',
      evidence: [{ origin: 'user_placed', witness: 'client', coordinate: PARIS }],
    }, { keyPrefix: 'captures' });
    const later = new Date(Date.now() + 4 * 86_400_000);
    const summary = await sweepExpiredCaptures(db(), { deleteObject: async () => { throw new Error('must not delete'); } }, { now: () => later }, services.jobStore);
    expect(summary).toMatchObject({ supersededMarked: 0, candidates: 0 });
  });

  it('dry-runs without touching rows or stores', async () => {
    await contribute();
    await clearPrivacy(1);
    const later = new Date(Date.now() + 4 * 86_400_000);
    const summary = await sweepExpiredCaptures(db(), null, { dryRun: true, now: () => later });
    expect(summary).toMatchObject({ dryRun: true, supersededMarked: 1, deleted: 0, derivativesDeleted: 0 });
    const [object] = await db().select().from(captureMediaObjects).where(and(eq(captureMediaObjects.storageState, 'stored')));
    expect(object?.deletionRequestedAt).toBeNull();
  });
});
