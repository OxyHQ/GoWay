/**
 * GoWay's own engine features, as one `@goway.to/maps` plugin (web).
 *
 * `@goway.to/maps` draws the map every app gets: the style, the camera, the
 * markers, the credit. What only GoWay's app draws on top of it — the 3D city
 * and its sky, the relief and the globe's night, GoWay Live, 3D models, the
 * camera-clearance rule, the animation clock and the performance runtime —
 * lives here, attached to the engine through `<MapPlugin>`: the SDK attaches it
 * when the engine is ready, hands it every new {@link GoWayEngineProps}, and
 * detaches it when the engine goes. So the app passes props and never runs an
 * effect, and the imperative engine work is in one module with one lifecycle.
 *
 * Each feature is a lazy chunk, requested only when it is wanted, exactly as
 * before: a visit that stays on a flat map pays nothing for the city.
 */
import type { LightSpecification } from '@maplibre/maplibre-gl-style-spec';
import { addProtocol, type Map as MapLibreMap, removeProtocol } from 'maplibre-gl';
import {
  type MapPlugin,
  type MapPluginHandle,
  type MapPluginHost,
  reportMapDefect,
} from '@goway.to/maps/plugin';

import { cityEngineWanted } from '@/lib/map/cityEngineGate';
import { isImageryId } from '@/lib/map/imagery';
import type { MapAttributionLink } from '@/lib/map/provider';
import type { QualityProfile } from '@/lib/map/quality/profile';
import { isReliefId, type ReliefFlags } from '@/lib/map/reliefFlag';
import type { MapStyleSelection } from '@/lib/map/style/catalogue';
import { mapFeatureStore } from '@/lib/map/useMapFeatures';

import { attachCameraClearance, type CameraClearanceHandle } from './cameraClearance.web';
import type { City3dHandle } from './city3dLayer.web';
import type { LiveLayerHandle } from './liveLayer.web';
import type { ModelSpec } from './engine/city3d/models';
import { type AnimationClock, createAnimationClock } from './perf/animationClock';
import type { MapRuntime } from './perf/mapRuntime.web';
import { applyQualityOverrides, type QualityHost } from './qualityOverrides';
import type { ReliefHandle } from './reliefLayer.web';
import type { MapCreditDisclosure, MapLiveLayer } from './types';

/** What the 3D city draws (the map-feature registry's answers). */
export interface GoWayCityOptions {
  /** The 3D city is on for this device (it attaches once the map is near the buildings). */
  buildings: boolean;
  cityTiles: boolean;
  trees: boolean;
  treeFill: boolean;
  cityLife: boolean;
  landmarks: boolean;
  detailed: boolean;
  streets: boolean;
  /** The sky, haze, sun shadows and time of day. */
  sky: boolean;
}

export interface GoWayEngineProps {
  quality: QualityProfile;
  relief: ReliefFlags;
  /** The light the style draws in, and the appearance everything else follows. */
  appearance: 'light' | 'dark';
  style: MapStyleSelection;
  /** A style with a fixed light is not darkened by the sun. */
  styleFollowsLight: boolean;
  city: GoWayCityOptions;
  /** The buildings' light (the same one `MapView`'s `light` sets). */
  light: LightSpecification | null;
  /** The instant the sky is lit for; `null` is now. */
  skyAt: Date | null;
  /** The models the engine draws in 3D (with any `moveModel` override applied). */
  models: readonly ModelSpec[];
  live: MapLiveLayer | null;
  /** The perf HUD (`?perf=1`). */
  perfHud: boolean;
  onModelStatus: (id: string, status: 'drawn' | 'fallback') => void;
  onModelPress: (id: string) => void;
  onLandmarkCredits: (links: readonly MapAttributionLink[]) => void;
  onCityCredits: (links: readonly MapAttributionLink[]) => void;
  onCityLife: (disclosure: MapCreditDisclosure | null) => void;
  onSkyActive: (active: boolean) => void;
  onSunAltitude: (altitudeDeg: number) => void;
  /** The handle a `MapApi.moveModel` drives, while a 3D engine is attached. */
  onModelMover: (move: ((id: string, placement: ModelSpec['placement']) => void) | null) => void;
}

let reliefChunk: Promise<typeof import('./reliefLayer.web')> | null = null;
function loadReliefChunk(): Promise<typeof import('./reliefLayer.web')> {
  if (!reliefChunk) {
    reliefChunk = import('./reliefLayer.web');
    // Handled where it is used; this only keeps a failed download from also
    // surfacing as an unhandled rejection before any map exists.
    reliefChunk.catch(() => {});
  }
  return reliefChunk;
}

