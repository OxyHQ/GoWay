/**
 * `bun run street3d:admin <command> --target-database=<name> [options]`
 *
 *     status
 *     disable-version <versionId> --reason "<text>"
 *     enable-version  <versionId>
 *     rebuild-scene   <sceneId> [--profile draft|standard]
 *     block-capture   <assetId> --reason "<text>"
 *     cancel-job      <jobId>
 *     requeue-job     <jobId>
 *
 * Asserts the database and migration ledger first, like the cleanup command.
 * Prints aggregate JSON; exits 1 on refusal. See `street3d/admin.ts`.
 */

import 'dotenv/config';
import { parseArgs } from 'node:util';
import { assertMigrationTarget } from '@oxy.so/db/migrate';
import { STREET_SCENE_PROFILES, type StreetSceneProfile } from '@goway/contracts';
import { street3dConfig } from '../config/street3d';
import { assertMigrationsCurrent, closePostgres, connectPostgres, getDb } from '../db/postgres';
import {
  adminBlockCapture,
  adminCancelJob,
  adminDisableVersion,
  adminEnableVersion,
  adminRebuildScene,
  adminRequeueJob,
  adminStatus,
  type AdminDeps,
} from './admin';
import { createConfiguredStreet3dServices } from './services';

const USAGE =
  'Usage: street3d:admin <status|disable-version|enable-version|rebuild-scene|block-capture|cancel-job|requeue-job> ' +
  '[id] --target-database=<name> [--reason <text>] [--profile draft|standard]';

async function run(command: string, id: string | undefined, values: { reason?: string; profile?: string }) {
  const deps: AdminDeps = { db: getDb(), services: createConfiguredStreet3dServices(), config: street3dConfig };
  const need = (what: string): string => {
    if (!id) throw new Error(`${command} needs a ${what}.`);
    return id;
  };
  const reason = (): string => {
    const text = values.reason?.trim();
    if (!text) throw new Error(`${command} needs --reason.`);
    return text;
  };
  switch (command) {
    case 'status':
      return adminStatus(deps);
    case 'disable-version':
      return adminDisableVersion(deps, need('version id'), reason());
    case 'enable-version':
      return adminEnableVersion(deps, need('version id'));
    case 'rebuild-scene': {
      const profile = values.profile ?? null;
      if (profile !== null && !(STREET_SCENE_PROFILES as readonly string[]).includes(profile)) {
        throw new Error(`--profile must be one of ${STREET_SCENE_PROFILES.join(', ')}.`);
      }
      return adminRebuildScene(deps, need('scene id'), profile as StreetSceneProfile | null);
    }
    case 'block-capture':
      return adminBlockCapture(deps, need('capture asset id'), reason());
    case 'cancel-job':
      return adminCancelJob(deps, need('job id'));
    case 'requeue-job':
      return adminRequeueJob(deps, need('job id'));
    default:
      throw new Error(USAGE);
  }
}

function refused(result: Record<string, unknown>): boolean {
  return (
    result.disabled === false ||
    result.enabled === false ||
    result.requested === false ||
    result.blocked === false ||
    result.cancelled === false ||
    (typeof result.outcome === 'string' && result.outcome !== 'requeued')
  );
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      'target-database': { type: 'string' },
      reason: { type: 'string' },
      profile: { type: 'string' },
    },
  });
  const [command, id] = positionals;
  if (!command) throw new Error(USAGE);
  const target = values['target-database'];
  if (!target?.trim()) throw new Error('--target-database is required.');
  await connectPostgres();
  try {
    await assertMigrationTarget(getDb().$client, target);
    await assertMigrationsCurrent();
    const result = (await run(command, id, values)) as Record<string, unknown>;
    console.log(JSON.stringify(result));
    if (refused(result)) process.exitCode = 1;
  } finally {
    await closePostgres();
  }
}

main().catch((error: unknown) => {
  // Usage errors are ours and safe to print; anything else may carry secrets.
  const message = error instanceof Error && /needs|Usage|--profile|required/.test(error.message)
    ? error.message
    : 'Street 3D admin command failed. Check its arguments, database and AWS configuration.';
  console.error(message);
  process.exitCode = 1;
});
