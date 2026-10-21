/**
 * The mesh service (`engine/city3d/meshService.ts`), the code BOTH mesh hosts
 * run — the web's Web Worker and native's worklet runtime — driven here through
 * a stand-in host: a tile meshes and its buffers are offered for transfer, a
 * re-mesh starts from memory, a missing tile is empty ground, a failed one is
 * an error, and a cancel is acknowledged — also on a host without
 * `AbortController` (a worklet runtime has none). And the PR #203 review:
 * buildings never wait on the tiles their trees are read against, a download
 * under way is joined rather than repeated, a tile with no trees asks for
 * nothing more, and a drawn tile's trees can be read again alone.
 */
import { afterEach, describe, expect, test } from 'bun:test';

import {
  createMeshService,
  type MeshHost,
  type TileResponse,
} from '@/components/map/engine/city3d/meshService';
import {
  CELL_INDEX_MAX_BYTES,
  volumeBytes,
  volumeTransferables,
} from '@/components/map/engine/camera/volumes';
import { packedTransferables } from '@/components/map/engine/city3d/packing';
import type {
  MeshWorkerRequest,
  MeshWorkerResponse,
} from '@/components/map/engine/city3d/protocol';
import { mercatorXFromLng, mercatorYFromLat } from '@/components/map/engine/city3d/tileMath';

import { cityTile, roadTile, SYNTHETIC_CENTRE } from './fixtures/syntheticCity';

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
const roadBytes = roadTile(TILE.z, TILE.x, TILE.y);
const PARENT = 'https://tiles.test/omt.pbf';
const ROADS = 'https://tiles.test/roads.pbf';
const NEIGHBOURS = [-1, 0, 1].flatMap((dy) =>
  [-1, 0, 1]
    .filter((dx) => dx !== 0 || dy !== 0)
    .map((dx) => ({
      tile: { z: Z, x: TILE.x + dx, y: TILE.y + dy },
      url: `https://tiles.test/roads-${dx}-${dy}.pbf`,
    })),
);
const LAYERS = {
  landcover: 'landcover',
  landuse: 'landuse',
  water: 'water',
  transportation: 'transportation',
  building: 'building',
};
const CONTEXT = {
  url: PARENT,
  tile: { z: 14, x: TILE.x >> 1, y: TILE.y >> 1 },
  roadsUrl: ROADS,
  roadNeighbours: NEIGHBOURS,
  mappedLayer: 'tree',
};

/** A city tile's mesh with its trees, read against the basemap and the road archive. */
function treeRequest(id: number): Extract<MeshWorkerRequest, { type: 'mesh' }> {
  return {
    ...(request(id) as Extract<MeshWorkerRequest, { type: 'mesh' }>),
    trees: LAYERS,
    treeContext: CONTEXT,
  };
}

/** The same tile's trees alone. */
function treesOnly(id: number): MeshWorkerRequest {
  return { type: 'trees', id, tile: TILE, url: URL_OK, trees: LAYERS, treeContext: CONTEXT };
}

