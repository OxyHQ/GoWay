/**
 * The model layer's bookkeeping, run for real (three's GLTFLoader parsing the
 * shipped GLB) against a fake pass that only records the scene it is asked
 * to draw — no WebGL needed. Each test pins one review finding on PR #123:
 *
 *  - instances of one asset must not share (and so mutate) materials;
 *  - a removed model reports `fallback`, so re-adding its id shows the marker;
 *  - the instance cap holds when the list is reordered;
 *  - a GLB with no (or a lying) Content-Length is cut off at the byte budget.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three';

import {
  createModelLayer,
  MAX_MODEL_FILE_BYTES,
  MAX_MODEL_INSTANCES,
  type ModelSpec,
  type ModelStatus,
} from '@/components/map/engine/city3d/models';

const GLB = new Uint8Array(
  readFileSync(
    join(import.meta.dir, '..', '..', '..', 'public', 'models', 'library', 'vehicle.sedan.glb'),
  ),
);
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function serve(body: () => Response): void {
  globalThis.fetch = (async () => body()) as unknown as typeof fetch;
}

const SAGRADA = { latitude: 41.4036, longitude: 2.1744 };
const spec = (id: string, extra: Partial<ModelSpec> = {}): ModelSpec => ({
  id,
  url: 'https://models.example/car.glb',
  placement: {
    position: SAGRADA,
    altitude: { meters: 0, reference: 'ground' },
    orientation: { heading: 0, pitch: 0, roll: 0 },
    scale: 1,
  },
  sizing: { mode: 'world' },
  minZoom: 0,
  maxZoom: 24,
  occlusion: 'buildings',
  ...extra,
});

/** A camera looking down at the model, through a plain perspective. */
const VIEW = {
  mercatorToClip: new THREE.Matrix4()
    .makePerspective(-0.5, 0.5, 0.5, -0.5, 0.1, 1000)
    .multiply(new THREE.Matrix4().makeTranslation(0, 0, -0.00001))
    .multiply(new THREE.Matrix4().makeScale(1e5, -1e5, 1e5))
    .multiply(
      new THREE.Matrix4().makeTranslation(
        -(180 + SAGRADA.longitude) / 360,
        -(
          0.5 -
          Math.log(Math.tan(Math.PI / 4 + (SAGRADA.latitude * Math.PI) / 360)) / (2 * Math.PI)
        ),
        0,
      ),
    ).elements,
  zoom: 17,
  center: { lng: SAGRADA.longitude, lat: SAGRADA.latitude },
};

