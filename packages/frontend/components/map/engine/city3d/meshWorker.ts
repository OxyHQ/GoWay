/**
 * The city-3D mesh Web Worker: fetch a vector tile, decode its buildings, mesh
 * them at the level of detail asked for (`lodMesher.ts`), pack them into the
 * compact vertex format (`packing.ts`), stand its trees (`trees.ts`) when
 * asked, and hand the buffers back without copying. The engine runs a small
 * pool of these (`workerPool.ts`).
 *
 * Started by `cityEngine.ts` as `new Worker(new URL('./meshWorker', import.meta.url))`,
 * which is the one spelling Expo's Metro recognises as a worker entry
 * (`@expo/metro-config` → `collect-dependencies`): it bundles this module and
 * everything it imports into a SEALED, self-contained chunk and rewrites the
 * call to load it. Nothing here is ever in the main bundle, and nothing from
 * the main bundle is in here — which is why this file imports only the pure
 * modules (`decode`, `mesher`, `lodMesher`, `packing`, `trees`, `tileMath`…)
 * and never the engine or three.js.
 *
 * ## Why the worker fetches the tile itself
 *
 * MapLibre has already fetched and decoded the same tile in its own worker,
 * but it exposes neither the bytes nor its worker to a custom layer; the
 * public path to the features is `querySourceFeatures`, which converts them to
 * GeoJSON on the MAIN thread — exactly where meshing a 4,655-ring Barcelona
 * multipolygon must not happen. So this asks for the same URL again. GoWay's
 * tiles are served `Cache-Control: public, max-age=86400` (measured), so the
 * second request is normally a browser-cache hit, not a second download.
 * Compiling GoWay's own 3D tiles removes the duplication altogether; see
 * `docs/MAP_3D_CITY.md` → "Phase 2".
 */
import { decodeBuildings } from './decode';
import { meshBuildingsLod } from './lodMesher';
import { meshBuildings } from './mesher';
import { meshOsmBuildings } from './osmMesher';
import { decodeCityTile } from './osmTiles';
import { type PackedMesh, packedTransferables, packMesh } from './packing';
import type { MeshWorkerRequest, MeshWorkerResponse } from './protocol';
import { tileSizeMetres } from './tileMath';
import { packTrees } from './trees';
import { type Footprint, treesFor } from './workerTrees';

/**
 * The slice of `DedicatedWorkerGlobalScope` this file uses. The frontend's
 * `tsconfig` compiles against the DOM library, where `self` is a `Window` and
 * `postMessage` has a different signature; naming the shape here is more
 * honest than a second tsconfig for one file.
 */
