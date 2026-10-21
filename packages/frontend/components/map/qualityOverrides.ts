/**
 * The runtime half of `lib/map/style/qualityOverrides.ts`: the loaded
 * document's own Standard-density overrides (`metadata['goway:quality-low']`),
 * folded into the document while the quality profile asks for Standard's
 * density. One function for both forks: the web hands the result to
 * `map.setStyle` (a diff, so a change of tier is applied in place), the native
 * fork hands it to `<Map mapStyle>`. Names no layer and no value itself; a
 * document without the key (Standard, the data basemaps, `openfreemap`)
 * comes back unchanged.
 */
const QUALITY_LOW_METADATA_KEY = 'goway:quality-low';

interface Override {
  layer: string;
  minzoom?: number;
  filter?: unknown;
  layout?: Record<string, unknown>;
  paint?: Record<string, unknown>;
}

/** The slice of a style document this reads and writes. */
export interface QualityDocument {
  metadata?: unknown;
  layers: readonly unknown[];
}

function overridesOf(document: QualityDocument): Override[] {
  const raw = (document.metadata as Record<string, unknown> | undefined)?.[
    QUALITY_LOW_METADATA_KEY
  ];
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (o): o is Override =>
      typeof o === 'object' && o !== null && typeof (o as Override).layer === 'string',
  );
}

/** Whether `document` carries any override (a document without one is drawn as it is). */
export function hasQualityOverrides(document: QualityDocument): boolean {
  return overridesOf(document).length > 0;
}

/**
 * `document` at Standard's density: each override's layer with its minzoom,
 * filter, layout and paint replaced. A new document; the input is not
 * touched. Unchanged (the same object) when it carries none.
 */
export function withQualityOverrides<Style extends QualityDocument>(document: Style): Style {
  const overrides = new Map(overridesOf(document).map((o) => [o.layer, o]));
  if (overrides.size === 0) return document;
  const layers = document.layers.map((layer) => {
    const id = (layer as { id?: unknown }).id;
    const o = typeof id === 'string' ? overrides.get(id) : undefined;
    if (!o) return layer;
    const next = { ...(layer as Record<string, unknown>) };
    if (o.minzoom !== undefined) next.minzoom = o.minzoom;
    if (o.filter !== undefined) next.filter = o.filter;
    if (o.layout) next.layout = { ...((next.layout as object) ?? {}), ...o.layout };
    if (o.paint) next.paint = { ...((next.paint as object) ?? {}), ...o.paint };
    return next;
  });
  return { ...document, layers };
}
