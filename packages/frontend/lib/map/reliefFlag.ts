/**
 * Whether this page draws the globe, and terrain — both ON by default, with
 * two ways to turn either off, deliberately unequal (`docs/MAP_TERRAIN_GLOBE.md`):
 *
 *  - `EXPO_PUBLIC_MAP_GLOBE=0` / `EXPO_PUBLIC_MAP_TERRAIN=0`, read by the
 *    map-feature registry (`mapFeatures.ts`): a BUILD decision, the kill
 *    switch. Every page of that build loses it. Short of that, the person can
 *    switch either off in the settings modal, on this device.
 *  - `?globe=0` / `?terrain=0` (or `=1` to turn a killed one back on) on the
 *    URL: a per-tab switch for comparing beside the flat map without
 *    rebuilding — honoured ONLY in a development build (`__DEV__`), so a link
 *    cannot change the renderer for somebody using goway.to.
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

/**
 * A default-ON build flag: anything but an explicit `0`/`false` (any case,
 * surrounding space ignored) leaves it on — unset, empty and typos included,
 * because the kill switch must be something somebody meant.
 */
export function enabledUnlessKilled(value: string | undefined): boolean {
  return !/^\s*(0|false)\s*$/i.test(value ?? '');
}

/** The relief features a page can ask for. */
export type ReliefFeature = 'globe' | 'terrain';

export interface ReliefFlagInput {
  /** The registry's answers for `globe` / `terrain` (`mapFeatures.ts`; on unless killed or switched off). */
  enabled: Readonly<Record<ReliefFeature, boolean>>;
  /** `__DEV__`. */
  development: boolean;
  /** `window.location.search`, or `''` where there is no window (native). */
  search: string;
}

/** What this page draws: each feature on or off, decided once per load. */
export type ReliefFlags = Readonly<Record<ReliefFeature, boolean>>;

function requested(input: ReliefFlagInput, feature: ReliefFeature): boolean {
  if (input.development) {
    const value = new URLSearchParams(input.search).get(feature);
    if (value === '0' || value === 'false') return false;
    if (value === '1' || value === 'true') return true;
  }
  return input.enabled[feature];
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
