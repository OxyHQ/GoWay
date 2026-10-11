/**
 * The MapLibre adapter for GoWay Live: draws a {@link MapLiveLayer}'s points
 * as heading-oriented glyphs, keeps them moving, answers taps, and — with the
 * city-3D engine attached — hands a three.js pass the same points to draw in
 * 3D at their real altitude.
 *
 * Reached ONLY through `import('./liveLayer.web')` in `MapCanvas.web.tsx`,
 * and only when the canvas is given a `live` layer — which `ExploreScreen`
 * gives only when `lib/map/liveFlag.ts` says so. Like `city3dLayer.web.ts` its
 * `maplibre-gl` import is TYPE-ONLY: it operates on the map `MapCanvas`
 * created and passes in. The 3D pass loads through the one three.js chunk
 * (`components/engine3d/lazyChunk.ts`); this file imports the engine folders
 * for types only, so nothing here is hoisted into the first-paint bundle.
 *
 * ## Drawing
 *
 * One GeoJSON source, two layers: a ring under the selected point and the
 * glyphs. Glyphs are drawn once into canvases (`map.addImage`) per shape and
 * colour, in a DIRECTIONAL version rotated to the point's heading and a STILL
 * version for a point without one — a vehicle whose feed reports no course
 * must not be drawn pointing north.
 *
 * ## Frames
 *
 * Positions move between fixes (the feature's dead reckoning), so the source
 * is re-set on an animation frame — throttled by zoom, because at a
 * continental zoom a moving aircraft crosses a pixel every few seconds — and
 * only while {@link MapLiveLayer.animating} says something moves. Otherwise
 * the loop sleeps until the layer notifies. A hidden tab draws nothing.
 */
import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';

import { GOWAY_LAYER_PREFIX } from '@/lib/map/provider';
import { FONT_STACKS } from '@/lib/map/style/schema';

import type { City3dHandle } from './city3dLayer.web';
// Type-only, as in `city3dLayer.web.ts`: the engine chunk imports these at
// runtime, and a module two lazy chunks share is hoisted into `__common`.
import type { LivePass } from './engine/live3d/livePass';
import { reportMapDefect } from './shared';
import type { MapLiveGlyph, MapLiveLayer, MapLivePoint } from './types';

export const LIVE_SOURCE_ID = `${GOWAY_LAYER_PREFIX}live`;
export const LIVE_ICON_LAYER_ID = `${GOWAY_LAYER_PREFIX}live-icons`;
export const LIVE_RING_LAYER_ID = `${GOWAY_LAYER_PREFIX}live-ring`;

/** The tap radius around a glyph, in CSS pixels. */
const PICK_PAD_PX = 14;
/** Glyph bitmaps are drawn at this many device pixels per CSS pixel. */
const GLYPH_PIXEL_RATIO = 2;
const GLYPH_CSS_PX = 26;

export interface LiveLayerHandle {
  /** The live point under a CSS-pixel point of the canvas, or `null`. */
  pick(point: { x: number; y: number }): string | null;
  /** Give the 3D pass the city engine to draw in, or take it away. */
  setCity(city: City3dHandle | null): void;
  detach(): void;
}

/** `requestAnimationFrame`, or a timer where there is none (tests). */
const requestFrame = (callback: () => void): number =>
  typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame(callback)
    : (setTimeout(callback, 16) as unknown as number);
const cancelFrame = (handle: number): void => {
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle);
  else clearTimeout(handle);
};

/** Frame interval by zoom: a pixel is ~10 km at z6 and ~10 m at z16. */
export function frameIntervalMs(zoom: number): number {
  if (zoom >= 12) return 50;
  if (zoom >= 9) return 100;
  return 250;
}

export interface GlyphVariant {
  glyph: string;
  directional: boolean;
  /** The colour it is drawn in, when not the glyph's own (a line colour). */
  tint?: string;
  approximate?: boolean;
  estimated?: boolean;
}

