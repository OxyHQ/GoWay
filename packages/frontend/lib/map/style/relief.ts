/**
 * The relief prototype's style fragments: the elevation sources, the
 * hillshade, the terrain, the globe projection and the sky — and the space
 * behind the globe. `docs/MAP_TERRAIN_GLOBE.md` is the design note.
 *
 * These are NOT part of the generated style documents. `scripts/build-map-style.ts`
 * never imports this module, so `public/map/goway-{light,dark}.json` and
 * `map:style:check` are exactly what they were; the web adapter
 * (`components/map/reliefLayer.web.ts`) lays these over the loaded style at
 * runtime, and only when `lib/map/reliefFlag.ts` says the page asked for them.
 * Keeping them out of the document is what makes "off" mean "unchanged", and it
 * is also the only way a per-tab development switch could work at all.
 *
 * Pure data and pure functions, so every fragment is validated against the
 * MapLibre style spec in `__tests__/relief.test.ts`.
 */
import type {
  HillshadeLayerSpecification,
  RasterDEMSourceSpecification,
  SkySpecification,
  TerrainSpecification,
} from '@maplibre/maplibre-gl-style-spec';

import { type MapAppearance, TERRAIN_SOURCE_LINK } from '../provider';
import { GLOBE_PROJECTION, GLOBE_SPACE_BASE, isReliefId, RELIEF_ID_PREFIX } from '../reliefFlag';

export { GLOBE_PROJECTION };

/**
 * Two sources over the SAME tiles: one feeds the hillshade, one the terrain.
 *
 * MapLibre asks for exactly this (it warns when one `raster-dem` source feeds
 * both): the terrain's tiles are fetched at the terrain's own zoom and resampled
 * for the mesh, the hillshade's at the map's zoom for the shading, and sharing
 * one source makes one of them wrong. The second request for a tile is a
 * browser-cache hit (the Worker serves them cacheable for a week).
 */
export const RELIEF_SOURCE_IDS = {
  hillshade: `${RELIEF_ID_PREFIX}dem-hillshade`,
  terrain: `${RELIEF_ID_PREFIX}dem-terrain`,
} as const;

export const HILLSHADE_LAYER_ID = `${RELIEF_ID_PREFIX}hillshade`;

/**
 * The hillshade goes directly under `water`: above every land fill (land use,
 * land cover, parks), so forests and fields are shaded by the mountains they
 * lie on, and below water, roads, buildings and labels, which stay flat and
 * legible. A style without `water` is not GoWay's, and the relief declines it.
 */
export const HILLSHADE_BEFORE_LAYER_ID = 'water';

/** Is this one of the relief prototype's sources or layers? */
export const isReliefSourceId = isReliefId;

/**
 * The DEM tiles, as Mapterhorn publishes them: Terrarium-encoded WebP, 512 px.
 *
 * Regional data is retained through z16; MapLibre walks to the available
 * parent in regions served only by the global z12 source.
 */
export const RELIEF_DEM = {
  encoding: 'terrarium',
  tileSize: 512,
  minzoom: 0,
  maxzoom: 16,
} as const;

/** A `raster-dem` source over the given `{z}/{x}/{y}` template. */
export function reliefDemSource(tiles: string): RasterDEMSourceSpecification {
  return {
    type: 'raster-dem',
    tiles: [tiles],
    ...RELIEF_DEM,
    attribution: `<a href="${TERRAIN_SOURCE_LINK.href}" target="_blank">${TERRAIN_SOURCE_LINK.label}</a>`,
  };
}

/**
 * The hillshade's colours, per appearance. Cartographic values, like the rest
 * of `palette.ts`: a cool blue-grey shadow (a black one muddies the warm land
 * and the greens into olive) and a white highlight in daylight; in the dark
 * appearance the shadow is near-black navy and the highlight is faint, so the
 * relief reads without lifting the map's overall brightness.
 */
const HILLSHADE_COLOURS: Record<
  MapAppearance,
  { shadow: string; highlight: string; accent: string }
> = {
  light: { shadow: '#4f6274', highlight: '#ffffff', accent: '#6b7c86' },
  dark: { shadow: '#060b16', highlight: '#5d7390', accent: '#0d1626' },
};

/**
 * The hillshade layer. Strongest across the regional zooms where relief is
 * what a map is read for, fading as streets take over, and gone by z17 — at
 * street level the 3D terrain (when tilted) carries the shape and a shaded
 * pavement only dirties it.
 *
 * Only the properties MapLibre Native also implements (a scalar direction, no
 * `hillshade-method`), because `MapCanvas.native.tsx` draws this same layer.
 */
/** Below this the globe draws no hillshade, so no DEM is downloaded for it. */
export const HILLSHADE_MIN_ZOOM = 3;

