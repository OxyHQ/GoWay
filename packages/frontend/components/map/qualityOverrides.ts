/**
 * The runtime half of `lib/map/style/qualityOverrides.ts`: apply the loaded
 * style's own Standard-density overrides (`metadata['goway:quality-low']`)
 * while the quality profile asks for Standard's density, and undo them
 * exactly when it stops asking. Names no layer and no value itself; a style
 * without the key (Standard, the data basemaps, `openfreemap`) is untouched.
 */
const QUALITY_LOW_METADATA_KEY = 'goway:quality-low';

/** The slice of MapLibre's `Map` this needs (so the tests can fake it). */
export interface QualityHost {
  getStyle(): { metadata?: unknown } | undefined;
  getLayer(id: string): { minzoom?: number; maxzoom?: number } | undefined;
  getFilter(id: string): unknown;
  setFilter(id: string, filter: unknown): void;
  getLayoutProperty(id: string, property: string): unknown;
  setLayoutProperty(id: string, property: string, value: unknown): void;
  getPaintProperty(id: string, property: string): unknown;
  setPaintProperty(id: string, property: string, value: unknown): void;
  setLayerZoomRange(id: string, minzoom: number, maxzoom: number): void;
}

interface Override {
  layer: string;
  minzoom?: number;
  filter?: unknown;
  layout?: Record<string, unknown>;
  paint?: Record<string, unknown>;
}

function overridesOf(host: QualityHost): Override[] {
  const raw = (host.getStyle()?.metadata as Record<string, unknown> | undefined)?.[
    QUALITY_LOW_METADATA_KEY
  ];
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (o): o is Override =>
      typeof o === 'object' && o !== null && typeof (o as Override).layer === 'string',
  );
}

/**
 * Apply the overrides; returns the undo (which restores every property to
 * what it was), or `null` when the style carries none.
 */
export function applyQualityOverrides(host: QualityHost): (() => void) | null {
  const overrides = overridesOf(host).filter((o) => host.getLayer(o.layer));
  if (overrides.length === 0) return null;
  const undo: (() => void)[] = [];
  for (const o of overrides) {
    const layer = host.getLayer(o.layer);
    if (o.minzoom !== undefined && layer) {
      const was = { min: layer.minzoom ?? 0, max: layer.maxzoom ?? 24 };
      host.setLayerZoomRange(o.layer, o.minzoom, was.max);
      undo.push(() => host.setLayerZoomRange(o.layer, was.min, was.max));
    }
    if (o.filter !== undefined) {
      const was = host.getFilter(o.layer);
      host.setFilter(o.layer, o.filter);
      undo.push(() => host.setFilter(o.layer, was ?? null));
    }
    for (const [property, value] of Object.entries(o.layout ?? {})) {
      const was = host.getLayoutProperty(o.layer, property);
      host.setLayoutProperty(o.layer, property, value);
      undo.push(() => host.setLayoutProperty(o.layer, property, was));
    }
    for (const [property, value] of Object.entries(o.paint ?? {})) {
      const was = host.getPaintProperty(o.layer, property);
      host.setPaintProperty(o.layer, property, value);
      undo.push(() => host.setPaintProperty(o.layer, property, was));
    }
  }
  return () => {
    for (const step of undo.reverse()) step();
  };
}
