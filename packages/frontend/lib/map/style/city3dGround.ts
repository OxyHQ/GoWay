/**
 * The 3D city's GROUND, as paint overrides on GoWay's own style document.
 *
 * When the detailed 3D city is on, the basemap under the buildings switches to
 * {@link CITY_GROUND_PALETTES} — but only from {@link CITY_GROUND_FADE}'s
 * zooms up, so the region-scale map stays the 2D cartography and the city
 * palette has fully arrived before the buildings grow in.
 *
 * ## Generated, never hand-listed
 *
 * The overrides are DERIVED: the same `buildLayers` that writes the style is
 * run twice, once with the 2D palette and once with the city palette, and
 * every paint colour that differs becomes one override, cross-faded by zoom.
 * So a layer added to the style, or a ground field moved in `palette3d.ts`,
 * reaches the 3D city with no list to update, and nothing in `components/`
 * names a layer or a colour.
 *
 * `scripts/build-map-style.ts` writes the result into each style document's
 * `metadata` (`goway:city3d-ground`), drift-checks it and validates the
 * overridden style with MapLibre's own validator. The city-3D adapter reads it
 * back off the loaded style (`components/map/city3dStyle.ts`) — no request,
 * no host, and nothing in any JavaScript bundle.
 *
 * Build-time only: this module imports `layers.ts` (the whole layer list),
 * which no app bundle should carry.
 */
import { parseHexColour } from '../colour';
import type { LayerSpecification } from '@maplibre/maplibre-gl-style-spec';

import type { MapAppearance } from '../provider';
import { BUILDING_3D_LAYER_ID } from './buildings3d';
import { buildLayers } from './layers';
import { CARTOGRAPHY_PALETTES } from './palette';
import { CITY_GROUND_FADE, CITY_GROUND_PALETTES, type GroundOverride } from './palette3d';

/** A zoom-only interpolate with literal stops: `['interpolate', type, ['zoom'], z, v, …]`. */
type ZoomStops = { type: unknown; stops: [number, unknown][] };

function zoomStops(value: unknown): ZoomStops | null {
  if (!Array.isArray(value) || value[0] !== 'interpolate') return null;
  const input = value[2];
  if (!Array.isArray(input) || input[0] !== 'zoom' || input.length !== 1) return null;
  const stops: [number, unknown][] = [];
  for (let i = 3; i + 1 < value.length; i += 2) {
    if (typeof value[i] !== 'number' || typeof value[i + 1] !== 'string') return null;
    stops.push([value[i], value[i + 1]]);
  }
  return { type: value[1], stops };
}

/** `#rrggbb` → channels, or `null` for any other colour notation. */
const parseHex = (value: unknown) =>
  typeof value === 'string' && value.length === 7 ? parseHexColour(value) : null;

/**
 * A colour expression's value at `zoom`: a colour, or a LINEAR zoom
 * interpolate of colours evaluated there. Between two `#rrggbb` stops the
 * channels are interpolated linearly, as MapLibre interpolates an opaque
 * colour; `null` for anything else, which the build reports.
 */
function constantAt(value: unknown, zoom: number): unknown {
  if (typeof value === 'string') return value;
  const parsed = zoomStops(value);
  if (!parsed || parsed.stops.length === 0) return null;
  const { stops } = parsed;
  if (zoom <= stops[0][0]) return stops[0][1];
  if (zoom >= stops[stops.length - 1][0]) return stops[stops.length - 1][1];
  const i = stops.findIndex(([z]) => z >= zoom);
  const [z1, v1] = stops[i];
  if (z1 === zoom) return v1;
  const [z0, v0] = stops[i - 1];
  const a = parseHex(v0);
  const b = parseHex(v1);
  if (!a || !b || !Array.isArray(parsed.type) || parsed.type[0] !== 'linear') return null;
  const t = (zoom - z0) / (z1 - z0);
  const channel = (k: number) =>
    Math.round(a[k] + (b[k] - a[k]) * t)
      .toString(16)
      .padStart(2, '0');
  return `#${channel(0)}${channel(1)}${channel(2)}`;
}

