/**
 * The GoWay Live adapter against a fake map: what it adds, where, what a
 * glyph's properties are, what a tap resolves to, and that detaching leaves
 * the style as it found it. The 3D half hands the city engine a pass and
 * takes it back.
 */
import { describe, expect, test } from 'bun:test';

import {
  attachLive,
  featureCollection,
  frameIntervalMs,
  imageName,
  LIVE_ICON_LAYER_ID,
  LIVE_RING_LAYER_ID,
  LIVE_SOURCE_ID,
} from '@/components/map/liveLayer.web';
import type { MapLiveLayer, MapLivePoint } from '@/components/map/types';

const GLYPHS = {
  aircraft: { shape: 'aircraft', color: '#7c3aed' },
  'transit-rail': { shape: 'vehicle', color: '#0f766e' },
} as const;

function point(overrides: Partial<MapLivePoint> = {}): MapLivePoint {
  return {
    id: 'adsb-lol:abc123',
    glyph: 'aircraft',
    coordinate: { latitude: 41.3, longitude: 2.1 },
    heading: 90,
    altitude: 900,
    opacity: 1,
    ...overrides,
  };
}

describe('featureCollection', () => {
  test('a directional glyph rotates; a glyph with no heading is drawn still, unrotated', () => {
    const { features } = featureCollection(
      [
        point(),
        point({
          id: 'renfe:1',
          glyph: 'transit-rail',
          heading: null,
          altitude: null,
          label: 'R2N',
        }),
      ],
      { glyphs: GLYPHS, threeD: false },
    );
    expect(features[0]?.properties).toMatchObject({
      icon: imageName('aircraft', true),
      heading: 90,
      opacity: 1,
    });
    expect(features[1]?.properties).toMatchObject({
      icon: imageName('transit-rail', false),
      heading: 0,
      label: 'R2N',
    });
    expect(features[0]?.geometry.coordinates).toEqual([2.1, 41.3]);
  });

  test('in 3D an airborne aircraft’s glyph becomes its shadow; unknown glyphs and NaN are skipped', () => {
    const { features } = featureCollection(
      [
        point(),
        point({ id: 'x', glyph: 'ufo' }),
        point({ id: 'nan', coordinate: { latitude: Number.NaN, longitude: 0 } }),
      ],
      { glyphs: GLYPHS, threeD: true },
    );
    expect(features).toHaveLength(1);
    expect(features[0]?.properties?.opacity).toBeCloseTo(0.4, 6);
  });

  test('throttles frames by zoom', () => {
    expect(frameIntervalMs(14)).toBe(50);
    expect(frameIntervalMs(10)).toBe(100);
    expect(frameIntervalMs(6)).toBe(250);
  });
});

function fakeMap() {
  const layers: string[] = ['background', 'label-place'];
  const sources = new Map<string, { setData: (data: unknown) => void; data: unknown }>();
  const handlers = new Map<string, () => void>();
  const map = {
    layers,
    sources,
    hasImage: () => false,
    addImage: () => {},
    removeImage: () => {},
    addSource: (id: string, spec: { data: unknown }) => {
      const source = {
        data: spec.data,
        setData: (data: unknown) => {
          source.data = data;
        },
      };
      sources.set(id, source);
    },
    getSource: (id: string) => sources.get(id),
    removeSource: (id: string) => sources.delete(id),
    addLayer: (layer: { id: string }, beforeId?: string) => {
      layers.splice(beforeId ? layers.indexOf(beforeId) : layers.length, 0, layer.id);
    },
    getLayer: (id: string) => (layers.includes(id) ? { id } : undefined),
    removeLayer: (id: string) => layers.splice(layers.indexOf(id), 1),
    on: (event: string, handler: () => void) => handlers.set(event, handler),
    off: (event: string) => handlers.delete(event),
    getBounds: () => ({
      getWest: () => 2,
      getSouth: () => 41.3,
      getEast: () => 2.3,
      getNorth: () => 41.5,
    }),
    getZoom: () => 12,
    triggerRepaint: () => {},
    queryRenderedFeatures: () => [
      { properties: { id: 'far' }, geometry: { type: 'Point', coordinates: [5, 5] } },
      { properties: { id: 'adsb-lol:abc123' }, geometry: { type: 'Point', coordinates: [10, 10] } },
    ],
    // A projection that is the identity on these test coordinates.
    project: ([x, y]: [number, number]) => ({ x, y }),
  };
  return map;
}

function fakeLayer(points: MapLivePoint[]) {
  const views: unknown[] = [];
  const layer: MapLiveLayer = {
    glyphs: GLYPHS,
    sample: () => points,
    animating: () => false,
    subscribe: () => () => {},
    setViewport: (view) => views.push(view),
    select: () => {},
    credits: () => [],
  };
  return { layer, views };
}

describe('attachLive', () => {
  test('adds its source and layers on top, reports the viewport, and detaches cleanly', async () => {
    const map = fakeMap();
    const { layer, views } = fakeLayer([point()]);
    const handle = attachLive(map as never, layer, { appearance: 'light' });
    expect(map.layers).toEqual([
      'background',
      'label-place',
      LIVE_RING_LAYER_ID,
      LIVE_ICON_LAYER_ID,
    ]);
    expect(views).toEqual([{ bounds: { west: 2, south: 41.3, east: 2.3, north: 41.5 }, zoom: 12 }]);
    await new Promise((resolve) => setTimeout(resolve, 40));
    const data = map.sources.get(LIVE_SOURCE_ID)?.data as GeoJSON.FeatureCollection;
    expect(data.features).toHaveLength(1);
    expect(handle.pick({ x: 10, y: 10 })).toBe('adsb-lol:abc123');
    handle.detach();
    expect(map.layers).toEqual(['background', 'label-place']);
    expect(map.sources.size).toBe(0);
    expect(handle.pick({ x: 10, y: 10 })).toBeNull();
  });

  test('gives the city engine a 3D pass, and takes it back', async () => {
    const map = fakeMap();
    const { layer } = fakeLayer([point()]);
    const handle = attachLive(map as never, layer, { appearance: 'dark' });
    const added: string[] = [];
    let removed = 0;
    handle.setCity({
      setLight: () => {},
      setModels: () => {},
      moveModel: () => {},
      pickModel: () => null,
      setNightFactor: () => {},
      detach: () => {},
      addPass: (pass) => {
        added.push(pass.id);
        return () => {
          removed++;
        };
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(added).toEqual(['live3d']);
    handle.setCity(null);
    expect(removed).toBe(1);
    handle.detach();
  });
});
