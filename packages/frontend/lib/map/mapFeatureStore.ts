/**
 * The person's map-feature choices, kept on THIS DEVICE only, and the live
 * answer the map reads from them (`docs/MAP_FEATURES.md`).
 *
 * A factory with its storage and environment passed in, so persistence
 * failures, hydration order and the `?labs=` switch are tests
 * (`__tests__/mapFeatureStore.test.ts`); the app's one instance is
 * `useMapFeatures.ts`.
 *
 * ## What is stored, and where
 *
 * One small JSON document under {@link MAP_FEATURES_STORAGE_KEY}: which
 * features the person turned on or off, whether Labs is revealed, the
 * Performance choice (`lib/map/quality/profile.ts`), the map style and its
 * light (`lib/map/style/catalogue.ts`) and what the device's GPU
 * measured (`lib/map/quality/gpuTier.ts`), so the next visit resolves its
 * quality before the first frame. Nothing
 * is sent anywhere — no request carries it, and no server learns it. On the
 * web it is `localStorage`, read synchronously, so the very first frame
 * already honours a choice (a globe switched off never flashes on). On native
 * it is AsyncStorage, read asynchronously: until it answers, the map draws the
 * registry's defaults, then follows the stored choices.
 *
 * Storage is a convenience, never a dependency: a store that throws, rejects,
 * or holds garbage leaves the map on its defaults, and a choice that cannot be
 * saved still applies to this session.
 *
 * A choice equal to the feature's default is not stored: it is
 * cleared, so a later change of default reaches the person.
 */
import {
  type MapFeatureDefinition,
  type MapPlatform,
  type ResolvedMapFeatures,
  resolveMapFeatures,
} from './mapFeatures';
import { type GpuTierRecord, parseGpuRecord } from './quality/gpuTier';
import { type PerformanceMode, parsePerformanceMode } from './quality/profile';
import {
  DEFAULT_MAP_STYLE,
  isMapLightMode,
  isMapStyleId,
  type MapLightMode,
  type MapStyleId,
} from './style/catalogue';

export const MAP_FEATURES_STORAGE_KEY = 'goway.mapFeatures';

/** Where the document is kept. Either method may throw or reject. */
export interface MapFeatureStorage {
  /** The stored document, or `null` for none. Sync on web, async on native. */
  load(): string | null | Promise<string | null>;
  save(value: string): void | Promise<void>;
}

export interface MapFeaturePreferences {
  /** Explicit on/off choices, by feature id. */
  choices: Readonly<Record<string, boolean>>;
  /** Whether the panel shows its Labs section. */
  labs: boolean;
  /** Settings → Performance. */
  performance: PerformanceMode;
  /** The map style (the layers picker). */
  style: MapStyleId;
  /** How the map picks its light (Settings → Map → Light). */
  light: MapLightMode;
  /** What this device's GPU measured, or `null` before it has been. */
  gpu: GpuTierRecord | null;
}

export const NO_PREFERENCES: MapFeaturePreferences = {
  choices: {},
  labs: false,
  performance: 'auto',
  style: DEFAULT_MAP_STYLE,
  light: 'app',
  gpu: null,
};

/**
 * Read a stored document. Anything unexpected — not JSON, a different shape, a
 * non-boolean, an id this build does not know — is dropped, never thrown.
 */
export function parsePreferences(
  raw: string | null,
  knownIds: ReadonlySet<string>,
  now: number = Date.now(),
): MapFeaturePreferences {
  if (!raw) return NO_PREFERENCES;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return NO_PREFERENCES;
  }
  if (typeof parsed !== 'object' || parsed === null) return NO_PREFERENCES;
  const document = parsed as {
    v?: unknown;
    choices?: unknown;
    labs?: unknown;
    performance?: unknown;
    style?: unknown;
    light?: unknown;
    gpu?: unknown;
  };
  if (document.v !== 1) return NO_PREFERENCES;
  const choices: Record<string, boolean> = {};
  if (typeof document.choices === 'object' && document.choices !== null) {
    for (const [id, value] of Object.entries(document.choices)) {
      if (knownIds.has(id) && typeof value === 'boolean') choices[id] = value;
    }
  }
  return {
    choices,
    labs: document.labs === true,
    performance: parsePerformanceMode(document.performance),
    // A style this build does not publish (an older or newer build's) is
    // the default, never an error.
    style: isMapStyleId(document.style) ? document.style : DEFAULT_MAP_STYLE,
    light: isMapLightMode(document.light) ? document.light : 'app',
    gpu: parseGpuRecord(document.gpu, now),
  };
}

