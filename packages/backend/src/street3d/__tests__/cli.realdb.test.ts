/**
 * The Street 3D commands as an operator runs them: real processes, a real
 * database, the same `--target-database` guard as `captures:cleanup`.
 */

import '../../__tests__/testEnv';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  requireSuite,
  createSuiteDatabase,
  destroySuiteDatabase,
  SUITE_SETUP_TIMEOUT_MS,
  type SuiteDatabase,
} from '../../db/__tests__/testDatabase';
import { writeLicensedImport } from './licensedImportFixtures';

let suite: SuiteDatabase | null = null;

beforeAll(async () => {
  suite = await createSuiteDatabase();
}, SUITE_SETUP_TIMEOUT_MS);
afterAll(async () => {
  await destroySuiteDatabase(suite);
});

async function cli(script: string, args: string[], extraEnv: Record<string, string> = {}) {
  // A clean Street 3D environment: the commands must work with the feature off.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('STREET3D_')),
  );
  const child = Bun.spawn([process.execPath, resolve(__dirname, '..', script), ...args], {
    env: { ...env, ...extraEnv, DATABASE_URL: requireSuite(suite).databaseUrl },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe('street3d CLIs', () => {
  it('reports status for the asserted database and refuses any other', async () => {
    const target = new URL(requireSuite(suite).databaseUrl).pathname.slice(1);
    const status = await cli('runAdmin.ts', ['status', `--target-database=${target}`]);
    expect(status.exitCode).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({
      queues: { jobs: null },
      reports: { open: 0, openPrivacy: 0 },
    });

    const wrong = await cli('runAdmin.ts', [
      'status',
      '--target-database=not_the_street3d_database',
    ]);
    expect(wrong.exitCode).toBe(1);
    expect(wrong.stdout).toBe('');
    expect(wrong.stderr).not.toContain(requireSuite(suite).databaseUrl);

    const missing = await cli('runAdmin.ts', [
      'disable-version',
      'v-1',
      `--target-database=${target}`,
    ]);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain('--reason');
  });

  it('runs a tick only when the pipeline is configured', async () => {
    const target = new URL(requireSuite(suite).databaseUrl).pathname.slice(1);
    const result = await cli('runTick.ts', [`--target-database=${target}`]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({ skipped: 'street3d_pipeline_not_configured' });
    expect((await cli('runTick.ts', [])).exitCode).toBe(1);
  });

  it('imports a licensed scene into a local scene directory, once', async () => {
    const target = `--target-database=${new URL(requireSuite(suite).databaseUrl).pathname.slice(1)}`;
    const sceneDir = mkdtempSync(join(tmpdir(), 'goway-scene-dir-'));
    const env = {
      STREET3D_SCENE_LOCAL_DIR: sceneDir,
      STREET3D_PUBLIC_ASSET_BASE_URL: 'http://127.0.0.1:8790',
    };
    const disk = writeLicensedImport();

    const missing = await cli('runAdmin.ts', ['import-licensed', target], env);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain('--manifest');

    const first = await cli(
      'runAdmin.ts',
      ['import-licensed', target, `--manifest=${disk.manifestPath}`],
      env,
    );
    expect(first.exitCode).toBe(0);
    const outcome = JSON.parse(first.stdout);
    expect(outcome).toMatchObject({
      imported: true,
      created: true,
      version: 1,
      objects: 7,
      uploaded: 7,
    });
    // Aggregate output: no URL, key, path or coordinate.
    for (const secret of ['http', 'scenes/', disk.dir, '35.69'])
      expect(first.stdout).not.toContain(secret);
    const versionDir = join(sceneDir, 'scenes', outcome.sceneId, 'v1');
    expect(readdirSync(versionDir)).toHaveLength(3);

    const again = await cli(
      'runAdmin.ts',
      ['import-licensed', target, `--manifest=${disk.manifestPath}`],
      env,
    );
    expect(again.exitCode).toBe(0);
    expect(JSON.parse(again.stdout)).toMatchObject({ imported: true, created: false, uploaded: 0 });

    const disabled = await cli(
      'runAdmin.ts',
      ['disable-version', outcome.versionId, '--reason', 'check', target],
      env,
    );
    expect(JSON.parse(disabled.stdout)).toEqual({ disabled: true, purged: 1, purgePending: false });
    expect(existsSync(join(sceneDir, 'scenes'))).toBe(false);
    const enabled = await cli(
      'runAdmin.ts',
      ['enable-version', outcome.versionId, `--manifest=${disk.manifestPath}`, target],
      env,
    );
    expect(JSON.parse(enabled.stdout)).toEqual({
      enabled: true,
      state: 'published',
      restoredAssets: 7,
    });
  });
});
