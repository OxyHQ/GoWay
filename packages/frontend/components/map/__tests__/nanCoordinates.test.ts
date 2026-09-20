/**
 * The net under `Invalid LngLat object: (NaN, NaN)` — the crash that replaced
 * goway.to with its error boundary.
 *
 * MapLibre builds a `LngLat` out of everything it is handed (a marker's
 * position, a camera centre, a box's corners) and that constructor THROWS on a
 * non-number. Thrown from a React effect, it reaches the nearest error boundary,
 * so a single bad coordinate does not misplace a pin — it removes the app.
 *
 * The message is exact about its cause, which is what makes it findable: it
 * prints the values it was given, so `(NaN, NaN)` means BOTH axes arrived as a
 * literal `NaN`. A missing field would read `(undefined, undefined)`. The first
 * test below pins that difference down, because it is the whole reason the
 * search led to arithmetic (`0 / 0`, `Infinity + -Infinity`) rather than to
 * missing data.
 *
 * Four layers are covered, in the order a coordinate meets them:
 *
 *  1. the PRODUCERS — an empty cluster's centroid, a padding computed against a
 *     zero-sized window, a stop built around an unusable fix;
 *  2. the SEAM — `components/map/shared.ts`, which both renderer forks route
 *     every coordinate through, and which must drop rather than throw;
 *  3. the SEAM'S OTHER TWO DOORS — overlays (raw GeoJSON) and the camera
 *     SCALARS (zoom, bearing, pitch, duration, maxZoom). These were added after
 *     the first fix, because guarding coordinates alone left both open;
 *  4. the FACTS the seam depends on, especially that `isDegenerateBounds`
 *     answers `false` for a NaN box (every comparison against NaN is false), so
 *     the finite check has to come first or the NaN walks straight past it.
 *
 * `maplibre-gl` is imported for real. An assertion that our own predicate
 * agrees with our own predicate proves nothing; these assert against the engine
 * that throws in production.
 */
import { describe, expect, mock, test } from 'bun:test';
import { LngLat, LngLatBounds, MercatorCoordinate } from 'maplibre-gl';

import {
  asFinite,
  drawableMarkers,
  drawableOverlays,
  isDrawableBounds,
  isDrawableCoordinate,
  isDrawableGeoJSON,
  isViewport,
  resolveOverlayPaint,
  resolvePadding,
  toLngLat,
} from '@/components/map/shared';
import type { MapMarker, MapOverlay } from '@/components/map/types';
import { boundsOf, isDegenerateBounds } from '@/lib/map/geo';
import {
  MAX_PADDING_SHARE,
  clampFitPadding,
  fitAxis,
  type FitPaddingSides,
} from '@/features/explore/mapPadding';
import {
  stopFromDevice,
  stopFromPlace,
  stopFromPoint,
  stopFromResult,
} from '@/features/directions/stops';

/**
 * `lib/goway/markers.ts` is pure clustering arithmetic, but its neighbours
 * (`categories`, `capabilities`, `format`) carry Bloom ICONS, which reach
 * `react-native` and `react-native-svg` — Flow-typed sources Bun cannot parse.
 * Stubbing the three neighbours is what keeps the module under test importable;
 * none of them has anything to do with where a marker is placed.
 */
mock.module('@/lib/goway/categories', () => ({
  resolveCategory: () => ({ key: 'place', label: 'Place', minZoom: 0 }),
  isVisibleAtZoom: () => true,
}));
mock.module('@/lib/goway/capabilities', () => ({ capabilitySummary: () => '' }));
mock.module('@/lib/goway/format', () => ({ markerLabel: (place: { name: string }) => place.name }));

const { buildMarkers } = await import('@/lib/goway/markers');

type TestPlace = Parameters<typeof buildMarkers>[0]['places'][number];

function place(id: string, latitude: number, longitude: number): TestPlace {
  return {
    id,
    name: id,
    location: { latitude, longitude },
    categories: ['cafe'],
    capabilities: [],
    status: 'open',
  } as unknown as TestPlace;
}

/** What the engine does with a coordinate, without a canvas: build a `LngLat`. */
function draw(coordinate: { latitude: number; longitude: number }): LngLat {
  const [longitude, latitude] = toLngLat(coordinate);
  return new LngLat(longitude, latitude);
}

// ---------------------------------------------------------------------------