function harness() {
  const statuses: Array<[string, ModelStatus]> = [];
  let lastScene: THREE.Scene | null = null;
  const layer = createModelLayer({
    requestRepaint: () => {},
    onStatus: (id, status) => statuses.push([id, status]),
    pageOrigin: 'https://goway.to',
  });
  // Whether the pass's backend is up (`tsl/tslPass.ts` → `drawScene`).
  let up = true;
  const pass = {
    drawScene: (scene: THREE.Scene) => {
      if (!up) return false;
      lastScene = scene;
      return true;
    },
  };
  const draw = () => layer.render(pass, VIEW, { width: 800, height: 600 });
  const setUp = (next: boolean) => {
    up = next;
  };
  return { layer, statuses, draw, scene: () => lastScene, setUp };
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** The materials of each drawn model instance (the scene's Group children). */
function instanceMaterials(scene: THREE.Scene): THREE.Material[][] {
  return scene.children
    .filter((child): child is THREE.Group => (child as THREE.Group).isGroup === true)
    .map((root) => {
      const out: THREE.Material[] = [];
      root.traverse((node) => {
        const mesh = node as THREE.Mesh;
        if (mesh.isMesh)
          out.push(...(Array.isArray(mesh.material) ? mesh.material : [mesh.material]));
      });
      return out;
    });
}

describe('model layer', () => {
  test('instances of one asset own their materials (occlusion and tint stay per instance)', async () => {
    serve(() => new Response(GLB));
    const h = harness();
    h.layer.setModels([spec('a'), spec('b', { occlusion: 'none', tint: '#ff0000' })]);
    await until(() => {
      if (!h.layer.active) return false;
      h.draw();
      return h.layer.anchors().length === 2;
    });
    const [a, b] = instanceMaterials(h.scene() as unknown as THREE.Scene);
    expect(a.length).toBeGreaterThan(0);
    const shared = a.filter((m) => b.includes(m));
    expect(shared).toEqual([]);
    expect(a.every((m) => m.depthTest)).toBe(true);
    expect(b.every((m) => !m.depthTest)).toBe(true);
  });

  test('a model is drawn only after a pass that drew: until then its marker stays', async () => {
    // Devin on #169: the TSL pass starts asynchronously (and may fail); a
    // model reported drawn hides its fallback marker and the building a
    // landmark replaces, so it must not be reported before a frame has it.
    serve(() => new Response(GLB));
    const h = harness();
    h.setUp(false);
    h.layer.setModels([spec('car')]);
    await until(() => h.layer.active);
    h.draw();
    h.draw();
    expect(h.statuses).toEqual([]);
    expect(h.layer.anchors()).toEqual([]);
    h.setUp(true);
    h.draw();
    expect(h.statuses).toEqual([['car', 'drawn']]);
    // A pass that stops drawing (the backend lost) brings the marker back.
    h.setUp(false);
    h.draw();
    expect(h.statuses).toEqual([
      ['car', 'drawn'],
      ['car', 'fallback'],
    ]);
  });

  test('a removed model reports fallback, so its id re-added starts as a marker', async () => {
    serve(() => new Response(GLB));
    const h = harness();
    h.layer.setModels([spec('car')]);
    await until(() => h.layer.active);
    h.draw();
    expect(h.statuses).toEqual([['car', 'drawn']]);
    h.layer.setModels([]);
    expect(h.statuses.at(-1)).toEqual(['car', 'fallback']);
  });

  test('the instance cap holds across a reorder', async () => {
    serve(() => new Response(GLB));
    const h = harness();
    const ids = Array.from({ length: MAX_MODEL_INSTANCES + 1 }, (_, i) => `m${i}`);
    h.layer.setModels(ids.map((id) => spec(id)));
    await until(() => {
      h.draw();
      return h.layer.anchors().length === MAX_MODEL_INSTANCES;
    });
    // Move the first (loaded) one past the cap; the one that was past it comes in.
    const reordered = [...ids.slice(1), ids[0]];
    h.layer.setModels(reordered.map((id) => spec(id)));
    await new Promise((r) => setTimeout(r, 100));
    h.draw();
    const drawn = h.layer.anchors().map((a) => a.id);
    expect(drawn.length).toBeLessThanOrEqual(MAX_MODEL_INSTANCES);
    expect(drawn).not.toContain('m0');
    expect(h.statuses.filter(([id]) => id === 'm0').at(-1)).toEqual(['m0', 'fallback']);
  });

  test('a body with no Content-Length is cut off at the byte budget, not buffered whole', async () => {
    const CHUNK = 64 * 1024;
    let pulled = 0;
    serve(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (pulled >= 3 * MAX_MODEL_FILE_BYTES) return controller.close();
              pulled += CHUNK;
              controller.enqueue(new Uint8Array(CHUNK));
            },
          }),
        ),
    );
    const h = harness();
    h.layer.setModels([spec('big')]);
    await until(() => h.statuses.length > 0);
    expect(h.statuses).toEqual([['big', 'fallback']]);
    expect(pulled).toBeLessThanOrEqual(MAX_MODEL_FILE_BYTES + 2 * CHUNK);
  });

  test('a model whose asset cannot load says so once — and only that one', async () => {
    serve(() => new Response('not found', { status: 404 }));
    const failed: string[] = [];
    const statuses: Array<[string, ModelStatus]> = [];
    const layer = createModelLayer({
      requestRepaint: () => {},
      onStatus: (id, status) => statuses.push([id, status]),
      onLoadFailed: (id) => failed.push(id),
      pageOrigin: 'https://goway.to',
    });
    layer.setModels([spec('broken')]);
    await until(() => failed.length > 0);
    expect(failed).toEqual(['broken']);
    expect(statuses).toEqual([['broken', 'fallback']]);

    // A model that loads is never reported as failed.
    serve(() => new Response(GLB));
    layer.setModels([spec('fine', { url: 'https://models.example/fine.glb' })]);
    await until(() => layer.active);
    expect(failed).toEqual(['broken']);
  });
});
