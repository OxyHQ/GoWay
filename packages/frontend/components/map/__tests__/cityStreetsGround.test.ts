import { describe, expect, test } from 'bun:test';
import type { Map as MapLibreMap } from 'maplibre-gl';

import { groundOf } from '../city3dGround.web';
import { withPolygonOffsetState } from '../engine/city3d/tsl/tslPass';
import { Buffers, subdivideSurfaces } from '../engine/cityStreets/meshBuffers';
import { kerbOffset } from '../engine/cityStreets/streetMesher';

describe('street surfaces on terrain', () => {
  test('a decal cannot carry polygon offset into the terrain, even after a failed draw', () => {
    for (const initiallyEnabled of [false, true]) {
      let enabled = initiallyEnabled;
      let factor = 2;
      let units = 3;
      const gl = {
        POLYGON_OFFSET_FILL: 1,
        POLYGON_OFFSET_FACTOR: 2,
        POLYGON_OFFSET_UNITS: 3,
        isEnabled: () => enabled,
        getParameter: (name: number) => (name === 2 ? factor : units),
        enable: () => {
          enabled = true;
        },
        disable: () => {
          enabled = false;
        },
        polygonOffset: (f: number, u: number) => {
          factor = f;
          units = u;
        },
      } as unknown as WebGL2RenderingContext;
      expect(() =>
        withPolygonOffsetState(gl, () => {
          gl.enable(gl.POLYGON_OFFSET_FILL);
          gl.polygonOffset(-1, -4);
          throw new Error('draw interrupted');
        }),
      ).toThrow('draw interrupted');
      expect({ enabled, factor, units }).toEqual({
        enabled: initiallyEnabled,
        factor: 2,
        units: 3,
      });
    }
  });

  test('ground reads the rendered DEM, not its coarser parent selected by terrain zoom', () => {
    for (const deltaZoom of [1, 2]) {
      const map = {
        getSource: () => ({ maxzoom: 12 }),
        getCenter: () => ({ lng: 0, lat: 0 }),
        terrain: {
          tileManager: { deltaZoom },
          getElevationForLngLatZoom: (at: { lng: number; lat: number }, zoom: number) =>
            zoom - deltaZoom >= 12 ? at.lng + at.lat : 100,
        },
      } as unknown as MapLibreMap;
      expect(groundOf(map, 'dem').sample(2, 41)).toBe(43);
    }
  });

  test('wide junctions are subdivided across the terrain, preserving area and material', () => {
    const b = new Buffers();
    const attr = [1, 255, 2, 0];
    b.vertex(0, 0, 0.15, attr);
    b.vertex(30, 0, 0.15, attr);
    b.vertex(0, 30, 0.15, attr);
    b.triangle(0, 1, 2);
    subdivideSurfaces(b, 6);
    let area = 0;
    for (let i = 0; i < b.indices.length; i += 3) {
      const ids = b.indices.slice(i, i + 3);
      const pts = ids.map((id) => b.positions.slice(id * 3, id * 3 + 3));
      for (let j = 0; j < 3; j++) {
        const a = pts[j];
        const c = pts[(j + 1) % 3];
        expect(Math.hypot(a[0] - c[0], a[1] - c[1])).toBeLessThanOrEqual(6);
        expect(a[2]).toBe(0.15);
        expect(b.attrs.slice(ids[j] * 4, ids[j] * 4 + 4)).toEqual(attr);
      }
      const [a, c, d] = pts;
      area += ((c[0] - a[0]) * (d[1] - a[1]) - (c[1] - a[1]) * (d[0] - a[0])) / 2;
    }
    expect(area).toBeCloseTo(450);
  });
});

describe('sidewalks reach a kerb laterally', () => {
  test('an endpoint beyond a junction cannot widen a sidewalk diagonally', () => {
    expect(kerbOffset(0, 0, 0, 1, 3, 4, 10, 4)).toBeNull();
    expect(kerbOffset(5, 0, 0, 1, 3, 4, 10, 4)).toBe(4);
    expect(kerbOffset(5, 0, 0, -1, 3, 4, 10, 4)).toBe(-4);
  });

  test('the miter scale cannot push the sidewalk past the kerb', () => {
    const offset = kerbOffset(5, 0, 0, 2, 3, 4, 10, 4);
    expect(offset).toBe(2);
    expect((offset ?? 0) * 2).toBe(4);
  });
});
