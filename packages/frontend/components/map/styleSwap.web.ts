/**
 * A style or light change, swapped into the SAME map (`map.setStyle` with a
 * diff), never by building a new one: every GoWay document is generated from
 * one layer list (`lib/map/style/layers.ts`), so a change of style or light is
 * mostly a change of paint, and MapLibre applies it as such. The 3D city's
 * engine, its meshes and its custom layer stay where they are (MapLibre never
 * serialises a custom layer, so a diff never removes one); what the runtime
 * added to the document — the relief's DEM sources and hillshade, the
 * terrain, the globe, GoWay Live, the street-name blockers — is carried over
 * into the next document by {@link carryRuntimeStyle}.
 *
 * Never in the middle of a gesture, an animation or a flyover (a run of
 * transient frames, `MapCameraOptions.transient`): a swap is a few
 * milliseconds of main thread and a frame of re-placed labels, so it waits
 * for the camera to settle ({@link createStyleSwapper}).
 *
 * Like the other web adapters it keeps to "only `MapCanvas.web.tsx` imports
 * a map engine": `maplibre-gl` is imported for types only.
 */
import type { Map as MapLibreMap, StyleSpecification } from 'maplibre-gl';

import { isTransientMove } from './cameraReports.web';

type Layer = StyleSpecification['layers'][number];

/** The metadata key a GoWay document lists every layer id its generator owns under. */
const DOCUMENT_LAYERS_KEY = 'goway:layers';

/** The layer ids `style`'s generator owns, or `null` for a document that is not GoWay's. */
function documentLayerIds(style: StyleSpecification | undefined): ReadonlySet<string> | null {
  const raw = (style?.metadata as Record<string, unknown> | undefined)?.[DOCUMENT_LAYERS_KEY];
  return Array.isArray(raw) ? new Set(raw.filter((id) => typeof id === 'string')) : null;
}

/** Whether both documents are GoWay's, so what the runtime added can be told from them. */
export function canSwapInPlace(
  previous: StyleSpecification | undefined,
  next: StyleSpecification,
): boolean {
  return documentLayerIds(previous) !== null && documentLayerIds(next) !== null;
}

const sourceOf = (layer: Layer): string | null =>
  'source' in layer && typeof layer.source === 'string' ? layer.source : null;

/**
 * The `transformStyle` of an in-place swap: `next`, plus everything the
 * runtime added to `previous` (the map's serialised style).
 *
 * - A layer of `previous` that its document's generator does not own (not in
 *   its `goway:layers`) and `next` does not have is the runtime's: it goes
 *   into `next` before the first layer that followed it there and is still in
 *   `next` (or on top, when none is).
 * - A source of `previous` that `next` lacks is kept when a carried layer
 *   reads it or the terrain stands on it; a document's own source `next`
 *   dropped (Outdoors' contours) goes with its layers.
 * - The terrain and the projection are the runtime's when `next` has none;
 *   the light is kept when `keepLight` (the sun light the canvas lays over
 *   the document's static one, re-laid for the new light right after).
 *
 * The sky is NOT carried: it is the light's (`reliefSky`, the city sky), and
 * the relief and the city lay the new one on as soon as the swap is in.
 */
export function carryRuntimeStyle(
  previous: StyleSpecification | undefined,
  next: StyleSpecification,
  options: { keepLight: boolean },
): StyleSpecification {
  const owned = documentLayerIds(previous);
  if (!previous || !owned) return next;
  const nextIds = new Set(next.layers.map((layer) => layer.id));
  const layers = [...next.layers];
  const previousLayers = previous.layers ?? [];
  const carried: Layer[] = [];
  previousLayers.forEach((layer, index) => {
    if (owned.has(layer.id) || nextIds.has(layer.id)) return;
    carried.push(layer);
    // Before the first layer that followed it and is still in the document.
    const after = previousLayers.slice(index + 1).find((later) => nextIds.has(later.id));
    const at = after ? layers.findIndex((l) => l.id === after.id) : -1;
    if (at >= 0) layers.splice(at, 0, layer);
    else layers.push(layer);
    nextIds.add(layer.id);
  });

  const sources = { ...next.sources };
  const terrainSource = previous.terrain?.source;
  const wanted = new Set(carried.map(sourceOf).filter((id): id is string => id !== null));
  if (terrainSource && !next.terrain) wanted.add(terrainSource);
  for (const id of wanted) {
    if (!(id in sources) && previous.sources?.[id]) sources[id] = previous.sources[id];
  }

  return {
    ...next,
    sources,
    layers,
    ...(next.terrain || !previous.terrain || !(previous.terrain.source in sources)
      ? {}
      : { terrain: previous.terrain }),
    ...(next.projection || !previous.projection ? {} : { projection: previous.projection }),
    ...(options.keepLight && previous.light ? { light: previous.light } : {}),
  };
}