export function hillshadeLayer(appearance: MapAppearance): HillshadeLayerSpecification {
  const colours = HILLSHADE_COLOURS[appearance];
  return {
    id: HILLSHADE_LAYER_ID,
    type: 'hillshade',
    source: RELIEF_SOURCE_IDS.hillshade,
    // Not on the whole-globe zooms: there the shading is a few pixels of
    // texture and cost ~0.9 MB of DEM per view (measured, 11 tiles at z1.6);
    // MapLibre fetches a source's tiles only while a layer using it is shown.
    minzoom: HILLSHADE_MIN_ZOOM,
    maxzoom: 17,
    paint: {
      'hillshade-exaggeration': [
        'interpolate',
        ['linear'],
        ['zoom'],
        0,
        0.32,
        6,
        0.42,
        11,
        0.38,
        14,
        0.24,
        16.5,
        0,
      ],
      'hillshade-shadow-color': colours.shadow,
      'hillshade-highlight-color': colours.highlight,
      'hillshade-accent-color': colours.accent,
      // Light from the upper left of the SCREEN: the convention every reader
      // has learned, and the one that does not invert valleys into ridges.
      'hillshade-illumination-anchor': 'viewport',
      'hillshade-illumination-direction': 315,
    },
  };
}

/**
 * The terrain. Exaggeration 1: the mountains are as tall as they are. A map is
 * a statement about the world, and Montserrat or the Pyrenees need no help.
 */
export const RELIEF_TERRAIN: TerrainSpecification = {
  source: RELIEF_SOURCE_IDS.terrain,
  exaggeration: 1,
};

/**
 * When the 3D terrain is on: once the camera tilts past {@link TERRAIN_ON_PITCH},
 * off again only when it is back under {@link TERRAIN_OFF_PITCH}.
 *
 * Seen straight down, terrain changes nothing a reader can see — a mountain
 * displaces the picture by `height · tan(pitch)` — and it costs a render-to-
 * texture pass for every 2D layer. So it is switched on as the tilt begins,
 * where that displacement is still tiny (a 1,200 m summit moves ~40 m at 2°),
 * and the relief then grows smoothly with the pitch instead of popping in. The
 * gap between the two thresholds keeps a camera resting near either from
 * toggling it every frame.
 */
export const TERRAIN_ON_PITCH = 2;
export const TERRAIN_OFF_PITCH = 0.5;

export function terrainWanted(pitch: number, terrainOn: boolean): boolean {
  if (!Number.isFinite(pitch)) return terrainOn;
  return terrainOn ? pitch >= TERRAIN_OFF_PITCH : pitch >= TERRAIN_ON_PITCH;
}

/**
 * The sky, per appearance: the gradient a tilted camera sees at the horizon
 * and the fog that softens far terrain into it.
 *
 * MapLibre's own globe ATMOSPHERE is off (`atmosphere-blend: 0`), on
 * measurement. It is a physical scattering model lit by the style's single
 * `light` — which GoWay aims from the sun for the BUILDINGS, shaped and
 * rotated for walls (`buildings3d.ts` → `sunLitBuildingsLight`), so the
 * atmosphere drew a hard, wrongly placed day/night band across the globe;
 * aimed for the atmosphere instead, it is additive haze that washed the light
 * palette out to cyan. The glow around the globe is drawn behind the canvas
 * instead ({@link globeSilhouette}, {@link spaceBackdrop}), and the light is
 * left to the buildings.
 */
const SKY_COLOURS: Record<
  MapAppearance,
  { sky: string; horizon: string; fog: string; fogGroundBlend: number }
> = {
  light: { sky: '#7fb8e6', horizon: '#e4eef4', fog: '#eef2ef', fogGroundBlend: 0.72 },
  dark: { sky: '#071226', horizon: '#22385a', fog: '#26364d', fogGroundBlend: 0.7 },
};

export function reliefSky(appearance: MapAppearance): SkySpecification {
  const colours = SKY_COLOURS[appearance];
  return {
    'sky-color': colours.sky,
    'horizon-color': colours.horizon,
    'fog-color': colours.fog,
    'sky-horizon-blend': 0.6,
    'horizon-fog-blend': 0.45,
    'fog-ground-blend': colours.fogGroundBlend,
    'atmosphere-blend': 0,
  };
}

/**
 * Space, behind the globe: a CSS background on the map's container, which
 * shows through wherever MapLibre draws nothing (it clears to transparent).
 * Deep blue-black rather than #000 — pure black next to the atmosphere's glow
 * reads as a hole — in both appearances, because space has no light mode.
 *
 * The stars are a fixed, seeded pattern of CSS radial gradients: no image to
 * fetch, no canvas, nothing per frame, and the same sky on every load.
 */
export const SPACE_BASE = GLOBE_SPACE_BASE;

