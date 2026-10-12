/**
 * The city-3D mesh Web Worker: the web's host for the mesh service
 * (`meshService.ts`), which fetches, meshes and packs a tile. The engine runs
 * a small pool of these (`workerPool.ts`); native runs the same service on a
 * worklet runtime instead (`meshRuntime.ts`).
 *
 * Started by `cityEngine.ts` as `new Worker(new URL('./meshWorker', import.meta.url))`,
 * which is the one spelling Expo's Metro recognises as a worker entry
 * (`@expo/metro-config` → `collect-dependencies`): it bundles this module and
 * everything it imports into a SEALED, self-contained chunk and rewrites the
 * call to load it. Nothing here is ever in the main bundle, and nothing from
 * the main bundle is in here — which is why the service imports only the pure
 * modules (`tileMeshing`, `packing`, `trees`, `tileMath`…) and never the
 * engine or three.js.
 */
import { createMeshService } from './meshService';
import type { MeshWorkerRequest, MeshWorkerResponse } from './protocol';

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
const handle = createMeshService({
  // Transfer, not copy: a dense tile is tens of megabytes of buffers.
  post: (message, transfer) => scope.postMessage(message, transfer),
  fetch: (url, signal) => fetch(url, { signal }),
  now: () => performance.now(),
});

scope.onmessage = (event) => handle(event.data);
