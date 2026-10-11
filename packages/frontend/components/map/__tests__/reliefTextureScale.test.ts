/**
 * The lighter terrain of the low quality preset (`reliefLayer.web.ts` →
 * `applyTextureScale`, `docs/MAP_PERFORMANCE.md`): MapLibre's terrain
 * render-to-texture at 1× its terrain tile instead of 2×. It leans on two
 * names inside MapLibre — `Terrain.qualityFactor` (documented) and the
 * render-to-texture's `rttSize`, computed from it once — so this pins the
 * INSTALLED version's code: an upgrade that renames either fails here, not
 * silently on a phone.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { applyTextureScale } from '@/components/map/reliefLayer.web';

const MAPLIBRE = readFileSync(require.resolve('maplibre-gl/dist/maplibre-gl.mjs'), 'utf8');

describe('the terrain texture scale', () => {
  test('MapLibre still sizes its terrain textures from qualityFactor, once, as the adapter assumes', () => {
    expect(MAPLIBRE).toContain('this.qualityFactor=2');
    expect(MAPLIBRE).toMatch(/this\.rttSize=\w+\.tileManager\.tileSize\*\w+\.qualityFactor/);
    expect(MAPLIBRE).toMatch(/acquireRTT\(\w+,\w+,this\.rttSize\)/);
  });

  test('sets both the factor and the size the terrain textures are made at', () => {
    const map = {
      terrain: { qualityFactor: 2, tileManager: { tileSize: 1024 } },
      painter: { renderToTexture: { rttSize: 2048 } },
    };
    applyTextureScale(map as never, 1);
    expect(map.terrain.qualityFactor).toBe(1);
    expect(map.painter.renderToTexture.rttSize).toBe(1024);
  });

  test('a map without them is left alone', () => {
    const map = { terrain: null, painter: {} };
    expect(() => applyTextureScale(map as never, 1)).not.toThrow();
  });
});
