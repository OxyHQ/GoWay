import '../../__tests__/testEnv';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import {
  createSuiteDatabase, destroySuiteDatabase, SUITE_SETUP_TIMEOUT_MS, type SuiteDatabase,
} from '../../db/__tests__/testDatabase';
import { captureAssets, captureMediaObjects, captureSessions } from '../../db/schema';
import { claimCaptureCleanup, completeCaptureCleanup } from '../../db/capture/captureCleanupRepository';
import { createCaptureSession, finalizeAsset, findOwnedAsset, registerAsset } from '../../db/capture/captureRepository';
import { sweepExpiredCaptures } from '../cleanup';

let suite: SuiteDatabase | null = null;
const now = new Date();
const daysBefore = (days: number) => new Date(now.getTime() - days * 86400_000);
const later = (seconds: number) => new Date(now.getTime() + seconds * 1000);
const claimOptions = { now, limit: 100, retryAfterSeconds: 300 };
const runOptions = { now: () => now };

async function fixture(stored = true) {
  const db = suite!.db;
  const owner = randomUUID();
  const session = await createCaptureSession(db, owner, { source: 'library', consentVersion: 'test' });
  const input = {
    mediaKind: 'photo' as const, source: 'library' as const,
    contentHash: createHash('sha256').update(randomUUID()).digest('hex'),
    contentType: 'image/jpeg', byteSize: 100,
    evidence: [{ origin: 'user_placed' as const, witness: 'client' as const, coordinate: { latitude: 41, longitude: 2 } }],
  };
  const registration = { id: session.id, oxyUserId: owner };
  const registered = await registerAsset(db, registration, input, { keyPrefix: 'captures' });
  if (stored) await finalizeAsset(db, registered.asset.id, owner, { byteSize: 100 });
  const [object] = await db.update(captureMediaObjects).set({
    createdAt: daysBefore(91), expiresAt: daysBefore(1), uploadIntentExpiresAt: daysBefore(90),
  }).where(eq(captureMediaObjects.objectKey, registered.objectKey)).returning();
  if (!object) throw new Error('Fixture object missing');
  return { ...registered, object, owner, input, registration };
}

beforeAll(async () => { suite = await createSuiteDatabase(); }, SUITE_SETUP_TIMEOUT_MS);
afterAll(async () => { await destroySuiteDatabase(suite); });
beforeEach(async () => {
  // These tables belong to this suite's disposable database only.
  await suite!.db.delete(captureAssets);
  await suite!.db.delete(captureMediaObjects);
  await suite!.db.delete(captureSessions);
});

