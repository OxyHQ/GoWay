/**
 * The camera catalogue against a real PostGIS: what a sync writes, what a
 * viewport reads, and the two things that fail silently if wrong — ordinate
 * order (a swapped pair is still a valid point in another hemisphere) and a
 * box that crosses the antimeridian.
 *
 * This suite does not skip. See `db/__tests__/testDatabase.ts`.
 */

import '../../__tests__/testEnv';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { CameraObservation } from '@goway/contracts';
import { cameraIdOf } from '../../cameras/normalise';
import type { CameraRecord } from '../../cameras/types';
import {
  cameraCounts,
  longitudeSpans,
  getCamera,
  listCameras,
  listObservations,
  pruneObservations,
  retireUnseen,
  saveObservation,
  touchFrame,
  upsertCameras,
} from '../cameras/camerasRepository';
import {
  createSuiteDatabase,
  destroySuiteDatabase,
  requireSuite,
  SUITE_SETUP_TIMEOUT_MS,
  type SuiteDatabase,
} from './testDatabase';

let suite: SuiteDatabase | null = null;

const record = (sourceId: string, latitude: number, longitude: number): CameraRecord => ({
  sourceId,
  name: `Camera ${sourceId}`,
  kind: 'traffic',
  position: { latitude, longitude },
  heading: null,
  roadName: null,
  media: { kind: 'snapshot', refreshSeconds: 60, width: null, height: null },
  upstreamUrl: `https://cams.example.org/${sourceId}.jpg`,
  frameAt: null,
});

const MADRID = record('madrid', 40.4168, -3.7038);
const BARCELONA = record('barcelona', 41.4036, 2.1744);
const FIJI = record('fiji', -17.7134, 178.065);
const SAMOA = record('samoa', -13.759, -172.1046);
const IBERIA = { west: -10, south: 36, east: 4, north: 44 };
const ALL = ['prov'];

beforeAll(async () => {
  suite = await createSuiteDatabase();
}, SUITE_SETUP_TIMEOUT_MS);
afterAll(async () => {
  await destroySuiteDatabase(suite);
});

const db = () => requireSuite(suite).db;
const now = () => new Date();

describe('cameras repository', () => {
  it('writes a read once, and re-reading it is a refresh, not a second row', async () => {
    const first = await upsertCameras(db(), 'prov', [MADRID, BARCELONA, FIJI, SAMOA], now());
    expect(first).toEqual({ created: 4, refreshed: 0 });
    const again = await upsertCameras(
      db(),
      'prov',
      [MADRID, { ...BARCELONA, name: 'Renamed' }],
      now(),
    );
    expect(again).toEqual({ created: 0, refreshed: 2 });
    expect((await getCamera(db(), cameraIdOf('prov', 'barcelona')))?.name).toBe('Renamed');
  });

  it('reads a viewport with latitude and longitude the right way round', async () => {
    const rows = await listCameras(db(), { box: IBERIA, providerIds: ALL }, { limit: 10 });
    expect(rows.map((row) => row.sourceId)).toEqual(['barcelona', 'madrid']);
    // The transposed Madrid (lat -3.7, lng 40.4) is in the Indian Ocean, not in this box.
    expect(rows.every((row) => row.latitude > 36 && row.longitude < 4)).toBe(true);
  });

  it('reads a box that crosses the antimeridian, and not its complement', async () => {
    const pacific = { west: 170, south: -25, east: -170, north: -10 };
    const rows = await listCameras(db(), { box: pacific, providerIds: ALL }, { limit: 10 });
    expect(rows.map((row) => row.sourceId)).toEqual(['fiji', 'samoa']);
  });

  it('pages by id without skipping or repeating', async () => {
    const world = { west: -180, south: -90, east: 180, north: 90 };
    const seen: string[] = [];
    let after: string | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const page = await listCameras(db(), { box: world, providerIds: ALL }, { limit: 2, after });
      if (page.length === 0) break;
      seen.push(...page.map((row) => row.sourceId));
      after = page[page.length - 1]?.id;
    }
    expect(seen).toEqual(['barcelona', 'fiji', 'madrid', 'samoa']);
  });

  it('lists nothing for a provider the registry no longer knows', async () => {
    expect(await listCameras(db(), { box: IBERIA, providerIds: [] }, { limit: 10 })).toEqual([]);
    expect(await listCameras(db(), { box: IBERIA, providerIds: ['other'] }, { limit: 10 })).toEqual(
      [],
    );
  });

  it('retires only what a complete read did not list, and restores it when it returns', async () => {
    const startedAt = now();
    await upsertCameras(db(), 'prov', [MADRID, BARCELONA, FIJI], startedAt);
    const retired = await retireUnseen(db(), 'prov', startedAt, now());
    expect(retired).toEqual([cameraIdOf('prov', 'samoa')]);
    expect(await getCamera(db(), cameraIdOf('prov', 'samoa'))).toBeNull();
    expect((await cameraCounts(db())).get('prov')).toBe(3);
    await upsertCameras(db(), 'prov', [SAMOA], now());
    expect(await getCamera(db(), cameraIdOf('prov', 'samoa'))).not.toBeNull();
  });

  it('only moves a camera forward in time', async () => {
    const id = cameraIdOf('prov', 'madrid');
    await touchFrame(db(), id, new Date('2026-01-02T00:00:00Z'));
    await touchFrame(db(), id, new Date('2026-01-01T00:00:00Z'));
    expect((await getCamera(db(), id))?.lastFrameAt?.toISOString()).toBe(
      '2026-01-02T00:00:00.000Z',
    );
  });
});