describe('the throw itself', () => {
  test('prints the values it was given, so (NaN, NaN) means arithmetic', () => {
    expect(() => new LngLat(NaN, NaN)).toThrow('Invalid LngLat object: (NaN, NaN)');
    // Missing data reads differently. This is the discriminator that sent the
    // hunt towards `0 / 0` rather than towards an absent field.
    expect(() => new LngLat(undefined as unknown as number, undefined as unknown as number)).toThrow(
      'Invalid LngLat object: (undefined, undefined)',
    );
  });

  test('the two ways GoWay could reach it are both (NaN, NaN)', () => {
    // A mean over an empty list.
    expect(() => new LngLat(0 / 0, 0 / 0)).toThrow('Invalid LngLat object: (NaN, NaN)');
    // The midpoint of `boundsOf`'s empty sentinel, had one ever escaped.
    expect(() => new LngLat((Infinity + -Infinity) / 2, (Infinity + -Infinity) / 2)).toThrow(
      'Invalid LngLat object: (NaN, NaN)',
    );
  });
});

describe('producer — a cluster of no places (lib/goway/markers.ts)', () => {
  /**
   * The bucket that broke it: the selected place, twice.
   *
   * `buildMarkers` draws the selection expanded and collapses "the rest" of its
   * bucket into a bubble beside it. When the list carries the same place twice —
   * a duplicate row, a refetch merged onto a stale page — "the rest" is EMPTY,
   * and the mean of no coordinates is `0 / 0` on both axes.
   */
  const duplicated = [place('dup', 41.3874, 2.1686), place('dup', 41.3874, 2.1686)];

  test('draws no bubble for it, rather than one at (NaN, NaN)', () => {
    const { markers, clusters } = buildMarkers({
      places: duplicated,
      zoom: 15,
      selectedPlaceId: 'dup',
    });

    expect(markers).toHaveLength(1);
    expect(markers[0].id).toBe('dup');
    expect([...clusters.keys()]).toEqual([]);
  });

  test('every marker it produces survives the engine', () => {
    for (const marker of buildMarkers({ places: duplicated, zoom: 15, selectedPlaceId: 'dup' }).markers) {
      expect(() => draw(marker.coordinate)).not.toThrow();
    }
  });

  test('a real cluster beside the selection is still drawn', () => {
    // Same 72 px bucket, three DISTINCT places, one of them selected.
    const bucket = [
      place('a', 41.3874, 2.1686),
      place('b', 41.38741, 2.16861),
      place('c', 41.38742, 2.16862),
    ];
    const { markers, clusters } = buildMarkers({ places: bucket, zoom: 15, selectedPlaceId: 'a' });

    expect(markers.map((marker) => marker.id)).toContain('a');
    expect(clusters.size).toBe(1);
    for (const marker of markers) expect(() => draw(marker.coordinate)).not.toThrow();
  });
});

