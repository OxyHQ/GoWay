/**
 * Public cameras, signed out (`docs/CAMERAS.md`):
 *
 *  - `GET /cameras`                        — the cameras in a box.
 *  - `GET /cameras/{id}`                   — one camera.
 *  - `GET /cameras/{id}/snapshot`          — GoWay's copy of its picture.
 *  - `GET /cameras/{id}/observations`      — what the video worker counted.
 *  - `GET /camera-providers`               — who the cameras come from, and on what terms.
 *
 * A camera is served only through a provider the registry still lists, with
 * that provider's credit and licence attached. Its picture is served only when
 * the provider's licence was read as allowing GoWay to redistribute it
 * (`redistribution: 'relay'`); otherwise the camera is listed and there is no
 * snapshot, which is answered as `not_found`, not as an empty image.
 */

import {
  type Camera,
  type CameraObservation,
  type CameraProvider,
  cameraListQuerySchema,
  cameraObservationsQuerySchema,
  cameraObservationSchema,
  cameraPathSchema,
} from '@goway/contracts';
import {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
  Router,
} from 'express';
import { FRAME_TOUCH_INTERVAL_SECONDS } from '../cameras/config';
import { cameraProviderById, CAMERA_PROVIDERS } from '../cameras/providers';
import { holdSeconds, SnapshotRelay, SnapshotUnavailableError } from '../cameras/relay';
import type { CameraProviderDefinition } from '../cameras/types';
import { type CameraRow, cameraOf } from '../cameras/view';
import {
  cameraCounts,
  getCamera,
  listCameras,
  listObservations,
  touchFrame,
} from '../db/cameras/camerasRepository';
import { getDb } from '../db/postgres';
import { ApiError } from '../http/apiError';
import {
  cursorBinding,
  decodeCursor,
  type Paged,
  pageOf,
  type TimeKeyset,
  timePageOf,
  timeWindowOf,
} from '../http/cursor';
import { parsePath, parseQuery } from '../http/validation';
import { z } from 'zod';

/** A catalogue changes when a sync runs; a status moves with each frame. */
const LIST_CACHE_CONTROL = 'public, max-age=30';
/**
 * One camera: revalidated every time. Its status and `lastFrameAt` move with
 * each picture, and the camera screen reads it again as soon as a new picture
 * has loaded — a cached copy would show the previous picture's age.
 */
const CAMERA_CACHE_CONTROL = 'no-cache';
const PROVIDERS_CACHE_CONTROL = 'public, max-age=300';

/** A list position: the last camera id served. */
const afterSchema = z.string().min(1).max(128);

/**
 * What the router reads. The database by default; injected in tests, so
 * paging, cursors and the relay are exercised without Postgres.
 */
export interface CamerasStore {
  list(
    filter: Parameters<typeof listCameras>[1],
    window: { limit: number; after?: string | undefined },
  ): Promise<CameraRow[]>;
  get(id: string): Promise<CameraRow | null>;
  counts(): Promise<Map<string, number>>;
  observations(
    cameraId: string,
    filter: { since?: Date | undefined },
    window: { limit: number; after?: TimeKeyset | undefined },
  ): Promise<Paged<CameraObservation>[]>;
  /** Record that a frame was seen at `at`. */
  touchFrame(cameraId: string, at: Date): Promise<void>;
}

const databaseStore: CamerasStore = {
  list: (filter, window) => listCameras(getDb(), filter, window),
  get: (id) => getCamera(getDb(), id),
  counts: () => cameraCounts(getDb()),
  observations: async (cameraId, filter, window) =>
    (await listObservations(getDb(), cameraId, filter, window)).map(({ row, position }) => ({
      item: cameraObservationSchema.parse({
        cameraId: row.cameraId,
        windowStart: row.windowFrom.toISOString(),
        windowEnd: row.windowTo.toISOString(),
        counts: row.counts,
        present: row.present,
        flowPerMinute: row.flowPerMinute,
        congestion: row.congestion,
        health: row.health,
      }),
      position,
    })),
  touchFrame: (cameraId, at) => touchFrame(getDb(), cameraId, at),
};

export interface CamerasRouterOptions {
  store?: CamerasStore;
  providers?: readonly CameraProviderDefinition[];
  relay?: SnapshotRelay;
  snapshotRateLimit?: RequestHandler;
  now?: () => Date;
}

function route(handler: (request: Request, response: Response) => Promise<void>): RequestHandler {
  return (request, response, next: NextFunction) => {
    handler(request, response).catch(next);
  };
}

