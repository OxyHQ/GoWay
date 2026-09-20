/**
 * Process bootstrap. Nothing else belongs in this file.
 *
 * Connect, listen, drain, exit — in that order, and the order is the point:
 *
 *   - CONNECT BEFORE LISTEN. A task that binds the port first is reachable
 *     before it can answer, so the load balancer routes to it and every request
 *     fails against a pool that is not open yet. Failing to connect must be a
 *     startup failure (exit 1, no listener), because there is no second store
 *     and no in-memory mode to fall back to.
 *   - DRAIN BEFORE CLOSING THE POOL. ECS and Kubernetes stop a task with
 *     SIGTERM. Closing the HTTP server first lets in-flight requests finish
 *     against a live connection instead of erroring on a socket closed
 *     underneath them.
 *
 * The application itself is built by `src/app.ts`, which opens no connections
 * and registers no signal handlers, so a test can exercise it without any of
 * this running.
 */

import http from 'node:http';
import { createApp } from './src/app';
import { config } from './src/config';
import { closePostgres, connectPostgres } from './src/db/postgres';
import { attachRealtime } from './src/realtime';
import { logger } from './src/utils/logger';

/** Seconds a shutdown waits for in-flight work before exiting anyway. */
const SHUTDOWN_GRACE_SECONDS = 20;

const app = createApp();
const server = http.createServer(app);
const io = attachRealtime(server);

let shuttingDown = false;

function shutdown(signal: string): void {
  // A second SIGTERM during a drain must not start a second drain: the two would
  // race on the pool and the loser exits on a closed connection.
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down');

  // A drain that never finishes is worse than an abrupt exit: the orchestrator
  // SIGKILLs the task after its own grace period and the shutdown path is never
  // observed at all. Bound it here so the timeout is ours and is logged.
  const forceExit = setTimeout(() => {
    logger.error({ signal }, 'Shutdown timed out — exiting with work in flight');
    process.exit(1);
  }, SHUTDOWN_GRACE_SECONDS * 1000);
  forceExit.unref();

  void io.close(() => {
    server.close(() => {
      void closePostgres().finally(() => {
        clearTimeout(forceExit);
        process.exit(0);
      });
    });
  });
}

async function boot(): Promise<void> {
  try {
    await connectPostgres();
  } catch (error) {
    logger.error({ err: error }, 'Failed to start — could not connect to PostgreSQL');
    process.exit(1);
  }

  server.listen(config.port, () => {
    logger.info({ port: config.port, nodeEnv: config.nodeEnv }, 'GoWay backend listening');
  });

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (require.main === module) {
  void boot();
}

// NOTHING is exported from this file, and that is load-bearing rather than
// tidiness.
//
// The image runs `bun packages/backend/dist/server.js`. Bun's entry wrapper
// treats a CommonJS module's `module.exports` as a `default` export and then
// calls `Bun.serve()` on it. An Express app is not a Bun server config, so the
// process printed the banner, served nothing, and exited 1:
//
//     TypeError: Bun.serve() needs either:
//       - A routes object ... - Or a fetch handler ...
//
// Reproduced exactly outside the container: `boot()` runs FIRST and the throw
// comes afterwards, which is why the logs showed a healthy start and the task
// still died. The guard is the absence of exported VALUES — the `__esModule`
// marker alone is harmless, so `tsc` emitting it is not the problem.
//
// `app`, `io` and `server` were exported and imported by nothing. If a test
// ever needs them, it should import the factory they come from rather than
// re-exporting them here, or the container goes back into a restart loop.
// `packages/backend/src/__tests__/entrypoint.test.ts` fails if this returns.
