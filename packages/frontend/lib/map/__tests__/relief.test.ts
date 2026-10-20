/**
 * The relief prototype's style fragments are valid MapLibre style, the
 * terrain switches with hysteresis, the globe's outline is where MapLibre
 * draws the globe, and the elevation credit appears exactly when relief does.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';

import { resolveMapAttribution, resolveTerrainTileUrl } from '@/lib/map/provider';
import {
  GLOBE_PROJECTION,
  globeSilhouette,
  HILLSHADE_BEFORE_LAYER_ID,
  HILLSHADE_LAYER_ID,
  hillshadeLayer,
  RELIEF_DEM,
  RELIEF_SOURCE_IDS,
  RELIEF_TERRAIN,
  reliefDemSource,
  reliefSky,
  SPACE_BASE,
  spaceBackdrop,
  starfield,
  TERRAIN_OFF_PITCH,
  TERRAIN_ON_PITCH,
  terrainWanted,
} from '@/lib/map/style/relief';

const TILES = 'https://goway.to/map/terrain/{z}/{x}/{y}.webp';

describe('style fragments', () => {
  for (const appearance of ['light', 'dark'] as const) {
    test(`a style carrying all of them validates (${appearance})`, () => {
      const errors = validateStyleMin({
        version: 8,
        sources: {
          [RELIEF_SOURCE_IDS.hillshade]: reliefDemSource(TILES),
          [RELIEF_SOURCE_IDS.terrain]: reliefDemSource(TILES),
          water: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
        },
        layers: [
          { id: 'background', type: 'background' },
          hillshadeLayer(appearance),
          { id: HILLSHADE_BEFORE_LAYER_ID, type: 'fill', source: 'water' },
        ],
        terrain: RELIEF_TERRAIN,
        sky: reliefSky(appearance),
        projection: GLOBE_PROJECTION,
      });
      expect(errors.map((e) => e.message)).toEqual([]);
    });
  }

  test('the DEM is Mapterhorn-shaped and retains available regional elevation through z16', () => {
    const source = reliefDemSource(TILES);
    expect(source).toMatchObject({ type: 'raster-dem', encoding: 'terrarium', tileSize: 512 });
    expect(source.maxzoom).toBe(16);
    expect(RELIEF_DEM.maxzoom).toBe(16);
    expect(source.tiles).toEqual([TILES]);
    expect(source.attribution).toContain('https://mapterhorn.com/attribution');
  });

  test('hillshade and terrain read separate sources, and the hillshade is in the GoWay namespace', () => {
    expect(hillshadeLayer('light').source).not.toBe(RELIEF_TERRAIN.source);
    expect(HILLSHADE_LAYER_ID.startsWith('goway:')).toBe(true);
    // Native draws this layer too: nothing MapLibre Native lacks.
    expect(Object.keys(hillshadeLayer('dark').paint ?? {})).not.toContain('hillshade-method');
  });

  test('no hillshade (and so no DEM download) at whole-globe zooms', () => {
    expect(hillshadeLayer('light').minzoom).toBe(3);
  });

  test('true elevation: no exaggeration', () => {
    expect(RELIEF_TERRAIN.exaggeration).toBe(1);
  });

  test("MapLibre's atmosphere stays off; the glow is GoWay's own", () => {
    expect(reliefSky('light')['atmosphere-blend']).toBe(0);
    expect(reliefSky('dark')['atmosphere-blend']).toBe(0);
  });
});

describe('terrainWanted', () => {
  test('on once tilted past the on threshold, off only below the off threshold', () => {
    expect(terrainWanted(0, false)).toBe(false);
    expect(terrainWanted(TERRAIN_ON_PITCH - 0.1, false)).toBe(false);
    expect(terrainWanted(TERRAIN_ON_PITCH, false)).toBe(true);
    expect(terrainWanted(1, true)).toBe(true);
    expect(terrainWanted(TERRAIN_OFF_PITCH - 0.1, true)).toBe(false);
    expect(terrainWanted(Number.NaN, true)).toBe(true);
  });
});

describe('globeSilhouette', () => {
  const camera = {
    worldSize: 512 * 2 ** 2,
    latitudeDeg: 0,
    pitchDeg: 0,
    cameraToCenterDistance: 1000,
    centerPoint: { x: 640, y: 400 },
  };

  test('straight down it is a circle around the centre: f·R / √(D² − R²)', () => {
    const r = camera.worldSize / (2 * Math.PI);
    const d = camera.cameraToCenterDistance + r;
    const expected = (camera.cameraToCenterDistance * r) / Math.sqrt(d * d - r * r);
    const outline = globeSilhouette(camera);
    expect(outline?.x).toBe(640);
    expect(outline?.y).toBeCloseTo(400, 6);
    expect(outline?.rx).toBeCloseTo(expected, 6);
    expect(outline?.ry).toBeCloseTo(expected, 6);
  });

  test('it grows with zoom and away from the equator, as MapLibre scales the sphere', () => {
    const z2 = globeSilhouette(camera);
    const z3 = globeSilhouette({ ...camera, worldSize: camera.worldSize * 2 });
    const north = globeSilhouette({ ...camera, latitudeDeg: 60 });
    expect(z3?.rx ?? 0).toBeGreaterThan(z2?.rx ?? 0);
    expect(north?.rx ?? 0).toBeGreaterThan(z2?.rx ?? 0);
  });

  test('tilted, the globe drops down the screen and its top stays above the centre', () => {
    const tilted = globeSilhouette({ ...camera, pitchDeg: 40 });
    if (!tilted) throw new Error('expected an outline');
    expect(tilted.y).toBeGreaterThan(400);
    expect(tilted.y - tilted.ry).toBeLessThan(400);
  });

  test('no outline when the globe fills the bottom of a pitched view, or the input is broken', () => {
    expect(globeSilhouette({ ...camera, worldSize: 512 * 2 ** 9, pitchDeg: 60 })).toBeNull();
    expect(globeSilhouette({ ...camera, cameraToCenterDistance: 0 })).toBeNull();
    expect(globeSilhouette({ ...camera, worldSize: Number.NaN })).toBeNull();
  });
});

describe('space', () => {
  test('the stars are the same on every load', () => {
    expect(starfield(20)).toBe(starfield(20));
    expect(starfield(20).match(/radial-gradient/g)?.length).toBe(20);
  });

  test('the glow is added only around a globe, and the base is always last', () => {
    expect(spaceBackdrop(null).endsWith(SPACE_BASE)).toBe(true);
    const withGlobe = spaceBackdrop({ x: 10, y: 20, rx: 100, ry: 90 });
    expect(withGlobe.startsWith('radial-gradient(ellipse 100.0px 90.0px at 10.0px 20.0px')).toBe(
      true,
    );
    expect(withGlobe.endsWith(SPACE_BASE)).toBe(true);
  });
});

describe('the elevation credit and the tiles', () => {
  const saved = process.env.EXPO_PUBLIC_MAP_TERRAIN_TILES;
  afterEach(() => {
    if (saved === undefined) delete process.env.EXPO_PUBLIC_MAP_TERRAIN_TILES;
    else process.env.EXPO_PUBLIC_MAP_TERRAIN_TILES = saved;
  });

  test('credited only while relief is drawn, after the basemap credit', () => {
    const plain = resolveMapAttribution();
    const relief = resolveMapAttribution({ terrain: true });
    expect(plain.links.some((link) => link.label.includes('Mapterhorn'))).toBe(false);
    expect(relief.links.slice(0, plain.links.length)).toEqual([...plain.links]);
    expect(relief.links.at(-1)).toEqual({
      label: '© Mapterhorn',
      href: 'https://goway.to/attribution#elevation',
    });
  });

  test("GoWay's own Worker route by default; configurable", () => {
    delete process.env.EXPO_PUBLIC_MAP_TERRAIN_TILES;
    expect(resolveTerrainTileUrl()).toBe(TILES);
    process.env.EXPO_PUBLIC_MAP_TERRAIN_TILES = 'https://preview.example/terrain/{z}/{x}/{y}.webp';
    expect(resolveTerrainTileUrl()).toBe('https://preview.example/terrain/{z}/{x}/{y}.webp');
  });
});
