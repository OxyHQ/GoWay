/**
 * The licensed-import path without a database: reading RAD headers, the
 * manifest's checks, the import digest, where the files go in the scene
 * bucket, and the local development store and server that stand in for it.
 */

import '../../__tests__/testEnv';
import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseStreet3dConfig } from '../../config/street3d';
import {
  fittingProfile,
  ImportRefused,
  isSimilarity,
  placeImport,
  prepareLicensedImport,
} from '../licensedImport';
import { serveLocalAsset } from '../localAssetServer';
import { parseRadHeader, RadHeaderError } from '../radHeader';
import {
  createFilesystemSceneAssetStore,
  hashFile,
  IMMUTABLE_CACHE_CONTROL,
  radTreeDigest,
} from '../sceneAssetStore';
import { importManifest, radHeaderBytes, writeLicensedImport } from './licensedImportFixtures';

const config = parseStreet3dConfig({
  STREET3D_PUBLIC_ASSET_BASE_URL: 'http://127.0.0.1:8790',
});
const now = new Date('2026-10-12T00:00:00.000Z');

async function refusal(run: () => Promise<unknown>): Promise<ImportRefused> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ImportRefused) return error;
    throw error;
  }
  throw new Error('Expected the import to be refused.');
}

describe('RAD headers', () => {
  const meta = (chunks: unknown[]) => ({ version: 1, type: 'gsplat', count: 10, chunks });

  it('reads the metadata and where inline chunks start, padded to 8 bytes', () => {
    const header = parseRadHeader(
      radHeaderBytes(meta([{ offset: 0, bytes: 4, filename: 'a-lod-0.radc' }])),
    );
    expect(header.meta.count).toBe(10);
    expect(header.chunksStart % 8).toBe(0);
    expect(header.chunksStart).toBeGreaterThan(8);
  });

  it('refuses a non-RAD, truncated metadata and a chunk name that leaves the directory', () => {
    expect(() => parseRadHeader(Buffer.from('not a rad at all'))).toThrow(RadHeaderError);
    expect(() => parseRadHeader(radHeaderBytes(meta([])).subarray(0, 20))).toThrow(RadHeaderError);
    for (const filename of ['../a-lod-0.radc', 'sub/a-lod-0.radc', 'a-lod-0.rad', '.radc']) {
      expect(() =>
        parseRadHeader(radHeaderBytes(meta([{ offset: 0, bytes: 4, filename }]))),
      ).toThrow(RadHeaderError);
    }
    expect(() =>
      parseRadHeader(
        radHeaderBytes(
          meta([
            { offset: 0, bytes: 4, filename: 'a-lod-0.radc' },
            { offset: 0, bytes: 4, filename: 'a-lod-0.radc' },
          ]),
        ),
      ),
    ).toThrow(RadHeaderError);
  });
});

describe('transforms and profiles', () => {
  it('accepts a right-handed similarity only', () => {
    expect(isSimilarity([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 6, 7, 1])).toBe(true);
    // Rotated 90° about z and scaled by 2.
    expect(isSimilarity([0, 2, 0, 0, -2, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1])).toBe(true);
    expect(isSimilarity([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1])).toBe(false);
    expect(isSimilarity([1, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])).toBe(false);
    expect(isSimilarity([1, 0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])).toBe(false);
  });

  it('records the smallest profile whose budget holds the tree, else the largest', () => {
    expect(fittingProfile(config, 1000, 1000)).toBe('draft');
    expect(fittingProfile(config, 2_000_000, 1000)).toBe('standard');
    expect(fittingProfile(config, 40_000_000, 4_000_000_000)).toBe('standard');
  });
});

