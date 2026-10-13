/**
 * The MapLibre adapter for the relief prototype: the globe, the sky and space
 * behind it, the hillshade, and 3D terrain while the camera is tilted. The
 * fragments are `lib/map/style/relief.ts`; the design note is
 * `docs/MAP_TERRAIN_GLOBE.md`.
 *
 * Reached ONLY through `import('./reliefLayer.web')` in `MapCanvas.web.tsx`,
 * started at module evaluation and only when `MAP_RELIEF` asks for globe or
 * terrain — so with both flags off this chunk is never requested and the
 * style is never touched. Like `city3dLayer.web.ts` it keeps to the letter of
 * "`MapCanvas.web.tsx` is the only web file allowed to import a map engine":
 * its `maplibre-gl` import is TYPE-ONLY, and it operates on the `Map` that
 * `MapCanvas` created.
 *
 * ## Lifetime
 *
 * One attachment per `maplibregl.Map`. `MapCanvas` builds a new map for an
 * appearance change or a retry, and attaches again; {@link ReliefHandle.detach}
 * runs just before the old map is removed, so it only has to give back what
 * outlives the map — its listeners and the container's background — and
 * leaves the style alone.
 *
 * ## A style GoWay does not own
 *
 * The globe and the sky are about the camera and the frame, not about the
 * document, and apply to any style. The hillshade is ANCHORED in the
 * document (directly under `water`), so — exactly like the city layer — it is
 * added only to GoWay's own style (`resolveOwnsStyleDocument`) and only when
 * that anchor is there. The terrain goes with it: a 3D surface under a
 * fallback style that was never drawn for one is a restyle, not a fallback.
 */
import type { Map as MapLibreMap, AddProtocolAction } from 'maplibre-gl';
import { CITY_ROAD_TILE_PATH } from '@/lib/map/cityRoads';
import { terrainDemProtocol } from './terrainDem.web';

import {
  type MapAppearance,
  resolveMapAnchors,
  resolveOwnsStyleDocument,
  resolveTerrainTileUrl,
} from '@/lib/map/provider';
import type { ReliefFlags } from '@/lib/map/reliefFlag';
import { BUILDING_3D_LAYER_ID } from '@/lib/map/style/buildings3d';
import {
  GLOBE_MERCATOR_ZOOM,
  GLOBE_PROJECTION,
  globeSilhouette,
  HILLSHADE_BEFORE_LAYER_ID,
  HILLSHADE_LAYER_ID,
  hillshadeLayer,
  isReliefSourceId,
  RELIEF_SOURCE_IDS,
  RELIEF_TERRAIN,
  reliefDemSource,
  reliefSky,
  spaceBackdrop,
  terrainWanted,
} from '@/lib/map/style/relief';

import { createGlobeNightLayer, GLOBE_NIGHT_LAYER_ID } from './globeNightLayer.web';
import { reportMapDefect } from './shared';

export interface AttachReliefOptions {
  addProtocol?: (name: string, action: AddProtocolAction) => void;
  removeProtocol?: (name: string) => void;
  demCacheTiles?: number;
  flags: ReliefFlags;
  appearance: MapAppearance;
  /**
   * The quality profile's `relief.terrain3d` (`lib/map/quality/profile.ts`):
   * `false` keeps the hillshade (and the globe) but never switches MapLibre's
   * 3D terrain on. Defaults to `true`.
   */
  terrain3d?: boolean;
  /**
   * The quality profile's `relief.terrainTextureScale`: MapLibre's terrain
   * render-to-texture side as a multiple of its terrain tile (its own default
   * is 2). Defaults to 2.
   */
  terrainTextureScale?: number;
  /** The quality profile's `relief.globeNight`: day and night on the globe. Defaults to `true`. */
  globeNight?: boolean;
  /** The instant the globe is lit for (the time-of-day scrubber's); `null`, the default, is now. */
  at?: Date | null;
}

export interface ReliefHandle {
  setDemCacheTiles(tiles: number): void;
  /** The quality profile changed: allow or forbid 3D terrain, live. */
  setTerrain3d(allowed: boolean): void;
  /** The quality profile changed: the terrain textures' scale, live (the terrain is re-made). */
  setTerrainTextureScale(scale: number): void;
  /** The quality profile changed: day and night on the globe, or not. */
  setGlobeNight(enabled: boolean): void;
  /** The instant to light the globe for (the time-of-day scrubber); `null` is now. */
  setTime(at: Date | null): void;
  /** Stop listening and give the container its background back. Idempotent. */
  detach(): void;
}

const NOT_LOADED = 'Style is not done loading';

