/**
 * What the relief prototype does to a map — and when it waits, declines or
 * cleans up. Run against a fake map that records every call, because the real
 * one needs WebGL.
 */
import { beforeAll, describe, expect, test } from 'bun:test';

import {
  GLOBE_PROJECTION,
  HILLSHADE_BEFORE_LAYER_ID,
  HILLSHADE_LAYER_ID,
  RELIEF_SOURCE_IDS,
  RELIEF_TERRAIN,
} from '@/lib/map/style/relief';

type AttachRelief = typeof import('@/components/map/reliefLayer.web').attachRelief;
let attachRelief: AttachRelief;

beforeAll(async () => {
  // A development global the adapter reads; Metro defines it, bun does not.
  (globalThis as { __DEV__?: boolean }).__DEV__ = false;
  ({ attachRelief } = await import('@/components/map/reliefLayer.web'));
});

type Listener = (event?: unknown) => void;

function fakeMap(options: { layers: string[]; loaded: boolean; pitch?: number }) {
  const calls: unknown[][] = [];
  const listeners = new Map<string, Set<Listener>>();
  const sources = new Set<string>();
  const layers = [...options.layers];
  let loaded = options.loaded;
  let terrain: unknown = null;
  let pitch = options.pitch ?? 0;
  const container = { style: { background: 'pink' }, clientWidth: 1280, clientHeight: 800 };
  const map = {
    calls,
    layers,
    container,
    fire(type: string, event?: unknown) {
      for (const listener of [...(listeners.get(type) ?? [])]) listener(event);
    },
    listenerCount: () => [...listeners.values()].reduce((n, set) => n + set.size, 0),
    load() {
      loaded = true;
      map.fire('style.load');
    },
    tilt(to: number) {
      pitch = to;
      map.fire('pitch');
    },
    on: (type: string, listener: Listener) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)?.add(listener);
    },
    once: (type: string, listener: Listener) => {
      const wrapped: Listener = (event) => {
        listeners.get(type)?.delete(wrapped);
        listener(event);
      };
      map.on(type, wrapped);
    },
    off: (type: string, listener: Listener) => {
      listeners.get(type)?.delete(listener);
      // `once` wraps; a test of detach only needs the plain listeners gone.
    },
    getContainer: () => container,
    setSky: (sky: unknown) => {
      if (!loaded) throw new Error('Style is not done loading.');
      calls.push(['setSky', sky]);
    },
    setProjection: (projection: unknown) => calls.push(['setProjection', projection]),
    getLayer: (id: string) => (layers.includes(id) ? { id } : undefined),
    getSource: (id: string) => (sources.has(id) ? { id } : undefined),
    addSource: (id: string, spec: unknown) => {
      sources.add(id);
      calls.push(['addSource', id, (spec as { type: string }).type]);
    },
    addLayer: (layer: { id: string }, before?: string) => {
      layers.splice(before ? layers.indexOf(before) : layers.length, 0, layer.id);
      calls.push(['addLayer', layer.id, before]);
    },
    getTerrain: () => terrain,
    setTerrain: (next: unknown) => {
      terrain = next;
      calls.push(['setTerrain', next]);
    },
    getPitch: () => pitch,
    getZoom: () => 2,
    getCenter: () => ({ lng: 0, lat: 20 }),
    getPadding: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
    getVerticalFieldOfView: () => 36.87,
  };
  return map;
}

const asMap = (map: ReturnType<typeof fakeMap>) => map as unknown as Parameters<AttachRelief>[0];
const GOWAY_LAYERS = ['background', 'landcover', HILLSHADE_BEFORE_LAYER_ID, 'road', 'label'];

