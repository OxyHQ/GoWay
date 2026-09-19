/**
 * Liveness and readiness.
 *
 * Two routes because they answer two different questions and an orchestrator
 * uses them for opposite purposes: a failing LIVENESS probe restarts the task,
 * a failing READINESS probe merely keeps traffic away from it. Collapsing them
 * into one endpoint means a database blip restarts every task in the service.
 *
 * Both are mounted OUTSIDE the rate limiter. A throttled probe reports a
 * service down that is merely popular.
 */

import { Router } from 'express';
import { assertMigrationsCurrent, checkPostgresHealth } from '../db/postgres';
import { logger } from '../utils/logger';

export const healthRouter: Router = Router();

/**
 * `GET /health` — is this process able to serve?
 *
 * Reports database REACHABILITY, because for GoWay that is not a detail: there
 * is no second store and no in-memory fallback, so a process that cannot reach
 * Postgres cannot answer a single Places request. It is still a real round trip
 * rather than a `db !== null` flag — a pool can exist while the server behind it
 * is gone, and the cheap synchronous answer is the one that reports healthy
 * during an outage.
 */
healthRouter.get('/health', async (_request, response) => {
  const database = (await checkPostgresHealth()) ? 'up' : 'down';
  response.status(database === 'up' ? 200 : 503).json({
    status: database === 'up' ? 'ok' : 'degraded',
    service: 'goway-backend',
    database,
  });
});

/**
 * `GET /ready` — may this task be given traffic?
 *
 * Connectivity is not enough. A deploy that migrates in a one-shot task and then
 * starts serving tasks has a failure that lands after the point of no return: if
 * the one-shot did not run, or ran against the wrong database, the serving tasks
 * still start, still connect, and then fail every query against a schema that is
 * not there. A task that cannot serve correctly must not be able to say that it
 * can.
 */
healthRouter.get('/ready', async (_request, response) => {
  if (!(await checkPostgresHealth())) {
    response.status(503).json({ status: 'not-ready', reason: 'database-unreachable' });
    return;
  }
  try {
    await assertMigrationsCurrent();
  } catch (error) {
    logger.warn({ err: error }, 'Not ready — migrations are not current');
    response.status(503).json({ status: 'not-ready', reason: 'migrations-pending' });
    return;
  }
  response.json({ status: 'ready' });
});
