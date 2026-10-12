/**
 * The map's optional features, in ONE registry: what each is, where it is
 * offered, and how its on/off answer is decided for this device and this page
 * (`docs/MAP_FEATURES.md`).
 *
 * Every feature is one entry in {@link MAP_FEATURES}. Its human labels are in
 * `mapFeatureLabels.ts` (keyed by the same id, every `LABEL_LANGUAGES`
 * language, and the type refuses an entry without them); they live apart only
 * so the first-paint bundle carries the decisions and not the copy, which only
 * the settings modal reads.
 *
 * ## How the answer is decided
 *
 * A PERSON decides, in the settings modal; the build never does — there is no
 * build variable. For each feature, in registry order (a dependency comes
 * first):
 *
 *  1. **The person's own choice**, made in the settings modal and kept on this
 *     device only (`mapFeatureStore.ts`);
 *  2. otherwise **the registry's default** (`defaultOn`);
 *  3. in a DEVELOPMENT build only, this page's address can override either:
 *     `?<query>=1` (or `true`) turns the feature on, `?<query>=0` (or `false`)
 *     off — a per-tab switch for comparing with and without it. A production
 *     build ignores the address, so a goway.to link can never switch a
 *     renderer on or off for somebody else;
 *  4. last, a feature is off while anything it `requires` is off.
 *
 * A feature production cannot serve yet is not switched off by a build: it is
 * `offer: 'development'` — not offered in the panel outside a development
 * build — and starts off.
 *
 * Pure: the store passes in the choices, platform, `__DEV__` and the URL, so
 * every rule here is a test rather than a comment.
 */

/** `stable` shows in the panel for everyone; `labs` only once Labs is revealed. */
export type MapFeatureTier = 'stable' | 'labs';

/** The settings modal's page a feature is listed on. */
export type MapFeatureSection = 'map' | 'layers';

/** `Platform.OS`, narrowed to the platforms GoWay ships. */
export type MapPlatform = 'web' | 'ios' | 'android';

export interface MapFeatureDefinition {
  /** Stable: it keys the stored choice and the labels. Never rename one. */
  id: string;
  tier: MapFeatureTier;
  /** On or off when the person has not chosen. */
  defaultOn: boolean;
  /** Features (earlier in the registry) that must be on for this one to be. */
  requires: readonly string[];
  /**
   * Which page of the settings modal it lives on: `map` (how the map itself
   * is drawn) or `layers` (what is drawn on it). A `labs` feature still shows
   * there only once Labs is revealed (`lib/map/mapSettingsPages.ts`).
   */
  section: MapFeatureSection;
  /** Where it draws anything at all. Elsewhere it is not offered in the panel. */
  platforms: readonly MapPlatform[];
  /**
   * `development`: offered in the panel only in a development build — for a
   * feature production cannot serve yet, so nobody on goway.to can switch on
   * something that has nothing behind it. `never`: registered (its answer and
   * labels exist) but this build has nothing that draws it yet — the branch
   * that lands the drawing deletes the line. Defaults to `always`.
   */
  offer?: 'always' | 'development' | 'never';
  /**
   * The query parameter a DEVELOPMENT build reads to force it on (`1`/`true`)
   * or off (`0`/`false`) for one tab. Omitted: the address cannot.
   */
  query?: string;
}

const WEB: readonly MapPlatform[] = ['web'];
const EVERYWHERE: readonly MapPlatform[] = ['web', 'ios', 'android'];

/**
 * Every optional map feature this build knows about. ORDER MATTERS: a feature
 * comes after everything it `requires`.
 *
 * Adding one is the recipe in `docs/MAP_FEATURES.md`: an entry here, its labels
 * in `mapFeatureLabels.ts`, and `useMapFeature('<id>')` where it is drawn.
 */
