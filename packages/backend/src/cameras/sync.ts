/**
 * Camera syncs: how a provider's catalogue gets into the database and stays
 * current (`docs/CAMERAS.md`).
 *
 * A {@link CameraSource} READS one upstream and never touches the database;
 * {@link applyCameraSync} writes what it read through the repository. So a
 * source is tested with a recorded answer, and the rule about what may be
 * withdrawn lives in one place: a camera is retired only when a read said it
 * was COMPLETE and the camera was not in it. A failed, timed-out or partial
 * read retires nothing — the previous catalogue stands until a whole one
 * replaces it.
 */

import { retireUnseen, upsertCameras } from '../db/cameras/camerasRepository';
import type { Database } from '../db/postgres';
import { logger } from '../utils/logger';
import { dedupe } from './normalise';
import type {
  CameraBatch,
  CameraFetchContext,
  CameraProviderDefinition,
  CameraSourceSettings,
} from './types';

/** One read may take this long before it is abandoned. */
export const READ_TIMEOUT_MS = 120_000;

export interface CameraSyncReport {
  providerId: string;
  read: number;
  created: number;
  refreshed: number;
  retired: string[];
  complete: boolean;
  skipped: Record<string, number>;
  failures: string[];
}

export interface CameraSyncContext {
  fetch: typeof fetch;
  now(): Date;
  settings(provider: CameraProviderDefinition): CameraSourceSettings;
}

export async function applyCameraSync(
  db: Database | null,
  provider: CameraProviderDefinition,
  context: CameraSyncContext,
): Promise<CameraSyncReport> {
  const startedAt = context.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), READ_TIMEOUT_MS);
  let batch: CameraBatch;
  try {
    const read: CameraFetchContext = {
      fetch: context.fetch,
      signal: controller.signal,
      now: context.now,
    };
    batch = await provider.create(context.settings(provider)).read(read);
  } finally {
    clearTimeout(timer);
  }
  const skipped = { ...batch.skipped };
  const cameras = dedupe(provider.id, batch.cameras, skipped);
  const report: CameraSyncReport = {
    providerId: provider.id,
    read: cameras.length,
    created: 0,
    refreshed: 0,
    retired: [],
    complete: batch.complete,
    skipped,
    failures: batch.failures,
  };
  // Nothing to write on a dry run (`db` is null), and an empty read of a
  // catalogue that is not known complete is a failed read, not an empty world.
  if (db === null) return report;
  if (cameras.length > 0) {
    const written = await upsertCameras(db, provider.id, cameras, startedAt);
    report.created = written.created;
    report.refreshed = written.refreshed;
  }
  if (batch.complete && batch.failures.length === 0 && cameras.length > 0) {
    report.retired = await retireUnseen(db, provider.id, startedAt, context.now());
  }
  logger.info({ report }, 'Camera sync applied');
  return report;
}