/**
 * Preload the relief chunk at module evaluation when this page draws either
 * relief feature, long before the style arrives, so the globe's sky is in
 * place for the first frames rather than replacing them.
 */
export function preloadRelief(flags: ReliefFlags): void {
  if (flags.globe || flags.terrain) loadReliefChunk();
}

/** What re-attaching the 3D city depends on; anything else reaches it live. */
function cityKey(props: GoWayEngineProps, wanted: boolean, buildings: boolean): string | null {
  if (!wanted) return null;
  const { city } = props;
  return [
    props.quality.tier,
    props.appearance,
    props.style.style,
    props.style.preset,
    buildings,
    city.cityTiles,
    city.trees,
    city.treeFill,
    city.cityLife,
    city.landmarks,
    city.detailed,
    city.streets,
    city.sky,
  ].join('|');
}

/** What re-attaching the relief depends on. */
function reliefKey(props: GoWayEngineProps): string | null {
  const { relief } = props;
  if (!relief.globe && !relief.terrain) return null;
  return [
    relief.globe,
    relief.terrain,
    props.appearance,
    props.style.style,
    props.style.preset,
    props.styleFollowsLight,
  ].join('|');
}

export const gowayEngine: MapPlugin<GoWayEngineProps> = {
  attach(map: MapLibreMap, initial: GoWayEngineProps, host: MapPluginHost) {
    let props = initial;
    let detached = false;
    const { container } = host;

    // --- The animation clock ---------------------------------------------
    // Everything that moves by itself asks it for frames; it pauses when the
    // tab is hidden or the map has been left alone for the profile's idle time.
    const clock: AnimationClock = createAnimationClock({
      hz: props.quality.frame.animationHz,
      idleMs: props.quality.frame.idlePauseMs,
      requestFrame: () => map.triggerRepaint(),
    });
    const noteInteraction = () => clock.noteInteraction();
    const onVisibility = () => clock.setHidden(document.visibilityState === 'hidden');
    const interactions = ['pointerdown', 'wheel', 'keydown', 'touchstart'] as const;
    for (const type of interactions) {
      container.addEventListener(type, noteInteraction, { passive: true, capture: true });
    }
    document.addEventListener('visibilitychange', onVisibility);
    onVisibility();

    // --- The map's eye never enters a building or the ground --------------
    let city: City3dHandle | null = null;
    const clearance: CameraClearanceHandle = attachCameraClearance(map, {
      field: () => city?.clearance() ?? null,
      clock,
      container,
      releaseTarget: window,
    });

    // --- The performance runtime (its own small chunk) ---------------------
    let runtime: MapRuntime | null = null;
    let runtimeSettled = false;
    import('./perf/mapRuntime.web')
      .then(({ attachMapRuntime }) => {
        if (detached) return;
        runtime = attachMapRuntime(map, {
          quality: props.quality,
          clock,
          hud: props.perfHud,
          gpuRecord: mapFeatureStore.getSnapshot().gpu,
          onGpuRecord: (record) => mapFeatureStore.setGpuRecord(record),
        });
      })
      .catch((cause: unknown) => {
        // The map draws without it: no dynamic resolution, no HUD.
        reportMapDefect('perf:load', `perf runtime: not loaded (${String(cause)}).`);
      })
      .finally(() => {
        runtimeSettled = true;
        if (!detached) syncCity();
      });

    // --- Relief: globe, sky, hillshade, terrain ----------------------------
    let relief: ReliefHandle | null = null;
    let reliefAttachedFor: string | null = null;
    let reliefGeneration = 0;
    const syncRelief = () => {
      const key = reliefKey(props);
      if (key === reliefAttachedFor) return;
      relief?.detach();
      relief = null;
      reliefAttachedFor = key;
      const generation = ++reliefGeneration;
      if (key === null) return;
      const at = props;
      loadReliefChunk()
        .then(({ attachRelief }) => {
          if (detached || generation !== reliefGeneration) return;
          relief = attachRelief(map, {
            flags: at.relief,
            appearance: at.appearance,
            terrain3d: at.quality.relief.terrain3d,
            terrainTextureScale: at.quality.relief.terrainTextureScale,
            // The terrain's own DEM reads, held and served by the relief
            // (`terrainDem.web.ts`), sized by the quality tier.
            addProtocol,
            removeProtocol,
            demCacheTiles: at.quality.relief.demCacheTiles,
            // A style with a fixed light is not darkened by the sun: its night
            // side would be a different map.
            globeNight: at.quality.relief.globeNight && at.styleFollowsLight,
            style: at.style,
            at: props.skyAt,
          });
        })
        .catch((cause: unknown) => {
          reportMapDefect('relief:load', `relief: not attached (${String(cause)}); flat map kept.`);
        });
    };

    // --- The low tier draws a dense style at Standard's density ------------
    let undoDensity: (() => void) | null = null;
    const syncDensity = () => {
      const wanted = props.quality.basemap.density === 'standard';
      if (wanted && !undoDensity) {
        try {
          undoDensity = applyQualityOverrides(map as unknown as QualityHost);
        } catch (cause) {
          reportMapDefect('qualityOverrides', `quality overrides: not applied (${String(cause)}).`);
        }
      } else if (!wanted && undoDensity) {
        undoDensity();
        undoDensity = null;
      }
    };

    // --- The 3D city (and the engine models are drawn in) ------------------
    // Requested only once the map has been near the buildings or tilted to
    // the horizon (`cityEngineWanted`); once reached it stays for the map.
    let cityZoomReached = false;
    const checkCityZoom = () => {
      if (cityZoomReached || !props.city.buildings) return;
      if (cityEngineWanted({ zoom: map.getZoom(), pitch: map.getPitch() })) {
        cityZoomReached = true;
        map.off('zoom', checkCityZoom);
        map.off('pitch', checkCityZoom);
        syncCity();
      }
    };
    map.on('zoom', checkCityZoom);
    map.on('pitch', checkCityZoom);

    let cityAttachedFor: string | null = null;
    let cityGeneration = 0;
    // One three.js engine draws the city and the models: with the city off
    // but models to draw, it attaches without the buildings.
    const wantsCity = () => (props.city.buildings && cityZoomReached) || props.models.length > 0;
    const detachCity = () => {
      if (!city) return;
      const handle = city;
      city = null;
      props.onModelMover(null);
      handle.detach();
      runtime?.set3d(false);
      props.onSkyActive(false);
      props.onLandmarkCredits([]);
      props.onCityCredits([]);
      props.onCityLife(null);
      for (const model of props.models) props.onModelStatus(model.id, 'fallback');
      live?.setCity(null);
    };
    function syncCity() {
      // The engine waits for the runtime, so the HUD's probe is in.
      if (!runtimeSettled) return;
      const key = cityKey(props, wantsCity(), props.city.buildings && cityZoomReached);
      if (key === cityAttachedFor) return;
      detachCity();
      cityAttachedFor = key;
      const generation = ++cityGeneration;
      if (key === null) return;
      const at = props;
      const buildings = at.city.buildings && cityZoomReached;
      import('./city3dLayer.web')
        .then(({ attachCity3d }) => {
          if (detached || generation !== cityGeneration) return null;
          return attachCity3d(map, {
            appearance: at.appearance,
            style: at.style,
            light: props.light,
            quality: at.quality,
            clock,
            probe: runtime?.probe ?? null,
            buildings,
            cityTiles: at.city.cityTiles,
            trees: at.city.trees,
            treeFill: at.city.treeFill,
            cityLife: at.city.cityLife,
            landmarks: at.city.landmarks,
            detailed: at.city.detailed,
            streets: at.city.streets,
            onModelStatus: (id, status) => props.onModelStatus(id, status),
            onLandmarkCredits: (links) => props.onLandmarkCredits(links),
            sky: at.city.sky
              ? { at: props.skyAt, onSun: (sun) => props.onSunAltitude(sun.altitudeDeg) }
              : undefined,
            onCredits: (links) => props.onCityCredits(links),
            // The simulation's label rides in the credit for exactly as long as
            // anything simulated is drawn.
            onCityLife: (disclosure) => props.onCityLife(disclosure),
          });
        })
        .then((attached) => {
          if (!attached) return;
          // Detached, or wanted differently, while the chunks downloaded.
          if (detached || generation !== cityGeneration) {
            attached.detach();
            return;
          }
          city = attached;
          attached.setLight(props.light);
          attached.setTime(props.skyAt);
          attached.setModels(props.models);
          props.onModelMover((id, placement) => attached.moveModel(id, placement));
          // Dynamic resolution and the GPU benchmark follow the 3D city.
          if (buildings) runtime?.set3d(true);
          props.onSkyActive(at.city.sky);
          if (buildings) live?.setCity(attached);
        })
        .catch((cause: unknown) => {
          // The shipped buildings are untouched until the layer is in.
          reportMapDefect(
            'city3d:load',
            `city3d: not attached (${String(cause)}); building-3d kept.`,
          );
        });
    }

    // --- GoWay Live ----------------------------------------------------------
    let live: LiveLayerHandle | null = null;
    let liveAttachedFor: { layer: MapLiveLayer; appearance: string } | null = null;
    let liveGeneration = 0;
    const syncLive = () => {
      const wanted = props.live;
      if (liveAttachedFor?.layer === wanted && liveAttachedFor?.appearance === props.appearance) {
        return;
      }
      live?.detach();
      live = null;
      liveAttachedFor = wanted ? { layer: wanted, appearance: props.appearance } : null;
      const generation = ++liveGeneration;
      if (!wanted) return;
      const at = props;
      import('./liveLayer.web')
        .then(({ attachLive }) => {
          if (detached || generation !== liveGeneration) return;
          live = attachLive(map, wanted, {
            appearance: at.appearance,
            clock,
            maxEntities: at.quality.live.maxEntities,
          });
          // The live layer's 3D pass follows the 3D city, not a models-only engine.
          if (city && cityZoomReached && props.city.buildings) live.setCity(city);
        })
        .catch((cause: unknown) => {
          reportMapDefect('live:load', `live: layer not attached (${String(cause)}).`);
        });
    };

    checkCityZoom();
    syncRelief();
    syncDensity();
    syncLive();

    const handle: MapPluginHandle<GoWayEngineProps> = {
      update(next) {
        const previous = props;
        props = next;
        if (next.quality !== previous.quality) {
          clock.configure({
            hz: next.quality.frame.animationHz,
            idleMs: next.quality.frame.idlePauseMs,
          });
          runtime?.setQuality(next.quality);
          relief?.setTerrain3d(next.quality.relief.terrain3d);
          relief?.setTerrainTextureScale(next.quality.relief.terrainTextureScale);
          relief?.setDemCacheTiles(next.quality.relief.demCacheTiles);
          relief?.setGlobeNight(next.quality.relief.globeNight);
        }
        if (next.light !== previous.light) city?.setLight(next.light);
        if (next.skyAt !== previous.skyAt) {
          city?.setTime(next.skyAt);
          // The globe's day and night follow the same instant.
          relief?.setTime(next.skyAt);
        }
        if (next.models !== previous.models) city?.setModels(next.models);
        checkCityZoom();
        syncRelief();
        syncDensity();
        syncCity();
        syncLive();
      },
      press(point) {
        // A 3D model, by its screen bounds (`engine/city3d/models.ts`).
        const model = city?.pickModel(point) ?? null;
        if (model) {
          props.onModelPress(model);
          return true;
        }
        // A live point is selected and the press consumed; a press anywhere
        // else clears the selection and carries on.
        const layer = props.live;
        if (layer) {
          const id = live?.pick(point) ?? null;
          layer.select(id);
          if (id) return true;
        }
        return false;
      },
      hover(point) {
        return (live?.pick(point) ?? null) !== null;
      },
      ownsError({ sourceId, status, message }) {
        // Elevation tiles are decoration: a failed one leaves flat ground, and
        // the relief layer reports it itself.
        if (isReliefId(sourceId)) return true;
        if (!isImageryId(sourceId)) return false;
        // An imagery tier answers 404 wherever nothing finer is published (the
        // tier below shows through), so a 404 is a normal answer. Anything
        // else is reported, and the map stays up: the roads, labels and the
        // tier below still draw.
        if (status !== 404) {
          reportMapDefect('imagery:tiles', `imagery: a tile failed (${message ?? 'unknown'}).`);
        }
        return true;
      },
      detach() {
        detached = true;
        map.off('zoom', checkCityZoom);
        map.off('pitch', checkCityZoom);
        detachCity();
        live?.detach();
        live = null;
        relief?.detach();
        relief = null;
        undoDensity?.();
        undoDensity = null;
        runtime?.dispose();
        runtime = null;
        for (const type of interactions) {
          container.removeEventListener(type, noteInteraction, { capture: true });
        }
        document.removeEventListener('visibilitychange', onVisibility);
        clearance.dispose();
        clock.dispose();
      },
    };
    return handle;
  },
};