function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Wait (a few ms at a time) until `done` holds. */
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !done(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(done()).toBe(true);
}

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

  test('buildings never wait on their trees: the trees follow when their tiles arrive', async () => {
    // The basemap and road tiles take as long as the test says.
    const gate = deferred();
    const h = host(async (url) => {
      if (url === URL_OK) return response(200, tileBytes);
      await gate.promise;
      return url === ROADS ? response(200, roadBytes) : response(404);
    });
    const handle = createMeshService(h.value);
    let next = h.replied();
    handle(treeRequest(1));
    await next;
    // The buildings, at once — the context tiles have not answered.
    const first = h.posted[0].message;
    if (first.type !== 'mesh') throw new Error(first.type);
    expect(first.mesh?.triangles).toBeGreaterThan(0);
    expect(first.more).toBe(true);
    expect(first.trees).toBeNull();
    // Asked for once the tile showed it has trees, while it was meshed: the
    // basemap tile, the road tile and the neighbours' its trees come near.
    const asked = h.fetched.map((f) => f.url);
    expect(asked.slice(0, 3)).toEqual([URL_OK, PARENT, ROADS]);
    const fetchedBefore = asked.length;

    next = h.replied();
    gate.resolve();
    await next;
    const second = h.posted[1].message;
    if (second.type !== 'trees') throw new Error(second.type);
    expect(second.id).toBe(1);
    expect(second.trees?.count).toBeGreaterThan(0);
    expect(second.treesComplete).toBe(true);
    expect(second.treeSettings?.street).toBeGreaterThan(0);
    if (second.trees) {
      expect(h.posted[1].transfer).toEqual([
        second.trees.data.buffer as ArrayBuffer,
        second.trees.form.buffer as ArrayBuffer,
      ]);
    }

    // The tiles are known now: the next mesh of it is one reply, nothing fetched.
    next = h.replied();
    handle(treeRequest(2));
    await next;
    const again = h.posted[2].message;
    if (again.type !== 'mesh') throw new Error(again.type);
    expect(again.more).toBeUndefined();
    expect(again.trees?.count).toBe(second.trees?.count ?? -1);
    expect(h.fetched).toHaveLength(fetchedBefore);
  });

  test('a download already under way is joined, not repeated', async () => {
    const gate = deferred();
    const h = host(async (url) => {
      await gate.promise;
      return url === URL_OK ? response(200, tileBytes) : response(404);
    });
    const handle = createMeshService(h.value);
    // Two levels of the same tile, and its trees read again, all at once.
    handle(treeRequest(1));
    handle({ ...treeRequest(2), lod: 1 });
    handle(treesOnly(3));
    gate.resolve();
    await until(() => h.posted.filter((p) => p.message.type !== 'mesh' || !p.message.more).length === 3);
    const asked = h.fetched.map((f) => f.url);
    expect(asked.filter((url) => url === URL_OK)).toHaveLength(1);
    expect(asked.filter((url) => url === PARENT)).toHaveLength(1);
    expect(asked.filter((url) => url === ROADS)).toHaveLength(1);
  });

  test('one request cancelled does not abort a download another still waits on', async () => {
    const gate = deferred();
    const h = host(async () => {
      await gate.promise;
      return response(200, tileBytes);
    });
    const handle = createMeshService(h.value);
    handle(request(1));
    handle(request(2));
    handle({ type: 'cancel', id: 1 });
    expect(h.fetched).toHaveLength(1);
    expect(h.fetched[0].signal?.aborted).toBe(false);
    gate.resolve();
    await until(() => h.posted.length === 2);
    expect(h.posted.map((p) => p.message.type).sort()).toEqual(['cancelled', 'mesh']);
  });

  test('a tile with no trees to set asks for no other tile', async () => {
    // Far outside the synthetic city: no buildings, no trees.
    const empty = cityTile(TILE.z, TILE.x + 200, TILE.y);
    const h = host(async (url) => (url === URL_OK ? response(200, empty) : response(404)));
    const handle = createMeshService(h.value);
    let next = h.replied();
    handle(treeRequest(1));
    await next;
    expect(h.posted[0].message).toMatchObject({ type: 'mesh', mesh: null, trees: null });
    // A tile the archive does not have: nothing else either.
    next = h.replied();
    handle({ ...treeRequest(2), url: 'https://tiles.test/404' });
    await next;
    expect(h.fetched.map((f) => f.url)).toEqual([URL_OK, 'https://tiles.test/404']);
  });

  test('a drawn tile’s trees read again alone: one trees reply, its buildings not meshed', async () => {
    let roadsUp = false;
    const h = host(async (url) => {
      if (url === URL_OK) return response(200, tileBytes);
      if (url === ROADS) return roadsUp ? response(200, roadBytes) : response(503);
      return response(404);
    });
    const handle = createMeshService(h.value);
    let next = h.replied();
    handle(treeRequest(1));
    await until(() => h.posted.some((p) => p.message.type === 'trees'));
    const failed = h.posted.find((p) => p.message.type === 'trees')?.message;
    expect(failed).toMatchObject({ type: 'trees', id: 1, treesComplete: false });

    roadsUp = true;
    const posted = h.posted.length;
    next = h.replied();
    handle(treesOnly(2));
    await next;
    expect(h.posted).toHaveLength(posted + 1);
    const reply = h.posted[posted].message;
    if (reply.type !== 'trees') throw new Error(reply.type);
    expect(reply.treesComplete).toBe(true);
    expect(reply.treeSettings?.street).toBeGreaterThan(0);
    // The tile came from memory; only the road tile was asked for again.
    expect(h.fetched.filter((f) => f.url === URL_OK)).toHaveLength(1);
  });

  test('a cancel while its trees are on their way is acknowledged, and they are not sent', async () => {
    const gate = deferred();
    const h = host(async (url) => {
      if (url === URL_OK) return response(200, tileBytes);
      await gate.promise;
      return response(404);
    });
    const handle = createMeshService(h.value);
    const next = h.replied();
    handle(treeRequest(1));
    await next;
    expect(h.posted[0].message).toMatchObject({ type: 'mesh', more: true });
    handle({ type: 'cancel', id: 1 });
    await until(() => h.posted.length === 2);
    gate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.posted.map((p) => p.message.type)).toEqual(['mesh', 'cancelled']);
  });

  test('a tile’s camera volumes come back with it, within the profile’s bytes, offered for transfer', async () => {
    const h = host(async () => response(200, tileBytes));
    const handle = createMeshService(h.value);
    const next = h.replied();
    const mesh1 = request(1) as Extract<MeshWorkerRequest, { type: 'mesh' }>;
    handle({ ...mesh1, volumes: { maxBytes: CELL_INDEX_MAX_BYTES, maxFootprintVertices: 4 } });
    await next;
    const message = h.posted[0].message;
    const mesh = message.type === 'mesh' ? message.mesh : null;
    expect(mesh?.volumes).toBeDefined();
    if (!mesh?.volumes) return;
    expect(volumeBytes(mesh.volumes)).toBeLessThanOrEqual(CELL_INDEX_MAX_BYTES);
    for (const buffer of volumeTransferables(mesh.volumes)) {
      expect(h.posted[0].transfer).toContain(buffer);
    }
  });

  test('a landmark’s columns are measured here, off the main thread, and offered for transfer', () => {
    const h = host(async () => response(404));
    const handle = createMeshService(h.value);
    // A 10 × 10 m, 30 m tall box: its top two triangles are enough.
    const positions = Float32Array.from([0, 0, 30, 10, 0, 30, 10, 10, 30, 0, 10, 30]);
    handle({
      type: 'volumes',
      id: 9,
      meshes: [{ positions, index: [0, 1, 2, 0, 2, 3] }],
      cellM: 2,
    });
    const message = h.posted[0].message;
    expect(message.type).toBe('volumes');
    const volumes = message.type === 'volumes' ? message.volumes : null;
    expect(volumes?.maxTop).toBeCloseTo(30, 3);
    if (volumes) expect(h.posted[0].transfer).toEqual(volumeTransferables(volumes));
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