describe('preparing an import', () => {
  it('validates, hashes and places a chunked tree beside its header', async () => {
    const disk = writeLicensedImport();
    const plan = await prepareLicensedImport(disk.manifestPath, config, now);
    expect(plan.splat.chunks.map((chunk) => chunk.name)).toEqual([
      'kabukicho-lod-0.radc',
      'kabukicho-lod-1.radc',
      'kabukicho-lod-2.radc',
    ]);
    expect(plan.splat.gaussians).toBe(2_400_000);
    expect(plan.profile).toBe('standard');
    // The footprint's corners are ~140 m from the anchor.
    expect(plan.radiusMeters).toBeGreaterThan(100);
    expect(plan.radiusMeters).toBeLessThan(200);
    // Viewpoints are thinned exactly as a reconstruction's are.
    expect(plan.navigation?.viewpoints).toHaveLength(2);

    const { assets, uploads } = placeImport(plan, config, 'scene-1', 1);
    const splat = assets.find((asset) => asset.role === 'splat');
    const tree = radTreeDigest(plan.splat.header.sha256, plan.splat.chunks);
    expect(splat?.key).toBe(`scenes/scene-1/v1/${tree}/kabukicho-lod.rad`);
    expect(splat?.url).toBe(`http://127.0.0.1:8790/scenes/scene-1/v1/${tree}/kabukicho-lod.rad`);
    expect(splat?.sha256).toBe(plan.splat.header.sha256);
    // Every chunk resolves against the header URL into the header's directory.
    for (const chunk of plan.splat.chunks) {
      const url = new URL(chunk.name, splat?.url);
      expect(url.pathname).toBe(`/scenes/scene-1/v1/${tree}/${chunk.name}`);
    }
    expect(splat?.chunks?.map((chunk) => chunk.key)).toEqual(
      plan.splat.chunks.map((chunk) => `scenes/scene-1/v1/${tree}/${chunk.name}`),
    );
    expect(assets.map((asset) => `${asset.role}:${asset.format}`)).toEqual([
      'splat:rad',
      'splat_environment:rad',
      'poster:jpeg',
    ]);
    // 3 + 1 chunks, 2 headers, 1 poster.
    expect(uploads).toHaveLength(7);
    expect(uploads.every((upload) => upload.key.startsWith('scenes/scene-1/v1/'))).toBe(true);
  });

  it('digests values and bytes, not key order or where the files sit', async () => {
    const disk = writeLicensedImport();
    const first = await prepareLicensedImport(disk.manifestPath, config, now);
    // Same values, keys written in another order.
    const reordered = Object.fromEntries(Object.entries(importManifest()).reverse());
    disk.writeManifest(reordered);
    expect((await prepareLicensedImport(disk.manifestPath, config, now)).digest).toBe(first.digest);
    disk.writeManifest(importManifest({ attributions: ['Another credit'] }));
    expect((await prepareLicensedImport(disk.manifestPath, config, now)).digest).not.toBe(
      first.digest,
    );
    // Different chunk bytes, same header: another digest, and another directory.
    const other = writeLicensedImport({}, { seed: 'other' });
    const second = await prepareLicensedImport(other.manifestPath, config, now);
    expect(second.digest).not.toBe(first.digest);
    expect(radTreeDigest(second.splat.header.sha256, second.splat.chunks)).not.toBe(
      radTreeDigest(first.splat.header.sha256, first.splat.chunks),
    );
  });

  it('refuses to publish without a privacy attestation in its closed set', async () => {
    const disk = writeLicensedImport({ privacy: undefined });
    expect(
      await refusal(() => prepareLicensedImport(disk.manifestPath, config, now)),
    ).toMatchObject({ reason: 'manifest_invalid', detail: 'privacy' });
    disk.writeManifest(
      importManifest({ privacy: { basis: 'trust_me', reviewedBy: 'x', note: 'y' } }),
    );
    expect(
      (await refusal(() => prepareLicensedImport(disk.manifestPath, config, now))).detail,
    ).toBe('privacy.basis');
    disk.writeManifest(
      importManifest({ privacy: { basis: 'goway_splat_review', reviewedBy: ' ', note: 'y' } }),
    );
    expect(
      (await refusal(() => prepareLicensedImport(disk.manifestPath, config, now))).detail,
    ).toBe('privacy.reviewedBy');
  });

  it('refuses a missing, resized or foreign chunk', async () => {
    const missing = writeLicensedImport();
    unlinkSync(join(missing.dir, 'kabukicho-lod-1.radc'));
    expect(
      (await refusal(() => prepareLicensedImport(missing.manifestPath, config, now))).reason,
    ).toBe('asset_missing');

    const resized = writeLicensedImport();
    writeFileSync(join(resized.dir, 'kabukicho-lod-2.radc'), Buffer.from('RADC'));
    expect(
      (await refusal(() => prepareLicensedImport(resized.manifestPath, config, now))).reason,
    ).toBe('rad_chunk_mismatch');

    const foreign = writeLicensedImport();
    const path = join(foreign.dir, 'kabukicho-lod-0.radc');
    const size = Bun.file(path).size;
    writeFileSync(path, Buffer.alloc(size, 7));
    expect(
      (await refusal(() => prepareLicensedImport(foreign.manifestPath, config, now))).reason,
    ).toBe('rad_chunk_mismatch');
  });

  it('refuses an insufficient licence, an overclaimed placement and a misplaced footprint', async () => {
    const disk = writeLicensedImport();
    const licence = importManifest().licence as Record<string, unknown>;
    disk.writeManifest(importManifest({ licence: { ...licence, permits: ['public_display'] } }));
    expect(
      await refusal(() => prepareLicensedImport(disk.manifestPath, config, now)),
    ).toMatchObject({ reason: 'licence_insufficient' });

    disk.writeManifest(importManifest({ placement: 'precise', alignmentResidualMeters: 12 }));
    expect(
      (await refusal(() => prepareLicensedImport(disk.manifestPath, config, now))).reason,
    ).toBe('placement_inconsistent');

    disk.writeManifest(
      importManifest({ bounds: { west: 139.7, south: 35.69, east: 139.701, north: 35.691 } }),
    );
    expect(
      (await refusal(() => prepareLicensedImport(disk.manifestPath, config, now))).detail,
    ).toContain('within bounds');

    disk.writeManifest(
      importManifest({ enuFromScene: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1] }),
    );
    expect(
      (await refusal(() => prepareLicensedImport(disk.manifestPath, config, now))).detail,
    ).toContain('similarity');

    disk.writeManifest(importManifest({ observedTo: '2027-01-01T00:00:00.000Z' }));
    expect(
      (await refusal(() => prepareLicensedImport(disk.manifestPath, config, now))).detail,
    ).toContain('future');
  });
});

