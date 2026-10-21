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
 * ## Buildings never wait on trees
 *
 * A city tile's mapped trees are read against other tiles (`treeContext.ts`):
 * the basemap tile under it and the road archive's tiles around it. Those are
 * asked for as soon as the tile's own bytes show it HAS trees to set (nothing
 * for a tile without), so their round trips overlap the meshing. When they
 * are already here the reply carries buildings and trees together; when they
 * are not, the buildings are posted at once (`more: true`) and the trees
 * follow in a `trees` reply to the same id. The first version awaited them,
 * so every tile's buildings waited on two more downloads (PR #203 review).
 *
 * Every download is shared: a URL already being fetched for one request is
 * joined by the next (a basemap tile serves four city tiles, a road tile its
 * own and up to eight neighbours), and aborted only when no request still
 * waits on it.
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
import { type TileId, tileSizeMetres } from './tileMath';
import { cityFootprints, meshCityTile, meshOpenMapTiles } from './tileMeshing';
import { decodeMappedTrees } from './treeSources';
import { packTrees } from './trees';
import {
  decodeRoadLines,
  type Footprint,
  type MappedTreeTile,
  type RoadLines,
  treesFor,
  treeTilesFor,
} from './workerTrees';

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

/**
 * Road tiles, kept DECODED (`workerTrees.ts` → `RoadLines`), by URL: one
 * decode (12–16 ms for a dense Eixample tile, measured in Bun) serves its own
 * city tile and the neighbours whose trees stand near their shared edge. Not
 * in {@link BYTE_CACHE}, so they never push a city tile's bytes out.
 */
export const ROAD_CACHE = { entries: 24 };

/** Tiles the archives do not have (204/404), by URL: asked for once. */
const ABSENT_ENTRIES = 256;

/** One request in flight, and whether the engine has since cancelled it. */
interface Job {
  aborted: boolean;
  /** What to undo when it is cancelled: its waits on shared downloads. */
  onAbort: Set<() => void>;
}

/** A download any number of requests wait on. */
interface Shared {
  promise: Promise<unknown>;
  controller: AbortController | null;
  waiters: number;
}

type MeshRequest = Extract<MeshWorkerRequest, { type: 'mesh' }>;
type TreesRequest = Extract<MeshWorkerRequest, { type: 'trees' }>;
type Gathered = Awaited<ReturnType<typeof treesFor>>;