/** What a swap tells the canvas: before the document changes, and once it has. */
export interface StyleSwapHooks {
  /** Give the old document back what was changed in it at runtime (the city's ground). */
  before(): void;
  /** The new document is up (in place, or — `rebuilt` — after MapLibre rebuilt the style). */
  after(rebuilt: boolean): void;
  /** The document could not be fetched or applied. */
  onError(message: string): void;
}

export interface StyleSwapper {
  /** Draw `url`'s document, through `transform` (the quality profile's density, …). */
  request(url: string, transform: (style: StyleSpecification) => StyleSpecification): void;
  dispose(): void;
}

/**
 * Swap `map`'s document in place when asked — once the document is fetched
 * AND the camera is still: not moving, no pointer down on `container`, and no
 * caller-driven animation between frames (a transient `moveend` holds the swap
 * until an ordinary one settles it). A newer request replaces a waiting one.
 */
export function createStyleSwapper(
  map: MapLibreMap,
  container: HTMLElement,
  hooks: StyleSwapHooks,
  options: { keepLight: () => boolean },
): StyleSwapper {
  let pending: StyleSpecification | null = null;
  let controller: AbortController | null = null;
  let pointers = 0;
  let animating = false;
  let disposed = false;

  const still = () => !map.isMoving() && pointers === 0 && !animating;

  const apply = () => {
    if (disposed || !pending || !still()) return;
    const document = pending;
    pending = null;
    const previous = map.getStyle();
    if (!canSwapInPlace(previous, document)) {
      // Not two GoWay documents: nothing tells the runtime's layers from the
      // document's, so MapLibre builds the style afresh (custom layers too).
      hooks.before();
      map.once('style.load', () => hooks.after(true));
      map.setStyle(document, {
        diff: false,
        transformStyle: (prev, next) =>
          carryRuntimeStyle(prev, next, { keepLight: options.keepLight() }),
      });
      return;
    }
    hooks.before();
    // An applied diff fires `style.load` before `setStyle` returns. A diff
    // MapLibre cannot express is rebuilt from scratch instead — a new `Style`,
    // loaded asynchronously, its custom layers gone — and fires it when done.
    // No change at all fires nothing.
    const style = map.style;
    let loaded = false;
    const onLoad = () => {
      loaded = true;
    };
    map.once('style.load', onLoad);
    map.setStyle(document, {
      diff: true,
      transformStyle: (prev, next) =>
        carryRuntimeStyle(prev, next, { keepLight: options.keepLight() }),
    });
    if (map.style !== style) {
      if (loaded) hooks.after(true);
      else {
        map.off('style.load', onLoad);
        map.once('style.load', () => hooks.after(true));
      }
      return;
    }
    if (!loaded) map.off('style.load', onLoad);
    hooks.after(false);
  };

  const onMoveEnd = (event: unknown) => {
    animating = isTransientMove(event);
    apply();
  };
  const onDown = () => {
    pointers += 1;
  };
  const onUp = () => {
    pointers = Math.max(0, pointers - 1);
    apply();
  };
  map.on('moveend', onMoveEnd);
  container.addEventListener('pointerdown', onDown, { capture: true, passive: true });
  // A pointer released anywhere (a drag that leaves the map), on the map's document.
  const page = container.ownerDocument ?? null;
  page?.addEventListener('pointerup', onUp, { capture: true, passive: true });
  page?.addEventListener('pointercancel', onUp, { capture: true, passive: true });

  return {
    request(url, transform) {
      controller?.abort();
      const ours = new AbortController();
      controller = ours;
      fetch(url, { signal: ours.signal })
        .then((response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.json() as Promise<StyleSpecification>;
        })
        .then((json) => {
          if (disposed || controller !== ours) return;
          pending = transform(json);
          apply();
        })
        .catch((cause: unknown) => {
          if (disposed || ours.signal.aborted) return;
          hooks.onError(`style ${url}: ${String(cause)}`);
        });
    },
    dispose() {
      disposed = true;
      controller?.abort();
      pending = null;
      map.off('moveend', onMoveEnd);
      container.removeEventListener('pointerdown', onDown, { capture: true });
      page?.removeEventListener('pointerup', onUp, { capture: true });
      page?.removeEventListener('pointercancel', onUp, { capture: true });
    },
  };
}
