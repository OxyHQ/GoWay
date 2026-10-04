/**
 * The Street 3D commands as an operator runs them: real processes, a real
 * database, the same `--target-database` guard as `captures:cleanup`.
 */

import '../../__tests__/testEnv';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { resolve } from 'node:path';
import { createSuiteDatabase, destroySuiteDatabase, SUITE_SETUP_TIMEOUT_MS, type SuiteDatabase } from '../../db/__tests__/testDatabase';

let suite: SuiteDatabase | null = null;

beforeAll(async () => {
  suite = await createSuiteDatabase();
}, SUITE_SETUP_TIMEOUT_MS);
afterAll(async () => {
  await destroySuiteDatabase(suite);
});

async function cli(script: string, args: string[]) {
  // A clean Street 3D environment: the commands must work with the feature off.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('STREET3D_')));
  const child = Bun.spawn([process.execPath, resolve(__dirname, '..', script), ...args], {
    env: { ...env, DATABASE_URL: suite!.databaseUrl },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { exitCode, stdout, stderr };
}

describe('street3d CLIs', () => {
  it('reports status for the asserted database and refuses any other', async () => {
    const target = new URL(suite!.databaseUrl).pathname.slice(1);
    const status = await cli('runAdmin.ts', ['status', `--target-database=${target}`]);
    expect(status.exitCode).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({ queues: { jobs: null }, reports: { open: 0, openPrivacy: 0 } });

    const wrong = await cli('runAdmin.ts', ['status', '--target-database=not_the_street3d_database']);
    expect(wrong.exitCode).toBe(1);
    expect(wrong.stdout).toBe('');
    expect(wrong.stderr).not.toContain(suite!.databaseUrl);

    const missing = await cli('runAdmin.ts', ['disable-version', 'v-1', `--target-database=${target}`]);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain('--reason');
  });

  it('runs a tick only when the pipeline is configured', async () => {
    const target = new URL(suite!.databaseUrl).pathname.slice(1);
    const result = await cli('runTick.ts', [`--target-database=${target}`]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({ skipped: 'street3d_pipeline_not_configured' });
    expect((await cli('runTick.ts', [])).exitCode).toBe(1);
  });
});
