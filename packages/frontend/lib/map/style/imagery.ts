/**
 * The satellite and hybrid style documents, derived from GoWay's own
 * (`docs/MAP_SATELLITE.md` → Styles).
 *
 * Pure: `scripts/build-map-style.ts` calls {@link buildImageryStyle} on the
 * dark document and writes `public/map/goway-{satellite,hybrid}.json` beside
 * the light and dark ones, checked by `map:style:check` like them. A style
 * system composing its own variants calls the same function; nothing about
 * imagery lives anywhere else in the style.
 *
 * - **satellite**: the imagery alone. Every basemap layer goes except the
 *   background (the ocean the base tier leaves transparent beyond z7) and
 *   the anchors overlays are inserted against, so a route still draws under
 *   where the labels would be.
 * - **hybrid**: the imagery under GoWay's roads, rails, boundaries, POIs and
 *   labels. Every fill goes (land use, water, parks, buildings): the photo
 *   is the land. Roads lose their casings and become translucent light
 *   strokes over the photo (motorways and trunks warm); labels keep the dark
 *   palette's light text with a darker halo, which reads over any photo.
 *
 * **No 3D buildings over imagery** (`building-3d` is dropped, so the city
 * layer declines, as it does on any style without it). The territorial
 * orthophotos are not true orthophotos — a tall building's roof is displaced
 * from its footprint by the camera's lean — so a roof textured from the photo
 * would misregister, and an untextured clay extrusion standing on a
 * photographed roof draws every building twice. Textured buildings need true
 * orthophotos (or oblique imagery) and are a separate step; the relief's 3D
 * terrain does drape the imagery (`reliefLayer.web.ts`), which is most of the
 * "Earth" look.
 */
import type {
  LayerSpecification,
  RasterLayerSpecification,
  RasterSourceSpecification,
  StyleSpecification,
} from '@maplibre/maplibre-gl-style-spec';

import {
  IMAGERY_ID_PREFIX,
  IMAGERY_TIER_IDS,
  IMAGERY_TIERS,
  IMAGERY_TILE_SIZE,
  type ImageryTierId,
  imageryTilePath,
  type MapImageryMode,
} from '../imagery';

export { IMAGERY_ID_PREFIX };

export function imagerySourceId(tier: ImageryTierId): string {
  return `${IMAGERY_ID_PREFIX}${tier}`;
}

export function imageryLayerId(tier: ImageryTierId): string {
  return `${IMAGERY_ID_PREFIX}${tier}`;
}

/** Metadata key a document carries when it is an imagery style. */
export const IMAGERY_METADATA_KEY = 'goway:imagery';

/**
 * The ocean beyond z7, where the base tier is transparent over open sea:
 * Blue Marble's own deep-sea blue (the mean of a 20 × 20 px window of the
 * August 2004 image at 5°E 39°N, between Mallorca and Sardinia: 13, 36, 79),
 * so the first Sentinel-2 zoom meets the last Blue Marble one without a step.
 */
export const IMAGERY_OCEAN = '#0d244f';

const STYLE_NAMES: Record<MapImageryMode, string> = {
  satellite: 'GoWay Satellite',
  hybrid: 'GoWay Hybrid',
};

/** The raster source of one tier, on GoWay's origin, crediting GoWay's attribution page. */
export function imageryRasterSource(
  origin: string,
  tier: ImageryTierId,
): RasterSourceSpecification {
  const range = IMAGERY_TIERS[tier];
  return {
    type: 'raster',
    tiles: [`${origin.replace(/\/+$/, '')}${imageryTilePath(tier)}`],
    tileSize: IMAGERY_TILE_SIZE,
    minzoom: range.minZoom,
    maxzoom: range.maxZoom,
    attribution: `<a href="${origin.replace(/\/+$/, '')}/attribution#imagery" target="_blank">Imagery: see sources</a>`,
  };
}

function imageryLayer(tier: ImageryTierId): RasterLayerSpecification {
  const range = IMAGERY_TIERS[tier];
  return {
    id: imageryLayerId(tier),
    type: 'raster',
    source: imagerySourceId(tier),
    // A finer tier draws only from its own first zoom; below it, nothing is requested.
    ...(range.minZoom > 0 ? { minzoom: range.minZoom } : {}),
    paint: { 'raster-fade-duration': 200, 'raster-resampling': 'linear' },
  };
}

const isAnchor = (layer: LayerSpecification) => layer.id.startsWith('goway:anchor:');