describe('longitudeSpans', () => {
  it('keeps a narrow box whole, splits a wide one, and splits at the antimeridian', () => {
    expect(longitudeSpans({ west: -10, east: 4 })).toEqual([[-10, 4]]);
    expect(longitudeSpans({ west: -180, east: 180 })).toEqual([
      [-180, -90],
      [-90, 0],
      [0, 90],
      [90, 180],
    ]);
    expect(longitudeSpans({ west: 170, east: -170 })).toEqual([
      [170, 180],
      [-180, -170],
    ]);
  });
});

describe('camera observations', () => {
  const cameraId = cameraIdOf('prov', 'madrid');
  const at = (minute: number): CameraObservation => ({
    cameraId,
    windowStart: new Date(Date.UTC(2026, 0, 1, 0, minute - 1)).toISOString(),
    windowEnd: new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString(),
    counts: { car: minute },
    present: { car: 1 },
    flowPerMinute: minute,
    congestion: 'free',
    health: 'ok',
  });

  it('stores a window once, so a worker retry is idempotent', async () => {
    await saveObservation(db(), at(1));
    await saveObservation(db(), { ...at(1), counts: { car: 99 } });
    const rows = await listObservations(db(), cameraId, {}, { limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.row.counts).toEqual({ car: 99 });
  });

  it('pages newest first across a keyset position', async () => {
    for (const minute of [2, 3, 4, 5]) await saveObservation(db(), at(minute));
    const first = await listObservations(db(), cameraId, {}, { limit: 2 });
    expect(first.map((r) => r.row.counts)).toEqual([{ car: 5 }, { car: 4 }]);
    const position = first[1]?.position;
    const next = await listObservations(db(), cameraId, {}, { limit: 10, after: position });
    expect(next.map((r) => r.row.counts)).toEqual([{ car: 3 }, { car: 2 }, { car: 99 }]);
  });

  it('answers only since a time, and prunes by age', async () => {
    const since = new Date(Date.UTC(2026, 0, 1, 0, 4));
    const recent = await listObservations(db(), cameraId, { since }, { limit: 10 });
    expect(recent).toHaveLength(2);
    expect(await pruneObservations(db(), since)).toBe(3);
    expect(await listObservations(db(), cameraId, {}, { limit: 10 })).toHaveLength(2);
  });
});
