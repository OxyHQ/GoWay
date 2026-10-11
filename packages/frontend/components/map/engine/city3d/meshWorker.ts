/**
 * The city-3D mesh Web Worker: fetch a vector tile, decode its buildings, mesh
 * them, and hand the buffers back without copying.
 *
 * Started by `cityEngine.ts` as `new Worker(new URL('./meshWorker', import.meta.url))`,
 * which is the one spelling Expo's Metro recognises as a worker entry
 * (`@expo/metro-config` → `collect-dependencies`): it bundles this module and
 * everything it imports into a SEALED, self-contained chunk and rewrites the
 * call to load it. Nothing here is ever in the main bundle, and nothing from
 * the main bundle is in here — which is why this file imports only the pure
 * modules (`decode`, `mesher`, `tileMath`) and never the engine or three.js.
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
import { meshBuildings, type TileMesh } from './mesher';
import { meshOsmBuildings } from './osmMesher';
import { decodeCityTile } from './osmTiles';
import type { MeshWorkerRequest, MeshWorkerResponse } from './protocol';
import { tileSizeMetres } from './tileMath';

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

async function mesh(request: Extract<MeshWorkerRequest, { type: 'mesh' }>): Promise<void> {
  const controller = new AbortController();
  inflight.set(request.id, controller);
  try {
    const response = await fetch(request.url, { signal: controller.signal });
    // A tile the archive does not have is empty ground, not an error.
    if (response.status === 204 || response.status === 404) {
      scope.postMessage({ type: 'mesh', id: request.id, mesh: null, meshMs: 0 });
      return;
    }
    if (!response.ok) throw new Error(`tile ${request.url} answered ${response.status}`);
    const bytes = await response.arrayBuffer();

    const started = performance.now();
    const result =
      request.format === 'goway' ? meshCityTile(bytes, request) : meshOpenMapTiles(bytes, request);
    const meshMs = performance.now() - started;

    // Transfer, not copy: a dense tile is tens of megabytes of buffers.
    const transfer: Transferable[] = [];
    if (result) {
      for (const value of Object.values(result)) {
        if (ArrayBuffer.isView(value)) transfer.push(value.buffer as ArrayBuffer);
      }
    }
    scope.postMessage({ type: 'mesh', id: request.id, mesh: result, meshMs }, transfer);
  } catch (cause) {
    // A cancelled request is the engine changing its mind; it wants no reply.
    if (controller.signal.aborted) return;
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

function meshOpenMapTiles(bytes: ArrayBuffer, request: MeshRequest): TileMesh | null {
  const decoded = decodeBuildings(bytes, request.sourceLayer);
  return decoded
    ? meshBuildings(decoded.features, {
        extent: decoded.extent,
        tileSizeMetres: tileSizeMetres(request.tile),
      })
    : null;
}

/** GoWay city tiles: per-building, with roofs, colours and recorded storeys. */
function meshCityTile(bytes: ArrayBuffer, request: MeshRequest): TileMesh | null {
  const decoded = decodeCityTile(bytes);
  return decoded
    ? meshOsmBuildings(decoded.buildings, {
        extent: decoded.extent,
        tileSizeMetres: tileSizeMetres(request.tile),
      })
    : null;
}

scope.onmessage = (event) => {
  const request = event.data;
  if (request.type === 'cancel') {
    inflight.get(request.id)?.abort();
    return;
  }
  void mesh(request);
};
