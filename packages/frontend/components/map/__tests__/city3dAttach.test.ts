/**
 * Where the city-3D layer goes in a style — and when it does not go at all.
 *
 * PR #119 review: on a style with no `building-3d` (the `openfreemap` escape
 * hatch, a style-URL override) the first version called `addLayer` with no
 * `beforeId`, which appends the meshes ABOVE every label. The layer now
 * declines to attach and leaves such a style untouched; on GoWay's own style
 * it goes directly before `building-3d` and swaps it out, and `detach` swaps
 * it back. Run against a fake map that records every call, because the real
 * one needs WebGL.
 */
import { describe, expect, test } from 'bun:test';

import { attachCity3d, CITY3D_LAYER_ID, MODELS_LAYER_ID } from '@/components/map/city3dLayer.web';
import { BUILDING_3D_LAYER_ID, BUILDINGS_LIGHT } from '@/lib/map/style/buildings3d';
import { createAnimationClock } from '@/components/map/perf/animationClock';
import { QUALITY_PRESETS } from '@/lib/map/quality/profile';

/** What every attach needs beyond the test's own options: a profile and the clock. */
const ENGINE = {
  quality: { ...QUALITY_PRESETS.high, reason: 'test' },
  clock: createAnimationClock({ hz: 30, idleMs: 0, requestFrame: () => {} }),
};

type Call = [string, ...unknown[]];

function fakeMap(layers: string[]) {
  const calls: Call[] = [];
  const order = [...layers];
  const visibility = new Map<string, string>();
  const added = new Map<string, Record<string, unknown>>();
  let maxPitch = 60;
  const map = {
    calls,
    order,
    visibility,
    added,
    getMaxPitch: () => maxPitch,
    setMaxPitch: (pitch: number) => {
      calls.push(['setMaxPitch', pitch]);
      maxPitch = pitch;
    },
    getLayer: (id: string) => (order.includes(id) ? { id } : undefined),
    getSource: () => ({ tiles: ['https://tiles.example/{z}/{x}/{y}.pbf'], maxzoom: 14 }),
    getLayoutProperty: (id: string) => visibility.get(id),
    setLayoutProperty: (id: string, name: string, value: string) => {
      calls.push(['setLayoutProperty', id, name, value]);
      visibility.set(id, value);
    },
    addLayer: (layer: { id: string }, beforeId?: string) => {
      calls.push(['addLayer', layer.id, beforeId]);
      added.set(layer.id, layer);
      order.splice(beforeId ? order.indexOf(beforeId) : order.length, 0, layer.id);
    },
    removeLayer: (id: string) => {
      calls.push(['removeLayer', id]);
      order.splice(order.indexOf(id), 1);
    },
    getStyle: () => ({
      layers: order.map((id) => ({ id, type: id.startsWith('label') ? 'symbol' : 'fill' })),
    }),
    getLight: () => BUILDINGS_LIGHT.light,
    getBearing: () => 0,
    triggerRepaint: () => {},
  };
  return map;
}

// The structural fake stands in for `maplibregl.Map`; only these calls are made.
const asMap = (map: ReturnType<typeof fakeMap>) =>
  map as unknown as Parameters<typeof attachCity3d>[0];

