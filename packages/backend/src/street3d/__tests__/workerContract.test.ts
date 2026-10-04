/**
 * The worker contract, against the canonical fixtures.
 *
 * Every `.json` file in `packages/reconstruction-worker/contract/fixtures/` is
 * parsed here, and an unrecognised file FAILS the suite rather than being
 * skipped: a fixture the backend never reads is a contract the backend never
 * agreed to. The worker's own tests parse the same files with its pydantic
 * models, which is what keeps the two languages from drifting apart.
 */

import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { z } from 'zod';
import {
  capturePrivacyResultSchema,
  jobEnvelopeSchema,
  sceneInputManifestSchema,
  sceneReconstructResultSchema,
  workerEventSchema,
} from '../workerContract';

const FIXTURES = resolve(__dirname, '../../../../reconstruction-worker/contract/fixtures');

function schemaFor(file: string): z.ZodType {
  if (file.startsWith('job.')) return jobEnvelopeSchema;
  if (file.startsWith('event.')) return workerEventSchema;
  if (file === 'result.capture_privacy.json') return capturePrivacyResultSchema;
  if (file === 'result.scene_reconstruct.json') return sceneReconstructResultSchema;
  if (file === 'scene_input_manifest.json') return sceneInputManifestSchema;
  throw new Error(`No backend parser is registered for fixture ${file}`);
}

function fixture(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES, file), 'utf8')) as Record<string, unknown>;
}

describe('worker contract fixtures', () => {
  const files = readdirSync(FIXTURES).filter((file) => file.endsWith('.json')).sort();

  it('finds the fixture directory', () => {
    expect(files.length).toBeGreaterThanOrEqual(8);
  });

  for (const file of files) {
    it(`parses ${file}`, () => {
      const result = schemaFor(file).safeParse(fixture(file));
      if (!result.success) throw new Error(`${file}: ${JSON.stringify(result.error.issues)}`);
      expect(result.success).toBe(true);
    });
  }

  it('fails closed on a pass without frames or with surviving metadata', () => {
    const passed = fixture('result.capture_privacy.json');
    expect(capturePrivacyResultSchema.safeParse({ ...passed, frames: [] }).success).toBe(false);
    expect(capturePrivacyResultSchema.safeParse({ ...passed, metadataStripped: false }).success).toBe(false);
    expect(capturePrivacyResultSchema.safeParse({ ...passed, verdict: 'failed', frames: [] }).success).toBe(true);
  });

  it('refuses unknown failure classes, stages and schema versions', () => {
    const failed = fixture('event.failed.json');
    expect(workerEventSchema.safeParse({ ...failed, failure: { code: 'gpu_on_fire', retryable: true } }).success).toBe(false);
    expect(workerEventSchema.safeParse({ ...fixture('event.heartbeat.json'), stage: 'dreaming' }).success).toBe(false);
    expect(workerEventSchema.safeParse({ ...failed, schemaVersion: 2 }).success).toBe(false);
    expect(workerEventSchema.safeParse({ ...failed, type: 'exploded' }).success).toBe(false);
  });

  it('refuses keys that escape their prefix', () => {
    const job = fixture('job.capture_privacy.json');
    expect(jobEnvelopeSchema.safeParse({ ...job, outputPrefix: '../captures/' }).success).toBe(false);
    expect(jobEnvelopeSchema.safeParse({ ...job, outputPrefix: '/derived/x/' }).success).toBe(false);
  });
});
