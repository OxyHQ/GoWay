/**
 * The adapter's half of the detailed look (`components/map/city3dStyle.ts`):
 * the ground overrides are read from the loaded style's metadata, applied
 * only to layers that exist, and undone exactly.
 */
import { describe, expect, test } from 'bun:test';

import {
  applyCityGround,
  type GroundHost,
  groundOverridesOf,
  cityMaterials,
} from '@/components/map/city3dStyle';
import { CITY3D_GROUND_METADATA_KEY, CITY_MATERIALS } from '@/lib/map/style/palette3d';

function fakeMap(metadata: unknown, paint: Record<string, Record<string, unknown>>) {
  const writes: string[] = [];
  const host: GroundHost = {
    getStyle: () => ({ metadata }),
    getLayer: (id) => (id in paint ? { id } : undefined),
    getPaintProperty: (layer, property) => paint[layer]?.[property],
    setPaintProperty: (layer, property, value) => {
      writes.push(`${layer}.${property}`);
      paint[layer][property] = value;
    },
  };
  return { host, paint, writes };
}

describe('applyCityGround', () => {
  test('applies the generated overrides and restores what was there', () => {
    const { host, paint } = fakeMap(
      {
        [CITY3D_GROUND_METADATA_KEY]: [
          { layer: 'background', property: 'background-color', value: ['interpolate'] },
          { layer: 'park', property: 'fill-color', value: '#00ff00' },
        ],
      },
      { background: { 'background-color': '#f6f4eb' }, park: {} },
    );
    const undo = applyCityGround(host);
    expect(paint.background['background-color']).toEqual(['interpolate']);
    expect(paint.park['fill-color']).toBe('#00ff00');
    undo();
    expect(paint.background['background-color']).toBe('#f6f4eb');
    // Unset before: set back to unset, which MapLibre reads as the default.
    expect(paint.park['fill-color']).toBeUndefined();
  });

  test('skips layers the style does not have', () => {
    const { host, writes } = fakeMap(
      {
        [CITY3D_GROUND_METADATA_KEY]: [{ layer: 'nope', property: 'fill-color', value: '#000000' }],
      },
      {},
    );
    applyCityGround(host)();
    expect(writes).toEqual([]);
  });

  test("a style without overrides (someone else's) is left alone", () => {
    for (const metadata of [undefined, {}, { [CITY3D_GROUND_METADATA_KEY]: 'x' }]) {
      const { host, writes } = fakeMap(metadata, { background: {} });
      expect(groundOverridesOf(host)).toEqual([]);
      applyCityGround(host)();
      expect(writes).toEqual([]);
    }
  });

  test('a torn-down map does not throw on undo', () => {
    const { host } = fakeMap(
      {
        [CITY3D_GROUND_METADATA_KEY]: [
          { layer: 'bg', property: 'background-color', value: '#000000' },
        ],
      },
      { bg: {} },
    );
    const undo = applyCityGround(host);
    host.getLayer = () => {
      throw new Error('style is gone');
    };
    expect(() => undo()).not.toThrow();
  });
});

describe('cityMaterials', () => {
  test('hands the engine both ends; the night seam picks between them on the GPU', () => {
    expect(cityMaterials()).toEqual(CITY_MATERIALS);
  });
});