interface WorkerScope {
  onmessage: ((event: MessageEvent<MeshWorkerRequest>) => void) | null;
  postMessage(message: MeshWorkerResponse, transfer?: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;
const inflight = new Map<number, AbortController>();

/**
 * The last tiles' bytes, by URL. A tile changes level as the camera comes
 * closer, and the pool sends it back to the same worker (`workerPool.ts`), so
 * the re-mesh starts from memory instead of a second fetch. Bounded by count
 * and bytes: a dense Barcelona tile is 1.2 MB.
 */
const BYTE_CACHE = { entries: 12, bytes: 24 * 1024 * 1024 };
const recent = new Map<string, ArrayBuffer>();

function remember(url: string, bytes: ArrayBuffer): void {
  recent.delete(url);
  recent.set(url, bytes);
  let total = 0;
  for (const value of recent.values()) total += value.byteLength;
  for (const [key, value] of recent) {
    if (recent.size <= BYTE_CACHE.entries && total <= BYTE_CACHE.bytes) break;
    recent.delete(key);
    total -= value.byteLength;
  }
}

async function tileBytes(url: string, signal: AbortSignal): Promise<ArrayBuffer | null> {
  const cached = recent.get(url);
  if (cached) {
    remember(url, cached);
    return cached;
  }
  const response = await fetch(url, { signal });
  // A tile the archive does not have is empty ground, not an error.
  if (response.status === 204 || response.status === 404) return null;
  if (!response.ok) throw new Error(`tile ${url} answered ${response.status}`);
  const bytes = await response.arrayBuffer();
  remember(url, bytes);
  return bytes;
}

/** Tell the pool a cancel took effect. */
function acknowledge(id: number): void {
  scope.postMessage({ type: 'cancelled', id });
}

async function mesh(request: Extract<MeshWorkerRequest, { type: 'mesh' }>): Promise<void> {
  const controller = new AbortController();
  inflight.set(request.id, controller);
  try {
    const bytes = await tileBytes(request.url, controller.signal);
    if (!bytes) {
      scope.postMessage({
        type: 'mesh',
        id: request.id,
        mesh: null,
        trees: null,
        meshMs: 0,
        treeMs: 0,
        treesComplete: true,
      });
      return;
    }
    if (controller.signal.aborted) {
      acknowledge(request.id);
      return;
    }

    const started = performance.now();
    const size = tileSizeMetres(request.tile);
    const { mesh: result, footprints } =
      request.format === 'goway'
        ? meshCityTile(bytes, size)
        : meshOpenMapTiles(bytes, request, size);
    const meshed = performance.now();
    const gathered = request.trees
      ? await treesFor(request, bytes, size, footprints, (url) => tileBytes(url, controller.signal))
      : { points: [], complete: true };
    const trees = packTrees(gathered.points, size);
    const treeMs = performance.now() - meshed;
    if (controller.signal.aborted) {
      acknowledge(request.id);
      return;
    }

    // Transfer, not copy: a dense tile is tens of megabytes of buffers.
    const transfer: Transferable[] = result ? packedTransferables(result) : [];
    if (trees) transfer.push(trees.data.buffer as ArrayBuffer);
    scope.postMessage(
      {
        type: 'mesh',
        id: request.id,
        mesh: result,
        trees,
        meshMs: meshed - started,
        treeMs,
        treesComplete: gathered.complete,
      },
      transfer,
    );
  } catch (cause) {
    // A cancelled request is the engine changing its mind: it wants no
    // result, only to know the slot is free (`workerPool.ts`).
    if (controller.signal.aborted) {
      acknowledge(request.id);
      return;
    }
    scope.postMessage({
      type: 'error',
      id: request.id,
      message: cause instanceof Error ? cause.message : String(cause),
    });
  } finally {
    inflight.delete(request.id);
  }
}

type MeshRequest = Extract<MeshWorkerRequest, { type: 'mesh' }>;

/** A mesh, and the footprints trees must not stand in. */
interface Meshed {
  mesh: PackedMesh | null;
  footprints: { list: readonly Footprint[]; extent: number };
}

/** OpenMapTiles' `building` layer, at the level of detail asked for. */
function meshOpenMapTiles(bytes: ArrayBuffer, request: MeshRequest, size: number): Meshed {
  const decoded = decodeBuildings(bytes, request.sourceLayer);
  if (!decoded) return { mesh: null, footprints: { list: [], extent: 4096 } };
  const footprints = { list: decoded.features, extent: decoded.extent };
  const options = { extent: decoded.extent, tileSizeMetres: size };
  if (request.lod !== 0) {
    return { mesh: meshBuildingsLod(decoded.features, options, request.lod), footprints };
  }
  const full = meshBuildings(decoded.features, options);
  return { mesh: full ? packMesh(full, size) : null, footprints };
}

/**
 * GoWay city tiles: per-building, with roofs, colours and recorded storeys.
 * Full detail only (`osmMesher.ts` has no far levels yet); packed with its
 * colour and facade lanes.
 */
function meshCityTile(bytes: ArrayBuffer, size: number): Meshed {
  const decoded = decodeCityTile(bytes);
  if (!decoded) return { mesh: null, footprints: { list: [], extent: 4096 } };
  const footprints = { list: decoded.buildings, extent: decoded.extent };
  const mesh = meshOsmBuildings(decoded.buildings, {
    extent: decoded.extent,
    tileSizeMetres: size,
  });
  return { mesh: mesh ? packMesh(mesh, size) : null, footprints };
}

scope.onmessage = (event) => {
  const request = event.data;
  if (request.type === 'cancel') {
    inflight.get(request.id)?.abort();
    return;
  }
  void mesh(request);
};