describe('temporary capture expiry', () => {
  it('deletes shared bytes once, preserves provenance, and closes every reconstruction gate', async () => {
    const f = await fixture();
    const db = suite!.db;
    // A second contribution referencing the same object, then expiry again.
    const second = await registerAsset(db, f.registration, f.input, { keyPrefix: 'captures' });
    await db.update(captureMediaObjects).set({ expiresAt: daysBefore(1) }).where(eq(captureMediaObjects.id, f.object.id));
    await db.update(captureAssets).set({ state: 'integrated', privacyState: 'passed', privacyPipelineVersion: 'test-v1', privacyCompletedAt: now });
    const deleted: string[] = [];
    const result = await sweepExpiredCaptures(db, { deleteObject: async (key) => { deleted.push(key); } }, runOptions);
    expect(deleted).toEqual([f.objectKey]);
    expect(result).toMatchObject({ deleted: 1, failed: 0, deletedDeclaredBytes: 100 });
    for (const id of [f.asset.id, second.asset.id]) {
      const asset = await findOwnedAsset(db, id, f.owner);
      expect(asset?.state).toBe('expired');
      expect(asset?.reconstructionEligible).toBe(false);
      expect(asset?.media.lifecycle.deletionReason).toBe('expired');
      expect(asset?.privacy.pipelineVersion).toBe('test-v1');
    }
    expect((await sweepExpiredCaptures(db, { deleteObject: async () => { throw new Error('must not run'); } }, runOptions)).candidates).toBe(0);
    const replacement = await registerAsset(db, f.registration, f.input, { keyPrefix: 'captures' });
    expect(replacement.uploadRequired).toBe(true);
    expect(replacement.objectKey).not.toBe(f.objectKey);
  });

  it('deletes unfinalized uploads without inventing a stored timestamp', async () => {
    const f = await fixture(false);
    const keys: string[] = [];
    await sweepExpiredCaptures(suite!.db, { deleteObject: async (key) => { keys.push(key); } }, runOptions);
    expect(keys).toEqual([f.objectKey]);
    const [object] = await suite!.db.select().from(captureMediaObjects).where(eq(captureMediaObjects.id, f.object.id));
    expect(object?.storageState).toBe('deleted');
    expect(object?.storedAt).toBeNull();
    expect((await findOwnedAsset(suite!.db, f.asset.id, f.owner))?.state).toBe('abandoned');
  });

  it('does not treat early video eligibility as proof of safely persisted keyframes', async () => {
    const f = await fixture();
    await suite!.db.update(captureMediaObjects).set({
      retentionClass: 'raw_video', retentionReason: 'derivation_source',
      expiresAt: later(86400), deletionEligibleAt: daysBefore(1),
    }).where(eq(captureMediaObjects.id, f.object.id));
    const result = await sweepExpiredCaptures(suite!.db, { deleteObject: async () => { throw new Error('still needed'); } }, runOptions);
    expect(result.candidates).toBe(0);
  });

  it('preserves protected inputs and active upload targets', async () => {
    const protectedInput = await fixture();
    await suite!.db.update(captureMediaObjects).set({ expiresAt: later(86400), protectedUntil: later(3600) })
      .where(eq(captureMediaObjects.id, protectedInput.object.id));
    const uploading = await fixture(false);
    await suite!.db.update(captureMediaObjects).set({ uploadIntentExpiresAt: later(60) })
      .where(eq(captureMediaObjects.id, uploading.object.id));
    const result = await sweepExpiredCaptures(suite!.db, { deleteObject: async () => { throw new Error('must not delete'); } }, runOptions);
    expect(result.candidates).toBe(0);
  });

  it('previews a bounded batch without changing rows or calling a store', async () => {
    const f = await fixture();
    await fixture();
    const result = await sweepExpiredCaptures(suite!.db, null, { ...runOptions, dryRun: true, limit: 1 });
    expect(result).toMatchObject({ dryRun: true, candidates: 1, declaredBytes: 100, deleted: 0 });
    const [object] = await suite!.db.select().from(captureMediaObjects).where(eq(captureMediaObjects.id, f.object.id));
    expect(object?.storageState).toBe('stored');
    expect((await findOwnedAsset(suite!.db, f.asset.id, f.owner))?.state).toBe('uploaded');
    await expect(sweepExpiredCaptures(suite!.db, null)).rejects.toThrow('configured object store');
  });

  it('keeps failed intents retryable, waits before retrying, and continues the batch', async () => {
    const f = await fixture();
    await fixture();
    const failed = await sweepExpiredCaptures(suite!.db, { deleteObject: async (key) => {
      if (key === f.objectKey) throw new Error('sensitive provider URL');
    } }, runOptions);
    expect(failed).toMatchObject({ candidates: 2, deleted: 1, failed: 1 });
    expect(JSON.stringify(failed)).not.toContain('sensitive');
    const [object] = await suite!.db.select().from(captureMediaObjects).where(eq(captureMediaObjects.id, f.object.id));
    expect(object?.deletedAt).toBeNull();
    expect(object?.storageState).toBe('deleting');
    const store = { deleteObject: async () => {} };
    expect((await sweepExpiredCaptures(suite!.db, store, runOptions)).candidates).toBe(0);
    const retried = await sweepExpiredCaptures(suite!.db, store, { now: () => later(300) });
    expect(retried).toMatchObject({ candidates: 1, deleted: 1, failed: 0 });
  });

  it('recovers a crash after intent or S3 success and writes a tombstone only once', async () => {
    const f = await fixture();
    await claimCaptureCleanup(suite!.db, claimOptions);
    // No completion: the process died. The next DELETE may find no object.
    const result = await sweepExpiredCaptures(suite!.db, { deleteObject: async () => {} }, { now: () => later(300) });
    expect(result.deleted).toBe(1);
    expect(await completeCaptureCleanup(suite!.db, f.object.id, later(301))).toBe(false);
  });

  it('never revives an object while its DELETE is in flight', async () => {
    const f = await fixture(false);
    const result = await sweepExpiredCaptures(suite!.db, { deleteObject: async () => {
      await expect(registerAsset(suite!.db, f.registration, f.input, { keyPrefix: 'captures' }))
        .rejects.toThrow('being removed');
      // The HEAD may have succeeded before cleanup claimed the object.
      await expect(finalizeAsset(suite!.db, f.asset.id, f.owner, { byteSize: 100 }))
        .rejects.toThrow('expired or is being removed');
    } }, runOptions);
    expect(result).toMatchObject({ deleted: 1, failed: 0 });
  });

  it('claims disjoint batches under concurrent sweepers', async () => {
    await fixture();
    await fixture();
    const results = await Promise.all([
      claimCaptureCleanup(suite!.db, { ...claimOptions, limit: 1 }),
      claimCaptureCleanup(suite!.db, { ...claimOptions, limit: 1 }),
    ]);
    expect(results.map((rows) => rows.length)).toEqual([1, 1]);
    expect(new Set(results.flat().map((row) => row.id)).size).toBe(2);
  });

  it('deduplicates simultaneous first contributions without a unique-index error', async () => {
    const f = await fixture();
    const input = { ...f.input, contentHash: 'b'.repeat(64) };
    const registrations = await Promise.all(Array.from({ length: 4 }, () =>
      registerAsset(suite!.db, f.registration, input, { keyPrefix: 'captures' })));
    expect(new Set(registrations.map((r) => r.objectKey)).size).toBe(1);
    expect(new Set(registrations.map((r) => r.asset.id)).size).toBe(4);
  });

  it('refuses finalization after expiry even before a sweeper runs', async () => {
    const f = await fixture(false);
    await expect(finalizeAsset(suite!.db, f.asset.id, f.owner, { byteSize: 100 }))
      .rejects.toThrow('expired or is being removed');
  });

  it('rejects unbounded or invalid cleanup parameters', async () => {
    for (const limit of [0, -1, 1001, NaN, 1.5]) {
      await expect(sweepExpiredCaptures(suite!.db, null, { dryRun: true, limit })).rejects.toThrow('limit');
    }
    for (const retryAfterSeconds of [0, 29, 86401, NaN]) {
      await expect(sweepExpiredCaptures(suite!.db, null, { dryRun: true, retryAfterSeconds })).rejects.toThrow('retry interval');
    }
  });

  it('runs the CLI in dry-run mode and refuses a mismatched database', async () => {
    await fixture();
    const target = new URL(suite!.databaseUrl).pathname.slice(1);
    async function cli(database: string) {
      const child = Bun.spawn([process.execPath, resolve(__dirname, '../runCleanup.ts'),
        '--dry-run', `--target-database=${database}`], {
        env: { ...process.env, DATABASE_URL: suite!.databaseUrl }, stdout: 'pipe', stderr: 'pipe',
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ]);
      return { exitCode, stdout, stderr };
    }
    const preview = await cli(target);
    expect(preview.exitCode).toBe(0);
    expect(JSON.parse(preview.stdout)).toMatchObject({ dryRun: true, candidates: 1, deleted: 0 });
    const wrong = await cli('not_the_capture_database');
    expect(wrong.exitCode).toBe(1);
    expect(wrong.stdout).toBe('');
    expect(wrong.stderr).not.toContain(suite!.databaseUrl);
  });
});
