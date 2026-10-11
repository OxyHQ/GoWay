/**
 * The map's optional features, in ONE registry: what each is, whether this
 * build carries it, and how its on/off answer is decided for this device and
 * this page (`docs/MAP_FEATURES.md`).
 *
 * Every feature is one entry in {@link MAP_FEATURES}. Its human labels are in
 * `mapFeatureLabels.ts` (keyed by the same id, every `LABEL_LANGUAGES`
 * language, and the type refuses an entry without them); they live apart only
 * so the first-paint bundle carries the decisions and not the copy, which only
 * the settings dialog reads.
 *
 * ## How the answer is decided
 *
 * For each feature, in registry order (a dependency comes first):
 *
 *  1. **The build's kill switch.** Its `EXPO_PUBLIC_MAP_*` variable set to
 *     `0`/`false`: the build does not carry it. Off, and absent from the panel;
 *     no stored choice can bring it back.
 *  2. **The person's own choice**, made in the settings dialog and kept on this
 *     device only (`mapFeatureStore.ts`).
 *  3. **The build's default.** The variable set to `1`/`true` turns a feature
 *     on by default for that build — what it always did — but no longer past a
 *     person who switched it off.
 *  4. **The registry's default** (`defaultOn`).
 *
 * That answer is then handed to the feature's own flag module (`request`) —
 * `city3dFlag.ts`, `reliefFlag.ts` and the rest, unchanged — exactly where the
 * build boolean used to go. So with no stored choice every flag answers what it
 * answered before this registry existed, the development-only `?city3d=1`-style
 * query parameters included; that is a test (`__tests__/mapFeatures.test.ts`).
 *
 * Last, a feature is off while anything it `requires` is off.
 *
 * Pure: the store passes in the choices, platform, `__DEV__` and the URL, so
 * every rule here is a test rather than a comment.
 */
import { isCity3dRequested } from './city3dFlag';
import { isCity3dTreeFillRequested, isCity3dTreesRequested } from './city3dTreesFlag';
import { isCitySkyRequested } from './citySkyFlag';
import { isCityLifeRequested } from './cityLifeFlag';
import { isCityTilesRequested } from './cityTilesFlag';
import { isFlyoverRequested } from './flyoverFlag';
import { isLandmarksRequested } from './landmarksFlag';
import { resolveReliefFlags } from './reliefFlag';

/** `stable` shows in the panel for everyone; `labs` only once Labs is revealed. */
export type MapFeatureTier = 'stable' | 'labs';

/** `Platform.OS`, narrowed to the platforms GoWay ships. */
export type MapPlatform = 'web' | 'ios' | 'android';

/** What a feature's own flag module is given, besides the registry's answer. */
export interface MapFeatureRequestContext {
  /** `__DEV__`. */
  development: boolean;
  /** `window.location.search`, or `''` where there is no window (native). */
  search: string;
  /** Whether a feature EARLIER in the registry ended up on. Throws for an unknown id. */
  on(id: string): boolean;
}