/** Roads and rails that stay in hybrid, and how each is drawn over a photo. */
function hybridLine(layer: LayerSpecification): LayerSpecification | null {
  if (layer.type !== 'line') return null;
  const id = layer.id;
  if (id.includes('casing') || id.includes('tunnel') || id === 'road-rail-hatch') return null;
  const paint = { ...(layer.paint ?? {}) } as Record<string, unknown>;
  let colour: string;
  let opacity: number;
  if (id.startsWith('boundary-')) {
    colour = '#ffffff';
    opacity = id === 'boundary-country' ? 0.8 : 0.55;
  } else if (/road-(motorway|trunk)/.test(id)) {
    colour = '#ffd66b';
    opacity = 0.75;
  } else if (/road-(primary|secondary)/.test(id)) {
    colour = '#ffffff';
    opacity = 0.6;
  } else if (/road-(tertiary|local)/.test(id)) {
    colour = '#ffffff';
    opacity = 0.4;
  } else if (/road-(service|track|path)/.test(id)) {
    colour = '#ffffff';
    opacity = 0.3;
  } else if (id === 'road-rail') {
    colour = '#e6e6e6';
    opacity = 0.6;
  } else if (id === 'road-ferry') {
    colour = '#9fd0ff';
    opacity = 0.7;
  } else {
    // Waterways, park outlines, runways: the photo already shows them.
    return null;
  }
  paint['line-color'] = colour;
  paint['line-opacity'] = opacity;
  // Over a photograph a road is a hint, not a fill: the map's widths (drawn
  // to be the road) at 60%, so the street itself stays visible under it.
  if (!id.startsWith('boundary-')) paint['line-width'] = scaleWidth(paint['line-width'], 0.6);
  return { ...layer, paint } as LayerSpecification;
}

/** A line width — a number or a zoom `interpolate`/`step` — times `k`, outputs only. */
function scaleWidth(width: unknown, k: number): unknown {
  const round = (value: number) => Math.round(value * k * 100) / 100;
  if (typeof width === 'number') return round(width);
  if (!Array.isArray(width)) return width;
  if (width[0] === 'interpolate') {
    // ['interpolate', type, input, stop, output, stop, output, …]
    return width.map((value, i) =>
      i >= 4 && i % 2 === 0 && typeof value === 'number' ? round(value) : value,
    );
  }
  if (width[0] === 'step') {
    // ['step', input, output0, stop, output, …]
    return width.map((value, i) =>
      i >= 2 && i % 2 === 0 && typeof value === 'number' ? round(value) : value,
    );
  }
  return width;
}

/** Labels over a photo: the dark palette's light text, on a darker, wider halo. */
function hybridSymbol(layer: LayerSpecification): LayerSpecification | null {
  if (layer.type !== 'symbol') return null;
  if (layer.id === 'road-oneway') return null;
  const paint = { ...(layer.paint ?? {}) } as Record<string, unknown>;
  if (layer.id.startsWith('label-place-') || layer.id.startsWith('label-road-')) {
    paint['text-color'] = '#ffffff';
  }
  paint['text-halo-color'] = 'rgba(0,0,0,0.78)';
  paint['text-halo-width'] = Math.max(Number(paint['text-halo-width'] ?? 1.2), 1.4);
  paint['text-halo-blur'] = 0.6;
  return { ...layer, paint } as LayerSpecification;
}

/**
 * The imagery document for `mode`, from GoWay's own document (the dark one:
 * its light-on-dark labels are the ones that read over a photo).
 */
export function buildImageryStyle(
  base: StyleSpecification,
  mode: MapImageryMode,
  origin: string,
): StyleSpecification {
  const background = base.layers.find((layer) => layer.type === 'background' && !isAnchor(layer));
  if (!background) throw new Error('the base style has no background layer');
  const layers: LayerSpecification[] = [
    {
      ...background,
      paint: { 'background-color': IMAGERY_OCEAN },
    } as LayerSpecification,
    ...IMAGERY_TIER_IDS.map(imageryLayer),
  ];
  for (const layer of base.layers) {
    if (layer === background) continue;
    if (isAnchor(layer)) {
      layers.push(layer);
      continue;
    }
    if (mode === 'satellite') continue;
    if (layer.type === 'circle') {
      layers.push(layer);
      continue;
    }
    const kept = hybridLine(layer) ?? hybridSymbol(layer);
    if (kept) layers.push(kept);
  }

  const metadata = { ...((base.metadata as Record<string, unknown> | undefined) ?? {}) };
  // The detailed 3D city's ground overrides aim at fills this document no longer has.
  for (const key of Object.keys(metadata)) {
    if (key.startsWith('goway:city3d')) delete metadata[key];
  }
  metadata[IMAGERY_METADATA_KEY] = mode;
  metadata['goway:layers'] = layers.map((layer) => layer.id);

  return {
    ...base,
    name: STYLE_NAMES[mode],
    metadata,
    sources: {
      ...base.sources,
      ...Object.fromEntries(
        IMAGERY_TIER_IDS.map((tier) => [imagerySourceId(tier), imageryRasterSource(origin, tier)]),
      ),
    },
    layers,
  };
}
