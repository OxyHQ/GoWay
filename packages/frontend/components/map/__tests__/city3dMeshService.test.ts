/**
 * The mesh service (`engine/city3d/meshService.ts`), the code BOTH mesh hosts
 * run — the web's Web Worker and native's worklet runtime — driven here through
 * a stand-in host: a tile meshes and its buffers are offered for transfer, a
 * re-mesh starts from memory, a missing tile is empty ground, a failed one is
 * an error, and a cancel is acknowledged — also on a host without
 * `AbortController` (a worklet runtime has none).
 */
import { afterEach, describe, expect, test } from 'bun:test';

import {
  createMeshService,
  type MeshHost,
  type TileResponse,
} from '@/components/map/engine/city3d/meshService';
import { packedTransferables } from '@/components/map/engine/city3d/packing';
import type {
  MeshWorkerRequest,
  MeshWorkerResponse,
} from '@/components/map/engine/city3d/protocol';
import { mercatorXFromLng, mercatorYFromLat } from '@/components/map/engine/city3d/tileMath';

import { cityTile, SYNTHETIC_CENTRE } from './fixtures/syntheticCity';

const Z = 15;
const TILE = {
  z: Z,
  x: Math.floor(mercatorXFromLng(SYNTHETIC_CENTRE.lng) * 2 ** Z),
  y: Math.floor(mercatorYFromLat(SYNTHETIC_CENTRE.lat) * 2 ** Z),
};
const URL_OK = 'https://tiles.test/city.pbf';

function request(id: number, url = URL_OK): MeshWorkerRequest {
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

function response(status: number, bytes?: Uint8Array): TileResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    arrayBuffer: async () => (bytes ? bytes.slice().buffer : new ArrayBuffer(0)),
  };
}

/** A host that answers fetches from `answer`, recording everything. */
function host(answer: (url: string) => Promise<TileResponse>) {
  const posted: Array<{ message: MeshWorkerResponse; transfer: ArrayBuffer[] }> = [];
  const fetched: Array<{ url: string; signal: AbortSignal | undefined }> = [];
  let settle: () => void = () => {};
  const replied = () =>
    new Promise<void>((resolve) => {
      settle = resolve;
    });
  const value: MeshHost = {
    post: (message, transfer) => {
      posted.push({ message, transfer });
      settle();
    },
    fetch: (url, signal) => {
      fetched.push({ url, signal });
      return answer(url);
    },
    now: () => performance.now(),
  };
  return { value, posted, fetched, replied };
}

const tileBytes = cityTile(TILE.z, TILE.x, TILE.y);

describe('createMeshService', () => {
  test('a city tile meshes, its buffers offered for transfer; a re-mesh starts from memory', async () => {
    const h = host(async () => response(200, tileBytes));
    const handle = createMeshService(h.value);

    let next = h.replied();
    handle(request(1));
    await next;
    const [first] = h.posted;
    expect(first.message.type).toBe('mesh');
    const mesh = first.message.type === 'mesh' ? first.message.mesh : null;
    expect(mesh).not.toBeNull();
    expect(mesh?.triangles).toBeGreaterThan(0);
    if (mesh) expect(first.transfer).toEqual(packedTransferables(mesh));

    next = h.replied();
    handle(request(2));
    await next;
    expect(h.posted[1].message).toMatchObject({ type: 'mesh', id: 2 });
    expect(h.fetched).toHaveLength(1);
  });

  test('a tile the archive does not have is empty ground; a failed one is an error', async () => {
    const h = host(async (url) => response(url.endsWith('404') ? 404 : 500));
    const handle = createMeshService(h.value);

    let next = h.replied();
    handle(request(1, 'https://tiles.test/404'));
    await next;
    expect(h.posted[0].message).toEqual({
      type: 'mesh',
      id: 1,
      mesh: null,
      trees: null,
      meshMs: 0,
      treeMs: 0,
      treesComplete: true,
    });

    next = h.replied();
    handle(request(2, 'https://tiles.test/500'));
    await next;
    expect(h.posted[1].message).toEqual({
      type: 'error',
      id: 2,
      message: 'tile https://tiles.test/500 answered 500',
    });
  });

  test('a cancel aborts the fetch and is acknowledged, not answered', async () => {
    let release: (value: TileResponse) => void = () => {};
    const h = host(() => new Promise((resolve) => (release = resolve)));
    const handle = createMeshService(h.value);

    const next = h.replied();
    handle(request(1));
    handle({ type: 'cancel', id: 1 });
    expect(h.fetched[0].signal?.aborted).toBe(true);
    release(response(200, tileBytes));
    await next;
    expect(h.posted.map((p) => p.message)).toEqual([{ type: 'cancelled', id: 1 }]);
  });

  describe('on a host without AbortController', () => {
    const original = globalThis.AbortController;
    afterEach(() => {
      globalThis.AbortController = original;
    });

    test('the fetch gets no signal, and a cancel still drops the result', async () => {
      // A worklet runtime's globals: no AbortController.
      (globalThis as { AbortController?: unknown }).AbortController = undefined;
      let release: (value: TileResponse) => void = () => {};
      const h = host(() => new Promise((resolve) => (release = resolve)));
      const handle = createMeshService(h.value);

      const next = h.replied();
      handle(request(1));
      expect(h.fetched[0].signal).toBeUndefined();
      handle({ type: 'cancel', id: 1 });
      release(response(200, tileBytes));
      await next;
      expect(h.posted.map((p) => p.message)).toEqual([{ type: 'cancelled', id: 1 }]);
    });
  });

  test('a cancel for a request no longer in flight is ignored', () => {
    const h = host(async () => response(404));
    const handle = createMeshService(h.value);
    handle({ type: 'cancel', id: 99 });
    expect(h.posted).toEqual([]);
  });
});