export function serializePreferences(preferences: MapFeaturePreferences): string {
  return JSON.stringify({
    v: 1,
    choices: preferences.choices,
    labs: preferences.labs,
    // The default is not stored, so a later change of default reaches the person.
    ...(preferences.performance === 'auto' ? {} : { performance: preferences.performance }),
    ...(preferences.style === DEFAULT_MAP_STYLE ? {} : { style: preferences.style }),
    ...(preferences.light === 'app' ? {} : { light: preferences.light }),
    ...(preferences.gpu ? { gpu: preferences.gpu } : {}),
  });
}

/**
 * `?labs=1` (or `true`) reveals Labs and `?labs=0` (or `false`) hides it, in
 * ANY build: it shows switches, it switches nothing on, so a link can never
 * turn an experimental renderer on for somebody else. `null` for no opinion.
 */
export function labsFromSearch(search: string): boolean | null {
  const value = new URLSearchParams(search).get('labs');
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;
  return null;
}

export interface MapFeatureSnapshot {
  features: ResolvedMapFeatures;
  /** Whether the panel shows Labs. */
  labs: boolean;
  /** Settings → Performance. */
  performance: PerformanceMode;
  /** The map style. */
  style: MapStyleId;
  /** How the map picks its light. */
  light: MapLightMode;
  /** What this device's GPU measured, or `null`. */
  gpu: GpuTierRecord | null;
  /** Whether the stored choices have been read (always `true` on web). */
  hydrated: boolean;
}

export interface MapFeatureStore {
  getSnapshot(): MapFeatureSnapshot;
  subscribe(listener: () => void): () => void;
  /** Turn a feature on or off on this device. Ignored for an unknown feature. */
  setChoice(id: string, on: boolean): void;
  /** Forget the choice for a feature, back to the default. */
  clearChoice(id: string): void;
  setLabs(visible: boolean): void;
  /** Settings → Performance. */
  setPerformance(mode: PerformanceMode): void;
  /** The layers picker: the map style. */
  setStyle(style: MapStyleId): void;
  /** Settings → Map → Light. */
  setLight(mode: MapLightMode): void;
  /** Remember what this device's GPU measured (`lib/map/quality/gpuTier.ts`). */
  setGpuRecord(record: GpuTierRecord): void;
}

export interface CreateMapFeatureStoreOptions {
  features: readonly MapFeatureDefinition[];
  storage: MapFeatureStorage;
  platform: MapPlatform;
  development: boolean;
  search: string;
  /** Where a storage failure is reported. Defaults to a development-only warning. */
  onStorageError?: (operation: 'load' | 'save', cause: unknown) => void;
}

function isPromise<T>(value: unknown): value is Promise<T> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

