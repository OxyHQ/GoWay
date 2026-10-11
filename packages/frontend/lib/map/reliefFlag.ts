/**
 * Whether this page asked for the globe, or for terrain — the same two-door
 * rule as `city3dFlag.ts`, for the relief features of `docs/MAP_TERRAIN_GLOBE.md`.
 *
 *  - `EXPO_PUBLIC_MAP_GLOBE=1` / `EXPO_PUBLIC_MAP_TERRAIN=1` (`lib/config.ts`):
 *    a BUILD decision. Every page of that build gets it. No production
 *    deployment sets either.
 *  - `?globe=1` / `?terrain=1` on the URL: a per-tab switch for looking at the
 *    prototype beside the shipped map without rebuilding — honoured ONLY in a
 *    development build (`__DEV__`), so a link cannot turn an experimental
 *    renderer on for somebody using goway.to.
 *
 * Pure, with its inputs passed in, so "production ignores the query string" is
 * a test rather than a comment (`__tests__/reliefFlag.test.ts`).
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

/** The relief features a page can ask for. */
export type ReliefFeature = 'globe' | 'terrain';

export interface ReliefFlagInput {
  /** `MAP_GLOBE_ENABLED` / `MAP_TERRAIN_ENABLED` from `lib/config.ts`. */
  enabled: Readonly<Record<ReliefFeature, boolean>>;
  /** `__DEV__`. */
  development: boolean;
  /** `window.location.search`, or `''` where there is no window (native). */
  search: string;
}

/** What this page draws: each feature on or off, decided once per load. */
export type ReliefFlags = Readonly<Record<ReliefFeature, boolean>>;

function requested(input: ReliefFlagInput, feature: ReliefFeature): boolean {
  if (input.enabled[feature]) return true;
  if (!input.development) return false;
  const value = new URLSearchParams(input.search).get(feature);
  return value === '1' || value === 'true';
}

export function resolveReliefFlags(input: ReliefFlagInput): ReliefFlags {
  return { globe: requested(input, 'globe'), terrain: requested(input, 'terrain') };
}

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
 * How the web map is handed its style, given whether the globe is on.
 *
 * Off: exactly as it always was — the URL in the constructor, nothing else.
 *
 * On: no style in the constructor (the key ABSENT, not present-and-undefined;
 * see `engineOptions.test.ts`), and the URL handed to `setStyle` right after
 * with {@link withGlobeProjection} as its `transformStyle`. The globe is then
 * part of the document from the moment it is fetched, so the first frame is a
 * globe whenever the relief chunk arrives — before, the projection was set by
 * that chunk at `style.load`, and a chunk slower than the style document meant
 * a frame or more of flat mercator first (PR #124 review).
 */
export function mapStyleLoading(
  styleUrl: string,
  globe: boolean,
): {
  construct: { style?: string };
  deferred: { url: string; transformStyle: typeof withGlobeProjection } | null;
  /** The container's background before the first frame; `null` leaves it alone. */
  background: string | null;
} {
  if (!globe) return { construct: { style: styleUrl }, deferred: null, background: null };
  return {
    construct: {},
    deferred: { url: styleUrl, transformStyle: withGlobeProjection },
    background: GLOBE_SPACE_BASE,
  };
}