describe('the local scene directory', () => {
  it('writes verified, serves by range with CORS, and removes emptied directories', async () => {
    const root = mkdtempSync(join(tmpdir(), 'goway-scene-dir-'));
    const store = createFilesystemSceneAssetStore({ root, scenePrefix: 'scenes' });
    const source = join(mkdtempSync(join(tmpdir(), 'goway-src-')), 'a.radc');
    writeFileSync(source, Buffer.from('RADC0123456789'));
    const hashed = await hashFile(source);
    const key = 'scenes/s/v1/tree/a-lod-0.radc';

    await expect(
      store.putFile({
        key,
        filePath: source,
        contentType: 'x',
        sha256: 'f'.repeat(64),
        byteSize: 14,
      }),
    ).rejects.toThrow('digest');
    expect(await store.head(key)).toBeNull();
    await store.putFile({ key, filePath: source, contentType: 'x', ...hashed });
    expect(await store.head(key)).toEqual({ byteSize: 14 });
    await expect(
      store.putFile({ key: 'captures/x', filePath: source, contentType: 'x', ...hashed }),
    ).rejects.toThrow();

    const options = { root, scenePrefix: 'scenes', basePath: '/' };
    const ranged = await serveLocalAsset(
      options,
      new Request(`http://127.0.0.1:8790/${key}`, { headers: { range: 'bytes=0-3' } }),
    );
    expect(ranged.status).toBe(206);
    expect(await ranged.text()).toBe('RADC');
    expect(ranged.headers.get('content-range')).toBe('bytes 0-3/14');
    expect(ranged.headers.get('access-control-allow-origin')).toBe('*');
    expect(ranged.headers.get('cache-control')).toBe(IMMUTABLE_CACHE_CONTROL);
    const whole = await serveLocalAsset(options, new Request(`http://127.0.0.1:8790/${key}`));
    expect(whole.status).toBe(200);
    expect(whole.headers.get('content-type')).toBe('application/octet-stream');
    for (const path of ['/scenes/s/v1/tree/missing.radc', '/other/x.radc', '/scenes/../x.radc']) {
      expect(
        (await serveLocalAsset(options, new Request(`http://127.0.0.1:8790${path}`))).status,
      ).toBe(404);
    }

    await store.delete(key);
    await store.delete(key);
    expect(existsSync(join(root, 'scenes'))).toBe(false);
    expect(readdirSync(root)).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });
});