export function createMapFeatureStore(options: CreateMapFeatureStoreOptions): MapFeatureStore {
  const { features, storage, platform, development, search } = options;
  const knownIds = new Set(features.map((feature) => feature.id));
  const reportError =
    options.onStorageError ??
    ((operation: 'load' | 'save', cause: unknown) => {
      if (development) console.warn(`map features: ${operation} failed; defaults kept.`, cause);
    });
  const labsRequested = labsFromSearch(search);

  let preferences: MapFeaturePreferences = NO_PREFERENCES;
  // What the person changed before the stored document arrived (native): it
  // wins over the document, which is older than the change.
  const changedEarly = new Map<string, boolean | null>();
  let labsChangedEarly: boolean | null = null;
  let performanceChangedEarly: PerformanceMode | null = null;
  let styleChangedEarly: MapStyleId | null = null;
  let lightChangedEarly: MapLightMode | null = null;
  let gpuChangedEarly: GpuTierRecord | null = null;
  let hydrated = false;
  const listeners = new Set<() => void>();

  const resolve = (): MapFeatureSnapshot => ({
    features: resolveMapFeatures({
      features,
      choices: preferences.choices,
      platform,
      development,
      search,
    }),
    labs: preferences.labs,
    performance: preferences.performance,
    style: preferences.style,
    light: preferences.light,
    gpu: preferences.gpu,
    hydrated,
  });
  let snapshot = resolve();

  const save = () => {
    try {
      const pending = storage.save(serializePreferences(preferences));
      if (isPromise<void>(pending)) pending.catch((cause) => reportError('save', cause));
    } catch (cause) {
      reportError('save', cause);
    }
  };

  const commit = (next: MapFeaturePreferences, persist: boolean) => {
    preferences = next;
    snapshot = resolve();
    if (persist) save();
    for (const listener of [...listeners]) listener();
  };

  const hydrate = (raw: string | null) => {
    const stored = parsePreferences(raw, knownIds);
    const choices: Record<string, boolean> = { ...stored.choices };
    for (const [id, value] of changedEarly) {
      if (value === null) delete choices[id];
      else choices[id] = value;
    }
    const labs = labsChangedEarly ?? labsRequested ?? stored.labs;
    const performance = performanceChangedEarly ?? stored.performance;
    const style = styleChangedEarly ?? stored.style;
    const light = lightChangedEarly ?? stored.light;
    const gpu = gpuChangedEarly ?? stored.gpu;
    hydrated = true;
    // Persist only when the page itself changed something (`?labs=`, or a
    // toggle before the document arrived); a plain read writes nothing.
    commit(
      { choices, labs, performance, style, light, gpu },
      labs !== stored.labs ||
        changedEarly.size > 0 ||
        performanceChangedEarly !== null ||
        styleChangedEarly !== null ||
        lightChangedEarly !== null ||
        gpuChangedEarly !== null,
    );
  };

  let loaded: string | null | Promise<string | null>;
  try {
    loaded = storage.load();
  } catch (cause) {
    reportError('load', cause);
    loaded = null;
  }
  if (isPromise<string | null>(loaded)) {
    loaded.then(hydrate, (cause: unknown) => {
      reportError('load', cause);
      hydrate(null);
    });
  } else {
    hydrate(loaded);
  }

  const setChoiceValue = (id: string, value: boolean | null) => {
    if (!knownIds.has(id)) return;
    const state = snapshot.features.get(id);
    // Equal to the default anyway: forget it instead of pinning it.
    const next = value === null || value === state.baseline ? null : value;
    if (!hydrated) changedEarly.set(id, next);
    const choices: Record<string, boolean> = { ...preferences.choices };
    if (next === null) delete choices[id];
    else choices[id] = next;
    commit({ ...preferences, choices }, hydrated);
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setChoice: (id, on) => setChoiceValue(id, on),
    clearChoice: (id) => setChoiceValue(id, null),
    setLabs(visible) {
      if (!hydrated) labsChangedEarly = visible;
      if (visible === preferences.labs) return;
      commit({ ...preferences, labs: visible }, hydrated);
    },
    setPerformance(mode) {
      if (!hydrated) performanceChangedEarly = mode;
      if (mode === preferences.performance) return;
      commit({ ...preferences, performance: mode }, hydrated);
    },
    setStyle(style) {
      if (!isMapStyleId(style)) return;
      if (!hydrated) styleChangedEarly = style;
      if (style === preferences.style) return;
      commit({ ...preferences, style }, hydrated);
    },
    setLight(mode) {
      if (!isMapLightMode(mode)) return;
      if (!hydrated) lightChangedEarly = mode;
      if (mode === preferences.light) return;
      commit({ ...preferences, light: mode }, hydrated);
    },
    setGpuRecord(record) {
      if (!hydrated) gpuChangedEarly = record;
      commit({ ...preferences, gpu: record }, hydrated);
    },
  };
}