/**
 * Size MapLibre's terrain textures — the 2D layers it caches per terrain tile —
 * at `scale` × the terrain tile (its own default is 2). `Terrain.qualityFactor`
 * is MapLibre's documented knob for exactly this, but it is read once, when
 * `setTerrain` makes the terrain's render-to-texture, so the size computed
 * there is set too. Both are guarded: on a MapLibre without them nothing
 * changes (the default size), and `reliefTextureScale.test.ts` pins the
 * installed version's code.
 */
export function applyTextureScale(map: MapLibreMap, scale: number): void {
  const internal = map as unknown as {
    terrain?: { qualityFactor?: number; tileManager?: { tileSize?: number } } | null;
    painter?: { renderToTexture?: { rttSize?: number } };
  };
  const terrain = internal.terrain;
  const tileSize = terrain?.tileManager?.tileSize;
  const rtt = internal.painter?.renderToTexture;
  if (!terrain || typeof terrain.qualityFactor !== 'number' || !tileSize || !rtt) return;
  if (typeof rtt.rttSize !== 'number') return;
  terrain.qualityFactor = scale;
  rtt.rttSize = tileSize * scale;
}

/**
 * Lay the relief over `map` — now if its style has loaded, else on
 * `style.load`, which fires before the first frame is drawn, so the globe is
 * never seen flat first.
 */
