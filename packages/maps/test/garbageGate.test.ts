/**
 * The garbage gate: what keeps a NaN from reaching an engine, where it is a
 * THROW (`Invalid LngLat object: (NaN, NaN)`) from inside a React handler
 * rather than a bad frame. `maplibre-gl` is imported for real: an assertion
 * that our own predicate agrees with our own predicate proves nothing; these
 * assert against the engine that throws in production.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, test } from 'bun:test';
import { LngLat, MercatorCoordinate } from 'maplibre-gl';

import {
  asFinite,
  drawableMarkers,
  isDrawableBounds,
  isDrawableCoordinate,
  isViewport,
  resolvePadding,
  toLngLat,
} from '../src/shared';
import type { MapMarkerData } from '../src/types';

/** What the engine does with a coordinate, without a canvas: build a `LngLat`. */
function draw(coordinate: { latitude: number; longitude: number }): LngLat {
  const [longitude, latitude] = toLngLat(coordinate);
  return new LngLat(longitude, latitude);
}

describe('seam — shared.ts', () => {
  const good: MapMarkerData = { id: 'good', coordinate: { latitude: 41.3874, longitude: 2.1686 } };
  const bad: MapMarkerData = { id: 'bad', coordinate: { latitude: NaN, longitude: NaN } };

  test('drops an undrawable marker instead of letting it reach the engine', () => {
    const kept = drawableMarkers([good, bad, { ...good, id: 'good2' }]);
    expect(kept.map((marker) => marker.id)).toEqual(['good', 'good2']);
    for (const marker of kept) expect(() => draw(marker.coordinate)).not.toThrow();
    // And the thing it dropped is exactly the production crash.
    expect(() => draw(bad.coordinate)).toThrow('Invalid LngLat object: (NaN, NaN)');
  });

  test('returns the input array untouched when nothing is wrong', () => {
    const markers = [good];
    expect(drawableMarkers(markers)).toBe(markers);
    expect(drawableMarkers(undefined)).toEqual([]);
  });

  test('accepts an unwrapped longitude, because the engine does', () => {
    // A click east of the antimeridian comes back as 181, not -179. Rejecting
    // it here would break panning past the date line in the name of safety.
    expect(isDrawableCoordinate({ latitude: 0, longitude: 181 })).toBe(true);
    expect(() => draw({ latitude: 0, longitude: 181 })).not.toThrow();
    // Latitude is bounded, because `LngLat` throws outside ±90.
    expect(isDrawableCoordinate({ latitude: 91, longitude: 0 })).toBe(false);
    expect(() => new LngLat(0, 91)).toThrow('Invalid LngLat latitude value');
  });

  test('refuses a box the engine cannot build', () => {
    expect(isDrawableBounds({ west: NaN, south: NaN, east: NaN, north: NaN })).toBe(false);
    expect(
      isDrawableBounds({ west: Infinity, south: Infinity, east: -Infinity, north: -Infinity }),
    ).toBe(false);
    expect(isDrawableBounds(null)).toBe(false);
    expect(isDrawableBounds({ west: 2.1, south: 41.3, east: 2.2, north: 41.4 })).toBe(true);
  });

  test('refuses a non-finite padding and clamps a negative one', () => {
    expect(resolvePadding({ top: NaN, right: 24, bottom: 24, left: 24 }, 48)).toBeNull();
    expect(resolvePadding(NaN, 48)).toBeNull();
    expect(resolvePadding({ top: -24, right: 24, bottom: -24, left: 24 }, 48)).toEqual({
      top: 0,
      right: 24,
      bottom: 0,
      left: 24,
    });
    expect(resolvePadding(undefined, 48)).toEqual({ top: 48, right: 48, bottom: 48, left: 48 });
    expect(resolvePadding(12, 48)).toEqual({ top: 12, right: 12, bottom: 12, left: 12 });
  });
});

