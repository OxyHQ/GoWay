/**
 * Recording a licensed import: a scene GoWay licensed rather than
 * reconstructed (`street3d/licensedImport.ts` validates and uploads; every
 * statement is here).
 *
 * ## One transaction, serialized per import digest
 *
 * The scene (when new), the version, the supersession of the previous
 * published version and the scene's move to `published` commit together, so a
 * viewer sees the old version or the new one and never neither. An advisory
 * lock on the import digest serializes two operators running the same import:
 * the second finds the first one's version under the lock and records nothing.
 * A new version of an existing scene takes the scene's row lock and its next
 * version number, as a reconstruction job does.
 */

import { and, eq, sql } from 'drizzle-orm';
import type { Database, Transaction } from '../postgres';
import { street3dSceneVersions, street3dScenes } from '../schema';

export type ImportedVersionRow = typeof street3dSceneVersions.$inferSelect;

/** The licensed-import version an import digest already produced, if any. */
export async function findImportedVersion(
  db: Database | Transaction,
  digest: string,
): Promise<ImportedVersionRow | null> {
  const [row] = await db
    .select()
    .from(street3dSceneVersions)
    .where(
      and(
        eq(street3dSceneVersions.source, 'licensed_import'),
        eq(street3dSceneVersions.resultSha256, digest),
      ),
    );
  return row ?? null;
}

/**
 * The scene and version number a new delivery of an EXISTING licensed scene
 * would take, or why it may not: only a licensed scene that is not disabled
 * takes another import.
 */
export async function loadImportTarget(
  db: Database,
  sceneId: string,
): Promise<{ sceneId: string; version: number; isNew: false } | { refused: string }> {
  const [scene] = await db.select().from(street3dScenes).where(eq(street3dScenes.id, sceneId));
  if (!scene) return { refused: 'scene_not_found' };
  if (scene.source !== 'licensed_import') return { refused: 'scene_not_licensed_import' };
  if (scene.state === 'disabled') return { refused: 'scene_disabled' };
  return { sceneId, version: scene.lastAllocatedVersion + 1, isNew: false };
}

export interface RecordLicensedImportInput {
  sceneId: string;
  /** Create the scene in this transaction. */
  isNew: boolean;
  version: number;
  /** A new scene's anchor and the radius its footprint reaches. */
  anchor: { latitude: number; longitude: number };
  radiusMeters: number;
  digest: string;
  values: Omit<
    typeof street3dSceneVersions.$inferInsert,
    | 'id'
    | 'sceneId'
    | 'version'
    | 'jobId'
    | 'source'
    | 'state'
    | 'resultSha256'
    | 'privacyPipelineVersions'
    | 'gateFailures'
    | 'publishedAt'
    | 'createdAt'
    | 'updatedAt'
  >;
}

export type RecordLicensedImportResult =
  | { created: boolean; sceneId: string; versionId: string; version: number; state: string }
  | { refused: string };

/** Record a validated, uploaded import as its scene's published version. */
export async function recordLicensedImport(
  db: Database,
  input: RecordLicensedImportInput,
  now: Date,
): Promise<RecordLicensedImportResult> {
  return db.transaction(async (tx): Promise<RecordLicensedImportResult> => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`street3d-import:${input.digest}`}, 0))`,
    );
    const existing = await findImportedVersion(tx, input.digest);
    if (existing) {
      return {
        created: false,
        sceneId: existing.sceneId,
        versionId: existing.id,
        version: existing.version,
        state: existing.state,
      };
    }

    if (input.isNew) {
      await tx.insert(street3dScenes).values({
        id: input.sceneId,
        source: 'licensed_import',
        state: 'candidate',
        anchorLatitude: input.anchor.latitude,
        anchorLongitude: input.anchor.longitude,
        radiusMeters: input.radiusMeters,
        createdAt: now,
        updatedAt: now,
      });
    }
    const [scene] = await tx
      .select()
      .from(street3dScenes)
      .where(eq(street3dScenes.id, input.sceneId))
      .for('update');
    if (scene?.source !== 'licensed_import') return { refused: 'scene_not_licensed_import' };
    if (scene.state === 'disabled') return { refused: 'scene_disabled' };
    // Another import of this scene committed since the target was read: its
    // objects were uploaded under a version number that is now taken.
    if (scene.lastAllocatedVersion + 1 !== input.version) return { refused: 'concurrent_import' };

    await tx
      .update(street3dSceneVersions)
      .set({ state: 'superseded', updatedAt: now })
      .where(
        and(
          eq(street3dSceneVersions.sceneId, scene.id),
          eq(street3dSceneVersions.state, 'published'),
        ),
      );
    const [version] = await tx
      .insert(street3dSceneVersions)
      .values({
        ...input.values,
        sceneId: scene.id,
        version: input.version,
        source: 'licensed_import',
        state: 'published',
        resultSha256: input.digest,
        // None of its imagery entered GoWay's privacy pipeline; the
        // attestation in `values` says how it was cleared instead.
        privacyPipelineVersions: [],
        gateFailures: [],
        publishedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: street3dSceneVersions.id });
    if (!version) throw new Error('The imported version was not recorded.');
    await tx
      .update(street3dScenes)
      .set({
        lastAllocatedVersion: input.version,
        currentVersionId: version.id,
        state: 'published',
        confidence: input.values.quality.registrationRatio,
        updatedAt: now,
      })
      .where(eq(street3dScenes.id, scene.id));
    return {
      created: true,
      sceneId: scene.id,
      versionId: version.id,
      version: input.version,
      state: 'published',
    };
  });
}