describe('producer — fit padding (features/explore/mapPadding.ts)', () => {
  const phone = {
    top: 47 + 24,
    right: 40,
    bottom: Math.round(844 * 0.45) + 24,
    left: 40,
  };

  test('a window with no size gets the plain gap, not negative padding', () => {
    // The old `cap()` was `min(value, round(axis * 0.65) - 24)`, which is -24 on
    // a zero axis: a padding that frames content OUTSIDE the viewport, and one
    // of the ways MapLibre's free space lands on exactly zero (`0 * Infinity`
    // is NaN, and the centre it computes from it throws).
    expect(clampFitPadding(phone, { width: 0, height: 0 }, 24)).toBe(24);
    expect(clampFitPadding(phone, { width: NaN, height: NaN }, 24)).toBe(24);
    expect(clampFitPadding(phone, { width: 390, height: 0 }, 24)).toBe(24);
    expect(clampFitPadding(phone, { width: Infinity, height: 844 }, 24)).toBe(24);
  });

  test('a non-finite inset never becomes a non-finite padding', () => {
    const padding = clampFitPadding(
      { top: NaN, right: 24, bottom: NaN, left: Infinity },
      { width: 390, height: 844 },
      24,
    );
    expect(typeof padding).toBe('object');
    for (const side of Object.values(padding as FitPaddingSides)) {
      expect(Number.isFinite(side)).toBe(true);
      expect(side).toBeGreaterThanOrEqual(0);
    }
  });

  test('the two sides of an axis never claim more than their share of it', () => {
    const cases: [number, number][] = [
      [390, 844],
      [1440, 900],
      [320, 480],
      [1, 1],
      [2400, 200],
    ];
    // A sheet at `half` plus a top bar plus a side panel: every chrome element
    // asking for everything at once.
    const greedy = { top: 600, right: 500, bottom: 900, left: 500 };

    for (const [width, height] of cases) {
      const padding = clampFitPadding(greedy, { width, height }, 24) as FitPaddingSides;
      expect(padding.top + padding.bottom).toBeLessThanOrEqual(height * MAX_PADDING_SHARE);
      expect(padding.left + padding.right).toBeLessThanOrEqual(width * MAX_PADDING_SHARE);
      // Which is the property that matters: MapLibre divides by what is LEFT.
      expect(height - (padding.top + padding.bottom)).toBeGreaterThan(0);
      expect(width - (padding.left + padding.right)).toBeGreaterThan(0);
    }
  });

  test('a padding that fits is passed through, asymmetry intact', () => {
    expect(clampFitPadding(phone, { width: 390, height: 844 }, 24)).toEqual({
      top: 71,
      right: 40,
      bottom: 404,
      left: 40,
    });
  });

  test('fitAxis shrinks proportionally rather than capping one side', () => {
    // 100 + 900 into a budget of 650: the bottom stays ~9x the top, because the
    // sheet really is at the bottom and a symmetric frame would be a lie.
    const [near, far] = fitAxis(100, 900, 1000);
    expect(near + far).toBeLessThanOrEqual(650);
    expect(far).toBeGreaterThan(near * 5);
  });
});

describe('producer — stops (features/directions/stops.ts)', () => {
  const nowhere = { latitude: NaN, longitude: NaN };

  test('refuses to build a stop it could not draw', () => {
    expect(stopFromDevice(nowhere)).toBeNull();
    expect(stopFromPoint(nowhere)).toBeNull();
    expect(stopFromPoint({ latitude: 91, longitude: 0 })).toBeNull();
    expect(
      stopFromResult({ id: 'r', displayName: 'Nowhere', kind: 'locality', coordinate: nowhere } as never),
    ).toBeNull();
    expect(stopFromPlace({ id: 'p', name: 'Nowhere', location: nowhere } as never)).toBeNull();
  });

  test('still builds one from a real point', () => {
    const stop = stopFromDevice({ latitude: 41.3874, longitude: 2.1686 });
    expect(stop).not.toBeNull();
    expect(() => draw(stop!.coordinate)).not.toThrow();
  });
});

