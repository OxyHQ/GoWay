/**
 * `bun run street3d:serve-assets` — serve the local scene directory
 * (`STREET3D_SCENE_LOCAL_DIR`) on the loopback origin
 * `STREET3D_PUBLIC_ASSET_BASE_URL` names, so a licensed import published on a
 * development machine opens in the viewer. See `localAssetServer.ts`.
 *
 * Development only: it refuses to start unless that origin is plain HTTP on a
 * loopback host — exactly the URLs the public contract accepts without TLS —
 * and it binds that host alone.
 */

import { street3dConfig } from '../config/street3d';
import { serveLocalAsset } from './localAssetServer';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

function main(): void {
  const root = street3dConfig.sceneLocalDir;
  const base = street3dConfig.publicAssetBaseUrl
    ? new URL(street3dConfig.publicAssetBaseUrl)
    : null;
  if (!root || !base || base.protocol !== 'http:' || !LOOPBACK_HOSTS.has(base.hostname)) {
    console.error(
      'street3d:serve-assets needs STREET3D_SCENE_LOCAL_DIR and a loopback ' +
        'STREET3D_PUBLIC_ASSET_BASE_URL such as http://127.0.0.1:8790.',
    );
    process.exitCode = 1;
    return;
  }
  const options = {
    root,
    scenePrefix: street3dConfig.sceneKeyPrefix,
    basePath: base.pathname,
  };
  const server = Bun.serve({
    hostname: base.hostname.replace(/^\[|\]$/g, ''),
    port: Number(base.port || 80),
    fetch: (request) => serveLocalAsset(options, request),
  });
  console.log(JSON.stringify({ serving: `${server.url}`.replace(/\/$/, '') }));
}

main();
