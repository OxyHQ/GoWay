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
  type?: string;
}

/**
 * Routes requests to workers, cancels them, and survives a worker dying.
 *
 * Two rules the first version broke (PR #126 review):
 *
 *  - **A cancelled request keeps its slot until its worker says so.** The
 *    worker acknowledges a cancel (`{ type: 'cancelled' }`) or, if the reply
 *    was already on its way, replies; only then is the slot free. Freeing it
 *    at once let new work queue behind work the worker was still doing, and
 *    a late reply to a cancelled request is discarded, never handed on.
 *  - **A worker that dies fails its requests and is replaced.** Its in-flight
 *    requests are reported failed (the engine retries them with backoff) —
 *    otherwise they stayed pending forever and their tiles never drew.
 */
export class WorkerPool<Request extends PoolMessage, Response extends PoolMessage> {
  private readonly workers: Worker[];
  private readonly loads: number[];
  private readonly owner = new Map<number, number>();
  private readonly cancelled = new Set<number>();

  constructor(
    private readonly factory: () => Worker,
    size: number,
    private readonly onMessage: (response: Response) => void,
    /** A request lost to a worker that died; the engine treats it as an error. */
    private readonly onFailed: (id: number, message: string) => void,
  ) {
    // 0 is allowed: an engine drawing no buildings starts no worker.
    this.workers = Array.from({ length: Math.max(0, size) }, () => factory());
    this.loads = this.workers.map(() => 0);
    this.workers.forEach((worker, index) => {
      this.attach(worker, index);
    });
  }

  private attach(worker: Worker, index: number): void {
    worker.onmessage = (event: MessageEvent<Response>) => {
      if (this.workers[index] !== worker) return;
      const { id, type } = event.data;
      if (this.owner.get(id) !== index) return;
      this.owner.delete(id);
      this.loads[index] = Math.max(0, this.loads[index] - 1);
      if (this.cancelled.delete(id) || type === 'cancelled') return;
      this.onMessage(event.data);
    };
    worker.onerror = (event: ErrorEvent) => {
      if (this.workers[index] !== worker) return;
      event.preventDefault?.();
      this.replace(index, event.message || 'mesh worker failed');
    };
  }

  /** Fail every request the worker at `index` held, and start a new one. */
  private replace(index: number, message: string): void {
    const lost: number[] = [];
    for (const [id, owner] of this.owner) if (owner === index) lost.push(id);
    for (const id of lost) {
      this.owner.delete(id);
      if (!this.cancelled.delete(id)) this.onFailed(id, message);
    }
    this.loads[index] = 0;
    this.workers[index].terminate();
    const fresh = this.factory();
    this.workers[index] = fresh;
    this.attach(fresh, index);
  }

  get size(): number {
    return this.workers.length;
  }

  /** Requests sent and not yet answered — cancelled ones included, until acknowledged. */
  get inFlight(): number {
    return this.owner.size;
  }

  send(request: Request, key: string): void {
    const index = pickWorker(this.loads, key);
    this.owner.set(request.id, index);
    this.loads[index]++;
    this.workers[index].postMessage(request);
  }

  /** Ask the worker holding `id` to drop it; the slot frees when it answers. */
  cancel(id: number, message: unknown): void {
    const index = this.owner.get(id);
    if (index === undefined || this.cancelled.has(id)) return;
    this.cancelled.add(id);
    this.workers[index].postMessage(message);
  }

  terminate(): void {
    for (const worker of this.workers) worker.terminate();
    this.owner.clear();
    this.cancelled.clear();
  }
}