describe('attachRelief', () => {
  test('the low quality preset keeps the hillshade and never turns 3D terrain on; live', () => {
    const map = fakeMap({ layers: GOWAY_LAYERS, loaded: true });
    const handle = attachRelief(asMap(map), {
      flags: { globe: true, terrain: true },
      appearance: 'light',
      terrain3d: false,
    });
    expect(map.layers).toContain(HILLSHADE_LAYER_ID);
    map.tilt(45);
    expect(map.calls.some((call) => call[0] === 'setTerrain')).toBe(false);
    // The profile changes (Settings → High quality): tilted, terrain comes on.
    handle.setTerrain3d(true);
    expect(map.calls.at(-1)).toEqual(['setTerrain', RELIEF_TERRAIN]);
    // And back: it goes off at once, not at the next tilt.
    handle.setTerrain3d(false);
    expect(map.calls.at(-1)).toEqual(['setTerrain', null]);
    handle.detach();
  });

  test("globe and terrain on GoWay's style: the hillshade under water, terrain only when tilted", () => {
    const map = fakeMap({ layers: GOWAY_LAYERS, loaded: true });
    const handle = attachRelief(asMap(map), {
      flags: { globe: true, terrain: true },
      appearance: 'light',
    });
    expect(map.calls.map((call) => call[0])).toEqual([
      'setSky',
      'setProjection',
      'addSource',
      'addSource',
      'addLayer',
    ]);
    expect(map.calls[1]).toEqual(['setProjection', GLOBE_PROJECTION]);
    expect(map.layers).toEqual([
      'background',
      'landcover',
      HILLSHADE_LAYER_ID,
      HILLSHADE_BEFORE_LAYER_ID,
      'road',
      'label',
    ]);
    expect(map.container.style.background).toContain('radial-gradient(ellipse');

    map.tilt(1);
    expect(map.calls.some((call) => call[0] === 'setTerrain')).toBe(false);
    map.tilt(30);
    expect(map.calls.at(-1)).toEqual(['setTerrain', RELIEF_TERRAIN]);
    map.tilt(1);
    expect(map.calls.at(-1)).toEqual(['setTerrain', RELIEF_TERRAIN]);
    map.tilt(0);
    expect(map.calls.at(-1)).toEqual(['setTerrain', null]);

    handle.detach();
    expect(map.container.style.background).toBe('pink');
    expect(map.listenerCount()).toBe(0);
    map.tilt(45);
    expect(map.calls.at(-1)).toEqual(['setTerrain', null]);
  });

  test('opened tilted, the terrain is on from the start', () => {
    const map = fakeMap({ layers: GOWAY_LAYERS, loaded: true, pitch: 60 });
    attachRelief(asMap(map), { flags: { globe: false, terrain: true }, appearance: 'dark' });
    expect(map.calls.at(-1)).toEqual(['setTerrain', RELIEF_TERRAIN]);
    expect(map.calls.some((call) => call[0] === 'setProjection')).toBe(false);
    // No globe, no space: the container is left alone.
    expect(map.container.style.background).toBe('pink');
  });

  test('before the style loads nothing is touched; on style.load everything is', () => {
    const map = fakeMap({ layers: GOWAY_LAYERS, loaded: false });
    attachRelief(asMap(map), { flags: { globe: true, terrain: true }, appearance: 'light' });
    expect(map.calls).toEqual([]);
    map.load();
    expect(map.calls.map((call) => call[0])).toContain('setProjection');
    expect(map.calls.map((call) => call[0])).toContain('addLayer');
  });

  test('an imagery style gets the terrain the photograph drapes over, and no hillshade', () => {
    const map = fakeMap({
      layers: ['background', 'goway:imagery:base', 'goway:imagery:detail', 'labels'],
      loaded: true,
      pitch: 60,
    });
    attachRelief(asMap(map), { flags: { globe: true, terrain: true }, appearance: 'dark' });
    const kinds = map.calls.map((call) => call[0]);
    expect(kinds).toEqual(['setSky', 'setProjection', 'addSource', 'setTerrain']);
    expect(map.calls.some((call) => call[0] === 'addLayer')).toBe(false);
  });

  test('a style with no water anchor gets the globe, but no hillshade and no terrain', () => {
    const map = fakeMap({ layers: ['background', 'roads', 'labels'], loaded: true, pitch: 60 });
    attachRelief(asMap(map), { flags: { globe: true, terrain: true }, appearance: 'light' });
    const kinds = map.calls.map((call) => call[0]);
    expect(kinds).toEqual(['setSky', 'setProjection']);
    expect(map.layers).toEqual(['background', 'roads', 'labels']);
    map.tilt(50);
    expect(map.calls.some((call) => call[0] === 'setTerrain')).toBe(false);
  });

  test('both sources are the relief namespace, never the basemap id', () => {
    const map = fakeMap({ layers: GOWAY_LAYERS, loaded: true });
    attachRelief(asMap(map), { flags: { globe: false, terrain: true }, appearance: 'light' });
    const added = map.calls.filter((call) => call[0] === 'addSource').map((call) => call[1]);
    expect(added).toEqual([RELIEF_SOURCE_IDS.hillshade, RELIEF_SOURCE_IDS.terrain]);
  });
});
