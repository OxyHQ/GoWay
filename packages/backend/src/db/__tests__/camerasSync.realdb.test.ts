/**
 * What a camera sync may and may not withdraw, against a real database: a
 * camera missing from a COMPLETE read is retired; one missing from a partial,
 * failed or empty read is not. This is the rule that keeps a provider's bad
 * hour from emptying its cameras off the map.
 *
 * This suite does not skip. See `db/__tests__/testDatabase.ts`.
 */

import '../../__tests__/testEnv';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { cameraIdOf } from '../../cameras/normalise';
import { applyCameraSync } from '../../cameras/sync';
import type { CameraBatch, CameraProviderDefinition, CameraRecord } from '../../cameras/types';
import { getCamera } from '../cameras/camerasRepository';
import {
  createSuiteDatabase,
  destroySuiteDatabase,
  requireSuite,
  SUITE_SETUP_TIMEOUT_MS,
  type SuiteDatabase,
} from './testDatabase';

let suite: SuiteDatabase | null = null;

beforeAll(async () => {
  suite = await createSuiteDatabase();
}, SUITE_SETUP_TIMEOUT_MS);
afterAll(async () => {
  await destroySuiteDatabase(suite);
});

const record = (sourceId: string): CameraRecord => ({
  sourceId,
  name: `Camera ${sourceId}`,
  kind: 'traffic',
  position: { latitude: 41, longitude: 2 },
  heading: null,
  roadName: null,
  media: { kind: 'snapshot', refreshSeconds: 60, width: null, height: null },
  upstreamUrl: `https://cams.example.org/${sourceId}.jpg`,
  frameAt: null,
});

let next: CameraBatch = { cameras: [], complete: true, skipped: {}, failures: [] };
const provider: CameraProviderDefinition = {
  id: 'sync-test',
  name: 'Sync test',
  attribution: { label: 'Test', href: 'https://example.org' },
  licence: { label: 'CC BY 4.0', href: 'https://creativecommons.org/licenses/by/4.0/' },
  licenceCheck: {
    verifiedOn: '2026-10-22',
    quote: 'free to share and adapt, even commercially',
    source: 'https://example.org/terms',
  },
  defaultUrl: 'https://example.org/cameras',
  requiresKey: false,
  pollIntervalSeconds: 600,
  staleAfterSeconds: 1200,
  dropAfterSeconds: 7200,
  coverage: null,
  redistribution: 'relay',
  create: () => ({ read: async () => next }),
};

let clock = Date.parse('2026-10-22T12:00:00Z');
const context = {
  fetch,
  now: () => new Date(clock),
  settings: () => ({ url: provider.defaultUrl, userAgent: 'test' }),
};
const sync = (batch: Partial<CameraBatch>) => {
  clock += 60_000;
  next = { cameras: [], complete: true, skipped: {}, failures: [], ...batch };
  return applyCameraSync(requireSuite(suite).db, provider, context);
};
const alive = async (sourceId: string) =>
  (await getCamera(requireSuite(suite).db, cameraIdOf('sync-test', sourceId))) !== null;

describe('applyCameraSync', () => {
  it('creates what it reads, drops repeats of one id, and reports what it refused', async () => {
    const report = await sync({
      cameras: [record('a'), record('b'), record('b')],
      skipped: { 'position.latitude': 2 },
    });
    expect(report).toMatchObject({
      read: 2,
      created: 2,
      refreshed: 0,
      retired: [],
      skipped: { 'position.latitude': 2, duplicate: 1 },
    });
  });

  it('retires a camera a COMPLETE read no longer lists', async () => {
    const report = await sync({ cameras: [record('a'), record('c')] });
    expect(report.retired).toEqual([cameraIdOf('sync-test', 'b')]);
    expect(await alive('b')).toBe(false);
    expect(await alive('c')).toBe(true);
  });

  it('retires nothing from a partial read, a read with failures, or an empty one', async () => {
    await sync({ cameras: [record('a')], complete: false });
    expect(await alive('c')).toBe(true);
    await sync({ cameras: [record('a')], failures: ['region 3 timed out'] });
    expect(await alive('c')).toBe(true);
    await sync({ cameras: [] });
    expect(await alive('a')).toBe(true);
    expect(await alive('c')).toBe(true);
  });

  it('brings a retired camera back when it reappears', async () => {
    await sync({ cameras: [record('a'), record('b')] });
    expect(await alive('b')).toBe(true);
  });

  it('writes nothing on a dry run', async () => {
    next = { cameras: [record('dry')], complete: true, skipped: {}, failures: [] };
    const report = await applyCameraSync(null, provider, context);
    expect(report.read).toBe(1);
    expect(await alive('dry')).toBe(false);
  });
});