export function createCamerasRouter(options: CamerasRouterOptions = {}): Router {
  const store = options.store ?? databaseStore;
  const providers = options.providers ?? CAMERA_PROVIDERS;
  const relay = options.relay ?? new SnapshotRelay();
  const now = options.now ?? (() => new Date());
  const providerOf = (id: string) =>
    options.providers ? providers.find((p) => p.id === id) : cameraProviderById(id);
  /** When each camera's frame time was last written, so a busy camera is not a write per request. */
  const touched = new Map<string, number>();

  const cameraOrNotFound = async (id: string): Promise<{ row: CameraRow; camera: Camera }> => {
    const row = await store.get(id);
    const camera = row ? cameraOf(row, providerOf(row.providerId), now()) : null;
    if (!row || !camera) throw new ApiError('not_found', 'No camera has that id.');
    return { row, camera };
  };

  const router: Router = Router();

  router.get(
    '/cameras',
    route(async (request, response) => {
      const { limit, cursor, kind, ...box } = parseQuery(cameraListQuerySchema, request.query);
      const binding = cursorBinding('cameras', { ...box, kind });
      const rows = await store.list(
        { box, kind, providerIds: providers.map((provider) => provider.id) },
        { limit: limit + 1, after: decodeCursor(cursor, binding, afterSchema) },
      );
      const at = now();
      response.setHeader('Cache-Control', LIST_CACHE_CONTROL);
      response.json(
        pageOf(
          rows,
          limit,
          binding,
          (row) => row.id,
          (row) => cameraOf(row, providerOf(row.providerId), at),
        ),
      );
    }),
  );

  router.get(
    '/cameras/:cameraId',
    route(async (request, response) => {
      const { cameraId } = parsePath(cameraPathSchema, request.params);
      const { camera } = await cameraOrNotFound(cameraId);
      response.setHeader('Cache-Control', CAMERA_CACHE_CONTROL);
      response.json(camera);
    }),
  );

  router.get(
    '/cameras/:cameraId/snapshot',
    ...(options.snapshotRateLimit ? [options.snapshotRateLimit] : []),
    route(async (request, response) => {
      const { cameraId } = parsePath(cameraPathSchema, request.params);
      const { row } = await cameraOrNotFound(cameraId);
      const provider = providerOf(row.providerId);
      if (provider?.redistribution !== 'relay' || row.mediaRefreshSeconds === null) {
        throw new ApiError('not_found', 'GoWay does not serve a picture for this camera.');
      }
      let snapshot: Awaited<ReturnType<SnapshotRelay['snapshot']>>;
      try {
        snapshot = await relay.snapshot({
          id: row.id,
          upstreamUrl: row.upstreamUrl,
          refreshSeconds: row.mediaRefreshSeconds,
        });
      } catch (error) {
        if (error instanceof SnapshotUnavailableError)
          throw new ApiError('provider_unavailable', 'The camera did not answer.');
        throw error;
      }
      // Record when the camera last took a frame, at most once a minute per camera.
      const frameAt = snapshot.frameAt ?? new Date(snapshot.fetchedAt);
      const lastTouch = touched.get(row.id) ?? 0;
      if (now().getTime() - lastTouch >= FRAME_TOUCH_INTERVAL_SECONDS * 1000) {
        touched.set(row.id, now().getTime());
        // Awaited: a client that refetches the camera once this picture has
        // loaded must read the time of the picture it is showing.
        await store.touchFrame(row.id, frameAt).catch(() => touched.delete(row.id));
      }
      const age = Math.max(0, Math.floor((now().getTime() - snapshot.fetchedAt) / 1000));
      response.setHeader('ETag', snapshot.etag);
      // The type is the one GoWay read from the bytes; a browser must not second-guess it.
      response.setHeader('X-Content-Type-Options', 'nosniff');
      // A public picture made to be embedded — by goway.to on another origin, or
      // any site — so not helmet's `same-origin`, which blocks it in an <img>.
      response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      response.setHeader(
        'Cache-Control',
        `public, max-age=${Math.max(1, holdSeconds(row.mediaRefreshSeconds) - age)}`,
      );
      if (snapshot.frameAt) response.setHeader('Last-Modified', snapshot.frameAt.toUTCString());
      if (request.headers['if-none-match'] === snapshot.etag) {
        response.status(304).end();
        return;
      }
      response.type(snapshot.contentType).send(Buffer.from(snapshot.bytes));
    }),
  );

  router.get(
    '/cameras/:cameraId/observations',
    route(async (request, response) => {
      const { cameraId } = parsePath(cameraPathSchema, request.params);
      const query = parseQuery(cameraObservationsQuerySchema, request.query);
      await cameraOrNotFound(cameraId);
      const binding = cursorBinding('camera-observations', {
        cameraId,
        since: query.since,
      });
      const window = timeWindowOf(query, binding);
      const rows = await store.observations(
        cameraId,
        { since: query.since ? new Date(query.since) : undefined },
        window,
      );
      response.setHeader('Cache-Control', LIST_CACHE_CONTROL);
      response.json(timePageOf(rows, query.limit, binding));
    }),
  );

  router.get(
    '/camera-providers',
    route(async (_request, response) => {
      const counts = await store.counts();
      const items: CameraProvider[] = providers.map((provider) => ({
        id: provider.id,
        name: provider.name,
        attribution: provider.attribution,
        licence: provider.licence,
        redistribution: provider.redistribution,
        cameraCount: counts.get(provider.id) ?? 0,
        coverage: provider.coverage,
      }));
      response.setHeader('Cache-Control', PROVIDERS_CACHE_CONTROL);
      response.json({ items, nextCursor: null });
    }),
  );

  return router;
}
