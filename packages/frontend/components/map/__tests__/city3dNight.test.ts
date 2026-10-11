/**
 * The night seam (`lib/map/landmarks/night.ts` → `nightFactor`, shared with
 * the landmarks) and the floodlights' data
 * path: OSM tags → city-tile property → decoded building → a per-vertex flag
 * the shaders light. Floodlighting is styling on a RECORDED fact, so every
 * step is pinned to "lit only where the tag says so".
 */
import { describe, expect, test } from 'bun:test';

import type { Point2 } from '@/components/map/engine/city3d/mesher';
import { meshOsmBuildings, VERTEX_FLAG_FLOODLIT } from '@/components/map/engine/city3d/osmMesher';
import { buildingFromProperties } from '@/components/map/engine/city3d/osmTiles';
import {
  skyCityFragmentShader,
  skyCityVertexShader,
} from '@/components/map/engine/city3d/skyShaders';
import { SKY_NIGHT_FADE_DEG, skyNightness } from '@/components/map/engine/city3d/atmosphere';
import { CITY_PROPS } from '@/lib/map/cityTiles';
import { NIGHT_FADE_DEG, nightFactor } from '@/lib/map/landmarks/night';
import { KEPT_KEYS } from '@/scripts/citygen/compile';
import { LIT_KEYS, parseLitAtNight, resolveProperties } from '@/scripts/citygen/tags';

describe('nightFactor, as the city sky uses it', () => {
  test('the sky turns to night over the same window the lights come on in', () => {
    // The sky's stylised night (atmosphere.ts) and every night look read the
    // one function: 0 above the window, 1 below it, monotonic between.
    expect(nightFactor({ appearance: 'light', sunAltitudeDeg: NIGHT_FADE_DEG[0] })).toBe(0);
    expect(nightFactor({ appearance: 'light', sunAltitudeDeg: NIGHT_FADE_DEG[1] })).toBe(1);
    let previous = 0;
    for (let altitude = 0; altitude >= -12; altitude -= 0.25) {
      const f = nightFactor({ appearance: 'light', sunAltitudeDeg: altitude });
      expect(f).toBeGreaterThanOrEqual(previous);
      previous = f;
    }
  });

  test('the sky’s own night window is the night factor’s, exactly', () => {
    // Restated in atmosphere.ts to keep the module out of the first-paint
    // bundle; pinned here so the two can never drift.
    expect(SKY_NIGHT_FADE_DEG).toEqual(NIGHT_FADE_DEG);
    for (let altitude = 5; altitude >= -15; altitude -= 0.5) {
      expect(skyNightness(altitude)).toBeCloseTo(
        nightFactor({ appearance: 'light', sunAltitudeDeg: altitude }),
        12,
      );
    }
  });

  test('every sky-lit material reads the same uniform', () => {
    for (const format of ['openmaptiles', 'goway'] as const) {
      expect(skyCityFragmentShader(format)).toContain('uniform float uNightFactor;');
    }
  });
});

describe('parseLitAtNight', () => {
  test('floodlit and an affirmative lit on the building', () => {
    const lit: Record<string, string>[] = [
      { floodlit: 'yes' },
      { floodlit: '1' },
      { lit: 'yes' },
      { lit: '24/7' },
      { lit: 'automatic' },
      { lit: 'dusk-dawn' },
      { lit: '18:00-05:30' },
      { lit: 'sunset-00:00,05:00-sunrise' },
    ];
    for (const tags of lit) {
      expect({ tags, lit: parseLitAtNight(tags) }).toEqual({ tags, lit: true });
    }
  });

  test('anything else is not lit — the default is dark, never a guess', () => {
    const dark: Record<string, string>[] = [
      {},
      { lit: 'no' },
      { lit: 'disused' },
      { floodlit: 'no' },
      { lit: 'maybe' },
      { light_source: 'floodlight' },
    ];
    for (const tags of dark) {
      expect({ tags, lit: parseLitAtNight(tags) }).toEqual({ tags, lit: false });
    }
  });

  test('the compiler keeps every key the parser reads', () => {
    // It drops all other keys on read: without these, every building read as
    // unlit and the Barcelona build said "lit at night 0".
    for (const key of LIT_KEYS) expect(KEPT_KEYS.has(key)).toBe(true);
    for (const key of ['floodlit', 'lit']) expect(LIT_KEYS as readonly string[]).toContain(key);
  });

  test('compiled into the tile only when recorded', () => {
    const lit = resolveProperties({ building: 'church', lit: 'yes' }, 'building', undefined);
    expect(lit[CITY_PROPS.floodlit]).toBe(true);
    const dark = resolveProperties({ building: 'yes' }, 'building', undefined);
    expect(CITY_PROPS.floodlit in dark).toBe(false);
  });
});