describe('seam — components/map/shared.ts', () => {
  const good: MapMarker = { id: 'good', coordinate: { latitude: 41.3874, longitude: 2.1686 } };
  const bad: MapMarker = { id: 'bad', coordinate: { latitude: NaN, longitude: NaN } };

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
    expect(isDrawableBounds({ west: Infinity, south: Infinity, east: -Infinity, north: -Infinity })).toBe(
      false,
    );
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

describe('facts the seam depends on (lib/map/geo.ts)', () => {
  test('isDegenerateBounds cannot be the NaN check — every NaN comparison is false', () => {
    // This is why `isDrawableBounds` runs FIRST in both forks: a NaN box is not
    // "degenerate", so it would sail past this and into `map.fitBounds`.
    expect(isDegenerateBounds({ west: NaN, south: NaN, east: NaN, north: NaN })).toBe(false);
  });

  test("isDegenerateBounds is true for boundsOf's empty sentinel, whose midpoint is NaN", () => {
    const sentinel = { west: Infinity, south: Infinity, east: -Infinity, north: -Infinity };
    expect(isDegenerateBounds(sentinel)).toBe(true);
    // The degenerate branch of `fitBounds` eases to the midpoint of the box —
    // which for this one is (NaN, NaN). `boundsOf` never returns it (it answers
    // `null` for an empty set), but `fitBounds` is public and a caller can.
    expect(() =>
      new LngLat((sentinel.west + sentinel.east) / 2, (sentinel.south + sentinel.north) / 2),
    ).toThrow('Invalid LngLat object: (NaN, NaN)');
    expect(isDrawableBounds(sentinel)).toBe(false);
  });

  test('boundsOf refuses to invent a box out of nothing', () => {
    expect(boundsOf([])).toBeNull();
    expect(boundsOf([{ latitude: NaN, longitude: NaN }])).toBeNull();
    expect(boundsOf([undefined as never])).toBeNull();
    expect(boundsOf([{ latitude: 41.3874, longitude: 2.1686 }, { latitude: NaN, longitude: 2 }])).toEqual({
      west: 2.1686,
      south: 41.3874,
      east: 2.1686,
      north: 41.3874,
    });
  });
});

// ---------------------------------------------------------------------------
// The two doors the first fix left open
// ---------------------------------------------------------------------------

describe('seam — overlays are raw GeoJSON, and they fail the OTHER way', () => {
  const line = (coordinates: unknown): MapOverlay => ({
    id: 'goway-route',
    kind: 'line',
    data: {
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates },
    } as unknown as GeoJSON.GeoJSON,
  });

  test('a bad overlay does NOT throw in the engine — it renders nowhere', () => {
    // Measured, not assumed. A geojson source is tiled in the WORKER by
    // geojson-vt, whose projection is plain arithmetic and builds no `LngLat`:
    //
    //   projectX(x) = x / 360 + 0.5
    //   projectY(y) = clamp01(0.5 - 0.25 * log((1 + sin(y°)) / (1 - sin(y°))) / π)
    //
    // (dist/maplibre-gl-shared-dev.mjs:20354). NaN in, NaN out, no throw — so
    // the feature's bbox is [NaN, NaN, NaN, NaN], it belongs to no tile, and
    // the route line is simply ABSENT with nothing in the console. That is why
    // `drawableOverlays` exists: the engine will not complain for us.
    const projectX = (x: number) => x / 360 + 0.5;
    const projectY = (y: number) => {
      const sin = Math.sin((y * Math.PI) / 180);
      const y2 = 0.5 - (0.25 * Math.log((1 + sin) / (1 - sin))) / Math.PI;
      return y2 < 0 ? 0 : y2 > 1 ? 1 : y2;
    };
    expect(Number.isNaN(projectX(NaN))).toBe(true);
    expect(Number.isNaN(projectY(NaN))).toBe(true);

    // The engine's bounds API, by contrast, IS strict about the same position —
    // which is the rule `isDrawableGeoJSON` encodes.
    expect(() => new LngLatBounds().extend([NaN, NaN])).toThrow(
      'Invalid LngLat object: (NaN, NaN)',
    );
  });

  test('rejects every shape a mis-sliced route produces', () => {
    const bad: unknown[] = [
      [
        [2.1, 41.3],
        [NaN, NaN],
        [2.2, 41.4],
      ], // a NaN vertex
      [], // coordinates: []
      [[2.1, 41.3]], // a one-point LineString draws nothing
      [
        [2.1, 41.3],
        [undefined, undefined],
      ], // highlight[0] never arrived
      [
        [2.1, 41.3],
        [2.2, 91],
      ], // a latitude off the earth
      [[2.1], [2.2, 41.4]], // a position with one axis
    ];
    for (const coordinates of bad) {
      expect(isDrawableGeoJSON(line(coordinates).data)).toBe(false);
    }
  });

  test('accepts the shapes Directions actually draws', () => {
    expect(
      isDrawableGeoJSON(
        line([
          [2.1, 41.3],
          [2.15, 41.35],
          [2.2, 41.4],
        ]).data,
      ),
    ).toBe(true);
    // The step highlight collapses to a Point when the slice is one vertex.
    expect(
      isDrawableGeoJSON({
        type: 'Feature',
        properties: {},
        geometry: { type: 'Point', coordinates: [2.1686, 41.3874] },
      }),
    ).toBe(true);
    // Altitude is a legal third ordinate and must not be mistaken for junk.
    expect(
      isDrawableGeoJSON(
        line([
          [2.1, 41.3, 12],
          [2.2, 41.4, 14],
        ]).data,
      ),
    ).toBe(true);
    // An unwrapped longitude past the antimeridian, same as everywhere else.
    expect(
      isDrawableGeoJSON(
        line([
          [181, 41.3],
          [182, 41.4],
        ]).data,
      ),
    ).toBe(true);
  });

  test('drops the bad overlay and keeps the rest', () => {
    const good = line([
      [2.1, 41.3],
      [2.2, 41.4],
    ]);
    const broken = {
      ...line([
        [2.1, 41.3],
        [NaN, NaN],
      ]),
      id: 'goway-route-step',
    };
    const kept = drawableOverlays([good, broken]);
    expect(kept.map((overlay) => overlay.id)).toEqual(['goway-route']);

    // Untouched when nothing is wrong, so the forks' effect deps keep their
    // identity and the source is not torn down and rebuilt every render.
    const clean = [good];
    expect(drawableOverlays(clean)).toBe(clean);
    expect(drawableOverlays(undefined)).toEqual([]);
  });

  test('a non-finite paint number cannot fail the whole addLayer', () => {
    const paint = resolveOverlayPaint('line', { width: NaN, opacity: NaN, radius: NaN }, '#000');
    expect(paint.width).toBe(4);
    expect(paint.opacity).toBe(1);
    expect(paint.radius).toBe(6);
  });
});

describe('seam — the camera SCALARS, which poison the transform one step later', () => {
  test('a NaN zoom is the same crash, arriving through getBounds()', () => {
    // MapLibre's own clamp does not stop it: nothing compares true to NaN.
    const clamp = (n: number, min: number, max: number) => Math.min(Math.max(n, min), max);
    expect(Number.isNaN(clamp(NaN, 0, 22))).toBe(true);
    expect(Number.isNaN(Math.pow(2, NaN))).toBe(true);

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
    expect(() => new LngLat(0 * (1 / Math.pow(2, NaN)), 0 * (1 / Math.pow(2, NaN)))).toThrow(
      'Invalid LngLat object: (NaN, NaN)',
    );
    expect(asFinite(NaN)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The door `every()` left open: a composite geometry with no parts
// ---------------------------------------------------------------------------

describe('seam — an EMPTY composite geometry is the same silent failure', () => {
  const geometry = (data: unknown): GeoJSON.GeoJSON =>
    ({ type: 'Feature', properties: {}, geometry: data } as unknown as GeoJSON.GeoJSON);

  const overlay = (data: unknown): MapOverlay => ({
    id: 'goway-route',
    kind: 'line',
    data: geometry(data),
  });

  test('`[].every()` is true — which is what let these through', () => {
    // The fact the bug rests on, asserted rather than asserted about: a
    // predicate applied to no elements is vacuously satisfied, so a geometry
    // whose ONLY check is `coordinates.every(...)` accepts `coordinates: []`
    // no matter how strict the per-part rule is.
    expect(([] as unknown[]).every(() => false)).toBe(true);
  });

  test('rejects a composite geometry with nothing in it', () => {
    for (const data of [
      { type: 'MultiLineString', coordinates: [] },
      { type: 'Polygon', coordinates: [] },
      { type: 'MultiPolygon', coordinates: [] },
      // A MultiPolygon of one polygon that has no rings: the outer array is
      // non-empty, so only the inner check can catch this one.
      { type: 'MultiPolygon', coordinates: [[]] },
      { type: 'MultiPoint', coordinates: [] },
    ]) {
      expect(isDrawableGeoJSON(geometry(data))).toBe(false);
    }
  });

  test('still accepts the same geometries with real parts', () => {
    const ring = [
      [2.1, 41.3],
      [2.2, 41.3],
      [2.2, 41.4],
      [2.1, 41.3],
    ];
    expect(
      isDrawableGeoJSON(
        geometry({
          type: 'MultiLineString',
          coordinates: [
            [
              [2.1, 41.3],
              [2.2, 41.4],
            ],
          ],
        }),
      ),
    ).toBe(true);
    expect(isDrawableGeoJSON(geometry({ type: 'Polygon', coordinates: [ring] }))).toBe(true);
    expect(isDrawableGeoJSON(geometry({ type: 'MultiPolygon', coordinates: [[ring]] }))).toBe(true);
  });

  test('drawableOverlays drops the empty polygon rather than drawing nothing', () => {
    // The whole point of the validator: an empty Polygon is accepted by
    // MapLibre, tiled by geojson-vt, and renders as absolutely nothing with
    // not a word anywhere. It has to be reported here or not at all.
    const empty = { ...overlay({ type: 'Polygon', coordinates: [] }), id: 'goway-area' };
    const good = overlay({
      type: 'LineString',
      coordinates: [
        [2.1, 41.3],
        [2.2, 41.4],
      ],
    });
    expect(drawableOverlays([good, empty]).map((o) => o.id)).toEqual(['goway-route']);
  });
});
