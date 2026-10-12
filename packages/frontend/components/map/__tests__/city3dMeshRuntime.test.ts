/**
 * The native mesh host (`engine/city3d/meshRuntime.ts`) behind the same pool
 * as the web's Web Workers: requests in, protocol replies out, the tile
 * fetched on the RN thread (a worker runtime has no `fetch`) and its bytes
 * handed across, and a runtime that cannot be scheduled failing its requests.
 *
 * react-native-worklets is stood in for: each worklet runs as a microtask on
 * this one runtime, as a worker runtime runs it on its own thread. What the
 * device does is measured, not tested (`docs/MAP_NATIVE_3D.md` → "Off-thread
 * meshing").
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

import type {
  MeshWorkerRequest,
  MeshWorkerResponse,
} from '@/components/map/engine/city3d/protocol';
import { mercatorXFromLng, mercatorYFromLat } from '@/components/map/engine/city3d/tileMath';
import { WorkerPool } from '@/components/map/engine/city3d/workerPool';

import { cityTile, SYNTHETIC_CENTRE } from './fixtures/syntheticCity';

/** How many of the next schedules throw. */
let failScheduling = 0;
const runtimes: string[] = [];

mock.module('react-native-worklets', () => ({
  createWorkletRuntime: (config: { name: string }) => {
    runtimes.push(config.name);
    return { name: config.name };
  },
  scheduleOnRuntime: <Args extends unknown[]>(
    _runtime: unknown,
    worklet: (...args: Args) => void,
    ...args: Args
  ) => {
    if (failScheduling > 0) {
      failScheduling--;
      throw new Error('runtime gone');
    }
    queueMicrotask(() => worklet(...args));
  },
  scheduleOnRN: <Args extends unknown[]>(fun: (...args: Args) => void, ...args: Args) => {
    queueMicrotask(() => fun(...args));
  },
}));

const { meshRuntimeWorker } = await import('@/components/map/engine/city3d/meshRuntime');

const Z = 15;
const TILE = {
  z: Z,
  x: Math.floor(mercatorXFromLng(SYNTHETIC_CENTRE.lng) * 2 ** Z),
  y: Math.floor(mercatorYFromLat(SYNTHETIC_CENTRE.lat) * 2 ** Z),
};
const tileBytes = cityTile(TILE.z, TILE.x, TILE.y);

function request(id: number, url: string): MeshWorkerRequest & { id: number } {
  return {
    type: 'mesh',
    id,
    tile: TILE,
    url,
    sourceLayer: 'building',
    format: 'goway',
    lod: 0,
    trees: null,
  };
}

const originalFetch = globalThis.fetch;
const fetched: string[] = [];

beforeEach(() => {
  failScheduling = 0;
  fetched.length = 0;
  runtimes.length = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    fetched.push(url);
    if (url.endsWith('/offline')) throw new Error('network down');
    if (url.endsWith('/missing')) return new Response(null, { status: 404 });
    return new Response(tileBytes.slice());
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete (globalThis as { __gowayMesh?: unknown }).__gowayMesh;
});

function pool() {
  const replies: MeshWorkerResponse[] = [];
  const failed: Array<{ id: number; message: string }> = [];
  let settle: () => void = () => {};
  const instance = new WorkerPool<MeshWorkerRequest & { id: number }, MeshWorkerResponse>(
    (events) => meshRuntimeWorker(events),
    1,
    (reply) => {
      replies.push(reply);
      settle();
    },
    (id, message) => {
      failed.push({ id, message });
      settle();
    },
  );
  const answered = () =>
    new Promise<void>((resolve) => {
      settle = resolve;
    });
  return { instance, replies, failed, answered };
}

describe('meshRuntimeWorker', () => {
  test('meshes a tile the RN thread fetched, and answers in the protocol', async () => {
    const { instance, replies, answered } = pool();
    expect(runtimes).toEqual(['goway-mesh']);
    const next = answered();
    instance.send(request(1, 'https://tiles.test/city.pbf'), '15/1/1');
    await next;
    expect(fetched).toEqual(['https://tiles.test/city.pbf']);
    expect(replies).toHaveLength(1);
    const [reply] = replies;
    expect(reply).toMatchObject({ type: 'mesh', id: 1, treesComplete: true });
    expect(reply.type === 'mesh' && reply.mesh ? reply.mesh.triangles : 0).toBeGreaterThan(0);
    expect(instance.inFlight).toBe(0);
  });

  test('a missing tile is empty ground; an unreachable one is an error', async () => {
    const { instance, replies, answered } = pool();
    let next = answered();
    instance.send(request(1, 'https://tiles.test/missing'), 'a');
    await next;
    expect(replies[0]).toMatchObject({ type: 'mesh', id: 1, mesh: null });

    next = answered();
    instance.send(request(2, 'https://tiles.test/offline'), 'a');
    await next;
    expect(replies[1]).toEqual({ type: 'error', id: 2, message: 'network down' });
  });

  test('a cancel is acknowledged, freeing the slot without an answer', async () => {
    const { instance, replies } = pool();
    instance.send(request(1, 'https://tiles.test/city.pbf'), 'a');
    instance.cancel(1, { type: 'cancel', id: 1 });
    expect(instance.inFlight).toBe(1);
    for (let i = 0; i < 50 && instance.inFlight > 0; i++)
      await new Promise((r) => setTimeout(r, 1));
    expect(instance.inFlight).toBe(0);
    expect(replies).toEqual([]);
  });

  test('a runtime that cannot be scheduled fails its requests and is replaced', async () => {
    const { instance, failed, answered } = pool();
    failScheduling = 1;
    const next = answered();
    instance.send(request(1, 'https://tiles.test/city.pbf'), 'a');
    await next;
    expect(failed).toEqual([{ id: 1, message: 'runtime gone' }]);
    expect(runtimes).toEqual(['goway-mesh', 'goway-mesh']);
    expect(instance.inFlight).toBe(0);
  });
});
