/**
 * GoWay Live's 3D pass (`engine/live3d/livePass.ts`) draws through the city
 * engine's TSL pass (`docs/MAP_NATIVE_3D.md` → Phase 2): the library loaded
 * from disk, one live bus placed, and the scene it hands the pass holds node
 * materials that encode their output to sRGB as `WebGLRenderer` did.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three';

import { createLivePass } from '@/components/map/engine/live3d/livePass';
import { FLEETS } from '@/features/live/fleets';

const LIBRARY = join(import.meta.dir, '..', '..', '..', 'public', 'models', 'library');
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const MADRID = { latitude: 40.4168, longitude: -3.7038 };

describe('the live 3D pass', () => {
  test('draws a live vehicle through the TSL pass, with node materials', async () => {
    globalThis.fetch = (async (url: string) =>
      new Response(
        readFileSync(join(LIBRARY, String(url).split('/').pop() ?? '')),
      )) as unknown as typeof fetch;
    const [key, model] = Object.entries(FLEETS).find(([, m]) => m.form === 'bus') ?? [];
    expect(key).toBeDefined();
    let repaints = 0;
    const pass = createLivePass({
      glyphs: {},
      models: { [key as string]: model as NonNullable<typeof model> },
      points: () => [
        {
          id: 'bus-1',
          glyph: 'bus',
          coordinate: MADRID,
          heading: 90,
          altitude: null,
          opacity: 1,
          model: key,
        },
      ],
      requestRepaint: () => {
        repaints++;
      },
    });
    // The library loads, then asks for a frame.
    const start = Date.now();
    while (repaints === 0 && Date.now() - start < 5000) await new Promise((r) => setTimeout(r, 10));
    expect(repaints).toBeGreaterThan(0);
    const drawn: THREE.Scene[] = [];
    pass.render({ drawScene: (scene: THREE.Scene) => drawn.push(scene) }, {
      mercatorToClip: new THREE.Matrix4().identity().elements,
      zoom: 17,
      center: { lng: MADRID.longitude, lat: MADRID.latitude },
    } as never);
    expect(drawn).toHaveLength(1);
    const meshes: THREE.Mesh[] = [];
    drawn[0].traverse((node) => {
      if ((node as THREE.Mesh).isMesh) meshes.push(node as THREE.Mesh);
    });
    const bus = meshes.find(
      (m) => (m as THREE.InstancedMesh).isInstancedMesh,
    ) as THREE.InstancedMesh;
    expect(bus.count).toBe(1);
    for (const mesh of meshes) {
      const material = mesh.material as THREE.Material & {
        isNodeMaterial?: boolean;
        outputNode?: unknown;
      };
      expect(material.isNodeMaterial).toBe(true);
      expect(material.outputNode).toBeTruthy();
    }
    pass.dispose();
  });
});