describe('attachCity3d', () => {
  test('declines on a style without building-3d, and touches nothing', async () => {
    const map = fakeMap(['background', 'building', 'label-road', 'label-place']);
    const handle = await attachCity3d(asMap(map), { ...ENGINE, appearance: 'light', light: null });
    expect(handle).toBeNull();
    expect(map.calls).toEqual([]);
    expect(map.order).toEqual(['background', 'building', 'label-road', 'label-place']);
  });

  test('on GoWay’s style: directly before building-3d, below the labels, and reversible', async () => {
    const map = fakeMap(['background', 'building', BUILDING_3D_LAYER_ID, 'label-road']);
    const handle = await attachCity3d(asMap(map), { ...ENGINE, appearance: 'light', light: null });
    expect(handle).not.toBeNull();
    expect(map.order).toEqual([
      'background',
      'building',
      CITY3D_LAYER_ID,
      BUILDING_3D_LAYER_ID,
      'label-road',
    ]);
    expect(map.visibility.get(BUILDING_3D_LAYER_ID)).toBe('none');

    handle?.detach();
    expect(map.order).toEqual(['background', 'building', BUILDING_3D_LAYER_ID, 'label-road']);
    expect(map.visibility.get(BUILDING_3D_LAYER_ID)).toBe('visible');
  });

  test('models (SDK_MAP_MODELS phase 1): their own layer, above the overlays and below the labels', async () => {
    const map = fakeMap(['background', 'building', BUILDING_3D_LAYER_ID, 'overlay', 'label-road']);
    const handle = await attachCity3d(asMap(map), {
      ...ENGINE,
      appearance: 'light',
      light: null,
      buildings: false,
    });
    expect(handle).not.toBeNull();
    // Models only: the extrusion keeps drawing, nothing is added until a model is.
    expect(map.order).toEqual([
      'background',
      'building',
      BUILDING_3D_LAYER_ID,
      'overlay',
      'label-road',
    ]);
    expect(map.visibility.get(BUILDING_3D_LAYER_ID)).toBeUndefined();

    handle?.setModels([
      {
        id: 'car',
        url: 'https://models.example/car.glb',
        placement: {
          position: { latitude: 41.39, longitude: 2.17 },
          altitude: { meters: 0, reference: 'ground' },
          orientation: { heading: 0, pitch: 0, roll: 0 },
          scale: 1,
        },
        sizing: { mode: 'world' },
        minZoom: 0,
        maxZoom: 24,
        occlusion: 'buildings',
      },
    ]);
    expect(map.order).toEqual([
      'background',
      'building',
      BUILDING_3D_LAYER_ID,
      'overlay',
      MODELS_LAYER_ID,
      'label-road',
    ]);

    handle?.detach();
    expect(map.order).toEqual([
      'background',
      'building',
      BUILDING_3D_LAYER_ID,
      'overlay',
      'label-road',
    ]);
  });

  test('without the sky: no offscreen pass, and the pitch ceiling is left alone', async () => {
    const map = fakeMap(['background', 'building', BUILDING_3D_LAYER_ID, 'label-road']);
    const handle = await attachCity3d(asMap(map), { ...ENGINE, appearance: 'light', light: null });
    expect(map.added.get(CITY3D_LAYER_ID)?.prerender).toBeUndefined();
    expect(map.calls.some(([name]) => name === 'setMaxPitch')).toBe(false);
    handle?.detach();
  });

  test('with the sky: a shadow pass, and the pitch ceiling left to MapCanvas', async () => {
    // `MapCanvas.web.tsx` owns `setMaxPitch` (`maxPitchFor`): an adapter that
    // set it too was overridden by the next `interaction` change (review of #125).
    const map = fakeMap(['background', 'building', BUILDING_3D_LAYER_ID, 'label-road']);
    const handle = await attachCity3d(asMap(map), {
      ...ENGINE,
      appearance: 'light',
      light: null,
      sky: { at: null },
    });
    expect(typeof map.added.get(CITY3D_LAYER_ID)?.prerender).toBe('function');
    handle?.setTime(new Date(2026, 5, 21, 20, 50));
    handle?.detach();
    expect(map.calls.some(([name]) => name === 'setMaxPitch')).toBe(false);
    expect(map.order).toEqual(['background', 'building', BUILDING_3D_LAYER_ID, 'label-road']);
  });
});

describe('city3d passes (GoWay Live’s 3D shapes)', () => {
  test('a pass goes directly above the buildings, and leaves with them', async () => {
    const map = fakeMap(['background', 'building', BUILDING_3D_LAYER_ID, 'label-road']);
    const handle = await attachCity3d(asMap(map), { appearance: 'light', light: null });
    let disposed = 0;
    const remove = handle?.addPass({ id: 'live3d', render: () => {}, dispose: () => disposed++ });
    expect(map.order).toEqual([
      'background',
      'building',
      CITY3D_LAYER_ID,
      'goway:live3d',
      BUILDING_3D_LAYER_ID,
      'label-road',
    ]);
    remove?.();
    expect(map.order).not.toContain('goway:live3d');
    expect(disposed).toBe(1);

    handle?.addPass({ id: 'live3d', render: () => {}, dispose: () => disposed++ });
    handle?.detach();
    expect(map.order).toEqual(['background', 'building', BUILDING_3D_LAYER_ID, 'label-road']);
    expect(disposed).toBe(2);
  });
});

describe('MapLibre’s own sky under the city sky', () => {
  test('its terrain fog is switched off, so the basemap is not hazed twice', async () => {
    // Owner preview, Madrid (review of #125): MapLibre's ground fog, coloured
    // by the city sky's pale horizon, fogged the draped basemap on top of the
    // city sky's own haze. The adapter hands MapLibre `fog-ground-blend: 1`
    // (no ground fog) with the colours, and restores the previous sky on detach.
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const adapter = readFileSync(join(import.meta.dir, '..', 'city3dLayer.web.ts'), 'utf8');
    const call = adapter.slice(
      adapter.indexOf('map.setSky({'),
      adapter.indexOf('});', adapter.indexOf('map.setSky({')),
    );
    expect(call).toContain("'fog-color': colours.fog");
    expect(call).toMatch(/'fog-ground-blend': 1\b/);
    expect(adapter).toContain('map.setSky(previousHostSky ?? {})');
  });
});