/**
 * `base` below `start`, `city` above `end`, a linear colour cross-fade
 * between. Either side may be a colour or a zoom interpolate of colours (the
 * palette's low-zoom road ramps); each keeps its own stops on its own side of
 * the fade. `null` when a side is some other expression or is mid-ramp at the
 * fade, which the build reports as an error rather than drawing something
 * wrong.
 */
export function crossFadeByZoom(
  base: unknown,
  city: unknown,
  start: number,
  end: number,
): unknown[] | null {
  const atStart = constantAt(base, start);
  const atEnd = constantAt(city, end);
  if (atStart === null || atEnd === null) return null;
  const out: unknown[] = ['interpolate', ['linear'], ['zoom']];
  for (const [z, v] of zoomStops(base)?.stops ?? []) if (z < start) out.push(z, v);
  out.push(start, atStart, end, atEnd);
  for (const [z, v] of zoomStops(city)?.stops ?? []) if (z > end) out.push(z, v);
  return out;
}

const isColourProperty = (property: string): boolean => property.endsWith('-color');

/**
 * The overrides for one appearance: every paint colour the city palette
 * changes, cross-faded by zoom. Throws on a value it cannot cross-fade, so a
 * palette change that would need a different mechanism fails the build.
 */
export function buildCity3dGroundOverrides(
  appearance: MapAppearance,
  source = 'openmaptiles',
): GroundOverride[] {
  const base = buildLayers(CARTOGRAPHY_PALETTES[appearance], source);
  const city = buildLayers(CITY_GROUND_PALETTES[appearance], source);
  if (base.length !== city.length) {
    throw new Error('city ground: the city palette changed the layer list');
  }
  const overrides: GroundOverride[] = [];
  base.forEach((layer: LayerSpecification, i) => {
    const twin = city[i];
    if (twin.id !== layer.id)
      throw new Error(`city ground: layer ${i} is ${twin.id}, not ${layer.id}`);
    // Hidden while the 3D city draws (the custom layer replaces it).
    if (layer.id === BUILDING_3D_LAYER_ID) return;
    const paint = ('paint' in layer ? layer.paint : undefined) as
      | Record<string, unknown>
      | undefined;
    const cityPaint = ('paint' in twin ? twin.paint : undefined) as
      | Record<string, unknown>
      | undefined;
    for (const property of Object.keys(cityPaint ?? {})) {
      const a = paint?.[property];
      const b = cityPaint?.[property];
      if (JSON.stringify(a) === JSON.stringify(b)) continue;
      if (!isColourProperty(property)) {
        throw new Error(`city ground: ${layer.id}.${property} differs but is not a colour`);
      }
      const value = crossFadeByZoom(a, b, CITY_GROUND_FADE.start, CITY_GROUND_FADE.end);
      if (!value) throw new Error(`city ground: cannot cross-fade ${layer.id}.${property}`);
      overrides.push({ layer: layer.id, property, value });
    }
  });
  return overrides;
}

/** Apply overrides to a copy of a layer list (for validating the 3D city's style). */
export function applyGroundOverrides(
  layers: readonly LayerSpecification[],
  overrides: readonly GroundOverride[],
): LayerSpecification[] {
  const byLayer = new Map<string, GroundOverride[]>();
  for (const o of overrides) byLayer.set(o.layer, [...(byLayer.get(o.layer) ?? []), o]);
  return layers.map((layer) => {
    const mine = byLayer.get(layer.id);
    if (!mine) return layer;
    const paint = { ...(('paint' in layer ? layer.paint : {}) as Record<string, unknown>) };
    for (const o of mine) paint[o.property] = o.value;
    return { ...layer, paint } as LayerSpecification;
  });
}