export function imageName(
  glyph: string,
  directional: boolean,
  tint?: string,
  approximate?: boolean,
  estimated?: boolean,
): string {
  return `${GOWAY_LAYER_PREFIX}live:${glyph}:${directional ? 'dir' : 'still'}${tint ? `:${tint}` : ''}${approximate ? ':approx' : ''}${estimated ? ':est' : ''}`;
}

/** Glyph length in CSS pixels at `icon-size` 1, for the shapes drawn to scale. */
const SCALED_GLYPH_PX: Partial<Record<MapLiveGlyph['shape'], number>> = { train: 96, bus: 48 };

/**
 * `icon-size` that makes a glyph its real length at zoom 13: CSS pixels per
 * metre at z13 on 512-px tiles, at ~41° (Barcelona, New York) — scale, not
 * survey. Doubles with every zoom (the expression is exponential, base 2).
 */
export function scaleAtZoom13(lengthMeters: number, glyphPx: number): number {
  const metresPerPixel = (40_075_016 * Math.cos((41 * Math.PI) / 180)) / (512 * 2 ** 13);
  return lengthMeters / metresPerPixel / glyphPx;
}

/** The GeoJSON the source is set to. Exported for the tests. */
export function featureCollection(
  points: readonly MapLivePoint[],
  options: { glyphs: Readonly<Record<string, MapLiveGlyph>>; threeD: boolean },
): GeoJSON.FeatureCollection<GeoJSON.Point> {
  const features: GeoJSON.Feature<GeoJSON.Point>[] = [];
  for (const point of points) {
    if (!options.glyphs[point.glyph]) continue;
    const { latitude, longitude } = point.coordinate;
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
    const directional = point.heading !== null && Number.isFinite(point.heading);
    const airborne = point.altitude !== null && point.altitude > 30;
    const shape = options.glyphs[point.glyph]?.shape;
    const glyphPx = shape ? SCALED_GLYPH_PX[shape] : undefined;
    features.push({
      type: 'Feature',
      id: point.id,
      geometry: { type: 'Point', coordinates: [longitude, latitude] },
      properties: {
        id: point.id,
        icon: imageName(point.glyph, directional, point.tint, point.approximate, point.estimated),
        heading: directional ? point.heading : 0,
        // With the 3D pass drawing a vehicle, its glyph steps back: an
        // airborne aircraft's becomes its shadow, a train's or bus's a faint
        // footprint under its model.
        opacity:
          Math.max(0, Math.min(1, point.opacity)) *
          (options.threeD && (airborne || glyphPx) ? 0.4 : 1),
        label: point.label ?? '',
        selected: point.selected === true,
        // Trains and buses grow to their real length at street zooms.
        min: glyphPx ? (glyphPx === 96 ? 0.42 : 0.6) : 0.8,
        k13: glyphPx && point.length && directional ? scaleAtZoom13(point.length, glyphPx) : 0,
      },
    });
  }
  return { type: 'FeatureCollection', features };
}

// ---------------------------------------------------------------------------
// Glyph bitmaps
// ---------------------------------------------------------------------------

type Ctx = CanvasRenderingContext2D;

function drawAircraft(ctx: Ctx, s: number): void {
  // Nose up (north), centred; s is the bitmap size.
  const c = s / 2;
  const u = s / 26;
  ctx.beginPath();
  ctx.moveTo(c, c - 11 * u); // nose
  ctx.lineTo(c + 1.6 * u, c - 8 * u);
  ctx.lineTo(c + 1.6 * u, c - 2.5 * u);
  ctx.lineTo(c + 11 * u, c + 2.5 * u); // right wing tip
  ctx.lineTo(c + 11 * u, c + 4.5 * u);
  ctx.lineTo(c + 1.6 * u, c + 2 * u);
  ctx.lineTo(c + 1.2 * u, c + 7.5 * u);
  ctx.lineTo(c + 4.5 * u, c + 10 * u); // right tailplane
  ctx.lineTo(c + 4.5 * u, c + 11.3 * u);
  ctx.lineTo(c, c + 10.3 * u);
  ctx.lineTo(c - 4.5 * u, c + 11.3 * u);
  ctx.lineTo(c - 4.5 * u, c + 10 * u);
  ctx.lineTo(c - 1.2 * u, c + 7.5 * u);
  ctx.lineTo(c - 1.6 * u, c + 2 * u);
  ctx.lineTo(c - 11 * u, c + 4.5 * u);
  ctx.lineTo(c - 11 * u, c + 2.5 * u);
  ctx.lineTo(c - 1.6 * u, c - 2.5 * u);
  ctx.lineTo(c - 1.6 * u, c - 8 * u);
  ctx.closePath();
}