export const MAP_FEATURES = [
  {
    id: 'globe',
    section: 'map',
    tier: 'stable',
    defaultOn: true,
    requires: [],
    platforms: WEB,
    query: 'globe',
  },
  {
    id: 'terrain',
    section: 'map',
    tier: 'stable',
    defaultOn: true,
    requires: [],
    // Native draws the hillshade only (its MapLibre has no terrain API).
    platforms: EVERYWHERE,
    query: 'terrain',
  },
  {
    id: 'street3d',
    section: 'layers',
    tier: 'stable',
    // Published Street 3D scenes on the map. On for everyone: a coverage
    // endpoint that is absent (404) or down (503) only hides the layer
    // (`features/street3d/queries.ts`).
    defaultOn: true,
    requires: [],
    // The native viewer embeds the web one (`docs/STREET3D_VIEWER.md`).
    platforms: EVERYWHERE,
  },
  {
    id: 'city3d',
    section: 'layers',
    tier: 'stable',
    // On for everyone (owner, 2026-10-12: "everything active on goway.to"),
    // and with it everything below that needs it: what each draws is capped
    // by the quality profile, a phone's included (`docs/MAP_PERFORMANCE.md`
    // → "Default on"). Its chunk is fetched only once the camera nears the
    // buildings or tilts (`lib/map/cityEngineGate.ts`).
    defaultOn: true,
    requires: [],
    platforms: WEB,
    query: 'city3d',
  },
  {
    id: 'citySky',
    section: 'map',
    tier: 'stable',
    defaultOn: true,
    // The sky, haze and shadows are drawn by the city layer.
    requires: ['city3d'],
    platforms: WEB,
    query: 'citysky',
  },
  {
    id: 'detailedCity',
    // How the map itself is drawn, beside the sky.
    section: 'map',
    tier: 'stable',
    defaultOn: true,
    // The art-directed look of the city layer (`docs/MAP_3D_CITY.md` → Art
    // direction): clay buildings in the sky's light, a 3D-mode ground, warm
    // windows at night. It brings its own live-clock sky when `citySky` is off.
    requires: ['city3d'],
    platforms: WEB,
    query: 'detailedCity',
  },
  {
    id: 'cityTiles',
    section: 'layers',
    tier: 'stable',
    defaultOn: true,
    requires: ['city3d'],
    platforms: WEB,
    // Drawn only where `/map/city/coverage.json` says a published region
    // (archive + receipt, ODbL) covers the ground, the basemap's buildings
    // everywhere else — an empty or unreadable document is the basemap alone,
    // never a flat map (`engine/city3d/sources.ts`). The official building
    // data merged into an archive (the Catastro's storeys, NYC's 3D model;
    // `docs/MAP_3D_SOURCES.md`) has no switch of its own: it is part of the
    // tiles, credited while drawn.
    query: 'cityTiles',
  },
  {
    id: 'city3dTrees',
    section: 'layers',
    tier: 'stable',
    // They come with the 3D city: on whenever it is, unless switched off.
    defaultOn: true,
    requires: ['city3d'],
    platforms: WEB,
    query: 'city3dTrees',
  },
  {
    id: 'city3dTreeFill',
    section: 'layers',
    tier: 'labs',
    // Owner decision: by default, trees only where OpenStreetMap maps one.
    defaultOn: false,
    requires: ['city3dTrees'],
    platforms: WEB,
    query: 'city3dTreeFill',
  },
  {
    id: 'cityLife',
    section: 'layers',
    tier: 'stable',
    defaultOn: true,
    // Drawn by the city engine; it drives on the road archive where one exists
    // and on the basemap's own roads, healed, everywhere else — no city tiles.
    requires: ['city3d'],
    platforms: WEB,
    // Its agents are the quality profile's (`life`): 300 + 300 on a phone
    // (`docs/MAP_PERFORMANCE.md` → "Default on").
    query: 'cityLife',
  },
  {
    id: 'cityStreets',
    // How the city itself is drawn: its streets, as the detailed look is its buildings.
    section: 'map',
    tier: 'stable',
    defaultOn: true,
    // Drawn by the city-3D engine, from the road archive (`docs/MAP_STREETS.md`).
    requires: ['city3d'],
    platforms: WEB,
    // Asks for road tiles only where the coverage document's `roads` tree
    // covers the ground; elsewhere it draws nothing and the basemap's roads
    // stay.
    query: 'cityStreets',
  },
  {
    id: 'landmarks',
    section: 'layers',
    tier: 'stable',
    defaultOn: true,
    // The tour and its entry need the city engine. A model draws only over
    // GoWay city tiles (it replaces per-building OSM ids; `docs/MAP_LANDMARKS.md`
    // → Needs city tiles), so the tour and its pill offer only the landmarks
    // the coverage document covers — none while it covers nothing.
    requires: ['city3d'],
    platforms: WEB,
    query: 'landmarks',
  },
  {
    id: 'live',
    section: 'layers',
    tier: 'labs',
    defaultOn: false,
    requires: [],
    platforms: WEB,
    // GoWay Live needs a backend that lists live sources (`LIVE_SOURCES`) and
    // its feeds' licence follow-ups done; goway.to has neither yet
    // (`docs/MAP_LIVE.md` → What production needs), so the switch is offered
    // where a backend can serve it.
    offer: 'development',
    query: 'live',
  },
  {
    id: 'flyover',
    section: 'layers',
    tier: 'stable',
    defaultOn: true,
    requires: [],
    // It flies on native too (the vehicle is a marker there); the video export
    // is web only, and says so itself.
    platforms: EVERYWHERE,
    query: 'flyover',
  },
] as const satisfies readonly MapFeatureDefinition[];

