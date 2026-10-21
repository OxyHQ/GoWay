/**
 * The globe and terrain's shared pieces (`docs/MAP_TERRAIN_GLOBE.md`): how
 * their sources and layers are recognised, the globe projection and the space
 * behind it, and how the style is handed over with the globe on.
 *
 * Whether either draws is the map-feature registry's answer
 * (`mapFeatures.ts`: both on by default, switched off per device in the
 * settings modal, and `?globe=0` / `?terrain=0` per tab in a development
 * build), read through `components/map/reliefFlags.ts`.
 */
import type { ProjectionSpecification, StyleSpecification } from '@maplibre/maplibre-gl-style-spec';

/**
 * Every source and layer the relief prototype adds starts with this, so the
 * map adapter can recognise one of its errors without importing the relief
 * module (which is a lazy chunk; see `lib/map/style/relief.ts`).
 */
export const RELIEF_ID_PREFIX = 'goway:relief:';

/** Is this a source or layer the relief prototype added? */
export function isReliefId(id: string | undefined): boolean {
  return typeof id === 'string' && id.startsWith(RELIEF_ID_PREFIX);
}

/** The relief features a page can draw. */
export type ReliefFeature = 'globe' | 'terrain';

/** What this page draws: each feature on or off. */
export type ReliefFlags = Readonly<Record<ReliefFeature, boolean>>;

/**
 * MapLibre's `globe`: a sphere ("vertical perspective") to z11, easing into
 * mercator by z12 — before any street-level layer (the 3D buildings start at
 * z15.5) has to know a globe exists.
 */
export const GLOBE_PROJECTION: ProjectionSpecification = { type: 'globe' };

/**
 * Deep space without the stars and the glow (those come with the relief
 * chunk): what the container shows around a globe from the very first frame.
 */
export const GLOBE_SPACE_BASE =
  'radial-gradient(ellipse at 50% 45%, #0e1d3a 0%, #070e1f 55%, #02050c 100%)';

/**
 * A `transformStyle` that puts the globe into the style document as it
 * arrives. Generic over the document type because maplibre-gl carries its
 * own copy of the style-spec types.
 */
export function withGlobeProjection<Style extends Pick<StyleSpecification, 'version'>>(
  _previous: unknown,
  next: Style,
): Style {
  return { ...next, projection: GLOBE_PROJECTION };
}

/**
 * How the web map is handed its style, given whether the globe is on and
 * whether the document is drawn through a `transform` (the quality profile's
 * density, `components/map/qualityOverrides.ts`).
 *
 * Neither: exactly as it always was — the URL in the constructor, nothing else.
 *
 * Otherwise: no style in the constructor (the key ABSENT, not
 * present-and-undefined; see `engineOptions.test.ts`), and the URL handed to
 * `setStyle` right after with a `transformStyle` that folds them in. The
 * globe is then part of the document from the moment it is fetched, so the
 * first frame is a globe whenever the relief chunk arrives — before, the
 * projection was set by that chunk at `style.load`, and a chunk slower than
 * the style document meant a frame or more of flat mercator first (PR #124
 * review) — and the low tier's first frame is already at its density.
 */
export function mapStyleLoading<Style extends Pick<StyleSpecification, 'version'>>(
  styleUrl: string,
  globe: boolean,
  transform?: (style: Style) => Style,
): {
  construct: { style?: string };
  deferred: { url: string; transformStyle: (previous: unknown, next: Style) => Style } | null;
  /** The container's background before the first frame; `null` leaves it alone. */
  background: string | null;
} {
  if (!globe && !transform) {
    return { construct: { style: styleUrl }, deferred: null, background: null };
  }
  if (!transform) {
    return {
      construct: {},
      deferred: { url: styleUrl, transformStyle: withGlobeProjection },
      background: GLOBE_SPACE_BASE,
    };
  }
  return {
    construct: {},
    deferred: {
      url: styleUrl,
      transformStyle: (previous, next) =>
        globe ? withGlobeProjection(previous, transform(next)) : transform(next),
    },
    background: globe ? GLOBE_SPACE_BASE : null,
  };
}