function drawPointer(ctx: Ctx, s: number, radius: number): void {
  // A disc with a pointed tip towards the top: a navigation marker.
  const c = s / 2;
  ctx.beginPath();
  ctx.moveTo(c, c - radius * 1.75);
  ctx.arc(c, c, radius, -Math.PI / 2 - 0.62, -Math.PI / 2 + 0.62, true);
  ctx.closePath();
}

function drawBoat(ctx: Ctx, s: number): void {
  const c = s / 2;
  const u = s / 26;
  ctx.beginPath();
  ctx.moveTo(c, c - 10 * u);
  ctx.quadraticCurveTo(c + 5 * u, c - 4 * u, c + 4.5 * u, c + 8 * u);
  ctx.lineTo(c - 4.5 * u, c + 8 * u);
  ctx.quadraticCurveTo(c - 5 * u, c - 4 * u, c, c - 10 * u);
  ctx.closePath();
}

function drawDisc(ctx: Ctx, s: number, radius: number): void {
  ctx.beginPath();
  ctx.arc(s / 2, s / 2, radius, 0, Math.PI * 2);
  ctx.closePath();
}

/** One glyph bitmap, or `null` where there is no 2D canvas (tests, SSR). */
/** A train (or bus) seen from above, nose up: a long rounded body, a darker roof line, a pointed cab. */
function drawVehicleBody(ctx: Ctx, w: number, h: number, nose: number): void {
  const r = w * 0.42;
  ctx.beginPath();
  ctx.moveTo(w / 2, 1.5);
  ctx.quadraticCurveTo(w - 2, 1.5 + nose * 0.4, w - 2, nose);
  ctx.lineTo(w - 2, h - r);
  ctx.quadraticCurveTo(w - 2, h - 2, w / 2, h - 2);
  ctx.quadraticCurveTo(2, h - 2, 2, h - r);
  ctx.lineTo(2, nose);
  ctx.quadraticCurveTo(2, 1.5 + nose * 0.4, w / 2, 1.5);
  ctx.closePath();
}