/** A service on `host`: hand it every request the engine sends. */
export function createMeshService(host: MeshHost): (request: MeshWorkerRequest) => void {
  const inflight = new Map<number, Job>();
  const recent = new Map<string, ArrayBuffer>();
  const roadCache = new Map<string, RoadLines>();
  const absent = new Set<string>();
  const shared = new Map<string, Shared>();

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
  const rememberRoads = (url: string, lines: RoadLines): void => {
    roadCache.delete(url);
    roadCache.set(url, lines);
    for (const key of roadCache.keys()) {
      if (roadCache.size <= ROAD_CACHE.entries) break;
      roadCache.delete(key);
    }
  };
  const rememberAbsent = (url: string): void => {
    absent.add(url);
    for (const key of absent) {
      if (absent.size <= ABSENT_ENTRIES) break;
      absent.delete(key);
    }
  };

  /**
   * Wait on the download `key`, starting it if no request has: shared by
   * every request that asks while it runs, aborted only when the last one
   * waiting is cancelled. A cancelled request stops waiting at once.
   */
  const join = <T,>(
    key: string,
    job: Job,
    start: (signal: AbortSignal | undefined) => Promise<T>,
  ): Promise<T> => {
    if (job.aborted) return Promise.reject(new Error('cancelled'));
    let download = shared.get(key);
    if (!download) {
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const created: Shared = { controller, waiters: 0, promise: start(controller?.signal) };
      const done = () => {
        if (shared.get(key) === created) shared.delete(key);
      };
      created.promise.then(done, done);
      shared.set(key, created);
      download = created;
    }
    const joined = download;
    joined.waiters++;
    return new Promise<T>((resolve, reject) => {
      const leave = (): boolean => {
        if (!job.onAbort.delete(cancel)) return false;
        joined.waiters--;
        return true;
      };
      const cancel = () => {
        if (!leave()) return;
        if (joined.waiters === 0 && shared.get(key) === joined) {
          shared.delete(key);
          joined.controller?.abort();
        }
        reject(new Error('cancelled'));
      };
      job.onAbort.add(cancel);
      joined.promise.then(
        (value) => {
          if (leave()) resolve(value as T);
        },
        (cause) => {
          if (leave()) reject(cause);
        },
      );
    });
  };

  /** Fetch `url`: `null` for a tile the archive does not have; throws when the fetch fails. */
  const download = async <T,>(
    url: string,
    signal: AbortSignal | undefined,
    read: (bytes: ArrayBuffer) => T,
  ): Promise<T | null> => {
    const response = await host.fetch(url, signal);
    // A tile the archive does not have is empty ground, not an error.
    if (response.status === 204 || response.status === 404) {
      rememberAbsent(url);
      return null;
    }
    if (!response.ok) throw new Error(`tile ${url} answered ${response.status}`);
    return read(await response.arrayBuffer());
  };

  /** A tile's bytes, from memory when they are there. */
  const tileBytes = (url: string, job: Job): Promise<ArrayBuffer | null> => {
    const cached = recent.get(url);
    if (cached) {
      remember(url, cached);
      return Promise.resolve(cached);
    }
    if (absent.has(url)) return Promise.resolve(null);
    return join(`bytes ${url}`, job, (signal) =>
      download(url, signal, (bytes) => {
        remember(url, bytes);
        return bytes;
      }),
    );
  };

  /** A road tile's lines, decoded once per worker. */
  const roadLines = (url: string, tile: TileId, job: Job): Promise<RoadLines | null> => {
    const cached = roadCache.get(url);
    if (cached) {
      rememberRoads(url, cached);
      return Promise.resolve(cached);
    }
    if (absent.has(url)) return Promise.resolve(null);
    return join(`roads ${url}`, job, (signal) =>
      download(url, signal, (bytes) => {
        const lines = decodeRoadLines(bytes, tile);
        rememberRoads(url, lines);
        return lines;
      }),
    );
  };

  /**
   * Ask for what a city tile's trees read (`treeTilesFor`: nothing for a
   * tile with no trees to set), and say whether it is all here already.
   */
  const prepareTrees = (request: MeshRequest | TreesRequest, bytes: ArrayBuffer, job: Job) => {
    const mapped: MappedTreeTile | undefined = request.treeContext
      ? decodeMappedTrees(bytes, request.treeContext.mappedLayer)
      : undefined;
    const tiles = mapped ? treeTilesFor(request, mapped) : { roads: [] };
    let ready = true;
    if (tiles.parent) {
      ready &&= recent.has(tiles.parent) || absent.has(tiles.parent);
      // Read (and its failure handled) by `treesFor`, which joins this download.
      tileBytes(tiles.parent, job).catch(() => {});
    }
    for (const road of tiles.roads) {
      ready &&= roadCache.has(road.url) || absent.has(road.url);
      roadLines(road.url, road.tile, job).catch(() => {});
    }
    return { mapped, ready };
  };

  const gatherTrees = (
    request: MeshRequest | TreesRequest,
    bytes: ArrayBuffer,
    size: number,
    footprints: { list: readonly Footprint[]; extent: number },
    mapped: MappedTreeTile | undefined,
    job: Job,
  ): Promise<Gathered> =>
    treesFor(request, bytes, size, footprints, (url) => tileBytes(url, job), {
      fetchRoads: (url, tile) => roadLines(url, tile, job),
      ...(mapped ? { mapped } : {}),
    });

  /** Gathered trees packed for a reply, and the buffers it may transfer. */
  const packed = (gathered: Gathered, size: number) => {
    const trees = packTrees(gathered.points, size);
    const transfer: ArrayBuffer[] = trees
      ? [trees.data.buffer as ArrayBuffer, trees.form.buffer as ArrayBuffer]
      : [];
    return {
      trees,
      transfer,
      treesComplete: gathered.complete,
      ...(gathered.settings ? { treeSettings: gathered.settings } : {}),
    };
  };

  /** Tell the pool a cancel took effect. */
  const acknowledge = (id: number): void => host.post({ type: 'cancelled', id }, []);

  /** Run one request's work; a cancel is acknowledged, a failure answered by `failed`. */
  const run = async (
    id: number,
    work: (job: Job) => Promise<void>,
    failed: (message: string) => void,
  ): Promise<void> => {
    const job: Job = { aborted: false, onAbort: new Set() };
    inflight.set(id, job);
    try {
      await work(job);
    } catch (cause) {
      // A cancelled request is the engine changing its mind: it wants no
      // result, only to know the slot is free (`workerPool.ts`).
      if (job.aborted) acknowledge(id);
      else failed(cause instanceof Error ? cause.message : String(cause));
    } finally {
      inflight.delete(id);
    }
  };

  const mesh = (request: MeshRequest) =>
    run(
      request.id,
      async (job) => {
        const bytes = await tileBytes(request.url, job);
        if (job.aborted) return acknowledge(request.id);
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

        // The trees' tiles are asked for before the meshing, so their round
        // trips overlap it.
        const prepared = request.trees ? prepareTrees(request, bytes, job) : null;
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
        // Transfer, not copy, where the host can: a dense tile is tens of
        // megabytes of buffers.
        const transfer = result ? packedTransferables(result) : [];
        const reply = {
          type: 'mesh' as const,
          id: request.id,
          mesh: result,
          meshMs: meshed - started,
          ...(sources.length > 0 ? { sources } : {}),
        };
        const gather = (): Promise<Gathered> =>
          prepared
            ? gatherTrees(request, bytes, size, footprints, prepared.mapped, job)
            : Promise.resolve({ points: [], complete: true });

        if (!prepared || prepared.ready || !result) {
          // The trees are ready, or there are none, or there are no
          // buildings to show first: one reply.
          const { transfer: treeTransfer, ...trees } = packed(await gather(), size);
          const treeMs = host.now() - meshed;
          if (job.aborted) return acknowledge(request.id);
          host.post({ ...reply, ...trees, treeMs }, [...transfer, ...treeTransfer]);
          return;
        }

        if (job.aborted) return acknowledge(request.id);
        host.post({ ...reply, trees: null, treeMs: 0, treesComplete: true, more: true }, transfer);
        const waited = host.now();
        let gathered: Gathered;
        try {
          gathered = await gather();
        } catch (cause) {
          if (job.aborted) throw cause;
          // The buildings are drawn; the engine asks for the trees again.
          gathered = { points: [], complete: false };
        }
        const { transfer: treeTransfer, ...trees } = packed(gathered, size);
        if (job.aborted) return acknowledge(request.id);
        host.post(
          { type: 'trees', id: request.id, ...trees, treeMs: host.now() - waited },
          treeTransfer,
        );
      },
      (message) => host.post({ type: 'error', id: request.id, message }, []),
    );

  const trees = (request: TreesRequest) =>
    run(
      request.id,
      async (job) => {
        const bytes = await tileBytes(request.url, job);
        if (job.aborted) return acknowledge(request.id);
        const started = host.now();
        const size = tileSizeMetres(request.tile);
        let gathered: Gathered = { points: [], complete: true };
        if (bytes) {
          const prepared = prepareTrees(request, bytes, job);
          // Its footprints only: the buildings are drawn already.
          gathered = await gatherTrees(
            request,
            bytes,
            size,
            cityFootprints(bytes),
            prepared.mapped,
            job,
          );
        }
        const { transfer, ...out } = packed(gathered, size);
        if (job.aborted) return acknowledge(request.id);
        host.post(
          { type: 'trees', id: request.id, ...out, treeMs: host.now() - started },
          transfer,
        );
      },
      // The tile itself could not be fetched again: what is drawn stays,
      // and the engine asks later.
      () =>
        host.post(
          { type: 'trees', id: request.id, trees: null, treeMs: 0, treesComplete: false },
          [],
        ),
    );

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
      if (!job || job.aborted) return;
      job.aborted = true;
      for (const undo of [...job.onAbort]) undo();
      return;
    }
    if (request.type === 'trees') void trees(request);
    else void mesh(request);
  };
}