export interface MapFeatureDefinition {
  /** Stable: it keys the stored choice and the labels. Never rename one. */
  id: string;
  tier: MapFeatureTier;
  /** On or off when neither the build nor the person says otherwise. */
  defaultOn: boolean;
  /**
   * The build variable, READ AS A LITERAL `process.env.EXPO_PUBLIC_MAP_*`
   * member expression in this file — the only spelling Metro inlines, and what
   * `expo/no-dynamic-env-var` checks. `0`/`false` kills the feature;
   * `1`/`true` makes it the build's default.
   */
  build: string | undefined;
  /** Features (earlier in the registry) that must be on for this one to be. */
  requires: readonly string[];
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
   * The feature's own flag module, given the registry's answer where it used
   * to be given the build boolean: the place a development-only query
   * parameter keeps working. Omitted, the registry's answer stands.
   */
  request?: (enabled: boolean, context: MapFeatureRequestContext) => boolean;
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
    tier: 'stable',
    defaultOn: true,
    build: process.env.EXPO_PUBLIC_MAP_GLOBE,
    requires: [],
    platforms: WEB,
    request: (enabled, { development, search }) =>
      resolveReliefFlags({ enabled: { globe: enabled, terrain: enabled }, development, search })
        .globe,
  },
  {
    id: 'terrain',
    tier: 'stable',
    defaultOn: true,
    build: process.env.EXPO_PUBLIC_MAP_TERRAIN,
    requires: [],
    // Native draws the hillshade only (its MapLibre has no terrain API).
    platforms: EVERYWHERE,
    request: (enabled, { development, search }) =>
      resolveReliefFlags({ enabled: { globe: enabled, terrain: enabled }, development, search })
        .terrain,
  },
  {
    id: 'city3d',
    tier: 'labs',
    defaultOn: false,
    build: process.env.EXPO_PUBLIC_MAP_CITY3D,
    requires: [],
    platforms: WEB,
    request: (enabled, { development, search }) =>
      isCity3dRequested({ enabled, development, search }),
  },
  {
    id: 'citySky',
    tier: 'labs',
    defaultOn: false,
    build: process.env.EXPO_PUBLIC_MAP_CITY_SKY,
    // The sky, haze and shadows are drawn by the city layer.
    requires: ['city3d'],
    platforms: WEB,
    request: (enabled, { development, search, on }) =>
      isCitySkyRequested({ city3d: on('city3d'), enabled, development, search }),
  },
  {
    id: 'cityTiles',
    tier: 'labs',
    defaultOn: false,
    build: process.env.EXPO_PUBLIC_MAP_CITY_TILES,
    requires: ['city3d'],
    platforms: WEB,
    // Not hosted on goway.to yet, and ODbL wants the archive and its receipt
    // published before anyone is served them (`docs/MAP_3D_CITY.md` → Hosting).
    // The official building data merged into an archive (the Catastro's
    // storeys, NYC's 3D model; `docs/MAP_3D_SOURCES.md`) has no switch of its
    // own: it is part of the tiles this switch draws, credited while drawn.
    offer: 'development',
    request: (enabled, { development, search, on }) =>
      isCityTilesRequested({ city3d: on('city3d'), enabled, development, search }),
  },
  {
    id: 'city3dTrees',
    tier: 'labs',
    // They come with the 3D city: on whenever it is, unless switched off.
    defaultOn: true,
    build: process.env.EXPO_PUBLIC_MAP_CITY3D_TREES,
    requires: ['city3d'],
    platforms: WEB,
    request: (enabled, { development, search }) =>
      isCity3dTreesRequested({ enabled, development, search }),
  },
  {
    id: 'city3dTreeFill',
    tier: 'labs',
    // Owner decision: by default, trees only where OpenStreetMap maps one.
    defaultOn: false,
    build: process.env.EXPO_PUBLIC_MAP_CITY3D_TREE_FILL,
    requires: ['city3dTrees'],
    platforms: WEB,
    request: (enabled, { development, search }) =>
      isCity3dTreeFillRequested({ enabled, development, search }),
  },
  {
    id: 'cityLife',
    tier: 'labs',
    defaultOn: false,
    build: process.env.EXPO_PUBLIC_MAP_CITY_LIFE,
    // It drives on the road archive compiled beside the city tiles.
    requires: ['cityTiles'],
    platforms: WEB,
    // Nothing serves the road tiles on goway.to yet (`docs/MAP_CITY_LIFE.md` →
    // Hosting), as for the city tiles it needs.
    offer: 'development',
    request: (enabled, { development, search, on }) =>
      isCityLifeRequested({
        city3d: on('city3d'),
        cityTiles: on('cityTiles'),
        enabled,
        development,
        search,
      }),
  },
  {
    id: 'landmarks',
    tier: 'labs',
    defaultOn: false,
    build: process.env.EXPO_PUBLIC_MAP_LANDMARKS,
    // The tour and its entry need the city engine; the models themselves
    // draw only over GoWay city tiles (they replace per-building OSM ids),
    // which the city layer checks on its own.
    requires: ['city3d'],
    platforms: WEB,
    // Without city tiles — not served on goway.to yet — the models draw
    // nowhere (`docs/MAP_LANDMARKS.md` → Needs city tiles), so the switch is
    // offered where they can be seen.
    offer: 'development',
    request: (enabled, { development, search }) =>
      isLandmarksRequested({ enabled, development, search }),
  },
  {
    id: 'live',
    tier: 'labs',
    defaultOn: false,
    build: process.env.EXPO_PUBLIC_MAP_LIVE,
    requires: [],
    platforms: WEB,
    // GoWay Live (#132) draws it; until that lands nothing does. When it does:
    // delete this line, and point `request` at `isLiveRequested` (the same rule).
    offer: 'never',
    request: (enabled, { development, search }) =>
      queryOverride('live', enabled, { development, search }),
  },
  {
    id: 'flyover',
    tier: 'labs',
    defaultOn: false,
    build: process.env.EXPO_PUBLIC_MAP_FLYOVER,
    requires: [],
    // It flies on native too (the vehicle is a marker there); the video export
    // is web only, and says so itself.
    platforms: EVERYWHERE,
    request: (enabled, { development, search }) =>
      isFlyoverRequested({ enabled, development, search }),
  },
] as const satisfies readonly MapFeatureDefinition[];

