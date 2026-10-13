/**
 * The city-3D mesh service: fetch a vector tile, decode its buildings, mesh
 * them at the level of detail asked for (`lodMesher.ts`), pack them into the
 * compact vertex format (`packing.ts`), stand its trees (`trees.ts`) when
 * asked, and post the result back — one request of the mesh protocol
 * (`protocol.ts`) at a time, any number in flight.
 *
 * It knows nothing of the thread it runs on. A host gives it a way to reply,
 * to fetch and to read a clock ({@link MeshHost}), and feeds it requests:
 *
 *  - on the web, the mesh Web Worker (`meshWorker.ts`);
 *  - on native, a react-native-worklets worker runtime (`meshRuntime.ts`).
 *
 * Both hosts run THIS code, so a tile meshes the same on every platform
 * (`docs/MAP_NATIVE_3D.md` → "Off-thread meshing").
 *
 * ## Why the service fetches the tile itself
 *
 * MapLibre has already fetched and decoded the same tile in its own worker,
 * but it exposes neither the bytes nor its worker to a custom layer; the
 * public path to the features is `querySourceFeatures`, which converts them to
 * GeoJSON on the MAIN thread — exactly where meshing a 4,655-ring Barcelona
 * multipolygon must not happen. So this asks for the same URL again. GoWay's
 * tiles are served `Cache-Control: public, max-age=86400` (measured), so the
 * second request is normally a cache hit, not a second download. Compiling
 * GoWay's own 3D tiles removes the duplication altogether; see
 * `docs/MAP_3D_CITY.md` → "Phase 2".
 */
import { surfaceVolumes, type VolumeIndex, volumeTransferables } from '../camera/volumes';
import { packedTransferables } from './packing';
import type { MeshWorkerRequest, MeshWorkerResponse } from './protocol';
import { tileSizeMetres } from './tileMath';
import { meshCityTile, meshOpenMapTiles } from './tileMeshing';
import { packTrees } from './trees';
import { treesFor } from './workerTrees';