export function attachRelief(map: MapLibreMap, options: AttachReliefOptions): ReliefHandle {
  const { flags, appearance } = options;
  const container = map.getContainer();
  const previousBackground = container.style.background;
  let detached = false;
  let terrainReady = false;
  let dem: ReturnType<typeof terrainDemProtocol> | null = null;
  let terrain3d = options.terrain3d !== false;
  let textureScale = options.terrainTextureScale ?? 2;
  const night = flags.globe
    ? createGlobeNightLayer({
        appearance,
        at: options.at ?? null,
        enabled: options.globeNight !== false,
        onDefect: (message) => reportMapDefect('relief:night', message),
      })
    : null;

  // Space is the container's own background: MapLibre clears to transparent
  // and draws nothing around the globe, so this is what shows there — with
  // the atmosphere's glow re-drawn around the globe's outline whenever the
  // camera moves (a string assignment; the browser composites it).
  let lastBackdrop = '';
  const updateSpace = () => {
    if (detached || !flags.globe) return;
    const zoom = map.getZoom();
    let silhouette = null;
    if (zoom < GLOBE_MERCATOR_ZOOM) {
      // MapLibre's own camera quantities, from public API: 512 px tiles, the
      // focal length from the vertical field of view, the padded centre.
      const width = container.clientWidth;
      const height = container.clientHeight;
      const padding = map.getPadding();
      const fov = (map.getVerticalFieldOfView() * Math.PI) / 180;
      silhouette = globeSilhouette({
        worldSize: 512 * 2 ** zoom,
        latitudeDeg: map.getCenter().lat,
        pitchDeg: map.getPitch(),
        cameraToCenterDistance: (0.5 / Math.tan(fov / 2)) * height,
        centerPoint: {
          x: (width + (padding.left ?? 0) - (padding.right ?? 0)) / 2,
          y: (height + (padding.top ?? 0) - (padding.bottom ?? 0)) / 2,
        },
      });
    }
    const backdrop = spaceBackdrop(silhouette);
    if (backdrop === lastBackdrop) return;
    lastBackdrop = backdrop;
    container.style.background = backdrop;
  };
  updateSpace();

  const syncTerrain = () => {
    if (detached || !terrainReady) return;
    const on = map.getTerrain() !== null;
    const wanted = terrain3d && terrainWanted(map.getPitch(), on);
    if (wanted === on) return;
    try {
      map.setTerrain(wanted ? RELIEF_TERRAIN : null);
      if (wanted) applyTextureScale(map, textureScale);
    } catch (cause) {
      reportMapDefect('relief:terrain', `relief: terrain not toggled (${String(cause)}).`);
    }
  };

  const addTerrain = () => {
    if (!resolveOwnsStyleDocument() || !map.getLayer(HILLSHADE_BEFORE_LAYER_ID)) {
      reportMapDefect(
        'relief:not-owned',
        `relief: the style is not GoWay's (or has no "${HILLSHADE_BEFORE_LAYER_ID}"); no hillshade or terrain.`,
      );
      return;
    }
    if (!dem && options.addProtocol && options.removeProtocol && options.demCacheTiles) {
      dem = terrainDemProtocol({
        template: resolveTerrainTileUrl(),
        roads: `${window.location.origin}${CITY_ROAD_TILE_PATH}`,
        cacheTiles: options.demCacheTiles,
        addProtocol: options.addProtocol,
        removeProtocol: options.removeProtocol,
      });
    }
    const tiles = dem?.template ?? resolveTerrainTileUrl();
    for (const id of [RELIEF_SOURCE_IDS.hillshade, RELIEF_SOURCE_IDS.terrain]) {
      if (!map.getSource(id)) map.addSource(id, reliefDemSource(tiles));
    }
    if (!map.getLayer(HILLSHADE_LAYER_ID)) {
      map.addLayer(hillshadeLayer(appearance), HILLSHADE_BEFORE_LAYER_ID);
    }
    terrainReady = true;
    syncTerrain();
  };

  // The night goes under the 3D layers (the city layer is put right before
  // `building-3d` later, so it ends up above this) and under the labels,
  // which stay legible on the night side. Only into a style with one of
  // those anchors: over somebody else's labels it would dim them.
  const addNight = () => {
    if (!night || map.getLayer(GLOBE_NIGHT_LAYER_ID)) return;
    const labels = resolveMapAnchors().beforeLabels;
    const before = map.getLayer(BUILDING_3D_LAYER_ID)
      ? BUILDING_3D_LAYER_ID
      : labels && map.getLayer(labels)
        ? labels
        : null;
    if (!before) return;
    map.addLayer(night, before);
  };

  /** `false` while the style is not loaded yet (nothing was changed). */
  const apply = (): boolean => {
    if (detached) return true;
    try {
      // First, and checked by MapLibre: if the style is not up this throws
      // before anything has been changed.
      map.setSky(reliefSky(appearance));
    } catch (cause) {
      if (String(cause).includes(NOT_LOADED)) return false;
      throw cause;
    }
    if (flags.globe) map.setProjection(GLOBE_PROJECTION);
    if (flags.terrain) addTerrain();
    addNight();
    return true;
  };

  const applySafely = () => {
    try {
      if (!apply()) map.once('style.load', applySafely);
    } catch (cause) {
      // Decoration failing is not the map failing: the basemap is untouched
      // by everything above except what already succeeded.
      reportMapDefect('relief:apply', `relief: not applied (${String(cause)}).`);
    }
  };

  // A DEM tile that fails (offline, a 404 before the Worker route is
  // deployed) is reported once, quietly; `MapCanvas` keeps it out of the
  // "Map data unavailable" state, because flat ground is still a map.
  const onSourceError = (event: { sourceId?: string; error?: { message?: string } }) => {
    if (!isReliefSourceId(event.sourceId)) return;
    reportMapDefect(
      'relief:tiles',
      `relief: an elevation tile failed (${event.error?.message ?? 'unknown'}).`,
    );
  };

  // Development only: the map, for a console or a headless browser to read
  // the terrain and the camera (`queryTerrainElevation`, `getTerrain`).
  if (__DEV__) (globalThis as { __gowayReliefMap?: MapLibreMap }).__gowayReliefMap = map;

  map.on('pitch', syncTerrain);
  map.on('pitchend', syncTerrain);
  map.on('move', updateSpace);
  map.on('resize', updateSpace);
  map.on('error', onSourceError);
  applySafely();

  return {
    setDemCacheTiles(tiles) {
      options.demCacheTiles = tiles;
      dem?.setCacheTiles(tiles);
    },
    setTerrain3d(allowed) {
      if (terrain3d === allowed) return;
      terrain3d = allowed;
      syncTerrain();
    },
    setTerrainTextureScale(scale) {
      if (textureScale === scale) return;
      textureScale = scale;
      // The texture side is fixed when the terrain is made: re-make it.
      if (!detached && map.getTerrain() !== null) {
        try {
          map.setTerrain(null);
          map.setTerrain(RELIEF_TERRAIN);
          applyTextureScale(map, textureScale);
        } catch (cause) {
          reportMapDefect('relief:terrain', `relief: terrain not re-made (${String(cause)}).`);
        }
      }
    },
    setGlobeNight(enabled) {
      night?.setEnabled(enabled);
    },
    setTime(at) {
      night?.setTime(at);
    },
    detach() {
      if (detached) return;
      detached = true;
      dem?.dispose();
      dem = null;
      // Its live-clock timer; the layer goes with the map.
      night?.setEnabled(false);
      map.off('pitch', syncTerrain);
      map.off('pitchend', syncTerrain);
      map.off('move', updateSpace);
      map.off('resize', updateSpace);
      map.off('error', onSourceError);
      map.off('style.load', applySafely);
      if (flags.globe) container.style.background = previousBackground;
    },
  };
}
