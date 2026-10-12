/**
 * The native host of the mesh service (`meshService.ts`): a
 * react-native-worklets worker runtime — a second Hermes runtime on its own
 * thread — speaking the same protocol as the web's mesh Web Worker
 * (`meshWorker.ts`), so the engine's pool (`workerPool.ts`) drives both alike.
 *
 * Measured on the Android emulator (`docs/MAP_NATIVE_3D.md` → "Off-thread
 * meshing"): a dense Barcelona tile holds the RN JS thread for about a second
 * when meshed there, and costs it no frame when meshed here.
 *
 * ## What the runtime has, and what it does not
 *
 * The service is the web's code, unchanged; this file only gives it the
 * {@link MeshHost} a worker runtime can offer:
 *
 *  - **No `fetch`.** Worker runtimes have none (worklets' fetch preview is
 *    experimental, and in 0.10 does not start in a release build). So the RN
 *    thread fetches — asynchronous I/O, which does not hold it — and hands the
 *    bytes to the runtime. Without `AbortController` either, a cancelled
 *    request's download still finishes; the service drops its result.
 *  - **No transfer.** Buffers cross runtimes by copy; a dense tile's reply
 *    costs tens of milliseconds more than its meshing (measured).
 *
 * ## Requires Bundle Mode
 *
 * The service and the mesher run as MODULES on the worker runtime, which only
 * worklets' Bundle Mode can do, with this directory's relative imports
 * forwarded (`importForwarding.relativePaths`). Without it, the mesher stays
 * on the RN thread and every call to it from the runtime throws.
 */
import {
  createWorkletRuntime,
  scheduleOnRN,
  scheduleOnRuntime,
  type WorkletRuntime,
} from 'react-native-worklets';

import { createMeshService } from './meshService';
import type { MeshWorkerRequest, MeshWorkerResponse } from './protocol';
import type { PoolWorker, WorkerEvents } from './workerPool';

/** A fetched tile as it crosses to the runtime: its status and, when OK, its bytes. */
interface Fetched {
  status: number;
  bytes: ArrayBuffer | null;
  error: string | null;
}

/** One runtime's state, on that runtime's own `globalThis`. */
interface RuntimeState {
  handle: (request: MeshWorkerRequest) => void;
  pending: Map<number, { resolve: (fetched: Fetched) => void }>;
  nextTicket: number;
}

type MeshGlobal = typeof globalThis & { __gowayMesh?: RuntimeState };

/** On the runtime: start its service, replying and fetching through the RN thread. */
function install(
  reply: (response: MeshWorkerResponse) => void,
  fetchOnRN: (url: string, ticket: number) => void,
): void {
  'worklet';
  const scope = globalThis as MeshGlobal;
  const state: RuntimeState = { handle: () => {}, pending: new Map(), nextTicket: 0 };
  state.handle = createMeshService({
    // Copied across runtimes; there is no transfer to make.
    post: (message) => scheduleOnRN(reply, message),
    fetch: (url) =>
      new Promise<Fetched>((resolve) => {
        const ticket = state.nextTicket++;
        state.pending.set(ticket, { resolve });
        scheduleOnRN(fetchOnRN, url, ticket);
      }).then((fetched) => {
        if (fetched.error !== null) throw new Error(fetched.error);
        const { status, bytes } = fetched;
        return {
          status,
          ok: status >= 200 && status < 300,
          arrayBuffer: async () => bytes ?? new ArrayBuffer(0),
        };
      }),
    now: () => performance.now(),
  });
  scope.__gowayMesh = state;
}

/** On the runtime: one request of the protocol. */
function handle(request: MeshWorkerRequest): void {
  'worklet';
  (globalThis as MeshGlobal).__gowayMesh?.handle(request);
}

/** On the runtime: the RN thread's answer to a fetch. */
function fetched(ticket: number, answer: Fetched): void {
  'worklet';
  const state = (globalThis as MeshGlobal).__gowayMesh;
  const waiting = state?.pending.get(ticket);
  if (!state || !waiting) return;
  state.pending.delete(ticket);
  waiting.resolve(answer);
}

/** Bytes of `url` on the RN thread, for the runtime's ticket. */
async function fetchFor(url: string): Promise<Fetched> {
  try {
    const response = await fetch(url);
    // Only an OK response's body is read and copied across.
    const bytes = response.ok ? await response.arrayBuffer() : null;
    return { status: response.status, bytes, error: null };
  } catch (cause) {
    return {
      status: 0,
      bytes: null,
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

/**
 * A pool worker on its own worker runtime, for `WorkerPool`'s factory:
 * `(events) => meshRuntimeWorker(events)`.
 *
 * worklets 0.10 cannot destroy a runtime, so {@link PoolWorker.terminate}
 * stops sending it work and drops its replies; the pool replaces a worker only
 * when it fails, which a runtime reports by throwing when scheduled.
 */
export function meshRuntimeWorker(
  events: WorkerEvents<MeshWorkerResponse>,
  name = 'goway-mesh',
): PoolWorker {
  let live = true;
  const runtime: WorkletRuntime = createWorkletRuntime({ name });

  const reply = (response: MeshWorkerResponse) => {
    if (live) events.message(response);
  };
  const fetchOnRN = (url: string, ticket: number) => {
    void fetchFor(url).then((answer) => {
      if (live) scheduleOnRuntime(runtime, fetched, ticket, answer);
    });
  };
  const send = <Args extends unknown[]>(worklet: (...args: Args) => void, ...args: Args) => {
    if (!live) return;
    try {
      scheduleOnRuntime(runtime, worklet, ...args);
    } catch (cause) {
      // Reported as a later task, as a Web Worker's error event is: the pool
      // may not yet hold this worker (the first send is from inside its
      // factory), and a replacement that fails too must not starve the thread.
      const message = cause instanceof Error ? cause.message : String(cause);
      setTimeout(() => events.error(message), 0);
    }
  };

  send(install, reply, fetchOnRN);
  return {
    postMessage: (message) => send(handle, message as MeshWorkerRequest),
    terminate: () => {
      live = false;
    },
  };
}