export type MapFeatureId = (typeof MAP_FEATURES)[number]['id'];

/**
 * The flag modules' shared development rule for a default-off feature:
 * `?<name>=1`/`true` turns it on in a development build only.
 */
export function queryOverride(
  name: string,
  enabled: boolean,
  input: { development: boolean; search: string },
): boolean {
  if (enabled) return true;
  if (!input.development) return false;
  const value = new URLSearchParams(input.search).get(name);
  return value === '1' || value === 'true';
}

/** What a build variable says: kill the feature, default it on, or nothing. */
export type BuildSwitch = 'killed' | 'on' | null;

/**
 * `0`/`false` (any case, surrounding space ignored) kills; `1`/`true` turns on;
 * anything else — unset, empty, a typo — says nothing. The two spellings are
 * the ones `enabledUnlessKilled` and `MAP_CITY3D_ENABLED` already accepted, so
 * no build that set one changes meaning.
 */
export function parseBuildSwitch(value: string | undefined): BuildSwitch {
  if (/^\s*(0|false)\s*$/i.test(value ?? '')) return 'killed';
  if (/^(1|true)$/i.test(value ?? '')) return 'on';
  return null;
}

/** Why a feature is on or off. */
export type MapFeatureSource =
  /** The build's kill switch. */
  | 'killed'
  /** The person's stored choice. */
  | 'choice'
  /** The build variable's `1`/`true`. */
  | 'build'
  /** The registry's `defaultOn`. */
  | 'default'
  /** This page's own address (a development query parameter) overrode the above. */
  | 'page';

export interface MapFeatureState {
  id: string;
  tier: MapFeatureTier;
  /** THE answer: whether the feature draws on this page. */
  on: boolean;
  /** Whether the panel offers it: the build carries it and this platform draws it. */
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
  const context: MapFeatureRequestContext = {
    development: input.development,
    search: input.search,
    on: (id) => lookup(id).on,
  };

  for (const feature of input.features) {
    const build = parseBuildSwitch(feature.build);
    const killed = build === 'killed';
    const stored = input.choices[feature.id];
    const choice = typeof stored === 'boolean' ? stored : null;
    const baseline = build === 'on' ? true : feature.defaultOn;

    let enabled: boolean;
    let source: MapFeatureSource;
    if (killed) {
      enabled = false;
      source = 'killed';
    } else if (choice !== null) {
      enabled = choice;
      source = 'choice';
    } else {
      enabled = baseline;
      source = build === 'on' ? 'build' : 'default';
    }

    const requested = feature.request ? feature.request(enabled, context) : enabled;
    if (requested !== enabled) source = 'page';
    const blockedBy = feature.requires.filter((id) => !lookup(id).on);

    byId.set(feature.id, {
      id: feature.id,
      tier: feature.tier,
      on: requested && blockedBy.length === 0,
      available:
        !killed &&
        feature.platforms.includes(input.platform) &&
        feature.offer !== 'never' &&
        (feature.offer !== 'development' || input.development),
      choice,
      baseline: killed ? false : baseline,
      source,
      blockedBy,
    });
  }

  const list = [...byId.values()];
  return { list, get: lookup, on: (id) => lookup(id).on };
}
