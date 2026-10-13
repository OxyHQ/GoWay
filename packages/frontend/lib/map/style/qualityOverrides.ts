/**
 * A dense style, drawn at Standard's density on the low quality tier
 * (`docs/MAP_STYLES.md` → Performance; `QualityProfile.basemap.density`).
 *
 * Streets places half again as many POIs as Standard, a zoom sooner, and its
 * footprints and house numbers earlier. On the low tier that is CPU a weak
 * phone does not have, and AGENTS.md wants a new cost to be a profile knob. A
 * style document is a static file, so the knob cannot change it: instead the
 * build writes, into the document's own `metadata`, what the SAME layers are
 * at Standard's density — derived by running the one layer list twice — and
 * the web map applies that while the profile says `standard`. Colour never
 * moves; only filters, zoom ranges and sizes.
 *
 * Build-time only (it imports the layer list); the runtime half is
 * `applyQualityOverrides` below, which names no layer itself.
 */
import type { LayerSpecification } from '@maplibre/maplibre-gl-style-spec';

import { buildLayers } from './layers';
import type { StyleOptions } from './options';
import type { CartographyPalette } from './palette';

/** The style `metadata` key the overrides are published under. */
export const QUALITY_LOW_METADATA_KEY = 'goway:quality-low';

/** One layer at Standard's density: what differs, nothing else. */
export interface QualityOverride {
  layer: string;
  minzoom?: number;
  filter?: unknown;
  layout?: Record<string, unknown>;
  paint?: Record<string, unknown>;
}

/** The options a style is drawn with at Standard's density. */
export function standardDensity(options: StyleOptions): StyleOptions {
  return {
    ...options,
    poi: options.poi === 'dense' ? 'standard' : options.poi,
    houseNumbersFrom:
      options.houseNumbersFrom === null ? null : Math.max(options.houseNumbersFrom, 18),
    buildingsFrom: Math.max(options.buildingsFrom, 15),
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The overrides for one style: empty when it already draws at Standard's
 * density. Throws if the two layer lists differ in their ids — density may
 * change how a layer draws, never whether it exists.
 */
export function buildQualityOverrides(
  palette: CartographyPalette,
  options: StyleOptions,
  source = 'openmaptiles',
): QualityOverride[] {
  const low = standardDensity(options);
  if (same(low, options)) return [];
  const full = buildLayers(palette, source, options);
  const lean = buildLayers(palette, source, low);
  if (
    !same(
      full.map((l) => l.id),
      lean.map((l) => l.id),
    )
  ) {
    throw new Error('quality overrides: Standard density changed the layer list');
  }
  const overrides: QualityOverride[] = [];
  full.forEach((layer: LayerSpecification, index) => {
    const twin = lean[index] as LayerSpecification & Record<string, unknown>;
    const a = layer as LayerSpecification & Record<string, unknown>;
    const override: QualityOverride = { layer: layer.id };
    if (a.minzoom !== twin.minzoom && typeof twin.minzoom === 'number') {
      override.minzoom = twin.minzoom;
    }
    if (!same(a.filter, twin.filter)) override.filter = twin.filter;
    for (const part of ['layout', 'paint'] as const) {
      const was = (a[part] ?? {}) as Record<string, unknown>;
      const now = (twin[part] ?? {}) as Record<string, unknown>;
      const changed = Object.keys({ ...was, ...now }).filter((key) => !same(was[key], now[key]));
      if (changed.length > 0) override[part] = Object.fromEntries(changed.map((k) => [k, now[k]]));
    }
    if (Object.keys(override).length > 1) overrides.push(override);
  });
  return overrides;
}