export type MapFeatureId = (typeof MAP_FEATURES)[number]['id'];

/**
 * What a development page's address says about one feature: `1`/`true` on,
 * `0`/`false` off, anything else (or a production build) nothing.
 */
export function pageOverride(
  query: string | undefined,
  input: { development: boolean; search: string },
): boolean | null {
  if (!input.development || query === undefined) return null;
  const value = new URLSearchParams(input.search).get(query);
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;
  return null;
}

/** Why a feature is on or off. */
export type MapFeatureSource =
  /** The person's stored choice. */
  | 'choice'
  /** The registry's `defaultOn`. */
  | 'default'
  /** This page's own address (a development query parameter) overrode the above. */
  | 'page';

export interface MapFeatureState {
  id: string;
  tier: MapFeatureTier;
  section: MapFeatureSection;
  /** THE answer: whether the feature draws on this page. */
  on: boolean;
  /** Whether the panel offers it: this platform draws it, and this build offers it. */
  available: boolean;
  /** The person's stored choice, or `null` for none. */
  choice: boolean | null;
  /** What the answer would be with no stored choice — what "reset" returns to. */
  baseline: boolean;
  source: MapFeatureSource;
  /** Dependencies that are off, which is why this one is off. */
  blockedBy: readonly string[];
}

export interface ResolvedMapFeatures {
  /** In registry order. */
  readonly list: readonly MapFeatureState[];
  get(id: string): MapFeatureState;
  on(id: string): boolean;
}

export interface ResolveMapFeaturesInput {
  features: readonly MapFeatureDefinition[];
  /** The person's stored choices, by id. Unknown ids are ignored. */
  choices: Readonly<Record<string, boolean | undefined>>;
  platform: MapPlatform;
  development: boolean;
  search: string;
}

export function resolveMapFeatures(input: ResolveMapFeaturesInput): ResolvedMapFeatures {
  const byId = new Map<string, MapFeatureState>();
  const lookup = (id: string): MapFeatureState => {
    const state = byId.get(id);
    if (!state) throw new Error(`map feature "${id}" is unknown, or not earlier in the registry`);
    return state;
  };

  for (const feature of input.features) {
    const stored = input.choices[feature.id];
    const choice = typeof stored === 'boolean' ? stored : null;
    const page = pageOverride(feature.query, input);

    let requested: boolean;
    let source: MapFeatureSource;
    if (page !== null && page !== (choice ?? feature.defaultOn)) {
      requested = page;
      source = 'page';
    } else if (choice !== null) {
      requested = choice;
      source = 'choice';
    } else {
      requested = feature.defaultOn;
      source = 'default';
    }
    const blockedBy = feature.requires.filter((id) => !lookup(id).on);
    // A feature this platform does not draw is off on it, whatever its
    // default: native shows no landmark pill for models it cannot draw.
    const drawnHere = feature.platforms.includes(input.platform);

    byId.set(feature.id, {
      id: feature.id,
      tier: feature.tier,
      section: feature.section,
      on: requested && blockedBy.length === 0 && drawnHere,
      available:
        drawnHere &&
        feature.offer !== 'never' &&
        (feature.offer !== 'development' || input.development),
      choice,
      baseline: feature.defaultOn,
      source,
      blockedBy,
    });
  }

  const list = [...byId.values()];
  return { list, get: lookup, on: (id) => lookup(id).on };
}