function glyphImage(glyph: MapLiveGlyph, variant: GlyphVariant): ImageData | null {
  if (typeof document === 'undefined') return null;
  const { directional } = variant;
  const color = variant.tint ?? glyph.color;
  const scaled = SCALED_GLYPH_PX[glyph.shape];
  if (scaled && directional) {
    // A long silhouette: `scaled` CSS px long, a quarter of that wide (trains), more for buses.
    const width = (glyph.shape === 'train' ? 18 : 18) * GLYPH_PIXEL_RATIO;
    const height = scaled * GLYPH_PIXEL_RATIO;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    drawVehicleBody(ctx, width, height, width * 0.9);
    ctx.lineJoin = 'round';
    ctx.lineWidth = 2.6 * GLYPH_PIXEL_RATIO;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
    if (variant.estimated) {
      // Estimated: hollow — a solid outline in its colour round a faint wash
      // of it, and no windscreen. Never a vehicle anyone reported.
      ctx.globalAlpha = 0.28;
      ctx.fillStyle = color;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.lineWidth = 2 * GLYPH_PIXEL_RATIO;
      ctx.strokeStyle = color;
      ctx.stroke();
    } else if (variant.approximate) {
      // Approximate: a pale body with a dashed outline in its colour.
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fill();
      ctx.setLineDash([3 * GLYPH_PIXEL_RATIO, 2.5 * GLYPH_PIXEL_RATIO]);
      ctx.lineWidth = 1.6 * GLYPH_PIXEL_RATIO;
      ctx.strokeStyle = color;
      ctx.stroke();
      ctx.setLineDash([]);
    } else {
      ctx.fillStyle = color;
      ctx.fill();
      // The roof line and the cab windscreen, in white: front and back read at a glance.
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.fillRect(width * 0.3, width * 0.95, width * 0.4, height - width * 1.6);
      ctx.beginPath();
      ctx.ellipse(width / 2, width * 0.55, width * 0.24, width * 0.16, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    return ctx.getImageData(0, 0, width, height);
  }
  const size = GLYPH_CSS_PX * GLYPH_PIXEL_RATIO;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const u = size / 26;
  switch (glyph.shape) {
    case 'train':
    case 'bus':
      drawDisc(ctx, size, 7 * u);
      break;
    case 'aircraft':
      if (directional) drawAircraft(ctx, size);
      else drawDisc(ctx, size, 5.5 * u);
      break;
    case 'boat':
      if (directional) drawBoat(ctx, size);
      else drawDisc(ctx, size, 5 * u);
      break;
    case 'vehicle':
    case 'arrow':
      if (directional) drawPointer(ctx, size, 7 * u);
      else drawDisc(ctx, size, 7 * u);
      break;
    case 'station':
      drawDisc(ctx, size, 6 * u);
      break;
  }
  // A white keyline so a glyph reads on any basemap colour, light or dark.
  ctx.lineJoin = 'round';
  ctx.lineWidth = 2.4 * u;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();
  if (variant.estimated) {
    ctx.globalAlpha = 0.28;
    ctx.fillStyle = color;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1.8 * u;
    ctx.strokeStyle = color;
    ctx.stroke();
    return ctx.getImageData(0, 0, size, size);
  }
  if (variant.approximate) {
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fill();
    ctx.setLineDash([3 * u, 2.4 * u]);
    ctx.lineWidth = 1.6 * u;
    ctx.strokeStyle = color;
    ctx.stroke();
    ctx.setLineDash([]);
    return ctx.getImageData(0, 0, size, size);
  }
  ctx.fillStyle = color;
  ctx.fill();
  if (
    glyph.shape === 'vehicle' ||
    glyph.shape === 'station' ||
    glyph.shape === 'train' ||
    glyph.shape === 'bus'
  ) {
    // A small white centre: reads as a stop/vehicle marker at any size.
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, 2.1 * u, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
  }
  return ctx.getImageData(0, 0, size, size);
}

// ---------------------------------------------------------------------------
// Attach
// ---------------------------------------------------------------------------

export function attachLive(
  map: MapLibreMap,
  layer: MapLiveLayer,
  options: { appearance: 'light' | 'dark' },
): LiveLayerHandle {
  const images = new Set<string>();
  /** Draw a glyph variant the first time something needs it (line colours are open-ended). */
  const ensureImage = (variant: GlyphVariant) => {
    const id = imageName(
      variant.glyph,
      variant.directional,
      variant.tint,
      variant.approximate,
      variant.estimated,
    );
    if (images.has(id) || map.hasImage(id)) return;
    const glyph = layer.glyphs[variant.glyph];
    if (!glyph) return;
    const image = glyphImage(glyph, variant);
    if (!image) return;
    map.addImage(id, image, { pixelRatio: GLYPH_PIXEL_RATIO });
    images.add(id);
  };
  for (const name of Object.keys(layer.glyphs)) {
    for (const directional of [true, false]) ensureImage({ glyph: name, directional });
  }

  let threeD = false;
  map.addSource(LIVE_SOURCE_ID, {
    type: 'geojson',
    data: featureCollection([], { glyphs: layer.glyphs, threeD }),
    promoteId: 'id',
  });
  const ink = options.appearance === 'dark' ? '#ffffff' : '#111827';
  const halo = options.appearance === 'dark' ? '#111827' : '#ffffff';
  // On top of the style: a live thing is what the user turned this layer on
  // to see, and its glyphs are small and opt out of collisions, so they never
  // push a label off the map — they sit over it.
  map.addLayer({
    id: LIVE_RING_LAYER_ID,
    type: 'circle',
    source: LIVE_SOURCE_ID,
    filter: ['==', ['get', 'selected'], true],
    paint: {
      'circle-radius': 17,
      'circle-color': 'rgba(0,0,0,0)',
      'circle-stroke-width': 3,
      'circle-stroke-color': ink,
    },
  });
  map.addLayer({
    id: LIVE_ICON_LAYER_ID,
    type: 'symbol',
    source: LIVE_SOURCE_ID,
    layout: {
      'icon-image': ['get', 'icon'],
      'icon-rotate': ['get', 'heading'],
      'icon-rotation-alignment': 'map',
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
      // Glyphs keep a legible minimum; trains and buses (`k13`) grow to their
      // real length from z13, doubling with each zoom like the map does.
      'icon-size': [
        'interpolate',
        ['exponential', 2],
        ['zoom'],
        6,
        ['*', ['get', 'min'], 0.68],
        11,
        ['get', 'min'],
        13,
        ['max', ['get', 'min'], ['get', 'k13']],
        20,
        ['max', ['get', 'min'], ['*', ['get', 'k13'], 128]],
      ],
      'text-field': ['step', ['zoom'], '', 12, ['get', 'label']],
      'text-font': [...FONT_STACKS.semibold],
      'text-size': 11,
      'text-offset': [1.15, 0],
      'text-anchor': 'left',
      'text-optional': true,
      'text-allow-overlap': false,
    },
    paint: {
      'icon-opacity': ['get', 'opacity'],
      'text-opacity': ['get', 'opacity'],
      'text-color': ink,
      'text-halo-color': halo,
      'text-halo-width': 1.4,
    },
  });

  let raf: number | null = null;
  let lastPush = 0;
  let detached = false;
  let points: readonly MapLivePoint[] = [];
  let pointsAt = 0;

  const sampleNow = (): readonly MapLivePoint[] => {
    const now = Date.now();
    // The 2D push and the 3D pass both ask within one frame: one sample.
    if (now - pointsAt > 12) {
      points = layer.sample(now);
      pointsAt = now;
    }
    return points;
  };

  const push = () => {
    if (detached) return;
    const source = map.getSource<GeoJSONSource>(LIVE_SOURCE_ID);
    if (!source) return;
    const points = sampleNow();
    for (const point of points) {
      if (!point.tint && !point.approximate && !point.estimated) continue;
      ensureImage({
        glyph: point.glyph,
        directional: point.heading !== null && Number.isFinite(point.heading),
        tint: point.tint,
        approximate: point.approximate,
        estimated: point.estimated,
      });
    }
    source.setData(featureCollection(points, { glyphs: layer.glyphs, threeD }));
    lastPush = Date.now();
  };

  const frame = () => {
    raf = null;
    if (detached) return;
    if (typeof document !== 'undefined' && document.hidden) return; // `visibilitychange` resumes
    if (Date.now() - lastPush >= frameIntervalMs(map.getZoom())) {
      push();
      if (threeD) map.triggerRepaint();
    }
    if (layer.animating()) raf = requestFrame(frame);
  };

  const wake = () => {
    if (detached) return;
    if (raf === null) raf = requestFrame(frame);
  };

  const unsubscribe = layer.subscribe(() => {
    // Data or selection changed: draw it now, then keep going if it moves.
    lastPush = 0;
    wake();
  });

  const reportViewport = () => {
    const bounds = map.getBounds();
    layer.setViewport({
      bounds: {
        west: bounds.getWest(),
        south: bounds.getSouth(),
        east: bounds.getEast(),
        north: bounds.getNorth(),
      },
      zoom: map.getZoom(),
    });
  };
  const onVisibility = () => {
    lastPush = 0;
    wake();
  };
  map.on('moveend', reportViewport);
  // Development only: where the drawn points are on screen, so a console (or a
  // headless browser) can find and tap one. Never in a production build.
  if (typeof __DEV__ !== 'undefined' && __DEV__) {
    (globalThis as { __gowayLive?: unknown }).__gowayLive = {
      onScreen: () =>
        sampleNow().map((point) => {
          const at = map.project([point.coordinate.longitude, point.coordinate.latitude]);
          return { id: point.id, glyph: point.glyph, x: at.x, y: at.y, altitude: point.altitude };
        }),
      pick: (x: number, y: number) => handle.pick({ x, y }),
    };
  }
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
  reportViewport();
  wake();

  // ── 3D ────────────────────────────────────────────────────────────────────
  let city: City3dHandle | null = null;
  let removePass: (() => void) | null = null;
  let passLoading = false;

  const setCity = (next: City3dHandle | null) => {
    if (next === city) return;
    removePass?.();
    removePass = null;
    city = next;
    threeD = false;
    if (!next || passLoading) {
      lastPush = 0;
      wake();
      return;
    }
    passLoading = true;
    import('@/components/engine3d/lazyChunk')
      .then(({ createLivePass }) => {
        passLoading = false;
        if (detached || city !== next) return;
        const pass: LivePass = createLivePass({
          glyphs: layer.glyphs,
          models: layer.models ?? {},
          points: sampleNow,
          // With 3D terrain on, the ground is the elevation MapLibre draws.
          groundAt: () =>
            map.getTerrain()
              ? (longitude, latitude) => map.queryTerrainElevation([longitude, latitude]) ?? 0
              : null,
          requestRepaint: () => map.triggerRepaint(),
        });
        removePass = next.addPass(pass);
        threeD = true;
        lastPush = 0;
        wake();
      })
      .catch((cause: unknown) => {
        passLoading = false;
        reportMapDefect('live:3d', `live: 3D pass not attached (${String(cause)}); 2D kept.`);
      });
  };

  const handle: LiveLayerHandle = {
    pick(point) {
      if (detached || !map.getLayer(LIVE_ICON_LAYER_ID)) return null;
      let hits: {
        properties?: Record<string, unknown> | null;
        geometry?: { type: string; coordinates?: unknown };
      }[];
      try {
        hits = map.queryRenderedFeatures(
          [
            [point.x - PICK_PAD_PX, point.y - PICK_PAD_PX],
            [point.x + PICK_PAD_PX, point.y + PICK_PAD_PX],
          ],
          { layers: [LIVE_ICON_LAYER_ID] },
        );
      } catch {
        return null;
      }
      // The nearest glyph to the pointer, not the first the index returns:
      // buses queue at a stop a few pixels apart.
      let best: string | null = null;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (const hit of hits) {
        const id = hit.properties?.id;
        if (typeof id !== 'string') continue;
        const coordinates = hit.geometry?.type === 'Point' ? hit.geometry.coordinates : null;
        let distance = PICK_PAD_PX;
        if (
          Array.isArray(coordinates) &&
          typeof coordinates[0] === 'number' &&
          typeof coordinates[1] === 'number'
        ) {
          const at = map.project([coordinates[0], coordinates[1]]);
          distance = Math.hypot(at.x - point.x, at.y - point.y);
        }
        if (distance < bestDistance) {
          best = id;
          bestDistance = distance;
        }
      }
      return best;
    },
    setCity,
    detach() {
      if (detached) return;
      detached = true;
      if (raf !== null) cancelFrame(raf);
      raf = null;
      unsubscribe();
      removePass?.();
      removePass = null;
      map.off('moveend', reportViewport);
      if (typeof __DEV__ !== 'undefined' && __DEV__)
        delete (globalThis as { __gowayLive?: unknown }).__gowayLive;
      if (typeof document !== 'undefined')
        document.removeEventListener('visibilitychange', onVisibility);
      // The map may already be gone (a style swap tears it down first).
      try {
        for (const id of [LIVE_ICON_LAYER_ID, LIVE_RING_LAYER_ID])
          if (map.getLayer(id)) map.removeLayer(id);
        if (map.getSource(LIVE_SOURCE_ID)) map.removeSource(LIVE_SOURCE_ID);
        for (const id of images) if (map.hasImage(id)) map.removeImage(id);
        images.clear();
      } catch {
        // A removed map throws on style access; the layers went with it.
      }
    },
  };
  return handle;
}