/** The part of a fetch `Response` the service reads. */
export interface TileResponse {
  readonly status: number;
  readonly ok: boolean;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** What a thread gives the service to run on it. */
export interface MeshHost {
  /**
   * Reply to the engine. `transfer` lists the buffers the reply owns, which a
   * host that can move memory between threads moves instead of copying.
   */
  post(message: MeshWorkerResponse, transfer: ArrayBuffer[]): void;
  /**
   * Fetch a tile. `signal` is absent where the host has no `AbortController`:
   * a cancelled request is then still dropped, only its download finishes.
   */
  fetch(url: string, signal: AbortSignal | undefined): Promise<TileResponse>;
  /** Milliseconds, for the dev stats' timings. */
  now(): number;
}

/**
 * The last tiles' bytes, by URL. A tile changes level as the camera comes
 * closer, and the pool sends it back to the same worker (`workerPool.ts`), so
 * the re-mesh starts from memory instead of a second fetch. Bounded by count
 * and bytes: a dense Barcelona tile is 1.2 MB.
 */
export const BYTE_CACHE = { entries: 12, bytes: 24 * 1024 * 1024 };

/** One request in flight, and whether the engine has since cancelled it. */
interface Job {
  aborted: boolean;
  controller: AbortController | null;
}

type MeshRequest = Extract<MeshWorkerRequest, { type: 'mesh' }>;

/** A service on `host`: hand it every request the engine sends. */
export function createMeshService(host: MeshHost): (request: MeshWorkerRequest) => void {
  const inflight = new Map<number, Job>();
  const recent = new Map<string, ArrayBuffer>();

  const remember = (url: string, bytes: ArrayBuffer): void => {
    recent.delete(url);
    recent.set(url, bytes);
    let total = 0;
    for (const value of recent.values()) total += value.byteLength;
    for (const [key, value] of recent) {
      if (recent.size <= BYTE_CACHE.entries && total <= BYTE_CACHE.bytes) break;
      recent.delete(key);
      total -= value.byteLength;
    }
  };

  const tileBytes = async (url: string, job: Job): Promise<ArrayBuffer | null> => {
    const cached = recent.get(url);
    if (cached) {
      remember(url, cached);
      return cached;
    }
    const response = await host.fetch(url, job.controller?.signal);
    // A tile the archive does not have is empty ground, not an error.
    if (response.status === 204 || response.status === 404) return null;
    if (!response.ok) throw new Error(`tile ${url} answered ${response.status}`);
    const bytes = await response.arrayBuffer();
    remember(url, bytes);
    return bytes;
  };

  /** Tell the pool a cancel took effect. */
  const acknowledge = (id: number): void => host.post({ type: 'cancelled', id }, []);

  const mesh = async (request: MeshRequest): Promise<void> => {
    const job: Job = {
      aborted: false,
      controller: typeof AbortController === 'function' ? new AbortController() : null,
    };
    inflight.set(request.id, job);
    try {
      // The tiles a city tile's trees are read against (`treeContext.ts`) are
      // asked for now, beside the tile itself, so their round trips overlap
      // the tile's own and its meshing instead of following them.
      const early = new Map<string, Promise<ArrayBuffer | null>>();
      if (request.trees && request.treeContext) {
        for (const url of [request.treeContext.url, request.treeContext.roadsUrl]) {
          if (!url) continue;
          const pending = tileBytes(url, job);
          // Read (and its failure handled) by `treesFor`, or not needed.
          pending.catch(() => {});
          early.set(url, pending);
        }
      }
      const bytes = await tileBytes(request.url, job);
      if (job.aborted) {
        acknowledge(request.id);
        return;
      }
      if (!bytes) {
        host.post(
          {
            type: 'mesh',
            id: request.id,
            mesh: null,
            trees: null,
            meshMs: 0,
            treeMs: 0,
            treesComplete: true,
          },
          [],
        );
        return;
      }

      const started = host.now();
      const size = tileSizeMetres(request.tile);
      const {
        mesh: result,
        footprints,
        sources,
      } = request.format === 'goway'
        ? meshCityTile(bytes, size, request.hidden, request.volumes)
        : meshOpenMapTiles(bytes, request, size);
      const meshed = host.now();
      const gathered = request.trees
        ? await treesFor(
            request,
            bytes,
            size,
            footprints,
            (url) => early.get(url) ?? tileBytes(url, job),
          )
        : { points: [], complete: true, settings: undefined };
      const trees = packTrees(gathered.points, size);
      const treeMs = host.now() - meshed;
      if (job.aborted) {
        acknowledge(request.id);
        return;
      }

      // Transfer, not copy, where the host can: a dense tile is tens of
      // megabytes of buffers.
      const transfer = result ? packedTransferables(result) : [];
      if (trees) transfer.push(trees.data.buffer as ArrayBuffer, trees.form.buffer as ArrayBuffer);
      host.post(
        {
          type: 'mesh',
          id: request.id,
          mesh: result,
          trees,
          meshMs: meshed - started,
          treeMs,
          treesComplete: gathered.complete,
          ...(gathered.settings ? { treeSettings: gathered.settings } : {}),
          ...(sources.length > 0 ? { sources } : {}),
        },
        transfer,
      );
    } catch (cause) {
      // A cancelled request is the engine changing its mind: it wants no
      // result, only to know the slot is free (`workerPool.ts`).
      if (job.aborted) {
        acknowledge(request.id);
        return;
      }
      host.post(
        {
          type: 'error',
          id: request.id,
          message: cause instanceof Error ? cause.message : String(cause),
        },
        [],
      );
    } finally {
      inflight.delete(request.id);
    }
  };

  return (request) => {
    if (request.type === 'volumes') {
      // A landmark's columns (`models.ts`): pure arithmetic on what was sent.
      let volumes: VolumeIndex | null = null;
      try {
        volumes = surfaceVolumes(request.meshes, request.cellM);
      } catch {
        // A model that cannot be measured is drawn all the same; the camera
        // just has no columns for it.
      }
      host.post(
        { type: 'volumes', id: request.id, volumes },
        volumes ? volumeTransferables(volumes) : [],
      );
      return;
    }
    if (request.type === 'cancel') {
      const job = inflight.get(request.id);
      if (!job) return;
      job.aborted = true;
      job.controller?.abort();
      return;
    }
    void mesh(request);
  };
}
