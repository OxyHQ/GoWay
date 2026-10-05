/**
 * The probes: `GET /health` and `GET /ready`, outside `/api/v1`.
 *
 * Two routes because they answer two different questions and an orchestrator
 * uses them for opposite purposes: a failing LIVENESS probe restarts the task,
 * a failing READINESS probe merely keeps traffic away from it.
 */

import { z } from 'zod';

/** `GET /health` — 200 with `ok`, or 503 with `degraded` when Postgres is unreachable. */
export const healthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  service: z.string().min(1),
  database: z.enum(['up', 'down']),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

/** `GET /ready` — whether this task may be given traffic, and why not. */
export const readinessResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ready') }),
  z.object({
    status: z.literal('not-ready'),
    reason: z.enum(['database-unreachable', 'migrations-pending']),
  }),
]);
export type ReadinessResponse = z.infer<typeof readinessResponseSchema>;
