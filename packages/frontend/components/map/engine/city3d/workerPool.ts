/**
 * A small pool of mesh Web Workers, so a dense tile meshing on one core does
 * not hold up every other tile behind it.
 *
 * The pool never constructs a worker itself: the engine hands it a factory
 * that spells `new Worker(new URL('./meshWorker', import.meta.url))`, the one
 * form Expo's Metro bundles as a sealed worker chunk (see `meshWorker.ts`).
 *
 * ## Which worker gets a request
 *
 * {@link pickWorker}: the tile's own worker (a hash of its key) when that is
 * not busier than the least busy by more than one request, else the least
 * busy. Affinity matters because a worker keeps the last tiles' bytes
 * (`meshWorker.ts`): when a tile changes level as the camera approaches, the
 * same worker re-meshes it from memory instead of fetching it again.
 *
 * Request concurrency is the ENGINE's to bound (`MAX_IN_FLIGHT_PER_WORKER`);
 * the pool only routes, cancels and counts.
 */

/** How many workers to start, from the device's logical cores. */
export function poolSize(hardwareConcurrency: number | undefined): number {
  const cores = Number.isFinite(hardwareConcurrency) ? (hardwareConcurrency as number) : 2;
  // Leave a core for the main thread (MapLibre's own workers share the rest).
  return Math.max(1, Math.min(3, cores - 1));
}

/** FNV-1a of a string: the tile's home worker. */
export function hashKey(key: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** The worker to send a request for `key` to, given each worker's in-flight count. */
export function pickWorker(loads: readonly number[], key: string): number {
  const home = hashKey(key) % loads.length;
  let least = 0;
  for (let i = 1; i < loads.length; i++) if (loads[i] < loads[least]) least = i;
  return loads[home] <= loads[least] + 1 ? home : least;
}

export interface PoolMessage {
  id: number;
}

export class WorkerPool<Request extends PoolMessage, Response extends PoolMessage> {
  private readonly workers: Worker[];
  private readonly loads: number[];
  private readonly owner = new Map<number, number>();

  constructor(
    factory: () => Worker,
    size: number,
    onMessage: (response: Response) => void,
    onError: () => void,
  ) {
    // 0 is allowed: an engine drawing no buildings starts no worker.
    this.workers = Array.from({ length: Math.max(0, size) }, factory);
    this.loads = this.workers.map(() => 0);
    this.workers.forEach((worker, index) => {
      worker.onmessage = (event: MessageEvent<Response>) => {
        if (this.owner.get(event.data.id) === index) {
          this.owner.delete(event.data.id);
          this.loads[index] = Math.max(0, this.loads[index] - 1);
        }
        onMessage(event.data);
      };
      worker.onerror = onError;
    });
  }

  get size(): number {
    return this.workers.length;
  }

  /** Requests sent and not yet answered or cancelled. */
  get inFlight(): number {
    return this.owner.size;
  }

  send(request: Request, key: string): void {
    const index = pickWorker(this.loads, key);
    this.owner.set(request.id, index);
    this.loads[index]++;
    this.workers[index].postMessage(request);
  }

  /** Cancel `id` on the worker that has it; `message` is the cancel request. */
  cancel(id: number, message: unknown): void {
    const index = this.owner.get(id);
    if (index === undefined) return;
    this.owner.delete(id);
    this.loads[index] = Math.max(0, this.loads[index] - 1);
    this.workers[index].postMessage(message);
  }

  terminate(): void {
    for (const worker of this.workers) worker.terminate();
    this.owner.clear();
  }
}