describe('the floodlit flag through decode and mesh', () => {
  const box = (x0: number): Point2[] => [
    [x0, 0],
    [x0 + 20, 0],
    [x0 + 20, 10],
    [x0, 10],
  ];
  const props = (floodlit: boolean) => ({
    [CITY_PROPS.renderHeight]: 12,
    [CITY_PROPS.renderMinHeight]: 0,
    ...(floodlit ? { [CITY_PROPS.floodlit]: true } : {}),
  });

  test('decoded only from a literal true', () => {
    expect(buildingFromProperties(1, [box(0)], props(true)).floodlit).toBe(true);
    expect(buildingFromProperties(1, [box(0)], props(false)).floodlit).toBeUndefined();
    expect(
      buildingFromProperties(1, [box(0)], { ...props(false), [CITY_PROPS.floodlit]: 'yes' })
        .floodlit,
    ).toBeUndefined();
  });

  test('every vertex of a floodlit building, and none of its neighbour’s, carries the flag', () => {
    const lit = buildingFromProperties(1, [box(0)], props(true));
    const dark = buildingFromProperties(2, [box(100)], props(false));
    const mesh = meshOsmBuildings([lit, dark], { extent: 4096, tileSizeMetres: 4096 });
    if (!mesh) throw new Error('nothing meshed');
    const vertexCount = mesh.positions.length / 3;
    expect(mesh.flags.length).toBe(vertexCount);
    for (let v = 0; v < vertexCount; v++) {
      const x = mesh.positions[v * 3];
      expect(mesh.flags[v]).toBe(x < 50 ? VERTEX_FLAG_FLOODLIT : 0);
    }
  });

  test('…and survives packing into the compact format (packing.ts)', async () => {
    const { packMesh } = await import('@/components/map/engine/city3d/packing');
    const lit = buildingFromProperties(1, [box(0)], props(true));
    const dark = buildingFromProperties(2, [box(100)], props(false));
    const mesh = meshOsmBuildings([lit, dark], { extent: 4096, tileSizeMetres: 4096 });
    if (!mesh) throw new Error('nothing meshed');
    const packed = packMesh(mesh, 4096);
    let flagged = 0;
    let total = 0;
    for (const chunk of packed.chunks) {
      expect(chunk.flags?.length).toBe(chunk.position.length / 4);
      for (const f of chunk.flags ?? []) {
        total++;
        if (f === VERTEX_FLAG_FLOODLIT) flagged++;
      }
    }
    expect(total).toBe(mesh.flags.length);
    expect(flagged).toBe(mesh.flags.filter((f) => f === VERTEX_FLAG_FLOODLIT).length);
    expect(flagged).toBeGreaterThan(0);
  });

  test('the sky-lit city-tile shaders read it; the OpenMapTiles ones carry no such data', () => {
    expect(skyCityVertexShader('goway')).toContain('in float flags;');
    expect(skyCityFragmentShader('goway')).toContain('vFlags');
    expect(skyCityFragmentShader('openmaptiles')).not.toContain('vFlags');
  });
});

describe('one shading path: the sky’s light inputs, a pluggable material', () => {
  test('the default material is the clay response, and a passed one replaces it', async () => {
    const { DEFAULT_CITY_MATERIAL_GLSL } = await import(
      '@/components/map/engine/city3d/skyShaders'
    );
    const standard = skyCityFragmentShader('goway');
    expect(standard).toContain(DEFAULT_CITY_MATERIAL_GLSL);
    const art = 'vec3 cityMaterial(CitySurface s, CityLight l) { return s.albedo * l.skyUp; }';
    const custom = skyCityFragmentShader('goway', art);
    expect(custom).toContain(art);
    expect(custom).not.toContain(DEFAULT_CITY_MATERIAL_GLSL);
    // The contract every material is handed, and the haze applied after it.
    for (const shader of [standard, custom]) {
      expect(shader).toContain('struct CitySurface');
      expect(shader).toContain('struct CityLight');
      expect(shader).toContain('light.nightFactor = uNightFactor;');
      expect(shader).toContain('cityMaterial(surface, light)');
      expect(shader.indexOf('cityMaterial(surface, light)')).toBeLessThan(
        shader.indexOf('hazeTransmittance(max(uCamera.z'),
      );
    }
  });
});