describe('seam — the camera SCALARS, which poison the transform one step later', () => {
  test('a NaN zoom is the same crash, arriving through getBounds()', () => {
    // MapLibre's own clamp does not stop it: nothing compares true to NaN.
    const clamp = (n: number, min: number, max: number) => Math.min(Math.max(n, min), max);
    expect(Number.isNaN(clamp(NaN, 0, 22))).toBe(true);
    expect(Number.isNaN(2 ** NaN)).toBe(true);

    // So `transform._scale` and `worldSize` become NaN, and the next
    // unprojection — which is literally `screenPointToMercatorCoordinate(p)
    // .toLngLat()`, run four times by `getBounds()`, which this canvas calls on
    // every `move` event and which `jumpTo` fires SYNCHRONOUSLY — throws the
    // exact string the user saw.
    expect(() => new MercatorCoordinate(100 / NaN, 100 / NaN).toLngLat()).toThrow(
      'Invalid LngLat object: (NaN, NaN)',
    );
  });

  test('isViewport no longer mistakes a NaN zoom for a viewport', () => {
    // `typeof NaN === 'number'`, so the old test said yes and handed the NaN on.
    // Treating it as a bare coordinate keeps the camera's current zoom.
    expect(isViewport({ latitude: 41.3874, longitude: 2.1686, zoom: NaN })).toBe(false);
    expect(isViewport({ latitude: 41.3874, longitude: 2.1686, zoom: 15 })).toBe(true);
    expect(isViewport({ latitude: 41.3874, longitude: 2.1686 })).toBe(false);
  });

  test('asFinite passes real numbers and nothing else', () => {
    expect(asFinite(0)).toBe(0);
    expect(asFinite(-3.5)).toBe(-3.5);
    expect(asFinite(NaN)).toBeUndefined();
    expect(asFinite(Infinity)).toBeUndefined();
    expect(asFinite(-Infinity)).toBeUndefined();
    expect(asFinite(undefined)).toBeUndefined();
    expect(asFinite(null)).toBeUndefined();
  });

  test('a NaN maxZoom would have reached the fitted centre', () => {
    // `zoom = Math.min(computedZoom, options.maxZoom)` — and Math.min with NaN
    // is NaN, which MapLibre's `scaleX < 0` guard does not catch. It ends up
    // multiplying the padding offset by `scale / 2 ** NaN`.
    expect(Number.isNaN(Math.min(11.5, NaN))).toBe(true);
    expect(() => new LngLat(0 * (1 / 2 ** NaN), 0 * (1 / 2 ** NaN))).toThrow(
      'Invalid LngLat object: (NaN, NaN)',
    );
    expect(asFinite(NaN)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// A failing tile must not speak for the whole canvas
// ---------------------------------------------------------------------------

describe('the degraded state is left as well as entered', () => {
  // `goway.to` showed "Map data unavailable" over a map that was drawing
  // perfectly. The cause was a handful of stale edge-cached tiles among
  // thousands of good ones: `emitError` latched on the first of them and
  // nothing ever retracted it, so one square of a viewport spoke for all of it
  // and kept speaking after the square came good.
  //
  // Source assertions, because the behaviour lives in a MapLibre `idle`
  // listener and there is no engine here to fire one. What they pin is the
  // shape of the rule, which is what was missing rather than mis-implemented.
  const web = () =>
    readFileSync(fileURLToPath(new URL('../src/MapView.web.tsx', import.meta.url).href), 'utf8');

  it('clears a tile error once the viewport settles with its tiles', () => {
    const source = web();
    expect(source).toContain('map.areTilesLoaded()');
    expect(source).toMatch(/reason !== 'tiles'\) return current;/);
  });

  it('never clears a style error the same way', () => {
    // Nothing about a viewport finishing says the style document arrived, and a
    // map with no style has nothing to draw whatever the tiles do.
    const idle = web().slice(web().indexOf('const handleIdle'));
    const body = idle.slice(0, idle.indexOf('\n      };'));
    expect(body).not.toContain("'style'");
  });

  it('tells the screen about the recovery, not only the failure', () => {
    // ExploreScreen hides "Search this area" and the directions picker while
    // `mapError` is set. Without this call they stay hidden for the life of the
    // screen on a map that is working.
    expect(web()).toContain('latest.current.onError?.(null)');
  });
});
