/**
 * The public Street 3D surface.
 *
 *     GET  /street3d/coverage?west&south&east&north   scenes and coarse coverage areas
 *     GET  /street3d/scenes/{sceneId}                  the served manifest of one scene
 *     POST /street3d/scenes/{sceneId}/reports          report a scene (Oxy session required)
 *
 * The two reads need no account — the map opens signed out, and a 3D street is
 * part of browsing it — and are in the public CORS lane (`middleware/cors.ts`).
 * Reporting is identity-bound: it is a moderation request somebody is
 * accountable for, so it sits behind `requireAuth` and a tighter rate limit.
 *
 * ## Off unless switched on
 *
 * With `STREET3D_VIEWING_ENABLED` false (the default) coverage answers
 * `service_unavailable` and a scene answers `not_found` — the same answer a
 * scene that does not exist gets — so a client can feature-detect without the
 * deployment advertising what it holds.
 *
 * ## Coarse by contract
 *
 * Nothing here can return a capture coordinate, a capture id, a contributor or
 * an object key: the repository (`db/street3d/public.ts`) never selects one.
 * Coverage areas are cell centres with banded counts.
 */

import {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import { street3dConfig, type Street3dConfig } from '../config/street3d';
import { getDb } from '../db/postgres';
import { createSceneReport, findCoverage, findPublishedManifest } from '../db/street3d/public';
import {
  coverageBoxWithin,
  scenePathSchema,
  streetCoverageQuerySchema,
  streetSceneReportInputSchema,
} from '@goway/contracts';
import { ApiError } from '../http/apiError';
import { parseBody, parsePath, parseQuery } from '../http/validation';

function route(handler: (request: Request, response: Response) => Promise<void>): RequestHandler {
  return (request, response, next: NextFunction) => {
    handler(request, response).catch(next);
  };
}

function sceneIdParam(request: Request): string {
  return parsePath(scenePathSchema, request.params).sceneId;
}

export interface Street3dRouterDependencies {
  requireAuth: RequestHandler;
  /** Applied to reports only, in addition to the API-wide limit. */
  reportRateLimit: RequestHandler;
  config?: Street3dConfig;
}

/** Short: a version is replaced by publication or hidden by moderation, and both must show quickly. */
const MANIFEST_CACHE_CONTROL = 'public, max-age=60';
const COVERAGE_CACHE_CONTROL = 'public, max-age=60';

export function createStreet3dRouter(dependencies: Street3dRouterDependencies): Router {
  const settings = dependencies.config ?? street3dConfig;
  const router: Router = Router();

  router.get(
    '/street3d/coverage',
    route(async (request, response) => {
      if (!settings.viewingEnabled) {
        throw new ApiError(
          'service_unavailable',
          'Street 3D is not available on this GoWay deployment.',
        );
      }
      const box = parseQuery(streetCoverageQuerySchema, request.query);
      // The cap is this deployment's, so it is checked here rather than in the
      // contract: a continent-sized box is a scan the row limit would truncate
      // arbitrarily, which reads as missing coverage rather than a refused query.
      if (!coverageBoxWithin(box, settings.coverageMaxSpanDegrees)) {
        throw new ApiError(
          'validation_failed',
          'The box is larger than this deployment serves coverage for.',
          {
            field: 'east',
            issue: 'too_big',
            maximumSpanDegrees: settings.coverageMaxSpanDegrees,
          },
        );
      }
      response.setHeader('Cache-Control', COVERAGE_CACHE_CONTROL);
      response.json(await findCoverage(getDb(), box));
    }),
  );

  router.get(
    '/street3d/scenes/:sceneId',
    route(async (request, response) => {
      const sceneId = sceneIdParam(request);
      const manifest = settings.viewingEnabled
        ? await findPublishedManifest(getDb(), sceneId)
        : null;
      if (!manifest) throw new ApiError('not_found', 'No published Street 3D scene has that id.');
      response.setHeader('Cache-Control', MANIFEST_CACHE_CONTROL);
      response.json(manifest);
    }),
  );

  router.post(
    '/street3d/scenes/:sceneId/reports',
    dependencies.reportRateLimit,
    dependencies.requireAuth,
    route(async (request, response) => {
      const sceneId = sceneIdParam(request);
      const reporter = request.userId;
      if (typeof reporter !== 'string' || reporter.length === 0) {
        throw new ApiError('unauthorized', 'Reporting a scene requires an Oxy session.');
      }
      const input = parseBody(streetSceneReportInputSchema, request.body ?? {});
      const result = settings.viewingEnabled
        ? await createSceneReport(getDb(), sceneId, reporter, {
            reason: input.reason,
            ...(input.note ? { note: input.note } : {}),
          })
        : null;
      if (!result) throw new ApiError('not_found', 'No published Street 3D scene has that id.');
      response.status(result.created ? 201 : 200).json(result.report);
    }),
  );

  return router;
}