/** A deterministic star field: `count` points as CSS radial gradients. */
export function starfield(count: number, seed = 0x9e3779b9): string {
  // mulberry32 — tiny, seeded, good enough to scatter dots.
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const stars: string[] = [];
  for (let i = 0; i < count; i++) {
    const x = (next() * 100).toFixed(2);
    const y = (next() * 100).toFixed(2);
    const size = next() < 0.85 ? 1 : 1.6;
    const alpha = (0.35 + next() * 0.6).toFixed(2);
    stars.push(
      `radial-gradient(${size}px ${size}px at ${x}% ${y}%, rgba(255,255,255,${alpha}), transparent)`,
    );
  }
  return stars.join(', ');
}

const STARS = starfield(90);

/** Zoom from which MapLibre's `globe` is plain mercator (see {@link GLOBE_PROJECTION}). */
export const GLOBE_MERCATOR_ZOOM = 12;

/** Where the globe is on screen: an ellipse, in CSS pixels. */
export interface GlobeSilhouette {
  x: number;
  y: number;
  /** Horizontal semi-axis. */
  rx: number;
  /** Vertical semi-axis. */
  ry: number;
}

/**
 * The globe's outline on screen, from the camera MapLibre reports.
 *
 * MapLibre sizes the sphere so the map's scale at the centre matches mercator
 * (`getGlobeRadiusPixels`: `R = worldSize / 2π / cos(lat)`) and puts the
 * camera `f = cameraToCenterDistance` pixels from the centre point — which is
 * also the focal length, in pixels — tilted by the pitch. So the sphere's
 * centre sits at depth `z = f + R·cos(pitch)`, `y = R·sin(pitch)` below the
 * view axis, and its silhouette is the section of the tangent cone (half-angle
 * `α = asin(R / D)` about a ray `θ = atan(y / z)` off-axis) by the image plane:
 * an ellipse, exact top and bottom at `f·tan(θ ∓ α)`, horizontal semi-axis
 * `f·sin α / √(cos²θ − sin²α)`. `null` when the cone does not close in front of
 * the camera (a pitched camera low over a huge globe) — the globe then fills
 * the bottom of the frame and there is no outline to glow.
 */
export function globeSilhouette(camera: {
  worldSize: number;
  latitudeDeg: number;
  pitchDeg: number;
  cameraToCenterDistance: number;
  centerPoint: { x: number; y: number };
}): GlobeSilhouette | null {
  const f = camera.cameraToCenterDistance;
  const cosLat = Math.cos((camera.latitudeDeg * Math.PI) / 180);
  if (!(f > 0) || !(camera.worldSize > 0) || !(cosLat > 1e-6)) return null;
  const radius = camera.worldSize / (2 * Math.PI) / cosLat;
  const pitch = (camera.pitchDeg * Math.PI) / 180;
  const z = f + radius * Math.cos(pitch);
  const y = radius * Math.sin(pitch);
  const distance = Math.hypot(z, y);
  if (!(distance > radius) || !(z > 0)) return null;
  const alpha = Math.asin(radius / distance);
  const theta = Math.atan2(y, z);
  if (theta + alpha >= Math.PI / 2) return null;
  const top = f * Math.tan(theta - alpha);
  const bottom = f * Math.tan(theta + alpha);
  const closing = Math.cos(theta) ** 2 - Math.sin(alpha) ** 2;
  if (!(closing > 0)) return null;
  const result = {
    x: camera.centerPoint.x,
    y: camera.centerPoint.y + (top + bottom) / 2,
    rx: (f * Math.sin(alpha)) / Math.sqrt(closing),
    ry: (bottom - top) / 2,
  };
  return [result.x, result.y, result.rx, result.ry].every(Number.isFinite) ? result : null;
}

/**
 * The container background behind the globe: a soft blue glow hugging the
 * silhouette (when there is one to hug), the stars, and the deep-space
 * gradient. Same in both appearances; the glow is the one thing that says
 * "atmosphere", without tinting the map itself.
 */
export function spaceBackdrop(globe: GlobeSilhouette | null): string {
  if (!globe) return `${STARS}, ${SPACE_BASE}`;
  // An ellipse of the silhouette's own size, so percentages are of the outline.
  const shape = `ellipse ${globe.rx.toFixed(1)}px ${globe.ry.toFixed(1)}px at ${globe.x.toFixed(1)}px ${globe.y.toFixed(1)}px`;
  const glow =
    `radial-gradient(${shape}, rgba(140,190,255,0) 98.5%, rgba(150,200,255,0.62) 100%, ` +
    'rgba(90,150,255,0.28) 103.5%, rgba(60,110,230,0.1) 110%, rgba(40,80,200,0) 128%)';
  return `${glow}, ${STARS}, ${SPACE_BASE}`;
}
