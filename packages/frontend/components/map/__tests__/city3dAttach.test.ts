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

type Call = [string, ...unknown[]];

function fakeMap(layers: string[]) {
  const calls: Call[] = [];
  const order = [...layers];
  const visibility = new Map<string, string>();
  const map = {
    calls,
    order,
    visibility,
    getLayer: (id: string) => (order.includes(id) ? { id } : undefined),
    getSource: () => ({ tiles: ['https://tiles.example/{z}/{x}/{y}.pbf'], maxzoom: 14 }),
    getLayoutProperty: (id: string) => visibility.get(id),
    setLayoutProperty: (id: string, name: string, value: string) => {
      calls.push(['setLayoutProperty', id, name, value]);
      visibility.set(id, value);
    },
    addLayer: (layer: { id: string }, beforeId?: string) => {
      calls.push(['addLayer', layer.id, beforeId]);
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
    const handle = await attachCity3d(asMap(map), { appearance: 'light', light: null });
    expect(handle).toBeNull();
    expect(map.calls).toEqual([]);
    expect(map.order).toEqual(['background', 'building', 'label-road', 'label-place']);
  });

  test('on GoWay’s style: directly before building-3d, below the labels, and reversible', async () => {
    const map = fakeMap(['background', 'building', BUILDING_3D_LAYER_ID, 'label-road']);
    const handle = await attachCity3d(asMap(map), { appearance: 'light', light: null });
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
});
